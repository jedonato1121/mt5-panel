// Mock MCP server: reproduces the MetaTrader 5 MCP surface (initialize,
// tools/list, tools/call with get_trading_account_info and
// get_trading_open_positions) so the panel can be exercised without terminals.
//
//   node tools/mock-mcp.js [basePort] [count] [token]
//   node tools/mock-mcp.js 22990 3 testtoken

import http from 'node:http'

const basePort = Number(process.argv[2] || 22990)
const count = Number(process.argv[3] || 3)
const token = process.argv[4] || 'testtoken'

const accounts = [
  { login: '34306890', balance: 10432.55, equity: 10211.2, marginLevel: 412.4 },
  { login: '33703655', balance: 8800.1, equity: 8640.3, marginLevel: 286.1 },
  { login: '36169228', balance: 15220.75, equity: 14980.9, marginLevel: 158.3 }
]

function makeServer(index) {
  const port = basePort + index
  const acc = accounts[index % accounts.length]
  let tick = 0
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const auth = req.headers.authorization || ''
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="MetaTrader5-MCP"' }).end()
        return
      }
      let msg
      try {
        msg = JSON.parse(body)
      } catch {
        res.writeHead(400).end()
        return
      }
      const reply = (result) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'mock-session' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
      }
      if (msg.method === 'initialize') {
        reply({
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'MetaTrader 5 MCP (mock)', version: '1.0.0' }
        })
      } else if (msg.method === 'notifications/initialized') {
        res.writeHead(202).end()
      } else if (msg.method === 'tools/list') {
        reply({
          tools: [
            { name: 'get_trading_account_info' },
            { name: 'get_trading_open_positions' },
            { name: 'get_workspace_info' }
          ]
        })
      } else if (msg.method === 'tools/call') {
        tick += 1
        const drift = Math.sin(tick / 3) * 120
        if (msg.params?.name === 'get_trading_account_info') {
          reply({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  login: acc.login,
                  name: `Mock ${acc.login}`,
                  server: 'VantageMarkets-Live 21 - Hedge',
                  currency: 'USD',
                  balance: acc.balance,
                  equity: acc.equity + drift,
                  margin: 3510.5,
                  margin_free: 6800.2,
                  margin_level: acc.marginLevel,
                  leverage: 500,
                  profit: acc.equity + drift - acc.balance
                })
              }
            ]
          })
        } else if (msg.params?.name === 'get_trading_open_positions') {
          const rungs = (index * 6 + 2) % 18
          const positions = Array.from({ length: rungs }, (_, i) => ({
            ticket: `${acc.login}${1000 + i}`,
            symbol: 'XAUUSD.sc',
            type: i % 2 === 0 ? 'buy' : 'sell',
            volume: 0.02,
            price_open: 4010.5 + i,
            price_current: 4012.25 + i * 0.4 + drift / 100,
            profit: (i % 2 === 0 ? 1 : -1) * (3.5 + i),
            sl: 0,
            tp: 0,
            comment: 'grid',
            magic: 20260101
          }))
          reply({ content: [{ type: 'text', text: JSON.stringify({ positions }) }] })
        } else {
          reply({ content: [{ type: 'text', text: '{"ok":true}' }] })
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }))
      }
    })
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`mock mcp ${index + 1}/${count} on http://127.0.0.1:${port}/mcp account=${acc.login}`)
  })
  return server
}

for (let i = 0; i < count; i++) makeServer(i)
console.log(`token: ${token}`)
