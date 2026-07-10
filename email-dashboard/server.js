// Unified Gmail Dashboard — v2 with real triage
//
// Reads all four Gmail accounts using the tokens already stored in ~/.gmail-mcp
// (created during MCP setup) and serves a single local web page at
// http://localhost:3777 with mail sorted into Priority / Everything else /
// Promos & newsletters.
//
// Sorting has two layers:
//   1. Bulk-mail detection (always on, free): mass mail carries fingerprint
//      headers (List-Unsubscribe, Precedence: bulk) that no human sender has.
//   2. Claude AI triage (optional): if an API key is saved at
//      ~/.gmail-mcp/anthropic.key, Claude reads each email's sender/subject/
//      snippet and judges whether Derek actually needs to see it. Verdicts are
//      cached per message, so only new mail costs anything.
//
// Read-only: this app never sends, deletes, or modifies email.

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { google } = require("googleapis");

const PORT = 3777;
const CONFIG_DIR = path.join(os.homedir(), ".gmail-mcp");
const OAUTH_KEYS_PATH = path.join(CONFIG_DIR, "gcp-oauth.keys.json");
const AI_KEY_PATH = path.join(CONFIG_DIR, "anthropic.key");
const AI_MODEL_PATH = path.join(CONFIG_DIR, "anthropic.model"); // optional override
const TRIAGE_CACHE_PATH = path.join(CONFIG_DIR, "triage-cache.json");
const DEFAULT_AI_MODEL = "claude-opus-4-8";

// The four accounts. The creds file must exist in ~/.gmail-mcp.
const ACCOUNTS = [
  { alias: "personal",  email: "djaeger15@gmail.com",           creds: "credentials-personal.json",  color: "#4f6ef7" },
  { alias: "lastcrumb", email: "derek@lastcrumb.com",           creds: "credentials-lastcrumb.json", color: "#e2725b" },
  { alias: "plushpay",  email: "derek@plushpay.com",            creds: "credentials-plushpay.json",  color: "#0aa47c" },
  { alias: "lunalulu",  email: "derek@lunaluluenterprises.com", creds: "credentials-lunalulu.json",  color: "#a05ad0" },
];

const DEFAULT_DEPTH = 30;   // emails per account; UI can request up to MAX_DEPTH
const MAX_DEPTH = 250;
const CACHE_TTL_MS = 60 * 1000;

// ---------------------------------------------------------------- Gmail ----

function getOAuthKeys() {
  const raw = JSON.parse(fs.readFileSync(OAUTH_KEYS_PATH, "utf8"));
  const keys = raw.installed || raw.web;
  if (!keys) throw new Error("Invalid gcp-oauth.keys.json (no installed/web section)");
  return keys;
}

function getClient(account) {
  const keys = getOAuthKeys();
  const credsPath = path.join(CONFIG_DIR, account.creds);
  if (!fs.existsSync(credsPath)) {
    throw new Error(`Not authenticated: ${credsPath} is missing`);
  }
  const tokens = JSON.parse(fs.readFileSync(credsPath, "utf8"));
  const client = new google.auth.OAuth2(keys.client_id, keys.client_secret, keys.redirect_uris[0]);
  client.setCredentials(tokens);
  client.on("tokens", (t) => {
    try {
      const merged = { ...tokens, ...t };
      if (!t.refresh_token) merged.refresh_token = tokens.refresh_token;
      fs.writeFileSync(credsPath, JSON.stringify(merged, null, 2));
    } catch { /* non-fatal */ }
  });
  return google.gmail({ version: "v1", auth: client });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function parseFrom(fromHeader) {
  if (!fromHeader) return { name: "(unknown sender)", address: "" };
  const m = fromHeader.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || m[2], address: m[2].trim() };
  return { name: fromHeader.trim(), address: fromHeader.trim() };
}

// Bulk-mail fingerprints: mass mail (promos, newsletters, notifications)
// carries headers real human senders never set.
function isBulk(headers, labelIds, from) {
  if (headers["list-unsubscribe"]) return true;
  const precedence = (headers["precedence"] || "").toLowerCase();
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") return true;
  const auto = (headers["auto-submitted"] || "").toLowerCase();
  if (auto && auto !== "no") return true;
  const l = new Set(labelIds || []);
  if (l.has("CATEGORY_PROMOTIONS") || l.has("CATEGORY_SOCIAL")) return true;
  if (/no-?reply|donotreply|do-not-reply|notifications?@|newsletter|mailer-daemon/i.test(from.address)) return true;
  return false;
}

// Heuristic tier, used when AI triage is off or hasn't judged a message yet.
//   high   -> Priority (humans writing to Derek, starred mail)
//   normal -> Everything else (receipts, updates, legit non-urgent)
//   low    -> Promos & newsletters
function heuristicTier(msg) {
  const l = new Set(msg.labelIds || []);
  if (msg.starred) return "high";
  if (msg.bulk) return "low";
  if (l.has("CATEGORY_UPDATES") || l.has("CATEGORY_FORUMS")) return "normal";
  return "high"; // non-bulk, non-category mail is almost always a real person
}

async function fetchAccount(account, depth) {
  const gmail = getClient(account);
  const ids = [];
  let pageToken;
  while (ids.length < depth) {
    const list = await gmail.users.messages.list({
      userId: "me",
      q: "in:inbox",
      maxResults: Math.min(100, depth - ids.length),
      pageToken,
    });
    ids.push(...(list.data.messages || []).map((m) => m.id));
    pageToken = list.data.nextPageToken;
    if (!pageToken) break;
  }
  return mapLimit(ids, 8, async (id) => {
    const res = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date", "List-Unsubscribe", "Precedence", "Auto-Submitted"],
    });
    const d = res.data;
    const headers = {};
    for (const h of d.payload?.headers || []) headers[h.name.toLowerCase()] = h.value;
    const from = parseFrom(headers.from);
    const labelIds = d.labelIds || [];
    const msg = {
      id: d.id,
      account: account.alias,
      accountEmail: account.email,
      color: account.color,
      from,
      subject: headers.subject || "(no subject)",
      snippet: d.snippet || "",
      dateMs: Number(d.internalDate) || 0,
      unread: labelIds.includes("UNREAD"),
      starred: labelIds.includes("STARRED"),
      labelIds,
      bulk: isBulk(headers, labelIds, from),
    };
    msg.tier = heuristicTier(msg);
    msg.why = msg.bulk ? "bulk mail (unsubscribe header / promo category)" : "";
    return msg;
  });
}

// ------------------------------------------------------------- AI triage ----

function getAIConfig() {
  let key = process.env.ANTHROPIC_API_KEY || null;
  try {
    if (!key && fs.existsSync(AI_KEY_PATH)) key = fs.readFileSync(AI_KEY_PATH, "utf8").trim();
  } catch { /* ignore */ }
  let model = DEFAULT_AI_MODEL;
  try {
    if (fs.existsSync(AI_MODEL_PATH)) {
      const m = fs.readFileSync(AI_MODEL_PATH, "utf8").trim();
      if (m) model = m;
    }
  } catch { /* ignore */ }
  return { key, model };
}

function loadTriageCache() {
  try {
    if (fs.existsSync(TRIAGE_CACHE_PATH)) return JSON.parse(fs.readFileSync(TRIAGE_CACHE_PATH, "utf8"));
  } catch { /* corrupt cache -> start fresh */ }
  return {};
}

function saveTriageCache(cache) {
  const ids = Object.keys(cache);
  if (ids.length > 3000) {
    for (const id of ids.slice(0, ids.length - 3000)) delete cache[id];
  }
  try {
    fs.writeFileSync(TRIAGE_CACHE_PATH, JSON.stringify(cache));
  } catch { /* non-fatal */ }
}

const TRIAGE_SYSTEM = `You triage email for Derek Jaeger. His accounts:
- personal: djaeger15@gmail.com (personal life)
- lastcrumb: derek@lastcrumb.com (his business Last Crumb)
- plushpay: derek@plushpay.com (his business Plush Pay, a payments company)
- lunalulu: derek@lunaluluenterprises.com (his business Luna Lulu Enterprises)

Classify each email by how much Derek needs to see it:
- "high": needs his attention. Real people writing to him personally; customers, partners, vendors, or employees of his businesses; anything about money owed/received, legal, taxes, security alerts, account problems, deadlines, or time-sensitive personal matters.
- "normal": legitimate but routine. Receipts, order/shipping confirmations, statements, calendar notices, service notifications he'd skim later.
- "low": marketing, promotions, sales, newsletters, digests, social notifications, product announcements, spam-adjacent noise. When a message is transparently trying to sell something, it is "low" no matter how urgent its subject line sounds.

Judge from the sender, subject, and snippet. Be skeptical of manufactured urgency ("ends tonight!", "last chance"). Give a short "why" (under 12 words).`;

const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer" },
          tier: { type: "string", enum: ["high", "normal", "low"] },
          why: { type: "string" },
        },
        required: ["i", "tier", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

async function classifyBatch(anthropic, model, batch) {
  const lines = batch.map((m, i) => ({
    i,
    account: m.account,
    from: `${m.from.name} <${m.from.address}>`,
    subject: m.subject.slice(0, 200),
    snippet: m.snippet.slice(0, 200),
    unread: m.unread,
    bulk_mail_headers: m.bulk,
  }));
  const response = await anthropic.messages.create({
    model,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: TRIAGE_SYSTEM,
    output_config: { format: { type: "json_schema", schema: TRIAGE_SCHEMA } },
    messages: [{ role: "user", content: `Classify these emails:\n${JSON.stringify(lines, null, 1)}` }],
  });
  const text = response.content.find((b) => b.type === "text");
  if (!text) throw new Error(`no text block in triage response (stop_reason: ${response.stop_reason})`);
  return JSON.parse(text.text).results;
}

async function runAITriage(emails, ai, payload) {
  let Anthropic;
  try {
    Anthropic = require("@anthropic-ai/sdk");
  } catch {
    payload.aiError = "AI package not installed — run: npm install";
    return;
  }
  const anthropic = new Anthropic({ apiKey: ai.key });
  const cache = loadTriageCache();

  // Apply cached verdicts; collect messages Claude hasn't judged yet.
  // Obvious bulk promos/social skip AI entirely — they're "low", no tokens needed.
  const pending = [];
  for (const m of emails) {
    const cached = cache[m.id];
    if (cached) {
      m.tier = cached.tier;
      m.why = cached.why;
      m.ai = true;
    } else if (m.bulk && (m.labelIds.includes("CATEGORY_PROMOTIONS") || m.labelIds.includes("CATEGORY_SOCIAL"))) {
      // keep heuristic "low"
    } else {
      pending.push(m);
    }
  }

  try {
    for (let start = 0; start < pending.length; start += 25) {
      const batch = pending.slice(start, start + 25);
      const results = await classifyBatch(anthropic, ai.model, batch);
      for (const r of results) {
        const m = batch[r.i];
        if (!m) continue;
        m.tier = r.tier;
        m.why = r.why;
        m.ai = true;
        cache[m.id] = { tier: r.tier, why: r.why };
      }
    }
    saveTriageCache(cache);
  } catch (err) {
    saveTriageCache(cache); // keep whatever finished
    const status = err?.status ? ` (HTTP ${err.status})` : "";
    payload.aiError =
      err?.status === 401 ? "AI key rejected — check ~/.gmail-mcp/anthropic.key"
      : err?.status === 429 ? "AI rate-limited — showing header-based sorting for some mail"
      : `AI triage failed${status}: ${String(err?.message || err).slice(0, 200)}`;
  }

  // Starred always wins, whatever the AI thinks.
  for (const m of emails) if (m.starred) m.tier = "high";
}

// ------------------------------------------------------------------ fetch ----

let cache = { at: 0, payload: null, pending: null, depth: 0 };

async function getAllEmails(fresh, depth) {
  const now = Date.now();
  if (!fresh && cache.payload && cache.depth === depth && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (cache.pending && cache.depth === depth) return cache.pending;

  cache.depth = depth;
  cache.pending = (async () => {
    const accounts = [];
    const emails = [];
    await Promise.all(
      ACCOUNTS.map(async (acc) => {
        try {
          const msgs = await fetchAccount(acc, depth);
          accounts.push({ alias: acc.alias, email: acc.email, color: acc.color, ok: true, count: msgs.length });
          emails.push(...msgs);
        } catch (err) {
          accounts.push({
            alias: acc.alias, email: acc.email, color: acc.color, ok: false,
            error: String(err.message || err).slice(0, 300),
          });
        }
      })
    );

    const ai = getAIConfig();
    const payload = { fetchedAt: Date.now(), accounts, emails, aiEnabled: !!ai.key, aiModel: ai.key ? ai.model : null };
    if (ai.key && emails.length) await runAITriage(emails, ai, payload);

    emails.sort((a, b) => b.dateMs - a.dateMs);
    cache = { at: Date.now(), payload, pending: null, depth };
    return payload;
  })();

  try {
    return await cache.pending;
  } finally {
    cache.pending = null;
  }
}

// ------------------------------------------------------------------- UI ----

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>All Inboxes</title>
<style>
  :root {
    --bg: #f6f7f9; --card: #ffffff; --ink: #1a1d23; --muted: #6b7280;
    --line: #e5e7eb; --accent: #4f6ef7;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #101216; --card: #191c22; --ink: #e8eaee; --muted: #8b93a1; --line: #262a33; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.45 -apple-system, "Segoe UI", system-ui, sans-serif;
  }
  .wrap { max-width: 880px; margin: 0 auto; padding: 24px 16px 80px; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.02em; }
  .meta { color: var(--muted); font-size: 13px; }
  .aibadge { font-size: 12px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--line);
    color: var(--muted); }
  .aibadge.on { color: #0aa47c; border-color: #0aa47c55; }
  button.refresh {
    margin-left: auto; border: 1px solid var(--line); background: var(--card); color: var(--ink);
    border-radius: 8px; padding: 7px 14px; font-size: 14px; cursor: pointer;
  }
  button.refresh:hover { border-color: var(--accent); }
  select.depth {
    border: 1px solid var(--line); background: var(--card); color: var(--ink);
    border-radius: 8px; padding: 6px 8px; font-size: 13.5px; cursor: pointer;
  }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; margin: 14px 0 20px; }
  .chip {
    display: inline-flex; align-items: center; gap: 7px; padding: 5px 12px; border-radius: 999px;
    border: 1px solid var(--line); background: var(--card); cursor: pointer; font-size: 13px; user-select: none;
  }
  .chip .dot { width: 9px; height: 9px; border-radius: 50%; }
  .chip.off { opacity: 0.38; }
  .chip .err { color: #d33; font-weight: 600; }
  h2.section {
    font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted);
    margin: 26px 0 8px; display: flex; align-items: center; gap: 8px; cursor: default;
  }
  h2.section.toggle { cursor: pointer; }
  .rows { background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .row { display: flex; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line); cursor: pointer; }
  .row:last-child { border-bottom: none; }
  .row:hover { background: rgba(127,127,127,0.06); }
  .row .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; margin-top: 6px; }
  .row .main { flex: 1; min-width: 0; }
  .row .top { display: flex; gap: 8px; align-items: baseline; }
  .row .sender { font-weight: 480; }
  .row.unread .sender, .row.unread .subject { font-weight: 700; }
  .row .acct { font-size: 11px; color: var(--muted); }
  .row .time { margin-left: auto; flex: none; font-size: 12.5px; color: var(--muted); }
  .row .subject { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row .snippet { display: block; color: var(--muted); font-size: 13.5px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row .star { color: #f2b01e; }
  .row .why { font-size: 12px; color: var(--muted); font-style: italic; margin-top: 4px; }
  .row .why .ai { color: #0aa47c; font-style: normal; }
  .row .expand { display: none; margin-top: 8px; }
  .row.open .expand { display: block; }
  .row.open .subject, .row.open .snippet { white-space: normal; }
  .expand a {
    display: inline-block; margin-top: 6px; color: var(--accent); text-decoration: none;
    font-size: 13.5px; font-weight: 600;
  }
  .empty { padding: 22px 16px; color: var(--muted); }
  .banner { background: #fff4e5; border: 1px solid #f0c188; color: #7a4d09;
    border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; font-size: 13.5px; }
  @media (prefers-color-scheme: dark) { .banner { background: #2b2214; border-color: #6b5426; color: #e8c98b; } }
  .loading { color: var(--muted); padding: 40px 0; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>📬 All Inboxes</h1>
    <span class="aibadge" id="aibadge"></span>
    <span class="meta" id="meta"></span>
    <button class="refresh" id="refresh">↻ Refresh</button>
    <select class="depth" id="depth" title="How far back to load, per inbox">
      <option value="30">Recent (30/inbox)</option>
      <option value="100">Deeper (100/inbox)</option>
      <option value="250">Way back (250/inbox)</option>
    </select>
  </header>
  <div class="chips" id="chips"></div>
  <div id="banners"></div>
  <div id="content"><div class="loading">Loading your four inboxes…</div></div>
</div>
<script>
const state = { data: null, hidden: new Set(), showLow: false, depth: 30 };

function timeAgo(ms) {
  if (!ms) return "";
  const d = new Date(ms), diff = Date.now() - ms;
  if (diff < 60e3) return "now";
  if (diff < 3600e3) return Math.floor(diff / 60e3) + "m";
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + "h";
  if (diff < 7 * 86400e3) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function renderChips() {
  const chips = document.getElementById("chips");
  chips.replaceChildren();
  for (const acc of state.data.accounts) {
    const c = el("span", "chip" + (state.hidden.has(acc.alias) ? " off" : ""));
    const dot = el("span", "dot"); dot.style.background = acc.color;
    c.append(dot, el("span", null, acc.alias));
    if (!acc.ok) c.append(el("span", "err", "⚠"));
    else c.append(el("span", "acct", String(acc.count)));
    c.onclick = () => {
      state.hidden.has(acc.alias) ? state.hidden.delete(acc.alias) : state.hidden.add(acc.alias);
      render();
    };
    chips.append(c);
  }
}

function renderBanners() {
  const b = document.getElementById("banners");
  b.replaceChildren();
  for (const acc of state.data.accounts) {
    if (!acc.ok) {
      b.append(el("div", "banner",
        "⚠ " + acc.alias + " (" + acc.email + ") couldn't be read: " + acc.error +
        " — if this mentions tokens/grants, re-run the auth command for this account."));
    }
  }
  if (state.data.aiError) b.append(el("div", "banner", "🤖 " + state.data.aiError));
}

function buildRow(m) {
  const row = el("div", "row" + (m.unread ? " unread" : ""));
  const dot = el("span", "dot"); dot.style.background = m.color; dot.title = m.account;
  const main = el("div", "main");
  const top = el("div", "top");
  top.append(el("span", "sender", m.from.name));
  if (m.starred) top.append(el("span", "star", "★"));
  top.append(el("span", "acct", m.account));
  top.append(el("span", "time", timeAgo(m.dateMs)));
  const subject = el("span", "subject", m.subject);
  const snippet = el("span", "snippet", m.snippet);
  const expand = el("div", "expand");
  if (m.why) {
    const why = el("div", "why");
    if (m.ai) why.append(el("span", "ai", "AI: "));
    why.append(document.createTextNode(m.why));
    expand.append(why);
  }
  const link = el("a", null, "Open in Gmail →");
  link.href = "https://mail.google.com/mail/?authuser=" + encodeURIComponent(m.accountEmail) + "#all/" + m.id;
  link.target = "_blank";
  link.onclick = (e) => e.stopPropagation();
  expand.append(el("div", "acct", m.from.address + " · to " + m.accountEmail), link);
  main.append(top, subject, snippet, expand);
  row.append(dot, main);
  row.onclick = () => row.classList.toggle("open");
  return row;
}

function section(title, list, emptyText) {
  const h = el("h2", "section", title);
  const box = el("div", "rows");
  list.length ? list.forEach((m) => box.append(buildRow(m))) : box.append(el("div", "empty", emptyText));
  return [h, box];
}

function render() {
  renderChips();
  renderBanners();
  const content = document.getElementById("content");
  content.replaceChildren();
  const visible = state.data.emails.filter((m) => !state.hidden.has(m.account));
  const high = visible.filter((m) => m.tier === "high");
  const normal = visible.filter((m) => m.tier === "normal");
  const low = visible.filter((m) => m.tier === "low");

  content.append(...section("🔥 Priority (" + high.length + ")", high, "Nothing needs you right now. 🎉"));
  content.append(...section("📥 Everything else (" + normal.length + ")", normal, "Empty."));

  const lowHeader = el("h2", "section toggle",
    "🗞 Promos & newsletters (" + low.length + ") " + (state.showLow ? "▾ click to hide" : "▸ click to show"));
  lowHeader.onclick = () => { state.showLow = !state.showLow; render(); };
  content.append(lowHeader);
  if (state.showLow) {
    const box = el("div", "rows");
    low.length ? low.forEach((m) => box.append(buildRow(m))) : box.append(el("div", "empty", "Empty."));
    content.append(box);
  }

  document.getElementById("meta").textContent =
    "updated " + new Date(state.data.fetchedAt).toLocaleTimeString();
  const badge = document.getElementById("aibadge");
  if (state.data.aiEnabled) {
    badge.textContent = "🤖 AI triage: on";
    badge.className = "aibadge on";
    badge.title = "Model: " + state.data.aiModel;
  } else {
    badge.textContent = "AI triage: off (header-based sorting)";
    badge.className = "aibadge";
  }
}

let loading = false;
async function load(fresh) {
  if (loading) return;
  loading = true;
  const content = document.getElementById("content");
  const meta = document.getElementById("meta");
  if (!state.data) content.replaceChildren(el("div", "loading", "Loading your four inboxes…"));
  else meta.textContent = "loading…";
  try {
    const res = await fetch("/api/emails?n=" + state.depth + (fresh ? "&fresh=1" : ""));
    state.data = await res.json();
    render();
  } finally {
    loading = false;
  }
}

document.getElementById("refresh").onclick = () => load(true);
document.getElementById("depth").onchange = (e) => {
  state.depth = Number(e.target.value);
  load(false);
};
setInterval(() => load(true), 5 * 60 * 1000);
load(false);
</script>
</body>
</html>`;

// --------------------------------------------------------------- server ----

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE);
    } else if (url.pathname === "/api/emails") {
      const depth = Math.max(10, Math.min(MAX_DEPTH, parseInt(url.searchParams.get("n"), 10) || DEFAULT_DEPTH));
      const data = await getAllEmails(url.searchParams.get("fresh") === "1", depth);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const ai = getAIConfig();
  console.log("");
  console.log("  📬 Email dashboard running!");
  console.log(`  Open:  http://localhost:${PORT}`);
  console.log("");
  console.log(ai.key
    ? `  🤖 AI triage: ON (${ai.model})`
    : "  🤖 AI triage: off — using header-based sorting. See README to enable.");
  console.log("");
  console.log("  (Keep this window open while using it. Press Ctrl+C to stop.)");
});
