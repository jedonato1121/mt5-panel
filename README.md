# MT5 Panel — Node + Vue single-panel monitor

Replaces the Python `mt5-monitor` (dashboard + `/manage`) with a Node.js server
and a Vue 3 frontend. One page shows every MetaTrader 5 terminal, its positions
(rungs), floating P/L, margin level, and the alert feed. Alerts go to Telegram
through the Hermes bot token.

```
browser ──SSE──► node server (Express) ──MCP/HTTP──► terminal 1..N
                        │
                        └── Telegram Bot API (alerts)
```

## Distribute to another PC

`mt5-panel-v1.0.0.zip` in this folder is a self-contained copy (source + built
`web/dist`, no `node_modules`, no secrets — only `data/*.example.json`).

On the target machine: unzip, `npm install`, `npm run build`, copy
`data/bots.example.json` → `data/bots.json` and edit it, then follow
**SETUP-PROMPT.md** (a ready-to-paste prompt for Hermes on that machine).

## Run

```bash
cd C:\Users\ADMIN\mt5-panel
npm install          # first time
npm run build        # builds web/dist (Vue)
npm start            # http://127.0.0.1:8787
```

After a reboot see **[RESTART-RUNBOOK.md](RESTART-RUNBOOK.md)** — three commands
(`start-fleet`, `doctor`, open the page) plus the full manual procedure.

Double-click `start-panel.cmd`, or use `start-panel.vbs` for no console window.
`MT5 Panel.vbs` in the user Startup folder starts it at logon (no admin needed).

## Configuration

Everything lives in `data/`:

| File | Purpose |
|---|---|
| `bots.json` | one entry per terminal: `name`, `port`, `label` (account), `install` path, `token`, thresholds |
| `settings.json` | poll interval, warn/critical rungs, repeats, Telegram chat id, HTTP port |
| `state.json` | alert de-duplication state (written by the server) |
| `alerts.jsonl` | alert history |
| `panel.log` | runtime log |

Per-bot keys: `token`. Optional overrides: `warnRungs`, `criticalRungs`,
`enabled`, `url` (defaults to `http://127.0.0.1:<port>/mcp`).

### Ports

Each terminal needs its own MCP port. `data/bots.json` assigns 22346–22355.

```bash
node scripts/apply-ports.js                    # dry run, shows current -> target
node scripts/apply-ports.js --write            # rewrite assistant.ini
node scripts/apply-ports.js --write --restart   # ... and relaunch each terminal
```

The MCP listener only binds at startup, so a restart is mandatory after a port
change. `--restart` stops `terminal64.exe` for that install path and starts it
again — EAs reattach, open positions stay on the server, but do it when you are
comfortable with a few seconds of downtime per terminal.

### API keys

MT5 writes a key into `<instance>\config\assistant.ini`, but that key is not the
one the MCP listener accepts (verified: every key from that file returns HTTP 401
against its own terminal). Use the key shown in **Tools → Options → MCP** of each
terminal:

- paste it in the panel: **Settings → Bots → api key → Test**
- or edit `data/bots.json` and restart the panel
- `node scripts/sync-keys.js` imports the assistant.ini values as a starting
  point; treat them as candidates until `Test` says `connected`

### Telegram

Alerts use `TELEGRAM_BOT_TOKEN` from `C:\Users\ADMIN\AppData\Local\hermes\.env`.
Only the chat id is needed: **Settings → Telegram chat id**. Message the bot once
so it is allowed to DM you, then press **Test alert**.

## Alerts

| Kind | Fires when |
|---|---|
| `warn` | rungs ≥ warn (default 10) |
| `critical` | rungs ≥ critical (default 15) |
| `escalation` | +5 rungs while still critical |
| `recovery` | back below critical |
| `offline` | terminal unreachable / 401 / no key (repeats every 30 min) |
| `online` | terminal reachable again |
| `margin` | margin level < 100 % |
| `negative` | equity < 0 |

Messages carry account, terminal, rungs/34, positions, buys/sells, lots,
floating, balance, equity, margin level, free margin and a timestamp. Delivery
state per alert is written to `alerts.jsonl` and shown in the panel feed.

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | full snapshot (bots, totals, alerts) |
| GET | `/api/stream` | SSE stream, pushes on every poll |
| GET | `/api/alerts?limit=` | alert history |
| POST | `/api/bots` | add bot |
| PATCH | `/api/bots/:name` | update label/port/token/thresholds/install |
| DELETE | `/api/bots/:name` | remove |
| POST | `/api/bots/:name/test` | connect, list tools |
| POST | `/api/bots/:name/open` | focus that bot's MT5 window, or start it if closed |
| PATCH | `/api/settings` | global settings |
| POST | `/api/test-alert` | send one test message |
| POST | `/api/import-hermes` | pull bearer tokens from Hermes `config.yaml` |

Binds `127.0.0.1` only, no authentication — never expose it.

## Demo / self-test

```bash
node tools/mock-mcp.js 22990 3 testtoken        # 3 fake MCP terminals
MT5PANEL_BOTS=data/bots.demo.json MT5PANEL_PORT=8790 node server/index.js
```

The mock speaks the same JSON-RPC (initialize, tools/list, tools/call,
`get_trading_account_info`, `get_trading_open_positions`) so the whole pipeline —
auth, polling, normalization, alerts, SSE, UI — can be exercised without MT5.

## Layout

```
server/index.js    HTTP + SSE + REST
server/mcp.js      MCP client and tolerant field normalizers
server/poller.js   poll loop, per-bot status
server/alerts.js   thresholds, de-dup, Telegram delivery
web/               Vue 3 app (Vite)
scripts/           apply-ports, sync-keys
tools/mock-mcp.js  mock terminals for testing
```
