import {
  McpClient,
  unwrapToolResult,
  normalizeAccount,
  normalizePosition,
  deepFindArray,
  pick,
  num
} from './mcp.js'
import { evaluateAlerts, dispatch } from './alerts.js'
import { STATE_FILE, readJson, writeJson, log } from './config.js'

const ACCOUNT_TOOLS = [
  'get_trading_account_info',
  'get_account_info',
  'trading_account_info',
  'account_info'
]
const POSITION_TOOLS = [
  'get_trading_open_positions',
  'get_open_positions',
  'open_positions',
  'positions'
]

// XauSniper martingale ladder. A "rung" is not a position count: a single
// 0.13-lot entry sits on rung 4. Depth = max(positions on that side, highest
// ladder tier present on that side), same rule as the Python monitor.
const LADDER = [
  0.05, 0.08, 0.1, 0.13, 0.17, 0.22, 0.37, 0.62, 1.05, 1.1,
  2.05, 2.5, 3.5, 3.9, 4.5, 4.9, 5.5, 5.9, 6.5, 6.9,
  7.5, 7.9, 8.5, 8.9, 9.5, 9.9, 10.5, 10.9, 11.5, 12.5,
  12.9, 13.5, 13.9, 14.5
]

function ladderIndex(volume) {
  const v = Math.round((Number(volume) || 0) * 100) / 100
  const i = LADDER.findIndex((x) => Math.abs(x - v) < 0.001)
  return i + 1
}

function sideDepth(list) {
  let depth = list.length
  for (const p of list) depth = Math.max(depth, ladderIndex(p.volume))
  return depth
}

async function callFirst(client, names, args) {
  let lastErr = null
  for (const name of names) {
    try {
      return await client.callTool(name, args ?? {})
    } catch (e) {
      lastErr = e
      if (e.status === 401) throw e
      // Only a missing tool justifies trying the next alias; a real error from
      // an existing tool must surface instead of being masked by the last alias.
      if (!/not found|unknown tool|method not found/i.test(e.message || '')) throw e
    }
  }
  if (lastErr) throw lastErr
  return null
}

export class Poller {
  constructor({ bots, settings, onUpdate }) {
    this.bots = bots
    this.settings = settings
    this.onUpdate = onUpdate
    this.snapshots = new Map()
    this.clients = new Map()
    this.previous = readJson(STATE_FILE, {})
    this.timer = null
    this.running = false
    this.lastRun = null
  }

  clientFor(bot) {
    const key = `${bot.name}|${bot.port}|${bot.token || ''}`
    let entry = this.clients.get(key)
    if (!entry) {
      entry = {
        client: new McpClient({
          url: bot.url || `http://127.0.0.1:${bot.port}/mcp`,
          token: bot.token,
          timeoutMs: this.settings.timeoutMs || 8000
        }),
        ready: false
      }
      this.clients.set(key, entry)
    }
    return entry
  }

  async pollOne(bot) {
    const started = Date.now()
    if (!bot.enabled) {
      return { ...bot, status: 'disabled', lastError: null, positions: [], rungs: 0 }
    }
    const token = (bot.token || '').trim()
    if (!token) {
      return {
        ...bot,
        status: 'nokey',
        lastError: 'no API key — open Tools → Options → MCP in the terminal and paste the key',
        positions: [],
        rungs: 0,
        account: null
      }
    }
    const { client, ready } = this.clientFor(bot)
    try {
      if (!ready) {
        await client.connect()
        this.clients.set(`${bot.name}|${bot.port}|${bot.token || ''}`, { client, ready: true })
      }

      const accountRaw = await callFirst(client, ACCOUNT_TOOLS)
      const positionsRaw = await callFirst(client, POSITION_TOOLS)
      const account = normalizeAccount(unwrapToolResult(accountRaw))

      const list =
        deepFindArray(positionsRaw, [
          'positions',
          'open_positions',
          'openpositions',
          'data',
          'items',
          'result'
        ]) || (Array.isArray(positionsRaw) ? positionsRaw : [])
      const all = list.map(normalizePosition).filter(Boolean)
      const magic = String(bot.magic ?? this.settings.magic ?? '202401').trim()
      const positions = magic ? all.filter((p) => String(p.magic ?? '') === magic) : all
      const buysArr = positions.filter((p) => p.side === 'buy')
      const sellsArr = positions.filter((p) => p.side === 'sell')
      const buyRungs = sideDepth(buysArr)
      const sellRungs = sideDepth(sellsArr)
      const rungs = Math.max(buyRungs, sellRungs)
      const side =
        buyRungs > sellRungs ? 'BUY' : sellRungs > buyRungs ? 'SELL' : positions.length ? 'HEDGED' : 'FLAT'
      const floating = positions.reduce((s, p) => s + (p.profit || 0), 0)
      const volume = positions.reduce((s, p) => s + (p.volume || 0), 0)

      return {
        ...bot,
        status: 'live',
        lastError: null,
        account,
        positions,
        rungs,
        buyRungs,
        sellRungs,
        side,
        manualPositions: all.length - positions.length,
        floating,
        volume,
        buys: buysArr.length,
        sells: sellsArr.length,
        latencyMs: Date.now() - started,
        lastOk: new Date().toISOString()
      }
    } catch (e) {
      const auth = e.status === 401 || e.status === 403
      return {
        ...bot,
        status: auth ? 'auth' : 'offline',
        lastError: auth ? 'HTTP 401 — key rejected by this terminal' : e.message,
        positions: this.snapshots.get(bot.name)?.positions || [],
        rungs: this.snapshots.get(bot.name)?.rungs ?? 0,
        account: this.snapshots.get(bot.name)?.account || null,
        latencyMs: Date.now() - started
      }
    }
  }

  async pollAll() {
    if (this.running) return
    this.running = true
    try {
      const results = await Promise.all(this.bots.map((b) => this.pollOne(b)))
      const events = []
      for (const bot of results) {
        this.snapshots.set(bot.name, bot)
        const prev = this.previous[bot.name]
        const { state, events: evs } = evaluateAlerts(bot, prev, this.settings)
        this.previous[bot.name] = state
        for (const ev of evs) {
          events.push({ ev, bot })
        }
      }
      writeJson(STATE_FILE, this.previous)
      for (const { ev, bot } of events) {
        const extra = { critical: this.settings.criticalRungs, maxRungs: 34 }
        if (ev.reason && ev.kind !== 'offline') extra.reason = ev.reason
        if (ev.kind === 'offline') extra.reason = bot.lastError || 'unreachable'
        if (this.settings.alertOnStartup || ev.kind !== 'online') {
          await dispatch(ev, bot, this.settings, extra)
        }
      }
      this.lastRun = new Date().toISOString()
      this.onUpdate?.(this.state())
    } finally {
      this.running = false
    }
  }

  state() {
    const bots = this.bots.map((b) => this.snapshots.get(b.name) || { ...b, status: 'pending', positions: [], rungs: 0 })
    const live = bots.filter((b) => b.status === 'live')
    const totals = {
      bots: bots.length,
      live: live.length,
      rungs: live.reduce((s, b) => s + (b.rungs || 0), 0),
      floating: live.reduce((s, b) => s + (b.floating || 0), 0),
      equity: live.reduce((s, b) => s + (b.account?.equity || 0), 0),
      balance: live.reduce((s, b) => s + (b.account?.balance || 0), 0)
    }
    return {
      ts: new Date().toISOString(),
      settings: this.settings,
      totals,
      bots
    }
  }

  start() {
    this.stop()
    const ms = Math.max(3, this.settings.pollSeconds) * 1000
    this.pollAll()
    this.timer = setInterval(() => this.pollAll().catch((e) => log(`poll error ${e.message}`)), ms)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  update(bots, settings) {
    if (bots) this.bots = bots
    if (settings) this.settings = settings
    this.start()
  }
}
