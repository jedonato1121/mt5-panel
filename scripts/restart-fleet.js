// Restart MT5 terminals one at a time and wait for each MCP port to bind.
//
//   node scripts/restart-fleet.js            # all bots in data/bots.json
//   node scripts/restart-fleet.js mt5_2 mt5_3  # only these
//
// Never restarts the next terminal until the previous one is listening again,
// so the machine never boots ten chart-heavy processes at once.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { loadBots } from '../server/config.js'

const only = process.argv.slice(2)
const bots = loadBots().filter((b) => !only.length || only.includes(b.name))

const sh = (cmd) =>
  execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim()

function pidFor(install) {
  try {
    const out = sh(
      `Get-Process terminal64 -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${install.replace(/'/g, "''")}*' } | Select-Object -ExpandProperty Id`
    )
    return out ? Number(out.split(/\s+/)[0]) : null
  } catch {
    return null
  }
}

function listening(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
    return out.split(/\r?\n/).some((l) => l.includes('LISTENING') && l.includes(`127.0.0.1:${port} `))
  } catch {
    return false
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (const bot of bots) {
  const install = bot.install
  const exe = path.join(install, 'terminal64.exe')
  if (!fs.existsSync(exe)) {
    console.log(`SKIP ${bot.name}: ${exe} missing`)
    continue
  }
  const pid = pidFor(install)
  console.log(`${bot.name}: pid ${pid ?? 'none'} -> restart for port ${bot.port}`)
  if (pid) {
    // Graceful close first: MT5 only writes its chart profile (and therefore EA
    // attachments) on a normal shutdown. Force-killing restores a stale .chr
    // without the expert. Fall back to Stop-Process if it will not close.
    let closed = false
    try {
      sh(`$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.CloseMainWindow() | Out-Null`)
      for (let i = 0; i < 24; i++) {
        if (!pidFor(install)) {
          closed = true
          break
        }
        await sleep(500)
      }
    } catch {
      /* fall through */
    }
    if (!closed) {
      console.log('  graceful close failed, forcing')
      sh(`Stop-Process -Id ${pid} -Force`)
      for (let i = 0; i < 20; i++) {
        if (!pidFor(install)) break
        await sleep(500)
      }
    } else {
      console.log('  closed gracefully (profile saved)')
    }
  }
  sh(`Start-Process -FilePath '${exe.replace(/'/g, "''")}' -WorkingDirectory '${install.replace(/'/g, "''")}'`)
  let ok = false
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    await sleep(2000)
    if (listening(bot.port)) {
      ok = true
      break
    }
  }
  const newPid = pidFor(install)
  console.log(`  ${ok ? 'UP' : 'NO BIND'} pid ${newPid ?? 'none'} port ${bot.port}${ok ? ' LISTENING' : ''}`)
  if (!ok) {
    console.log('  stopping here so you can look at the terminal; fix and re-run')
    process.exit(2)
  }
}
console.log('done')
