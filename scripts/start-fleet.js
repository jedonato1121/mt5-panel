// Start every terminal that is not running, then wait for its MCP port.
//
//   node scripts/start-fleet.js            # all bots in data/bots.json
//   node scripts/start-fleet.js mt5_3 mt5_4
//
// Terminals already listening are left alone. This never kills anything.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { loadBots } from '../server/config.js'

const only = process.argv.slice(2)
const bots = loadBots().filter((b) => !only.length || only.includes(b.name))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function listening(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
    return out.split(/\r?\n/).some((l) => l.includes('LISTENING') && l.includes(`127.0.0.1:${port} `))
  } catch {
    return false
  }
}

for (const bot of bots) {
  if (!bot.enabled) {
    console.log(`${bot.name}: disabled, skipped`)
    continue
  }
  if (listening(bot.port)) {
    console.log(`${bot.name}: already up on :${bot.port}`)
    continue
  }
  const exe = path.join(bot.install, 'terminal64.exe')
  if (!fs.existsSync(exe)) {
    console.log(`${bot.name}: missing ${exe}`)
    continue
  }
  console.log(`${bot.name}: starting ${exe}`)
  try {
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -WorkingDirectory '${bot.install.replace(/'/g, "''")}'`
    ])
  } catch (e) {
    console.log(`  start failed: ${e.message}`)
    continue
  }
  const deadline = Date.now() + 60000
  let up = false
  while (Date.now() < deadline) {
    await sleep(2000)
    if (listening(bot.port)) {
      up = true
      break
    }
  }
  console.log(`  ${up ? 'UP' : 'NO BIND'} on :${bot.port}`)
}
console.log('done — run node scripts/doctor.js to verify keys and data')
