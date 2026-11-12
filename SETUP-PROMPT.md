# Prompt for Hermes — replicate this MT5 panel on another Windows PC

Copy everything below the line into Hermes on the target machine. Fill the two
`<...>` values first (or let Hermes discover them). It assumes the target has
MetaTrader 5 terminals installed and Hermes already configured with a Telegram
bot, like this machine.

---

You are setting up a multi-terminal MetaTrader 5 monitoring panel on this Windows
PC. Work through the steps in order, verify each one with real output, and do not
claim a step is done without a readback. Ask before restarting any trading
terminal.

## What you are building

A Node.js (Express) server that polls each MT5 terminal's MCP endpoint every 15 s,
plus a Vue 3 single-page UI served at http://127.0.0.1:8787, plus Telegram alerts.
Each terminal is an independent MT5 install with its own data folder and its own
MCP port. The panel shows every account's equity, margin level, rung count and
open positions on one page and alerts on warn/critical/escalation/recovery/
offline/margin/negative-equity.

## 0. Prerequisites to confirm before touching anything

```bash
node --version      # need 20+
npm --version
hermes --version    # for the Telegram token + gateway
powershell -NoProfile -Command "Get-Process terminal64 | Select Id,MainWindowTitle,Path"
```

- If Node is missing, install the LTS build and reopen the shell.
- Record the terminals: the `MainWindowTitle` starts with the account login, and
  `Path` gives the install folder (e.g. `C:\mt5 - 1\terminal64.exe`).
- The real MT5 data folder is NOT the install folder. It is
  `%APPDATA%\MetaQuotes\Terminal\<32-hex>\`, and `origin.txt` inside it (UTF-16)
  contains the install path. Resolve it programmatically, never guess the hex.

## 1. Install the panel

```bash
cd C:\Users\<you>
# unzip the package so you get C:\Users\<you>\mt5-panel
cd mt5-panel
npm install --no-audit --no-fund
npm run build
```

`npm run build` must print a `web/dist` bundle. If it fails, stop and fix that
before continuing.

## 2. Configure the bots

`data/bots.json` is the source of truth. One entry per terminal:

```json
{ "name": "mt5_1", "port": 22346, "label": "34306890",
  "install": "C:\\mt5 - 1", "token": "", "enabled": true }
```

Rules:

- `name` — short id, `mt5_1` … `mt5_N`, used everywhere else.
- `port` — one unique port per terminal starting at 22346. Skip 22345: that
  belongs to MetaEditor. Never assign the same port twice.
- `label` — the account login (from the window title). It is what you will read
  in the UI and in Telegram alerts.
- `install` — the folder containing that terminal's `terminal64.exe`.
- `token` — leave empty for now; step 4 fills it.
- `settings.json` — set `httpPort` (8787 default), `warnRungs` (10),
  `criticalRungs` (15), and `telegramChatId` (the numeric chat id, see step 5).

## 3. Give every terminal its own MCP port

MCP config lives in the **instance** folder, not the install folder:
`%APPDATA%\MetaQuotes\Terminal\<hex>\config\assistant.ini`. It is UTF-16LE with a
BOM and CRLF. Section `[MCP.MetaTrader]` holds `Enable=1`,
`Endpoint=http://127.0.0.1:<port>/mcp`, `ApiKey=...`.

```bash
node scripts/apply-ports.js                 # dry run: current -> target per bot
node scripts/apply-ports.js --write          # rewrite assistant.ini files
node scripts/apply-ports.js --write --restart # apply and relaunch, one at a time
```

The listener binds only at process start, so a restart is part of the change.
**Ask the user before restarting live terminals.** Never `Stop-Process -Force`
directly: MT5 only writes its chart profile on a clean exit, and a killed
terminal comes back without its EA. `restart-fleet.js` already closes windows
gracefully and falls back to a kill only if that fails.

If a terminal does come back without its EA: `list_open_charts` over MCP returns
`expert: {name, path, inputs}` when an EA is attached and omits the field when it
is not. Reattach with `chart_add_expert {chart_id, expert_path}`
(`node scripts/reattach-eas.js <bot>:<version>`), then compare the EA's own
`"... loaded. ladder=..."` log line with the pre-restart one. Do not invent EA
inputs — if they differ, stop and ask the user.

## 4. API keys

**The `ApiKey` that MT5 writes into `assistant.ini` is not accepted by the MCP
listener** — it returns HTTP 401. Do not spend time deriving it. The valid key is
shown per terminal in **Tools → Options → MCP** in the terminal UI, and each
terminal issues its own.

Two ways to load them:

- paste each one in the panel: Settings → Bots → api key → **Test** (it reports
  `connected · N tools · Xms`), or
- put all keys into `data/keyring.json` (`{"keys": ["...", "..."]}`) and run
  `curl -X POST http://127.0.0.1:8787/api/keyring/resolve` — it tries every key
  against every bot's port and pins the one that authenticates. Use this when the
  keys arrive as an unlabelled batch; paste order is not reliable.

## 5. Telegram

- The bot token belongs in Hermes: `%LOCALAPPDATA%\hermes\.env` as
  `TELEGRAM_BOT_TOKEN=...`. The panel reads that file at send time, so there is
  no second copy of the token.
- The chat id goes in `data/settings.json` as `telegramChatId`. The user must
  message the bot at least once (`/start`) before it can DM them.
- Verify: `POST http://127.0.0.1:8787/api/test-alert` must return
  `{"sent":true}`, and the message must arrive.
- Alert rules: warn at 10 rungs, critical at 15, escalation every +5 while
  critical, recovery when back below critical, plus offline / margin < 100 % /
  negative equity. De-duplication state lives in `data/state.json`; history with
  delivery results in `data/alerts.jsonl`.

## 6. Start it, and make it survive a reboot

```bash
start-panel.cmd        # or start-panel.vbs for no console window
```

Autostart is a per-user Startup shortcut, no admin needed: put a `.vbs` that runs
`cmd /c cd /d <project> && node server\index.js` into
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`. MT5 terminals are NOT
started automatically — `node scripts/start-fleet.js` launches any that are not
running and waits for their ports.

## 7. Verification — all of this must pass

```bash
node scripts/doctor.js
```

Expect: panel HTTP 200, Startup VBS present, Hermes_Gateway Ready, one PASS per
terminal with its login and equity, Telegram token + chat id present, data files
present. Then open http://127.0.0.1:8787 and confirm one live card per account,
and that clicking a card expands the position ladder.

## Hard rules

- Bind `127.0.0.1` only; the panel has no authentication and can reach the
  terminals' trade_* tools.
- Never commit or share `data/bots.json`, `data/keyring.json`, `data/settings.json`
  or Hermes `.env` — they contain live API keys and the Telegram token.
- One port per terminal; a second process on the same port silently loses the
  bind and its card shows offline.
- `auth failed` (401) and `offline` (unreachable) are different failures: the
  first is a wrong key, the second is a stopped terminal or a wrong port.
- Report numbers from real output (logins, ports, rung counts, tool counts), not
  "should be working".
