import fs from 'node:fs'
import { ALERTS_FILE, HERMES_ENV, log } from './config.js'

const fmt = (n, d = 2) =>
  n === null || n === undefined || Number.isNaN(n)
    ? '—'
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

export function readTelegramToken(settings) {
  if (!settings.telegramTokenFromHermes && settings.telegramToken) return settings.telegramToken.trim()
  try {
    const env = fs.readFileSync(HERMES_ENV, 'utf8')
    const m = env.match(/^\s*TELEGRAM_BOT_TOKEN\s*=\s*(.+)\s*$/m)
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, '')
  } catch {
    /* no hermes env */
  }
  return (settings.telegramToken || '').trim()
}

export async function sendTelegram(text, settings) {
  const token = readTelegramToken(settings)
  const chatId = (settings.telegramChatId || '').trim()
  if (!settings.telegramEnabled) return { sent: false, reason: 'alerts disabled' }
  if (!token) return { sent: false, reason: 'no TELEGRAM_BOT_TOKEN' }
  if (!chatId) return { sent: false, reason: 'no chat id configured' }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 12000)
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      }),
      signal: ac.signal
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.ok === false) {
      return { sent: false, reason: body.description || `HTTP ${res.status}` }
    }
    return { sent: true }
  } catch (e) {
    return { sent: false, reason: e.name === 'AbortError' ? 'timeout' : e.message }
  } finally {
    clearTimeout(timer)
  }
}

export function recordAlert(event) {
  try {
    fs.appendFileSync(ALERTS_FILE, JSON.stringify(event) + '\n')
  } catch {
    /* ignore */
  }
}

const HEADERS = {
  warn: '⚠️ <b>MT5 RUNG WARNING</b>',
  critical: '🚨 <b>MT5 RUNG ALERT — {critical}+ RUNGS</b>',
  escalation: '🚨 <b>MT5 RUNG ESCALATION</b>',
  recovery: '✅ <b>MT5 BASKET RECOVERED</b>',
  offline: '🔌 <b>MT5 BOT OFFLINE</b>',
  online: '🟢 <b>MT5 BOT BACK ONLINE</b>',
  margin: '⚠️ <b>MT5 MARGIN WARNING</b>',
  negative: '🚨 <b>MT5 NEGATIVE EQUITY</b>',
  test: '🧪 <b>MT5 PANEL TEST ALERT</b>'
}

export function formatAlert(kind, bot, extra = {}) {
  const a = bot.account || {}
  const positions = bot.positions || []
  const buys = positions.filter((p) => p.side === 'buy').length
  const sells = positions.length - buys
  const lots = positions.reduce((s, p) => s + (p.volume || 0), 0)
  const floating = positions.reduce((s, p) => s + (p.profit || 0), 0)
  const header = (HEADERS[kind] || HEADERS.warn).replace('{critical}', extra.critical ?? '')
  const lines = [
    header,
    '',
    `<b>Account:</b> ${bot.label || bot.name} (${a.login || '—'})`,
    `<b>Terminal:</b> ${bot.name} · ${bot.url || (bot.port ? `http://127.0.0.1:${bot.port}/mcp` : '')}`,
    `<b>Rungs:</b> ${bot.rungs ?? positions.length} / ${extra.maxRungs ?? 34}`,
    `<b>Positions:</b> ${positions.length} (${buys} buy / ${sells} sell) · ${fmt(lots)} lots`,
    `<b>Floating:</b> ${fmt(floating)} ${a.currency || ''}`,
    `<b>Balance:</b> ${fmt(a.balance)} · <b>Equity:</b> ${fmt(a.equity)}`,
    `<b>Margin level:</b> ${a.marginLevel === null || a.marginLevel === undefined ? '—' : fmt(a.marginLevel) + '%'}`,
    `<b>Free margin:</b> ${fmt(a.marginFree)}`
  ]
  if (extra.reason) lines.push('', `<i>${extra.reason}</i>`)
  lines.push('', `<i>${new Date().toLocaleString()}</i>`)
  return lines.join('\n')
}

export function evaluateAlerts(bot, prev, settings, now = Date.now()) {
  const events = []
  const st = { ...(prev || {}) }
  const clamp = (v) => (v === null || v === undefined ? null : v)
  const repeatMs = Math.max(1, settings.repeatAlertMinutes) * 60000
  const offlineMs = Math.max(1, settings.offlineRepeatMinutes) * 60000
  const warn = bot.warnRungs ?? settings.warnRungs
  const critical = bot.criticalRungs ?? settings.criticalRungs
  const rungs = bot.rungs ?? 0

  // A bot with no key / disabled / not yet polled is a configuration state, not
  // an outage — never page the user for it.
  if (bot.status === 'nokey' || bot.status === 'disabled' || bot.status === 'pending') {
    st.level = bot.status
    st.rungs = rungs
    return { state: st, events }
  }

  if (bot.status !== 'live') {
    const last = st.lastOfflineAt || 0
    if (!last || now - last > offlineMs) {
      events.push({ kind: 'offline', reason: bot.lastError || bot.status })
      st.lastOfflineAt = now
    }
    st.level = 'offline'
    st.rungs = rungs
    return { state: st, events }
  }

  if (st.level === 'offline' && bot.status === 'live') {
    events.push({ kind: 'online', reason: 'terminal reachable again' })
    st.lastOfflineAt = 0
    st.level = null
  }

  const equity = clamp(bot.account?.equity)
  if (equity !== null && equity < 0) {
    if (st.negativeSentAt === undefined || now - st.negativeSentAt > repeatMs) {
      events.push({ kind: 'negative' })
      st.negativeSentAt = now
    }
  } else {
    st.negativeSentAt = 0
  }

  const ml = clamp(bot.account?.marginLevel)
  if (ml !== null && ml > 0 && ml < 100) {
    if (!st.marginSentAt || now - st.marginSentAt > repeatMs) {
      events.push({ kind: 'margin', reason: `margin level ${fmt(ml)}%` })
      st.marginSentAt = now
    }
  } else {
    st.marginSentAt = 0
  }

  if (rungs >= critical) {
    if (st.level !== 'critical') {
      events.push({ kind: 'critical', critical })
      st.level = 'critical'
      st.escalationRungs = rungs
      st.lastCriticalAt = now
    } else if (rungs >= (st.escalationRungs || critical) + settings.escalationStep) {
      events.push({ kind: 'escalation', critical })
      st.escalationRungs = rungs
    } else if (now - (st.lastCriticalAt || 0) > repeatMs) {
      events.push({ kind: 'critical', critical, reason: 'still critical' })
      st.lastCriticalAt = now
    }
  } else if (rungs >= warn) {
    if (st.level !== 'warn' && st.level !== 'critical') {
      events.push({ kind: 'warn', critical })
      st.level = 'warn'
      st.lastWarnAt = now
    } else if (st.level === 'warn' && now - (st.lastWarnAt || 0) > repeatMs) {
      events.push({ kind: 'warn', critical, reason: 'still above warning' })
      st.lastWarnAt = now
    }
    st.escalationRungs = 0
  } else {
    if (st.level === 'critical' || st.level === 'warn') {
      events.push({ kind: 'recovery', critical })
    }
    st.level = 'ok'
    st.escalationRungs = 0
    st.lastWarnAt = 0
  }

  st.rungs = rungs
  st.lastSeen = now
  return { state: st, events }
}

export async function dispatch(event, bot, settings, extra = {}) {
  const text = formatAlert(event.kind, bot, extra)
  const res = await sendTelegram(text, settings)
  const rec = {
    ts: new Date().toISOString(),
    kind: event.kind,
    bot: bot.name,
    label: bot.label,
    account: bot.account?.login || null,
    rungs: bot.rungs ?? null,
    floating: bot.floating ?? null,
    delivered: !!res.sent,
    reason: res.sent ? null : res.reason,
    text
  }
  recordAlert(rec)
  log(`alert ${event.kind} ${bot.name} delivered=${rec.delivered}${rec.reason ? ' (' + rec.reason + ')' : ''}`)
  return rec
}
