# 📬 Unified Email Dashboard

One local web page showing all four Gmail inboxes (personal, lastcrumb,
plushpay, lunalulu) merged together, sorted into three buckets:

- **🔥 Priority** — mail that actually needs Derek's attention
- **📥 Everything else** — legit but routine (receipts, confirmations, notices)
- **🗞 Promos & newsletters** — collapsed by default

**Read-only:** this app never sends, deletes, or modifies email.
**Local-only:** it runs entirely on your PC (bound to localhost). Email
metadata goes only to Google's Gmail API — and, if you enable AI triage,
sender/subject/snippet lines go to Anthropic's Claude API for scoring.

## Run it

First time (and after every update):

```powershell
npm install
npm start
```

Then open http://localhost:3777 — or just double-click `start-dashboard.bat`.

## How sorting works

**Layer 1 — always on, free:** bulk-mail detection. Mass mail (promos,
newsletters, notifications) carries fingerprint headers (`List-Unsubscribe`,
`Precedence: bulk`) that no human sender has. Bulk → Promos bucket; mail from
real people → Priority; Gmail's Updates category (receipts etc.) → Everything
else. Starred mail is always Priority.

**Layer 2 — optional, Claude AI triage:** Claude reads each email's sender,
subject, and snippet and judges whether Derek needs to see it (customers,
money, legal, deadlines → Priority; receipts → Everything else; anything
selling something → Promos). Verdicts are cached per message in
`~/.gmail-mcp/triage-cache.json`, so only new mail costs anything —
typically well under a cent per refresh.

### Enabling AI triage

1. Get an API key at https://console.anthropic.com (Settings → API Keys).
2. Save it (replace the placeholder with your real key):

   ```powershell
   "sk-ant-YOUR-KEY-HERE" | Set-Content "$env:USERPROFILE\.gmail-mcp\anthropic.key" -NoNewline
   ```

3. Restart the dashboard. The header badge shows "🤖 AI triage: on".

Default model is `claude-opus-4-8` (best judgment). To use the cheaper
`claude-haiku-4-5` (~5x less per token) instead:

```powershell
"claude-haiku-4-5" | Set-Content "$env:USERPROFILE\.gmail-mcp\anthropic.model" -NoNewline
```

Delete that file to go back to the default.

## Customize

- **Accounts:** edit the `ACCOUNTS` list at the top of `server.js`.
- **How many emails:** `MESSAGES_PER_ACCOUNT` (default 30 per account).
- **Port:** `PORT` (default 3777).
- **What "Priority" means:** edit `TRIAGE_SYSTEM` in `server.js` — it's
  plain-English instructions to the AI.

## Run it invisibly at startup (no PowerShell window)

`start-dashboard-hidden.vbs` launches the server with no window at all.

1. Press **Win + R**, type `shell:startup`, press Enter — a folder opens.
2. Right-click `start-dashboard-hidden.vbs` in the email-dashboard folder →
   **Show more options → Create shortcut**, and move that shortcut into the
   startup folder.

From then on the dashboard starts silently every time you log in — just
bookmark http://localhost:3777. To stop it manually: Task Manager → find
**Node.js** → End task.

## Accessing it from other devices

The server deliberately binds to localhost only — it holds OAuth tokens for
four mailboxes, so it must never be exposed to the public internet as-is.
To reach it from a phone/laptop, use a private mesh VPN like Tailscale
(free tier) and open `http://<pc-name>:3777` from any of your own devices —
traffic stays encrypted and invitation-only. Hosting it on a public website
would require adding real authentication first.

## Troubleshooting

- Account chip shows ⚠ with a token/grant error → that account's login
  expired. Re-run its auth command, then refresh.
- 🤖 banner about the AI key → the key in `~/.gmail-mcp/anthropic.key` is
  wrong or out of credit; sorting falls back to header-based automatically.
- Page won't load → make sure the server window is still open.
