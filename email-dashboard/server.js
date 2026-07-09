// Unified Gmail Dashboard
// Reads all four Gmail accounts using the tokens already stored in ~/.gmail-mcp
// (created during MCP setup) and serves a single local web page at
// http://localhost:3777 with priority-sorted email across every account.
//
// Read-only: this app never sends, deletes, or modifies mail.

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { google } = require("googleapis");

const PORT = 3777;
const CONFIG_DIR = path.join(os.homedir(), ".gmail-mcp");
const OAUTH_KEYS_PATH = path.join(CONFIG_DIR, "gcp-oauth.keys.json");

// The four accounts. To add/remove accounts, edit this list — the creds file
// must exist in ~/.gmail-mcp (created by the MCP auth flow).
const ACCOUNTS = [
  { alias: "personal",  email: "djaeger15@gmail.com",            creds: "credentials-personal.json",  color: "#4f6ef7" },
  { alias: "lastcrumb", email: "derek@lastcrumb.com",            creds: "credentials-lastcrumb.json", color: "#e2725b" },
  { alias: "plushpay",  email: "derek@plushpay.com",             creds: "credentials-plushpay.json",  color: "#0aa47c" },
  { alias: "lunalulu",  email: "derek@lunaluluenterprises.com",  creds: "credentials-lunalulu.json",  color: "#a05ad0" },
];

const MESSAGES_PER_ACCOUNT = 30;
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
  // Persist refreshed tokens so future runs (and the MCP servers) stay logged in.
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

// Importance score. Gmail already runs its own ML to decide what matters
// (the IMPORTANT label / Primary category) — we lean on that, then nudge.
function scoreMessage(labelIds, from) {
  const l = new Set(labelIds || []);
  let s = 0;
  if (l.has("STARRED")) s += 100;
  if (l.has("IMPORTANT")) s += 50;
  if (l.has("CATEGORY_PERSONAL")) s += 25;
  if (l.has("UNREAD")) s += 10;
  if (l.has("CATEGORY_PROMOTIONS")) s -= 60;
  if (l.has("CATEGORY_SOCIAL")) s -= 40;
  if (l.has("CATEGORY_UPDATES")) s -= 20;
  if (l.has("CATEGORY_FORUMS")) s -= 20;
  if (/no-?reply|donotreply|notify|notification|newsletter|marketing|@e\.|@em\.|@mail\./i.test(from.address)) s -= 15;
  return s;
}

async function fetchAccount(account) {
  const gmail = getClient(account);
  const list = await gmail.users.messages.list({
    userId: "me",
    q: "in:inbox",
    maxResults: MESSAGES_PER_ACCOUNT,
  });
  const ids = (list.data.messages || []).map((m) => m.id);
  const messages = await mapLimit(ids, 8, async (id) => {
    const res = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });
    const d = res.data;
    const headers = {};
    for (const h of d.payload?.headers || []) headers[h.name.toLowerCase()] = h.value;
    const from = parseFrom(headers.from);
    const labelIds = d.labelIds || [];
    return {
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
      score: scoreMessage(labelIds, from),
    };
  });
  return messages;
}

let cache = { at: 0, payload: null, pending: null };

async function getAllEmails(fresh) {
  const now = Date.now();
  if (!fresh && cache.payload && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (cache.pending) return cache.pending;

  cache.pending = (async () => {
    const accounts = [];
    const emails = [];
    await Promise.all(
      ACCOUNTS.map(async (acc) => {
        try {
          const msgs = await fetchAccount(acc);
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
    emails.sort((a, b) => b.dateMs - a.dateMs);
    const payload = { fetchedAt: Date.now(), accounts, emails };
    cache = { at: Date.now(), payload, pending: null };
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
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.02em; }
  .meta { color: var(--muted); font-size: 13px; }
  button.refresh {
    margin-left: auto; border: 1px solid var(--line); background: var(--card); color: var(--ink);
    border-radius: 8px; padding: 7px 14px; font-size: 14px; cursor: pointer;
  }
  button.refresh:hover { border-color: var(--accent); }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
  .chip {
    display: inline-flex; align-items: center; gap: 7px; padding: 5px 12px; border-radius: 999px;
    border: 1px solid var(--line); background: var(--card); cursor: pointer; font-size: 13px; user-select: none;
  }
  .chip .dot { width: 9px; height: 9px; border-radius: 50%; }
  .chip.off { opacity: 0.38; }
  .chip .err { color: #d33; font-weight: 600; }
  h2.section {
    font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted);
    margin: 26px 0 8px; display: flex; align-items: center; gap: 8px;
  }
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
    <span class="meta" id="meta"></span>
    <button class="refresh" id="refresh">↻ Refresh</button>
  </header>
  <div class="chips" id="chips"></div>
  <div id="banners"></div>
  <div id="content"><div class="loading">Loading your four inboxes…</div></div>
</div>
<script>
const state = { data: null, hidden: new Set() };

function timeAgo(ms) {
  if (!ms) return "";
  const d = new Date(ms), now = Date.now(), diff = now - ms;
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

function render() {
  renderChips();
  renderBanners();
  const content = document.getElementById("content");
  content.replaceChildren();
  const visible = state.data.emails.filter((m) => !state.hidden.has(m.account));
  const priority = visible.filter((m) => m.score >= 35);
  const rest = visible.filter((m) => m.score < 35);

  const sec1 = el("h2", "section", "🔥 Priority (" + priority.length + ")");
  const list1 = el("div", "rows");
  priority.length
    ? priority.forEach((m) => list1.append(buildRow(m)))
    : list1.append(el("div", "empty", "Nothing marked important right now. 🎉"));

  const sec2 = el("h2", "section", "Everything else (" + rest.length + ")");
  const list2 = el("div", "rows");
  rest.length
    ? rest.forEach((m) => list2.append(buildRow(m)))
    : list2.append(el("div", "empty", "Empty."));

  content.append(sec1, list1, sec2, list2);
  document.getElementById("meta").textContent =
    "updated " + new Date(state.data.fetchedAt).toLocaleTimeString();
}

async function load(fresh) {
  const content = document.getElementById("content");
  if (!state.data) content.replaceChildren(el("div", "loading", "Loading your four inboxes…"));
  const res = await fetch("/api/emails" + (fresh ? "?fresh=1" : ""));
  state.data = await res.json();
  render();
}

document.getElementById("refresh").onclick = () => load(true);
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
      const data = await getAllEmails(url.searchParams.get("fresh") === "1");
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
  console.log("");
  console.log("  📬 Email dashboard running!");
  console.log(`  Open:  http://localhost:${PORT}`);
  console.log("");
  console.log("  (Keep this window open while using it. Press Ctrl+C to stop.)");
});
