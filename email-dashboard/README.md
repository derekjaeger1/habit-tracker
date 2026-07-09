# 📬 Unified Email Dashboard

One local web page showing all four Gmail inboxes (personal, lastcrumb,
plushpay, lunalulu) merged together, with important mail sorted to the top.

**Read-only:** this app never sends, deletes, or modifies email.
**Local-only:** it runs entirely on your PC (bound to localhost) and talks
only to Google's Gmail API using the login tokens already stored in
`~/.gmail-mcp` from the MCP setup. Nothing is uploaded anywhere.

## Run it

First time:

```powershell
npm install
npm start
```

Then open http://localhost:3777 — or just double-click `start-dashboard.bat`,
which starts the server and opens the page for you.

## How "Priority" works

Each message gets a score built mostly from Gmail's own importance signals
(the same machine learning behind Gmail's "Important" marker and Primary tab):

- ★ Starred: +100 · Gmail "Important": +50 · Primary/personal category: +25 · Unread: +10
- Promotions: −60 · Social: −40 · Updates/Forums: −20 · no-reply/newsletter senders: −15

Score ≥ 35 lands in **🔥 Priority**; everything else below. Tune the numbers
in `scoreMessage()` in `server.js`.

## Customize

- **Accounts:** edit the `ACCOUNTS` list at the top of `server.js`.
- **How many emails:** `MESSAGES_PER_ACCOUNT` (default 30 per account).
- **Port:** `PORT` (default 3777).

## Troubleshooting

- An account shows ⚠ with a token/grant error → that account's login expired.
  Re-run its auth command (see the setup conversation), then refresh.
- Page won't load → make sure the server window is still open.
