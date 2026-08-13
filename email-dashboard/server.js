// Unified Gmail Dashboard — v4
//
// Reads all four Gmail accounts using the tokens already stored in ~/.gmail-mcp
// and serves a single local page at http://localhost:3777 with mail sorted into
// Priority / Everything else / Promos & newsletters.
//
// Fetching is by TIME WINDOW (last 7/14/30 days of each inbox, complete), not
// by message count — so no day can be silently missing from the view.
//
// Sorting layers:
//   1. Bulk-mail detection (always on, free): mass mail carries fingerprint
//      headers (List-Unsubscribe, Precedence: bulk) no human sender has.
//   2. Claude AI triage (optional): if a key is saved at
//      ~/.gmail-mcp/anthropic.key, Claude judges each email. Verdicts are
//      cached per message + rule version, so only new mail costs anything.
//
// Read-only: this app never sends, deletes, or modifies email.

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { google } = require("googleapis");

const VERSION = "v6";
const PORT = 3777;
const CONFIG_DIR = path.join(os.homedir(), ".gmail-mcp");
const OAUTH_KEYS_PATH = path.join(CONFIG_DIR, "gcp-oauth.keys.json");
const AI_KEY_PATH = path.join(CONFIG_DIR, "anthropic.key");
const AI_MODEL_PATH = path.join(CONFIG_DIR, "anthropic.model"); // optional override
const TRIAGE_CACHE_PATH = path.join(CONFIG_DIR, "triage-cache.json");
const DEFAULT_AI_MODEL = "claude-opus-4-8";

const ACCOUNTS = [
  { alias: "personal",  email: "djaeger15@gmail.com",           creds: "credentials-personal.json",  color: "#7c9cf5" },
  { alias: "lastcrumb", email: "derek@lastcrumb.com",           creds: "credentials-lastcrumb.json", color: "#f0987a" },
  { alias: "plushpay",  email: "derek@plushpay.com",            creds: "credentials-plushpay.json",  color: "#5fd0a5" },
  { alias: "lunalulu",  email: "derek@lunaluluenterprises.com", creds: "credentials-lunalulu.json",  color: "#c493ef" },
];

const DEFAULT_DAYS = 7;      // time window; UI offers 7 / 14 / 30
const MAX_DAYS = 60;
const MAX_PER_ACCOUNT = 500; // safety cap within the window
const CACHE_TTL_MS = 60 * 1000;

// Appointment-ish mail must never be shortcut into the promo bucket, even
// when it carries bulk headers (Resy, OpenTable, Calendly all do).
const APPT_RE = /reservation|appointment|booking|booked|invitation|invite\b|itinerar|check.?in|schedule|fitting|signature|sign\b|waiver|calendar|rsvp|confirm/i;

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

// Bulk-mail fingerprints: mass mail carries headers real humans never set.
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
function heuristicTier(msg) {
  const l = new Set(msg.labelIds || []);
  if (msg.starred) return "high";
  if (APPT_RE.test(msg.subject)) return "high";
  if (msg.bulk) return "low";
  if (l.has("CATEGORY_UPDATES") || l.has("CATEGORY_FORUMS")) return "normal";
  return "high"; // non-bulk, non-category mail is almost always a real person
}

async function fetchAccount(account, days) {
  const gmail = getClient(account);
  const ids = [];
  let pageToken;
  while (ids.length < MAX_PER_ACCOUNT) {
    const list = await gmail.users.messages.list({
      userId: "me",
      q: `in:inbox newer_than:${days}d`,
      maxResults: Math.min(100, MAX_PER_ACCOUNT - ids.length),
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
    msg.why = msg.bulk && msg.tier === "low" ? "bulk mail (unsubscribe header / promo category)" : "";
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
  if (ids.length > 6000) {
    for (const id of ids.slice(0, ids.length - 6000)) delete cache[id];
  }
  try {
    fs.writeFileSync(TRIAGE_CACHE_PATH, JSON.stringify(cache));
  } catch { /* non-fatal */ }
}

// Bump this whenever TRIAGE_SYSTEM changes: cached verdicts from older rule
// versions are ignored, so every email gets re-judged once under the new rules.
const PROMPT_VERSION = 4;

const TRIAGE_SYSTEM = `You triage email for Derek Jaeger, the way Superhuman's "Important" split would — near-perfect separation of what deserves his attention from noise. His accounts:
- personal: djaeger15@gmail.com (personal life)
- lastcrumb: derek@lastcrumb.com (his business Last Crumb)
- plushpay: derek@plushpay.com (his business Plush Pay, a payments company)
- lunalulu: derek@lunaluluenterprises.com (his business Luna Lulu Enterprises)

Classify each email:

"high" — Derek needs to see it:
- Real people writing to or about him, his family, or his businesses: customers, partners, vendors, contractors, employees, friends. Project threads (construction, design, legal, deals) are high even mid-thread.
- He is the owner and often CC'd on threads addressed to teammates. Conversations between real people about his businesses — introductions, negotiations, hiring, vendor/customer coordination — are high even when the greeting names someone else. Reply threads ("Re:", "Fw:") between humans conducting business are high unless clearly trivial.
- ANYTHING involving appointments or scheduling: restaurant/hotel reservations (Resy, OpenTable, Tock...), bookings, fittings, calendar invitations and event changes, meeting/call confirmations and reminders. These are high even though they come from automated platforms.
- Action required from him: e-signature requests, waivers, document approvals, confirmations he must click, verification requests.
- Money, legal, taxes (including government/state tax notices), security alerts, fraud warnings, account problems, deadlines.
- When unsure between high and normal for mail involving a real human or a scheduled event, choose high — burying an important email is far worse than one extra in Priority.

"normal" — legitimate, no action needed:
- Receipts, payment confirmations, statements, order/shipping notices.
- Routine service notifications, reports, and digests from tools his businesses use (sales summaries, usage reports).
- Package delivery notices that need no action.

"low" — noise:
- Marketing, promotions, sales, newsletters, product announcements, social notifications.
- Unsolicited pitches from strangers: agencies, recruiters, growth/marketing/PR services, "we helped X achieve Y" cold outreach, LinkedIn-style networking from people Derek has no existing relationship with. These are low even when personalized with his name or his company's name and even when they reply-bump their own thread ("still curious...", "following up..."). A stranger selling services is low; a customer or partner is high — judge which one this is.
- Manufactured urgency ("ends tonight!", "last chance") is a promo tell, not a priority signal.

Judge from the sender, subject, and snippet. Give a short "why" (under 12 words).`;

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

  const pending = [];
  for (const m of emails) {
    const cached = cache[m.id];
    const obviousPromo =
      m.bulk &&
      (m.labelIds.includes("CATEGORY_PROMOTIONS") || m.labelIds.includes("CATEGORY_SOCIAL")) &&
      !APPT_RE.test(m.subject); // appointment-ish mail always gets a real judgment
    if (cached && cached.v === PROMPT_VERSION) {
      m.tier = cached.tier;
      m.why = cached.why;
      m.ai = true;
    } else if (obviousPromo) {
      // keep heuristic "low", no tokens needed
    } else {
      pending.push(m);
    }
  }

  const batches = [];
  for (let start = 0; start < pending.length; start += 25) batches.push(pending.slice(start, start + 25));
  let judged = 0;
  if (pending.length) setProgress({ phase: "judging", done: 0, total: pending.length });

  try {
    await mapLimit(batches, 4, async (batch) => {
      const results = await classifyBatch(anthropic, ai.model, batch);
      for (const r of results) {
        const m = batch[r.i];
        if (!m) continue;
        m.tier = r.tier;
        m.why = r.why;
        m.ai = true;
        cache[m.id] = { tier: r.tier, why: r.why, v: PROMPT_VERSION };
      }
      judged += batch.length;
      setProgress({ phase: "judging", done: judged, total: pending.length });
      saveTriageCache(cache); // persist per batch so an interrupted run loses nothing
    });
    saveTriageCache(cache);
  } catch (err) {
    saveTriageCache(cache); // keep whatever finished
    const status = err?.status ? ` (HTTP ${err.status})` : "";
    payload.aiError =
      err?.status === 401 ? "AI key rejected — check ~/.gmail-mcp/anthropic.key"
      : err?.status === 429 ? "AI rate-limited — showing header-based sorting for some mail"
      : `AI triage failed${status}: ${String(err?.message || err).slice(0, 200)}`;
  }

  for (const m of emails) if (m.starred) m.tier = "high";
}

// ------------------------------------------------------------------ fetch ----

let cache = { at: 0, payload: null, pending: null, days: 0 };
let progressState = null;
function setProgress(p) { progressState = p; }

async function getAllEmails(fresh, days) {
  const now = Date.now();
  if (!fresh && cache.payload && cache.days === days && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (cache.pending && cache.days === days) return cache.pending;

  cache.days = days;
  cache.pending = (async () => {
    setProgress({ phase: "fetching" });
    const accounts = [];
    const emails = [];
    await Promise.all(
      ACCOUNTS.map(async (acc) => {
        try {
          const msgs = await fetchAccount(acc, days);
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
    setProgress(null);
    cache = { at: Date.now(), payload, pending: null, days };
    return payload;
  })();

  try {
    return await cache.pending;
  } finally {
    cache.pending = null;
  }
}

// ------------------------------------------------------- full email body ----

function decodeB64Url(data) {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

// Walk the MIME tree; prefer HTML, fall back to plain text.
function extractBody(payload) {
  let html = null, text = null;
  (function walk(p) {
    if (!p) return;
    if (p.mimeType === "text/html" && p.body?.data && !html) html = decodeB64Url(p.body.data);
    else if (p.mimeType === "text/plain" && p.body?.data && !text) text = decodeB64Url(p.body.data);
    (p.parts || []).forEach(walk);
  })(payload);
  return { html, text };
}

async function getMessageBody(alias, id) {
  const acc = ACCOUNTS.find((a) => a.alias === alias);
  if (!acc) throw new Error("unknown account");
  const gmail = getClient(acc);
  const r = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  return extractBody(r.data.payload);
}

// ------------------------------------------------------------------- UI ----

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Inbox</title>
<style>
  :root {
    --bg: #131419; --panel: #17181f; --hover: #1e2029; --ink: #eceef4;
    --dim: #b9bdc9; --muted: #7e8494; --line: rgba(255,255,255,0.07);
    --accent: #8f93ff; --gold: #e8b64c; --warn-bg: #2b2214; --warn-line: #6b5426; --warn-ink: #e8c98b;
  }
  :root[data-theme="light"] {
    --bg: #f7f6f3; --panel: #ffffff; --hover: #edecea; --ink: #1c1d22;
    --dim: #45474f; --muted: #82868f; --line: rgba(0,0,0,0.08);
    --accent: #5a5fd6; --warn-bg: #fff4e5; --warn-line: #f0c188; --warn-ink: #7a4d09;
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14.5px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .app { max-width: 820px; margin: 0 auto; padding: 30px 20px 100px; }

  header.top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 26px; }
  .brand { font-size: 21px; font-weight: 700; letter-spacing: -0.02em; }
  .aibadge { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; }
  .aibadge.on { color: #5fd0a5; border-color: rgba(95,208,165,0.35); }
  .spacer { flex: 1; }
  .meta { color: var(--muted); font-size: 12.5px; }
  select.depth, button.iconbtn {
    border: 1px solid var(--line); background: var(--panel); color: var(--dim);
    border-radius: 8px; padding: 6px 12px; font-size: 13px; cursor: pointer;
  }
  button.iconbtn:hover, select.depth:hover { color: var(--ink); border-color: var(--accent); }

  .accounts { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 11px; border-radius: 999px;
    border: 1px solid var(--line); cursor: pointer; font-size: 12.5px; color: var(--dim); user-select: none;
  }
  .chip .dot { width: 7px; height: 7px; border-radius: 50%; }
  .chip.off { opacity: 0.35; }
  .chip .err { color: #e07070; font-weight: 700; }

  .banner { background: var(--warn-bg); border: 1px solid var(--warn-line); color: var(--warn-ink);
    border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; font-size: 13px; }

  .sec { display: flex; align-items: baseline; gap: 10px; margin: 36px 2px 4px; }
  .sec:first-child { margin-top: 8px; }
  .sec .name { font-size: 15.5px; font-weight: 650; letter-spacing: -0.01em; }
  .sec .count { font-size: 12px; color: var(--muted); }
  .sec::after { content: ""; flex: 1; height: 1px; background: var(--line); }
  .sec.toggle { cursor: pointer; }
  .sec.toggle .name { color: var(--muted); font-weight: 600; }
  .sec.toggle:hover .name { color: var(--dim); }

  .day { font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--muted); margin: 20px 14px 4px; }

  .row {
    display: grid; grid-template-columns: 46px 1fr; gap: 0 14px;
    padding: 11px 14px; border-radius: 12px; cursor: pointer;
  }
  .row:hover { background: var(--hover); }
  .avatar {
    width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center;
    justify-content: center; font-size: 13px; font-weight: 650; margin-top: 2px;
  }
  .row.unread .avatar { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--avc); }
  .main { min-width: 0; }
  .l1 { display: flex; align-items: baseline; gap: 8px; }
  .sender { font-weight: 600; color: var(--dim); white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; max-width: 60%; }
  .row.unread .sender { color: var(--ink); }
  .star { color: var(--gold); font-size: 13px; }
  .acct { font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
  .time { margin-left: auto; flex: none; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .l2 { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
  .subject { color: var(--dim); font-weight: 500; }
  .row.unread .subject { color: var(--ink); font-weight: 650; }
  .snip { color: var(--muted); font-weight: 400; }
  .row.open .l2 { white-space: normal; }
  .expand { display: none; margin-top: 10px; }
  .row.open .expand { display: block; }
  .why { display: inline-block; font-size: 12px; color: var(--muted); font-style: italic;
    border: 1px solid var(--line); border-radius: 999px; padding: 3px 11px; margin-bottom: 8px; }
  .why .ai { color: #5fd0a5; font-style: normal; font-weight: 600; }
  .addr { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
  .gmail { display: inline-block; color: var(--accent); text-decoration: none;
    font-size: 13px; font-weight: 600; border: 1px solid var(--line); border-radius: 8px; padding: 6px 14px; }
  .bodyholder { margin: 12px 0; color: var(--muted); font-size: 13px; }
  iframe.body { width: 100%; height: 520px; border: 1px solid var(--line); border-radius: 12px;
    background: #ffffff; display: block; }
  .gmail:hover { border-color: var(--accent); }
  .empty { padding: 20px 14px; color: var(--muted); font-size: 13.5px; }
  .loading { color: var(--muted); padding: 60px 0; text-align: center; }
</style>
</head>
<body>
<div class="app">
  <header class="top">
    <span class="brand">Inbox</span>
    <span class="meta" id="ver"></span>
    <span class="aibadge" id="aibadge"></span>
    <span class="spacer"></span>
    <span class="meta" id="meta"></span>
    <select class="depth" id="days" title="How far back to load">
      <option value="7">Last 7 days</option>
      <option value="14">Last 14 days</option>
      <option value="30">Last 30 days</option>
    </select>
    <button class="iconbtn" id="theme" title="Toggle light/dark">◐</button>
    <button class="iconbtn" id="refresh" title="Refresh">↻</button>
  </header>
  <div class="accounts" id="chips" style="margin-bottom:18px"></div>
  <div id="banners"></div>
  <main id="content"><div class="loading">Loading your four inboxes…</div></main>
</div>
<script>
const state = { data: null, hidden: new Set(), showLow: false, days: 7 };

document.getElementById("ver").textContent = "${VERSION}";
if (localStorage.getItem("theme") === "light") document.documentElement.dataset.theme = "light";
document.getElementById("theme").onclick = () => {
  const root = document.documentElement;
  if (root.dataset.theme === "light") {
    delete root.dataset.theme;
    localStorage.removeItem("theme");
  } else {
    root.dataset.theme = "light";
    localStorage.setItem("theme", "light");
  }
};

function timeAgo(ms) {
  if (!ms) return "";
  const d = new Date(ms), diff = Date.now() - ms;
  if (diff < 60e3) return "now";
  if (diff < 3600e3) return Math.floor(diff / 60e3) + "m";
  if (diff < 86400e3) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (diff < 7 * 86400e3) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dayLabel(ms) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= today) return "Today";
  if (ms >= today - 86400e3) return "Yesterday";
  if (ms >= today - 6 * 86400e3)
    return new Date(ms).toLocaleDateString(undefined, { weekday: "long" });
  if (ms >= today - 13 * 86400e3) return "Last week";
  return "Older";
}

function initials(name) {
  const words = name.replace(/[^\\p{L}\\p{N} ]/gu, " ").trim().split(/\\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words[0][0] + (words[1] ? words[1][0] : "")).toUpperCase();
}

function escapeHtml(t) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
    if (!acc.ok) c.append(el("span", "err", "!"));
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
  row.style.setProperty("--avc", m.color);
  const av = el("div", "avatar", initials(m.from.name));
  av.style.background = m.color + "26";
  av.style.color = m.color;
  av.title = m.account;
  const main = el("div", "main");
  const l1 = el("div", "l1");
  l1.append(el("span", "sender", m.from.name));
  if (m.starred) l1.append(el("span", "star", "★"));
  l1.append(el("span", "acct", m.account));
  l1.append(el("span", "time", timeAgo(m.dateMs)));
  const l2 = el("div", "l2");
  l2.append(el("span", "subject", m.subject));
  if (m.snippet) l2.append(el("span", "snip", "  —  " + m.snippet));
  const expand = el("div", "expand");
  if (m.why) {
    const why = el("div", "why");
    if (m.ai) why.append(el("span", "ai", "AI  ·  "));
    why.append(document.createTextNode(m.why));
    expand.append(why);
  }
  expand.append(el("div", "addr", m.from.address + "  ·  to " + m.accountEmail));
  const link = el("a", "gmail", "Open in Gmail ↗");
  link.href = "https://mail.google.com/mail/?authuser=" + encodeURIComponent(m.accountEmail) + "#all/" + m.id;
  link.target = "_blank";
  link.onclick = (e) => e.stopPropagation();
  expand.append(link);
  main.append(l1, l2, expand);
  row.append(av, main);
  let bodyLoaded = false;
  row.onclick = () => {
    row.classList.toggle("open");
    if (!row.classList.contains("open") || bodyLoaded) return;
    bodyLoaded = true;
    const holder = el("div", "bodyholder", "loading email…");
    expand.insertBefore(holder, link);
    fetch("/api/message?account=" + m.account + "&id=" + m.id)
      .then((r) => r.json())
      .then((b) => {
        holder.textContent = "";
        const iframe = document.createElement("iframe");
        iframe.className = "body";
        iframe.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
        iframe.srcdoc = b.html
          ? '<base target="_blank">' + b.html
          : '<base target="_blank"><pre style="white-space:pre-wrap;font:14px/1.6 system-ui;margin:14px">' +
            escapeHtml(b.text || "(no content)") + "</pre>";
        holder.append(iframe);
      })
      .catch(() => { holder.textContent = "couldn't load email body — use Open in Gmail below"; });
  };
  return row;
}

function renderList(container, list) {
  let lastDay = null;
  for (const m of list) {
    const label = dayLabel(m.dateMs);
    if (label !== lastDay) {
      container.append(el("div", "day", label));
      lastDay = label;
    }
    container.append(buildRow(m));
  }
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

  const sec1 = el("div", "sec");
  sec1.append(el("span", "name", "Priority"), el("span", "count", String(high.length)));
  content.append(sec1);
  high.length ? renderList(content, high) : content.append(el("div", "empty", "Nothing needs you right now."));

  const sec2 = el("div", "sec");
  sec2.append(el("span", "name", "Everything else"), el("span", "count", String(normal.length)));
  content.append(sec2);
  normal.length ? renderList(content, normal) : content.append(el("div", "empty", "Empty."));

  const sec3 = el("div", "sec toggle");
  sec3.append(el("span", "name", (state.showLow ? "▾" : "▸") + "  Promos & newsletters"), el("span", "count", String(low.length)));
  sec3.onclick = () => { state.showLow = !state.showLow; render(); };
  content.append(sec3);
  if (state.showLow) {
    low.length ? renderList(content, low) : content.append(el("div", "empty", "Empty."));
  }

  document.getElementById("meta").textContent =
    "updated " + new Date(state.data.fetchedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const badge = document.getElementById("aibadge");
  if (state.data.aiEnabled) {
    badge.textContent = "AI triage on";
    badge.className = "aibadge on";
    badge.title = "Model: " + state.data.aiModel;
  } else {
    badge.textContent = "AI off";
    badge.className = "aibadge";
    badge.title = "Header-based sorting — see README to enable AI triage";
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
  const poll = setInterval(async () => {
    try {
      const p = await (await fetch("/api/progress")).json();
      const label =
        p.phase === "judging" ? "AI judging " + p.done + " of " + p.total + "…" :
        p.phase === "fetching" ? "fetching mail…" : null;
      if (label) {
        meta.textContent = label;
        const ld = document.querySelector(".loading");
        if (ld) ld.textContent = "Loading your four inboxes — " + label;
      }
    } catch { /* server busy; try next tick */ }
  }, 1200);
  try {
    const res = await fetch("/api/emails?d=" + state.days + (fresh ? "&fresh=1" : ""));
    state.data = await res.json();
    render();
  } finally {
    clearInterval(poll);
    loading = false;
  }
}

document.getElementById("refresh").onclick = () => load(true);
document.getElementById("days").onchange = (e) => {
  state.days = Number(e.target.value);
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
    } else if (url.pathname === "/api/message") {
      const body = await getMessageBody(url.searchParams.get("account"), url.searchParams.get("id"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else if (url.pathname === "/api/progress") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(progressState || { idle: true }));
    } else if (url.pathname === "/api/emails") {
      const days = Math.max(1, Math.min(MAX_DAYS, parseInt(url.searchParams.get("d"), 10) || DEFAULT_DAYS));
      const data = await getAllEmails(url.searchParams.get("fresh") === "1", days);
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
  console.log(`  📬 Email dashboard running! (${VERSION})`);
  console.log(`  Open:  http://localhost:${PORT}`);
  console.log("");
  console.log(ai.key
    ? `  🤖 AI triage: ON (${ai.model})`
    : "  🤖 AI triage: off — using header-based sorting. See README to enable.");
  console.log("");
  console.log("  (Keep this window open while using it. Press Ctrl+C to stop.)");
});
