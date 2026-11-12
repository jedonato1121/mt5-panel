# MT5 stack — restart & recovery runbook

Everything needed to bring this machine back to a fully working state after a
reboot, a crash, or a "something stopped working" moment.

Last verified: 2026-11-05 15:37 local, 10/10 terminals live.

---

## 0. What the thing is

```
browser ──HTTP/SSE──► node + Express (127.0.0.1:8787) ──MCP/HTTP──► terminal 1..10
                              │                                       :22346-22355
                              └──► Telegram Bot API (alerts) ──► chat <chat id>
```

- **UI is a Vue 3 single-page app** (built with Vite into `web/dist`), served by
  the Node/Express server on `http://127.0.0.1:8787`. `/api/*` and `/api/stream`
  are the Express JSON + SSE endpoints; the page itself is Vue with reactive
  components (`BotCard`, `AlertsPanel`, `SettingsModal`). No Vue dev server is
  needed in normal use — the built bundle is served statically.
- **Backend** polls every terminal's MCP endpoint every 15 s, normalizes account
  + positions, pushes snapshots over SSE, and evaluates alert thresholds.
- **Ten terminals**, each its own install folder and its own MCP port, each with
  its own API key. Only the terminal's own key works — the value MT5 writes to
  `assistant.ini` is rejected (HTTP 401).

| Bot | Install | Port | Account | EA |
|---|---|---|---|---|
| mt5_1 | C:\mt5 - 1 | 22346 | 34306890 | XAU_SNIPER_BOT |
| mt5_2 | C:\mt5 - 2 | 22347 | 33703655 | none (EA removed itself) |
| mt5_3 | C:\mt5 - 3 | 22348 | 33703664 | XauSniperTrail 1.29a |
| mt5_4 | C:\mt5 - 4 | 22349 | 34589951 | XauSniperTrail 1.29a |
| mt5_5 | C:\mt5 - 5 | 22350 | 36169228 | XauSniperTrail 1.29a |
| mt5_6 | C:\mt5 - 6 | 22351 | 36169230 | XauSniperTrail 1.29a |
| mt5_7 | C:\mt5 - 7 | 22352 | 36169231 | XauSniperTrail 1.29b |
| mt5_8 | C:\mt5 - 8 | 22353 | 36169889 | XauSniperTrail 1.29b |
| mt5_9 | C:\mt5 - 9 | 22354 | 36169891 | XauSniperTrail 1.29b |
| mt5_10 | C:\mt5 - 10 | 22355 | 36169892 | XauSniperTrail 1.29b |

---

## 1. After a reboot — the 3-minute version

The **panel** starts itself; the **terminals** do not.

```bash
cd C:\Users\ADMIN\mt5-panel

node scripts/start-fleet.js     # 1. launch every terminal, wait for its MCP port
node scripts/doctor.js          # 2. verify ports, keys, accounts, Telegram
```

Then open **http://127.0.0.1:8787**. If `doctor` ends with *all checks passed* and
ten `PASS` lines with account numbers, you are done.

If the panel itself is not running (the page does not open):

```bash
start-panel.cmd          # visible console
# or: double-click start-panel.vbs for a hidden window
```

Terminals log in to their saved accounts automatically. rungs/positions come back
from the broker; nothing needs to be re-entered.

---

## 2. What survives a reboot, and what does not

| Item | Survives? | Notes |
|---|---|---|
| `data/bots.json` (ports, labels, keys) | yes | on disk |
| `data/settings.json` (thresholds, chat id) | yes | on disk |
| `data/keyring.json` (all 10 keys) | yes | only used for re-mapping |
| MCP port per terminal (`assistant.ini`) | yes | read at terminal start |
| Panel autostart (`Startup\MT5 Panel.vbs`) | yes | per-user Startup folder |
| Hermes gateway (`Hermes_Gateway` task) | yes | scheduled task at logon |
| Alert history `data/alerts.jsonl` | yes | append-only |
| **The terminals themselves** | **no** | nothing launches them at logon |
| **EA attachment** | **only if the terminal closed cleanly** | MT5 writes the chart profile on normal exit; a force-kill loses the EA |
| Windows sleep/screen settings | usually | a *feature update* can reset them, a reboot does not |

If a terminal was killed (Task Manager, power loss, `Stop-Process -Force`), it can
come back with a plain chart and **no EA**. `doctor.js` will not catch that — it
only proves the account and MCP endpoint work. Check the chart's expert field:

```bash
node --input-type=module -e "
import {McpClient} from './server/mcp.js'
import fs from 'node:fs'
const b=JSON.parse(fs.readFileSync('data/bots.json','utf8')).servers.find(x=>x.name==='mt5_3')
const c=new McpClient({url:'http://127.0.0.1:'+b.port+'/mcp',token:b.token}); await c.connect()
const r=await c.callTool('list_open_charts',{})
console.log(r.charts[0].title, 'EA:', r.charts[0].expert?.name || 'NONE')
"
```

`EA: XauSniperTrail_v1.29a` = fine. `EA: NONE` = reattach it (M1 chart, same
inputs as before):

```bash
node scripts/reattach-eas.js mt5_3:1.29a mt5_7:1.29b
```

---

## 3. Manual, click-by-click recovery

Use this if you do not want to run the scripts.

1. **Start the terminals** — double-click each:
   `C:\mt5 - 1\terminal64.exe` … `C:\mt5 - 10\terminal64.exe`
2. **Wait for sync** — each window title shows the account when logged in
   (`34306890 - VantageMarkets-Live 11 - Hedge …`).
3. **Confirm ports** (PowerShell or git-bash):
   ```
   netstat -ano | findstr LISTENING | findstr 223
   ```
   Expect one line each for 22346–22355. A missing port means that terminal is
   not running, or its `assistant.ini` still points at someone else's port.
4. **Start the panel**: double-click `C:\Users\ADMIN\mt5-panel\start-panel.cmd`
5. **Open** http://127.0.0.1:8787 — ten cards, all `live`.
6. **Test the alert channel**: Settings → Test alert, or
   ```
   curl -X POST http://127.0.0.1:8787/api/test-alert
   ```
   Expect `{"sent":true}` and a message in Telegram.

---

## 4. Where everything lives

```
C:\Users\ADMIN\mt5-panel\
  server\index.js        HTTP + SSE + REST + keyring resolver
  server\mcp.js          MCP client and field normalizers
  server\poller.js       poll loop, per-bot status
  server\alerts.js       thresholds, de-dup, Telegram delivery
  web\                   Vue 3 source (Vite)
  web\dist\              built UI that Express serves  <- needs `npm run build`
  data\bots.json         port, label, install path, API key per bot
  data\settings.json     poll seconds, warn/critical, Telegram chat id, http port
  data\keyring.json      all API keys (re-mapping only)
  data\alerts.jsonl      alert history with delivery result
  data\state.json        alert de-dup state (safe to delete)
  data\panel.log         runtime log (also data\stdout.log for crashes)
  data\ini-backup-*      backups of every assistant.ini before port changes
  scripts\               start-fleet, restart-fleet, apply-ports, doctor,
                         reattach-eas, sync-keys
  start-panel.cmd        run the server in a console
  start-panel.vbs        run it hidden (used by Startup)
```

Terminal data folders (not in the install dir):
`C:\Users\ADMIN\AppData\Roaming\MetaQuotes\Terminal\<32-hex>\`
Each has `origin.txt` (which install it belongs to) and
`config\assistant.ini` (MCP enable + endpoint + key mirror).

Hermes: `C:\Users\ADMIN\AppData\Local\hermes\` — `.env` holds
`TELEGRAM_BOT_TOKEN`; the panel reads it at send time.

---

## 5. Common jobs

| Job | Command / place |
|---|---|
| Start all terminals | `node scripts/start-fleet.js` |
| Restart one terminal (graceful) | `node scripts/restart-fleet.js mt5_5` |
| Change warn/critical rungs | panel → Settings, or `data/settings.json` |
| Change Telegram chat id | panel → Settings → Telegram chat id |
| Add a terminal | add to `data/bots.json`, then `node scripts/apply-ports.js --write --restart` |
| Re-map keys after adding terminals | put keys in `data/keyring.json`, `curl -X POST http://127.0.0.1:8787/api/keyring/resolve` |
| Read alert history | `tail -20 data/alerts.jsonl` |
| Rebuild the UI after editing `web/` | `npm run build`, then restart the panel |
| Check everything | `node scripts/doctor.js` |

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Page does not open | panel not running / port taken | run `start-panel.cmd`, check `data/stdout.log`; change `httpPort` in settings.json if 8787 is busy |
| All cards `offline` | terminals not started | `node scripts/start-fleet.js` |
| One card `auth failed` | key rejected (401) for that terminal | re-copy it from Tools → Options → MCP, paste in Settings → Bots → Test |
| Card `no key` | `token` empty in bots.json | same as above |
| Card `offline` but the terminal is open | its MCP port is still 22346 (someone else's) | `node scripts/apply-ports.js` (dry run), then `--write --restart` |
| Two terminals fight over 22346 | copies inherited the same default port | above |
| Telegram silent, `delivered=false` in alerts.jsonl | chat id missing or bot never messaged | panel Settings → Telegram chat id (also `telegramChatId` in `data/settings.json`); press Start in the bot chat; `hermes send --to telegram "test"` |
| EA not running after a crash | chart profile not saved before the kill | `node scripts/reattach-eas.js <bot>:<version>` |
| Alert fires twice at the same level | older build (< 15:35) had a de-dup bug | fixed; restart the panel |
| `node` not found | PATH in a fresh shell | reopen the shell, or use the full path to node |

---

## 7. Rebuild from source (if `web/` changes)

```bash
cd C:\Users\ADMIN\mt5-panel
npm install          # only after package.json changes
npm run build        # writes web/dist
# restart the panel: close start-panel.cmd window, run it again
```

Server-only changes need just a panel restart; no rebuild.

---

## 8. Security notes

- The panel binds `127.0.0.1` only and has **no authentication**. Never expose
  8787 to the network; anyone who reaches it can also reach the trade_* MCP tools.
- API keys are stored in clear text in `data/bots.json` and `data/keyring.json`,
  and the Telegram token lives in `hermes\.env`. Treat those files as secrets;
  do not commit them or share the folder.
- Each terminal's key is per-terminal and can be rotated in Tools → Options → MCP
  (then update the panel key).
