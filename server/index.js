import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  ROOT,
  HERMES_CONFIG,
  BOTS_FILE,
  ensureDirs,
  loadBots,
  saveBots,
  loadSettings,
  saveSettings,
  readJson,
  ALERTS_FILE,
  log
} from './config.js'
import { Poller } from './poller.js'
import { McpClient } from './mcp.js'
import { sendTelegram, formatAlert, recordAlert } from './alerts.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '1mb' }))

ensureDirs()
let bots = loadBots()
let settings = loadSettings()
const port = Number(process.env.MT5PANEL_PORT || settings.httpPort || 8790)

const sseClients = new Set()
function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`
  for (const res of sseClients) {
    try {
      res.write(data)
    } catch {
      sseClients.delete(res)
    }
  }
}

const poller = new Poller({ bots, settings, onUpdate: (s) => broadcast(s) })

function botByName(name) {
  return bots.find((b) => b.name === name)
}

function publicBot(b) {
  const { token, ...rest } = b
  return { ...rest, hasToken: !!token, tokenHint: token ? `${token.slice(0, 6)}…${token.slice(-4)}` : '' }
}

const OPEN_PS1 = path.join(here, 'open-terminal.ps1')

// Focus the MT5 window for one bot, or start it when it is not running.
// Resolves to 'focused' | 'running' | 'launched'.
function openTerminal(exe, dir) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OPEN_PS1, '-Exe', exe, '-Dir', dir],
      { timeout: 20000, windowsHide: true },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim()
        if (err) return reject(new Error(String(stderr || err.message || 'powershell failed').trim()))
        resolve(out || 'launched')
      }
    )
  })
}

// --- state -----------------------------------------------------------------
app.get('/api/state', (req, res) => {
  const state = poller.state()
  state.bots = state.bots.map(publicBot)
  state.alerts = readAlerts(40)
  res.json(state)
})

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.write('retry: 3000\n\n')
  const state = poller.state()
  state.bots = state.bots.map(publicBot)
  state.alerts = readAlerts(40)
  res.write(`data: ${JSON.stringify(state)}\n\n`)
  sseClients.add(res)
  req.on('close', () => sseClients.delete(res))
})

app.get('/api/alerts', (req, res) => {
  res.json(readAlerts(Number(req.query.limit) || 100))
})

function readAlerts(limit) {
  try {
    const lines = fs.readFileSync(ALERTS_FILE, 'utf8').trim().split('\n').filter(Boolean)
    return lines.slice(-limit).reverse().map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    }).filter(Boolean)
  } catch {
    return []
  }
}

// --- bots ------------------------------------------------------------------
app.post('/api/bots', (req, res) => {
  const { name, port, label, token, warnRungs, criticalRungs } = req.body || {}
  if (!name || !port) return res.status(400).json({ error: 'name and port required' })
  if (botByName(name)) return res.status(409).json({ error: 'bot exists' })
  bots.push({
    name,
    port: Number(port),
    label: label || '',
    token: token || '',
    enabled: true,
    warnRungs: warnRungs ?? null,
    criticalRungs: criticalRungs ?? null
  })
  saveBots(bots)
  poller.update(bots)
  res.json({ ok: true })
})

app.patch('/api/bots/:name', (req, res) => {
  const bot = botByName(req.params.name)
  if (!bot) return res.status(404).json({ error: 'not found' })
  const allowed = ['label', 'port', 'token', 'enabled', 'warnRungs', 'criticalRungs', 'url', 'install']
  for (const k of allowed) {
    if (k in req.body) bot[k] = req.body[k]
  }
  if (req.body.port) bot.port = Number(req.body.port)
  saveBots(bots)
  poller.update(bots)
  res.json({ ok: true, bot: publicBot(bot) })
})

app.delete('/api/bots/:name', (req, res) => {
  const i = bots.findIndex((b) => b.name === req.params.name)
  if (i < 0) return res.status(404).json({ error: 'not found' })
  bots.splice(i, 1)
  saveBots(bots)
  poller.update(bots)
  res.json({ ok: true })
})

app.post('/api/bots/:name/test', async (req, res) => {
  const bot = botByName(req.params.name)
  if (!bot) return res.status(404).json({ error: 'not found' })
  const token = (req.body?.token || bot.token || '').trim()
  const url = bot.url || `http://127.0.0.1:${bot.port}/mcp`
  const started = Date.now()
  try {
    const client = new McpClient({ url, token, timeoutMs: 8000 })
    const init = await client.connect()
    const tools = await client.listTools()
    res.json({
      ok: true,
      ms: Date.now() - started,
      server: init?.serverInfo || null,
      toolCount: tools.length,
      tools: tools.map((t) => t.name)
    })
  } catch (e) {
    res.json({
      ok: false,
      ms: Date.now() - started,
      status: e.status || null,
      error: e.message,
      url,
      hasToken: !!token
    })
  }
})

// Open the terminal behind a card: focuses the running window, else starts it.
app.post('/api/bots/:name/open', async (req, res) => {
  const bot = botByName(req.params.name)
  if (!bot) return res.status(404).json({ error: 'not found' })
  const install = String(bot.install || '').trim()
  if (!install) return res.status(400).json({ error: 'no install path for this bot' })
  const exe = path.join(install, 'terminal64.exe')
  if (!fs.existsSync(exe)) return res.status(400).json({ error: `terminal64.exe not found at ${exe}` })
  try {
    const action = await openTerminal(exe, install)
    log(`open ${bot.name}: ${action} (${exe})`)
    res.json({ ok: true, action, exe })
  } catch (e) {
    log(`open ${bot.name} failed: ${e.message}`)
    res.status(500).json({ error: e.message, exe })
  }
})

// --- settings --------------------------------------------------------------
app.get('/api/settings', (req, res) => {
  const { telegramToken, ...rest } = settings
  res.json({ ...rest, hasTelegramToken: !!telegramToken })
})

app.patch('/api/settings', (req, res) => {
  const allowed = [
    'pollSeconds',
    'warnRungs',
    'criticalRungs',
    'repeatAlertMinutes',
    'offlineRepeatMinutes',
    'escalationStep',
    'magic',
    'agentProject',
    'agentBot',
    'metaEditorUrl',
    'metaEditorToken',
    'telegramEnabled',
    'telegramChatId',
    'telegramTokenFromHermes',
    'telegramToken',
    'alertOnStartup',
    'httpPort'
  ]
  for (const k of allowed) {
    if (k in req.body) settings[k] = req.body[k]
  }
  settings.pollSeconds = Math.max(3, Number(settings.pollSeconds) || 15)
  saveSettings(settings)
  poller.update(bots, settings)
  res.json({ ok: true, settings: { ...settings, telegramToken: undefined } })
})

app.post('/api/test-alert', async (req, res) => {
  const bot = poller.state().bots[0] || {
    name: 'test',
    label: 'TEST',
    rungs: 15,
    positions: [],
    account: { balance: 0, equity: 0 },
    url: ''
  }
  const text = formatAlert('test', bot, { critical: settings.criticalRungs, maxRungs: 34, reason: 'manual test from panel' })
  const result = await sendTelegram(text, settings)
  recordAlert({
    ts: new Date().toISOString(),
    kind: 'test',
    bot: 'panel',
    label: 'manual',
    delivered: !!result.sent,
    reason: result.sent ? null : result.reason,
    text
  })
  res.json(result)
})

// --- agent config (Claude Code / Codex snippets) ----------------------------
// Renders the project-local MCP config for one terminal. Contains the API key,
// like everything else here: 127.0.0.1 only, no auth, do not expose the port.
app.get('/api/agent-config', (req, res) => {
  const wanted = String(req.query.bot || '')
  const bot =
    (wanted && botByName(wanted)) ||
    bots.find((b) => b.name === 'mt5_5') ||
    bots.find((b) => b.token) ||
    bots[0]
  if (!bot) return res.status(404).json({ error: 'no bots configured' })
  const url = bot.url || `http://127.0.0.1:${bot.port}/mcp`
  const token = bot.token || ''
  const meUrl = String(settings.metaEditorUrl || '').trim()
  const meToken = String(settings.metaEditorToken || '').trim()

  const servers = {}
  if (meUrl) {
    servers.metaeditor = {
      type: 'http',
      url: meUrl,
      headers: { Authorization: `Bearer ${meToken}` }
    }
  }
  servers.terminal = {
    type: 'http',
    url,
    headers: { Authorization: `Bearer ${token}` }
  }
  const mcpJson = JSON.stringify({ mcpServers: servers }, null, 2)

  const blocks = []
  if (meUrl) {
    blocks.push(
      ['[mcp_servers.metaeditor]', `url = "${meUrl}"`, 'enabled = true', `http_headers = { "Authorization" = "Bearer ${meToken}" }`].join('\n')
    )
  }
  blocks.push(
    ['[mcp_servers.terminal]', `url = "${url}"`, 'enabled = true', `http_headers = { "Authorization" = "Bearer ${token}" }`].join('\n')
  )
  const codexToml = blocks.join('\n\n') + '\n'

  res.json({
    name: bot.name,
    label: bot.label || '',
    port: bot.port,
    url,
    tokenSet: !!token,
    metaEditor: meUrl ? { url: meUrl, tokenSet: !!meToken } : null,
    project: settings.agentProject || '',
    mcpJson,
    codexToml
  })
})

// --- hermes key import -----------------------------------------------------
app.post('/api/import-hermes', (req, res) => {
  try {
    const yaml = fs.readFileSync(HERMES_CONFIG, 'utf8')
    let imported = 0
    for (const bot of bots) {
      const re = new RegExp(`^\\s{2}${bot.name}:\\s*$\\n((?:\\s{4}.*\\n)+)`, 'm')
      const m = yaml.match(re)
      if (!m) continue
      const auth = m[1].match(/Authorization:\s*Bearer\s+([^\s"']+)/i)
      if (auth) {
        bot.token = auth[1].replace(/["']/g, '')
        imported++
      }
    }
    saveBots(bots)
    poller.update(bots)
    res.json({ ok: true, imported })
  } catch (e) {
    res.status(500).json({ error: e.message, hint: 'config.yaml not found at ' + HERMES_CONFIG })
  }
})

// --- key ring --------------------------------------------------------------
// POST /api/keyring/resolve: for every bot, try each key from data/keyring.json
// until one authenticates, then pin it. Removes the "which key belongs to which
// terminal" guesswork after ports are assigned.
app.post('/api/keyring/resolve', async (req, res) => {
  const ringPath = path.join(path.dirname(BOTS_FILE), 'keyring.json')
  let keys = []
  try {
    const raw = JSON.parse(fs.readFileSync(ringPath, 'utf8'))
    keys = Array.isArray(raw) ? raw : raw.keys || []
  } catch {
    return res.status(400).json({ error: 'keyring.json missing', path: ringPath })
  }
  keys = [...new Set(keys.map((k) => String(k).trim()).filter(Boolean))]
  const results = {}
  for (const bot of bots) {
    const url = bot.url || `http://127.0.0.1:${bot.port}/mcp`
    if (bot.token) {
      try {
        await new McpClient({ url, token: bot.token, timeoutMs: 4000 }).connect()
        results[bot.name] = { ok: true, pinned: false, hint: 'existing key works' }
        continue
      } catch {
        /* fall through to ring */
      }
    }
    let matched = null
    for (const key of keys) {
      try {
        await new McpClient({ url, token: key, timeoutMs: 4000 }).connect()
        matched = key
        break
      } catch {
        /* next key */
      }
    }
    if (matched) {
      bot.token = matched
      bot.keySource = 'keyring'
      results[bot.name] = { ok: true, pinned: true, keyHint: `${matched.slice(0, 6)}…` }
    } else {
      results[bot.name] = { ok: false, hint: 'no key in the ring works' }
    }
  }
  saveBots(bots)
  poller.update(bots)
  res.json({ ok: true, resolved: Object.values(results).filter((r) => r.ok).length, results })
})

// --- static ----------------------------------------------------------------
const dist = path.join(ROOT, 'web', 'dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next()
    res.sendFile(path.join(dist, 'index.html'))
  })
} else {
  app.get('/', (req, res) =>
    res
      .status(200)
      .type('html')
      .send('<pre>UI not built yet.\n\nRun: npm run build\n\nAPI is live at /api/state</pre>')
  )
}

app.listen(port, '127.0.0.1', () => {
  log(`panel listening on http://127.0.0.1:${port} · ${bots.length} bots · poll ${settings.pollSeconds}s`)
  poller.start()
})

process.on('SIGINT', () => {
  poller.stop()
  process.exit(0)
})

// Keep the panel alive on a bad request path; log instead of dying.
process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e?.stack || e}`))
process.on('uncaughtException', (e) => log(`uncaught exception: ${e?.stack || e}`))
