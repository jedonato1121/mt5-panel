// Minimal MCP client for MetaTrader 5 terminals (streamable HTTP transport).
// Speaks JSON-RPC 2.0 over POST /mcp, handles both JSON and SSE responses,
// keeps the Mcp-Session-Id returned by initialize.

const PROTOCOL = '2025-06-18'

function parseSse(text) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      out.push(JSON.parse(payload))
    } catch {
      /* ignore keep-alives */
    }
  }
  return out
}

export class McpClient {
  constructor({ url, token, timeoutMs = 8000 }) {
    this.url = url
    this.token = token || ''
    this.timeoutMs = timeoutMs
    this.sessionId = null
    this.nextId = 1
  }

  headers() {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL
    }
    if (this.token) h.Authorization = `Bearer ${this.token}`
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId
    return h
  }

  async post(body) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: ac.signal
      })
      const sid = res.headers.get('mcp-session-id')
      if (sid) this.sessionId = sid
      const ctype = res.headers.get('content-type') || ''
      const text = await res.text()
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`)
        err.status = res.status
        err.body = text.slice(0, 400)
        throw err
      }
      if (ctype.includes('text/event-stream')) return parseSse(text)
      if (!text) return []
      try {
        return [JSON.parse(text)]
      } catch {
        return parseSse(text)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async rpc(method, params, { notify = false } = {}) {
    const body = { jsonrpc: '2.0', method }
    if (params !== undefined) body.params = params
    if (!notify) body.id = this.nextId++
    const messages = await this.post(body)
    if (notify) return null
    const reply = messages.find((m) => m && m.id === body.id) || messages[0]
    if (!reply) throw new Error('empty MCP response')
    if (reply.error) throw new Error(reply.error.message || JSON.stringify(reply.error))
    return reply.result
  }

  async connect() {
    const result = await this.rpc('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'mt5-panel', version: '1.0.0' }
    })
    await this.rpc('notifications/initialized', undefined, { notify: true }).catch(() => {})
    this.serverInfo = result?.serverInfo || null
    return result
  }

  async listTools() {
    const result = await this.rpc('tools/list', {})
    return result?.tools || []
  }

  async callTool(name, args = {}) {
    const result = await this.rpc('tools/call', { name, arguments: args })
    return unwrapToolResult(result)
  }
}

export function unwrapToolResult(result) {
  if (!result) return null
  if (result.structuredContent && Object.keys(result.structuredContent).length) {
    return result.structuredContent
  }
  const parts = Array.isArray(result.content) ? result.content : []
  const texts = parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text)
  if (texts.length === 1) {
    const raw = texts[0]
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  if (texts.length > 1) {
    const parsed = texts.map((t) => {
      try {
        return JSON.parse(t)
      } catch {
        return t
      }
    })
    return parsed
  }
  return result
}

// --- tolerant field pickers -------------------------------------------------

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

export function pick(obj, names, fallback = undefined) {
  if (!obj || typeof obj !== 'object') return fallback
  const wanted = new Set(names.map(norm))
  for (const [k, v] of Object.entries(obj)) {
    if (wanted.has(norm(k)) && v !== null && v !== undefined && v !== '') return v
  }
  return fallback
}

export function deepFindArray(obj, names, depth = 0) {
  if (!obj || depth > 4) return null
  if (Array.isArray(obj)) return obj.some((v) => v && typeof v === 'object') ? obj : null
  const wanted = new Set(names.map(norm))
  for (const [k, v] of Object.entries(obj)) {
    if (wanted.has(norm(k)) && Array.isArray(v)) return v
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const hit = deepFindArray(v, names, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

export function num(v, fallback = null) {
  if (v === null || v === undefined || v === '') return fallback
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[\s,]/g, ''))
  return Number.isFinite(n) ? n : fallback
}

const SIDE_BUY = new Set(['buy', 'long', '0', 'positionbuy', 'dealbuy'])
const SIDE_SELL = new Set(['sell', 'short', '1', 'positionsell', 'dealsell'])

export function normalizePosition(p) {
  if (!p || typeof p !== 'object') return null
  const sideRaw = pick(p, ['type', 'side', 'direction', 'action', 'order_type', 'deal_type'], '')
  const sideStr = norm(sideRaw)
  let side = 'buy'
  if (SIDE_SELL.has(sideStr)) side = 'sell'
  else if (SIDE_BUY.has(sideStr)) side = 'buy'
  else if (typeof sideRaw === 'number') side = sideRaw === 1 ? 'sell' : 'buy'

  const volume = num(pick(p, ['volume', 'lots', 'lot', 'size', 'contract_size']), 0)
  const open = num(pick(p, ['price_open', 'open_price', 'priceopen', 'entry', 'openprice']), null)
  const current = num(pick(p, ['price_current', 'current_price', 'pricecurrent', 'price_last', 'last', 'market_price']), null)
  const profit = num(pick(p, ['profit', 'pnl', 'pl', 'floating', 'unrealized_profit']), 0)

  return {
    ticket: String(pick(p, ['ticket', 'order', 'id', 'position_id', 'deal'], '') || ''),
    symbol: String(pick(p, ['symbol', 'instrument', 'pair'], '') || ''),
    side,
    volume,
    open,
    current,
    profit,
    sl: num(pick(p, ['sl', 'stop_loss', 'stoploss']), null),
    tp: num(pick(p, ['tp', 'take_profit', 'takeprofit']), null),
    comment: String(pick(p, ['comment', 'note'], '') || ''),
    magic: num(pick(p, ['magic', 'expert_id', 'magic_number']), null),
    time: pick(p, ['time', 'open_time', 'opentime', 'create_time', 'created_at', 'setup_time'], null)
  }
}

export function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return null
  const src = raw.account && typeof raw.account === 'object' ? raw.account : raw
  const margin = num(pick(src, ['margin', 'margin_used', 'used_margin']), null)
  const equity = num(pick(src, ['equity']), null)
  let marginLevel = num(pick(src, ['margin_level', 'marginlevel', 'margin_level_percent']), null)
  // MT5's MCP payload omits margin_level; derive it the way the terminal does.
  if (marginLevel === null && margin !== null && margin > 0 && equity !== null) {
    marginLevel = (equity / margin) * 100
  }
  return {
    login: String(pick(src, ['login', 'account', 'account_number', 'accountnumber', 'number'], '') || ''),
    name: String(pick(src, ['name', 'owner', 'account_name', 'client'], '') || ''),
    server: String(pick(src, ['server', 'broker', 'company', 'trade_server'], '') || ''),
    currency: String(pick(src, ['currency', 'deposit_currency', 'account_currency'], 'USD') || 'USD'),
    balance: num(pick(src, ['balance']), null),
    equity,
    margin,
    marginFree: num(pick(src, ['margin_free', 'freemargin', 'free_margin']), null),
    marginLevel,
    floating: num(pick(src, ['profit', 'floating', 'equity_profit', 'open_profit']), null),
    leverage: num(pick(src, ['leverage']), null),
    tradeAllowed: pick(src, ['trade_allowed', 'tradeallowed', 'trading_allowed'], null)
  }
}
