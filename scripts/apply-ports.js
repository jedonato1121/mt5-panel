// Apply one unique MCP port per MT5 terminal instance.
//
//   node scripts/apply-ports.js            # dry run: show what would change
//   node scripts/apply-ports.js --write    # rewrite assistant.ini for each bot
//   node scripts/apply-ports.js --write --restart   # ... and restart each terminal
//
// Ports come from data/bots.json (bot.port). The instance folder is resolved
// from origin.txt, so this works for copies installed anywhere.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { loadBots, MT5_INSTANCES } from '../server/config.js'

const args = new Set(process.argv.slice(2))
const WRITE = args.has('--write')
const RESTART = args.has('--restart')

function instances() {
  const out = new Map()
  let dirs = []
  try {
    dirs = fs.readdirSync(MT5_INSTANCES, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return out
  }
  for (const d of dirs) {
    const root = path.join(MT5_INSTANCES, d.name)
    const originFile = path.join(root, 'origin.txt')
    const ini = path.join(root, 'config', 'assistant.ini')
    if (!fs.existsSync(originFile) || !fs.existsSync(ini)) continue
    let origin = ''
    try {
      origin = fs.readFileSync(originFile).toString('utf16le').replace(/\0/g, '').trim()
    } catch {
      continue
    }
    out.set(path.normalize(origin).toLowerCase(), { root, ini, origin })
  }
  return out
}

function readIni(file) {
  // toString('utf16le') keeps the BOM as U+FEFF; strip it so writeIni does not
  // prepend a second BOM and make every file look "changed".
  return fs.readFileSync(file).toString('utf16le').replace(/\0/g, '').replace(/^\uFEFF/, '')
}

function writeIni(file, text) {
  const body = text.replace(/\r?\n/g, '\r\n')
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]))
}

function setTraderEndpoint(text, port) {
  // No /m here: with it, `$` in the lookahead matches every line end, so the
  // lazy body stops after "Enable=1" and the rewrite duplicates lines.
  const sectionRe = /(\[MCP\.MetaTrader\]\r?\n)([\s\S]*?)(?=\r?\n\[|$)/
  const m = text.match(sectionRe)
  if (!m) {
    return text.trimEnd() + `\r\n[MCP.MetaTrader]\r\nEnable=1\r\nEndpoint=http://127.0.0.1:${port}/mcp\r\n`
  }
  let body = m[2]
  if (/^Endpoint=.*$/m.test(body)) body = body.replace(/^Endpoint=.*$/m, `Endpoint=http://127.0.0.1:${port}/mcp`)
  else body = `Enable=1\r\nEndpoint=http://127.0.0.1:${port}/mcp\r\n` + body
  if (!/^Enable=/m.test(body)) body = 'Enable=1\r\n' + body
  return text.replace(sectionRe, m[1] + body)
}

function runningExe(installPath) {
  try {
    const ps = `Get-Process terminal64 -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${installPath.replace(/'/g, "''")}*' } | Select-Object -ExpandProperty Id`
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim()
    return out ? Number(out.split(/\s+/)[0]) : null
  } catch {
    return null
  }
}

const map = instances()
const bots = loadBots()
if (!bots.length) {
  console.error('no bots in data/bots.json')
  process.exit(1)
}

console.log(`found ${map.size} terminal instances\n`)
let planned = 0
for (const bot of bots) {
  const install = bot.install || `C:\\mt5 - ${bot.name.replace('mt5_', '')}`
  const inst = map.get(path.normalize(install).toLowerCase())
  if (!inst) {
    console.log(`— ${bot.name.padEnd(7)} port ${String(bot.port).padEnd(6)} install ${install}  (no instance folder, skipped)`)
    continue
  }
  const before = readIni(inst.ini)
  const cur = (before.match(/\[MCP\.MetaTrader\][\s\S]*?Endpoint=http:\/\/127\.0\.0\.1:(\d+)\/mcp/) || [])[1]
  const after = setTraderEndpoint(before, bot.port)
  const changed = after !== before
  if (changed) planned++
  console.log(`• ${bot.name.padEnd(7)} ${String(cur || '—').padStart(5)} -> ${String(bot.port).padEnd(5)} ${changed ? 'UPDATE' : 'ok    '}  ${install}`)
  if (WRITE && changed) {
    writeIni(inst.ini, after)
  }
  if (RESTART) {
    const exe = path.join(install, 'terminal64.exe')
    const pid = runningExe(install)
    if (pid) {
      console.log(`    restarting pid ${pid}`)
      execFileSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`])
      execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 1500'])
    }
    if (fs.existsSync(exe)) {
      execFileSync('powershell', ['-NoProfile', '-Command', `Start-Process -FilePath '${exe.replace(/'/g, "''")}'`])
      console.log('    started')
    }
  }
}

console.log(`\n${planned} terminal(s) need a port change`)
if (!WRITE) console.log('dry run — re-run with --write to apply, add --restart to relaunch terminals')
