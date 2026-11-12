// One-shot health check for the whole MT5 stack.
//
//   node scripts/doctor.js          # read-only checks
//   node scripts/doctor.js --send   # also send a Telegram test message
//
// Exit code 0 = everything green, 1 = something needs attention.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { McpClient, normalizeAccount, normalizePosition, deepFindArray } from '../server/mcp.js'
import { loadBots, loadSettings, HERMES_ENV, HERMES_HOME } from '../server/config.js'
import { readTelegramToken, sendTelegram } from '../server/alerts.js'

const SEND = process.argv.includes('--send')
const ok = (m) => console.log(`  PASS  ${m}`)
const bad = (m) => {
  console.log(`  FAIL  ${m}`)
  failures++
}
const warn = (m) => console.log(`  WARN  ${m}`)
let failures = 0

const settings = loadSettings()
const bots = loadBots()
const panelPort = settings.httpPort || 8787

function listening(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
    return out.split(/\r?\n/).some((l) => l.includes('LISTENING') && l.includes(`127.0.0.1:${port} `))
  } catch {
    return false
  }
}

async function main() {
  console.log(`MT5 panel doctor — ${new Date().toLocaleString()}\n`)

  console.log('Panel process')
  let state = null
  try {
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/state`, { signal: AbortSignal.timeout(4000) })
    state = await res.json()
    ok(`HTTP ${res.status} on 127.0.0.1:${panelPort} (${state.bots?.length ?? 0} bots configured)`)
  } catch (e) {
    bad(`panel not reachable on 127.0.0.1:${panelPort} — start it with start-panel.cmd (${e.message})`)
  }

  console.log('\nAutostart')
  const startup = path.join(
    process.env.APPDATA || '',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'MT5 Panel.vbs'
  )
  fs.existsSync(startup) ? ok('Startup\\MT5 Panel.vbs present') : bad('Startup\\MT5 Panel.vbs missing (panel will not start at logon)')
  try {
    const t = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', "(Get-ScheduledTask -TaskName 'Hermes_Gateway' -ErrorAction SilentlyContinue).State"],
      { encoding: 'utf8' }
    ).trim()
    t ? ok(`Hermes_Gateway task: ${t}`) : warn('Hermes_Gateway scheduled task not found — Telegram chat/agent may not answer')
  } catch {
    warn('could not query Hermes_Gateway task')
  }

  console.log('\nTerminals')
  for (const bot of bots) {
    if (!bot.enabled) {
      console.log(`  SKIP  ${bot.name} (disabled)`)
      continue
    }
    if (!listening(bot.port)) {
      bad(`${bot.name} :${bot.port} not listening — terminal not running, or its MCP port differs`)
      continue
    }
    if (!bot.token) {
      bad(`${bot.name} :${bot.port} listening but no API key in data/bots.json`)
      continue
    }
    try {
      const c = new McpClient({ url: `http://127.0.0.1:${bot.port}/mcp`, token: bot.token, timeoutMs: 6000 })
      await c.connect()
      const acctRaw = await c.callTool('get_trading_account_info', {})
      const posRaw = await c.callTool('get_trading_open_positions', {})
      const acct = normalizeAccount(acctRaw)
      const list =
        deepFindArray(posRaw, ['positions', 'open_positions', 'openpositions', 'data', 'items', 'result']) ||
        (Array.isArray(posRaw) ? posRaw : [])
      const positions = list.map(normalizePosition).filter(Boolean)
      const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }))
      ok(
        `${bot.name} :${bot.port} login ${acct?.login || '?'} · ${positions.length} rungs · equity ${fmt(acct?.equity)} ${acct?.currency || ''}`
      )
    } catch (e) {
      if (e.status === 401) bad(`${bot.name} :${bot.port} HTTP 401 — key rejected; re-paste it from Tools → Options → MCP`)
      else bad(`${bot.name} :${bot.port} ${e.message}`)
    }
  }

  console.log('\nTelegram')
  const token = readTelegramToken(settings)
  token ? ok('bot token found (Hermes .env)') : bad('no TELEGRAM_BOT_TOKEN in ' + HERMES_ENV)
  settings.telegramChatId ? ok(`chat id ${settings.telegramChatId}`) : bad('no chat id in data/settings.json')
  console.log(`        alerts ${settings.telegramEnabled ? 'enabled' : 'DISABLED'} · warn ${settings.warnRungs} / critical ${settings.criticalRungs} · poll ${settings.pollSeconds}s`)
  if (SEND) {
    const r = await sendTelegram('MT5 doctor: alert channel is live', settings)
    r.sent ? ok('test message delivered') : bad(`test message failed: ${r.reason}`)
  }

  console.log('\nHermes')
  console.log(`  INFO  home ${HERMES_HOME}`)
  const cfg = path.join(HERMES_HOME, 'config.yaml')
  if (fs.existsSync(cfg)) {
    const yaml = fs.readFileSync(cfg, 'utf8')
    const n = (yaml.match(/^ {2}mt5_\d+:/gm) || []).length
    n ? ok(`${n} MT5 servers registered in Hermes config`) : warn('no mt5_* MCP servers in Hermes config (optional)')
  }

  console.log('\nData files')
  const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')
  for (const f of ['bots.json', 'settings.json', 'keyring.json', 'alerts.jsonl']) {
    const p = path.join(dataDir, f)
    fs.existsSync(p) ? ok(f) : warn(`${f} missing`)
  }

  console.log(`\n${failures ? failures + ' problem(s) found' : 'all checks passed'}`)
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error('doctor crashed:', e)
  process.exit(1)
})
