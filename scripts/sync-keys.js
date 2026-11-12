// Import per-terminal API keys from each instance's assistant.ini into
// data/bots.json. These are the keys the terminal writes for its own AI
// assistant; if a terminal rejects one with HTTP 401, replace it from
// Tools -> Options -> MCP in that terminal (the panel's settings dialog).

import fs from 'node:fs'
import path from 'node:path'
import { loadBots, saveBots, MT5_INSTANCES } from '../server/config.js'

function instances() {
  const out = new Map()
  for (const d of fs.readdirSync(MT5_INSTANCES, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const root = path.join(MT5_INSTANCES, d.name)
    const originFile = path.join(root, 'origin.txt')
    const ini = path.join(root, 'config', 'assistant.ini')
    if (!fs.existsSync(originFile) || !fs.existsSync(ini)) continue
    const origin = fs.readFileSync(originFile).toString('utf16le').replace(/\0/g, '').trim()
    const text = fs.readFileSync(ini).toString('utf16le').replace(/\0/g, '')
    const m = text.match(/\[MCP\.MetaTrader\]([\s\S]*?)(?=\n\[|$)/)
    const key = m && (m[1].match(/ApiKey=(\w+)/) || [])[1]
    out.set(path.normalize(origin).toLowerCase(), { origin, key, ini })
  }
  return out
}

const map = instances()
const bots = loadBots()
let n = 0
for (const bot of bots) {
  const install = bot.install || `C:\\mt5 - ${bot.name.replace('mt5_', '')}`
  const inst = map.get(path.normalize(install).toLowerCase())
  if (!inst?.key) {
    console.log(`— ${bot.name}: no key found`)
    continue
  }
  bot.token = inst.key
  bot.keySource = 'assistant.ini'
  n++
  console.log(`✓ ${bot.name}: key ${inst.key.slice(0, 8)}… (${inst.key.length} chars)`)
}
saveBots(bots)
console.log(`\nimported ${n} key(s) into data/bots.json`)
