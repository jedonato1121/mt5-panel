// Reattach an EA that was lost when a terminal was force-restarted.
//
// A force-killed MT5 never saves its chart profile, so the next launch restores
// an older .chr without the expert. This reattaches the .ex5 to the open chart
// and reports the EA's own "loaded." line so the config can be compared with
// the pre-restart line in MQL5\Logs.
//
//   node scripts/reattach-eas.js mt5_3:1.29a mt5_7:1.29b ...

import fs from 'node:fs'
import path from 'node:path'
import { McpClient } from '../server/mcp.js'
import { loadBots, MT5_INSTANCES } from '../server/config.js'

const args = process.argv.slice(2)
if (!args.length) {
  console.error('usage: node scripts/reattach-eas.js <bot>:<version> [...]')
  process.exit(1)
}

const bots = loadBots()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function instanceDir(install) {
  for (const d of fs.readdirSync(MT5_INSTANCES, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const root = path.join(MT5_INSTANCES, d.name)
    const originFile = path.join(root, 'origin.txt')
    if (!fs.existsSync(originFile)) continue
    const origin = fs.readFileSync(originFile).toString('utf16le').replace(/\0/g, '').trim()
    if (path.normalize(origin).toLowerCase() === path.normalize(install).toLowerCase()) return root
  }
  return null
}

for (const spec of args) {
  const [name, version] = spec.split(':')
  const bot = bots.find((b) => b.name === name)
  if (!bot) {
    console.log(`${name}: not in bots.json`)
    continue
  }
  const inst = instanceDir(bot.install)
  if (!inst) {
    console.log(`${name}: instance folder not found for ${bot.install}`)
    continue
  }
  const mql5 = path.join(inst, 'MQL5')
  const exe = path.join(mql5, 'Experts', 'XauSniperTrail', `XauSniperTrail_v${version}.ex5`)
  if (!fs.existsSync(exe)) {
    console.log(`${name}: missing ${exe}`)
    continue
  }
  const client = new McpClient({ url: `http://127.0.0.1:${bot.port}/mcp`, token: bot.token })
  try {
    await client.connect()
    const charts = await client.callTool('list_open_charts', {})
    const chart = charts.charts?.[0]
    if (!chart) {
      console.log(`${name}: no open chart`)
      continue
    }
    if (chart.expert) {
      console.log(`${name}: already has ${chart.expert.name}`)
      continue
    }
    await client.callTool('chart_add_expert', { chart_id: chart.chart_id, expert_path: exe })
    await sleep(2500)
    const after = await client.callTool('list_open_charts', {})
    const expert = after.charts?.[0]?.expert
    console.log(`${name}: attached -> ${expert ? expert.name : 'NOT ATTACHED'}`)
    if (expert?.inputs) console.log(`   inputs: ${expert.inputs.map((i) => Object.entries(i).map(([k, v]) => `${k}=${v}`).join(',')).join(' ')}`)
  } catch (e) {
    console.log(`${name}: ERROR ${e.message}`)
  }
}
