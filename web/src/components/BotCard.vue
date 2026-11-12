<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  bot: { type: Object, required: true },
  warn: { type: Number, default: 10 },
  critical: { type: Number, default: 15 }
})

const open = ref(false)
const opening = ref(false)
const openState = ref('') // '' | 'ok' | 'bad'
const openHint = ref('')

async function openApp() {
  if (!props.bot.install || opening.value) return
  opening.value = true
  openState.value = ''
  try {
    const r = await fetch(`/api/bots/${encodeURIComponent(props.bot.name)}/open`, { method: 'POST' })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status)
    openState.value = 'ok'
    openHint.value = j.action === 'focused' ? 'window focused' : j.action === 'running' ? 'already running' : 'terminal launched'
  } catch (e) {
    openState.value = 'bad'
    openHint.value = e.message
  } finally {
    opening.value = false
    setTimeout(() => {
      openState.value = ''
      openHint.value = ''
    }, 3000)
  }
}

const money = (n) =>
  n === null || n === undefined || Number.isNaN(n)
    ? '—'
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const level = computed(() => {
  if (props.bot.status !== 'live') return 'off'
  if ((props.bot.rungs || 0) >= props.critical) return 'crit'
  if ((props.bot.rungs || 0) >= props.warn) return 'warn'
  return 'live'
})

const pillText = computed(() => {
  const s = props.bot.status
  if (s === 'live') return 'live'
  if (s === 'auth') return 'auth failed'
  if (s === 'nokey') return 'no key'
  if (s === 'disabled') return 'disabled'
  if (s === 'pending') return 'starting'
  return 'offline'
})

const floating = computed(() => {
  const f = props.bot.floating
  if (f === null || f === undefined) return props.bot.account?.floating ?? null
  return f
})

const segments = computed(() => {
  const filled = Math.min(props.bot.rungs || 0, 34)
  return Array.from({ length: 34 }, (_, i) => {
    if (i >= filled) return ''
    if ((props.bot.rungs || 0) >= props.critical) return 'on crit'
    if ((props.bot.rungs || 0) >= props.warn) return 'on warn'
    return 'on'
  })
})

const ago = computed(() => {
  const t = props.bot.lastOk || props.bot.lastSeen
  if (!t) return '—'
  const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000)
  if (s < 60) return `${Math.round(s)}s ago`
  return `${Math.round(s / 60)}m ago`
})

function fmtTime(t) {
  if (!t) return ''
  const d = new Date(typeof t === 'number' ? t * (t > 1e12 ? 1 : 1000) : t)
  return Number.isNaN(d.getTime()) ? String(t) : d.toLocaleTimeString()
}
</script>

<template>
  <article class="card" :class="level" @click="open = !open">
    <div class="card-head">
      <span class="acct">{{ bot.label || bot.account?.login || bot.name }}</span>
      <span class="tag">{{ bot.name }}</span>
      <button
        class="openapp"
        :class="[openState, { busy: opening }]"
        :disabled="!bot.install || opening"
        :title="openHint || (!bot.install ? 'No install path set for this bot' : 'Open ' + bot.install)"
        aria-label="Open terminal"
        @click.stop="openApp"
      >
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          <path d="M5 2.5H2.6v6.9h6.9V7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M7.1 2.5h2.4v2.4M9.3 2.7 5.6 6.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <span class="pill" :class="level">{{ pillText }}</span>
    </div>

    <div class="card-body">
      <div class="equity">
        {{ money(bot.account?.equity) }}
        <small>{{ bot.account?.currency || 'USD' }}</small>
      </div>
      <div class="float" :class="(floating ?? 0) >= 0 ? 'pos' : 'neg'">
        {{ (floating ?? 0) >= 0 ? '+' : '' }}{{ money(floating) }}
        <div class="muted" style="font-size:10px">floating</div>
      </div>
    </div>

    <div class="mini">
      <div><div class="k">Balance</div><div class="v">{{ money(bot.account?.balance) }}</div></div>
      <div><div class="k">Margin lvl</div><div class="v">{{ bot.account?.marginLevel == null ? '—' : money(bot.account.marginLevel) + '%' }}</div></div>
      <div><div class="k">Free</div><div class="v">{{ money(bot.account?.marginFree) }}</div></div>
      <div><div class="k">Lots</div><div class="v">{{ (bot.volume ?? 0).toFixed(2) }}</div></div>
    </div>

    <div class="rungs">
      <div class="row">
        <span>Rungs {{ bot.rungs ?? 0 }} / 34<span v-if="bot.manualPositions" class="muted"> · +{{ bot.manualPositions }} non-EA</span></span>
        <span>{{ bot.buys ?? 0 }} buy · {{ bot.sells ?? 0 }} sell</span>
      </div>
      <div class="bar">
        <i v-for="(c, i) in segments" :key="i" :class="c"></i>
      </div>
    </div>

    <div class="card-foot">
      <span>{{ ago }}</span>
      <span class="right">{{ bot.latencyMs ? bot.latencyMs + 'ms' : '' }} · :{{ bot.port }}</span>
    </div>

    <div v-if="bot.lastError" class="err">{{ bot.lastError }}</div>
    <div v-if="bot.status === 'nokey'" class="hint">
      Paste the API key from Tools → Options → MCP in this terminal (Settings → Bots).
    </div>

    <div v-if="open" class="positions" @click.stop>
      <table v-if="bot.positions && bot.positions.length">
        <thead>
          <tr><th>Ticket</th><th>Symbol</th><th>Side</th><th>Lots</th><th>Open</th><th>Now</th><th>P/L</th><th>Time</th><th>Comment</th></tr>
        </thead>
        <tbody>
          <tr v-for="p in bot.positions" :key="p.ticket">
            <td>{{ p.ticket }}</td>
            <td>{{ p.symbol }}</td>
            <td :class="p.side">{{ p.side }}</td>
            <td>{{ (p.volume ?? 0).toFixed(2) }}</td>
            <td>{{ p.open ?? '—' }}</td>
            <td>{{ p.current ?? '—' }}</td>
            <td :class="(p.profit ?? 0) >= 0 ? 'pos' : 'neg'">{{ money(p.profit) }}</td>
            <td>{{ fmtTime(p.time) }}</td>
            <td class="muted">{{ p.comment }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">No open positions.</div>
    </div>
  </article>
</template>
