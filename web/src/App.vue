<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import BotCard from './components/BotCard.vue'
import AlertsPanel from './components/AlertsPanel.vue'
import AgentConfig from './components/AgentConfig.vue'
import SettingsModal from './components/SettingsModal.vue'

const state = ref({ ts: null, totals: {}, bots: [], alerts: [], settings: {} })
const connected = ref(false)
const showSettings = ref(false)
const toast = ref('')
let es = null
let fallback = null

async function fetchState() {
  try {
    const r = await fetch('/api/state')
    if (!r.ok) throw new Error('HTTP ' + r.status)
    state.value = await r.json()
    connected.value = true
  } catch {
    connected.value = false
  }
}

function connect() {
  try {
    es = new EventSource('/api/stream')
    es.onmessage = (ev) => {
      try {
        state.value = JSON.parse(ev.data)
        connected.value = true
      } catch {}
    }
    es.onerror = () => {
      connected.value = false
    }
  } catch {
    connected.value = false
  }
}

const totals = computed(() => state.value.totals || {})
const bots = computed(() => state.value.bots || [])
const settings = computed(() => state.value.settings || {})
const warn = computed(() => settings.value.warnRungs ?? 10)
const critical = computed(() => settings.value.criticalRungs ?? 15)

const overall = computed(() => {
  if (!connected.value) return 'off'
  if (bots.value.some((b) => b.rungs >= critical.value)) return 'crit'
  if (bots.value.some((b) => b.rungs >= warn.value)) return 'warn'
  return 'live'
})

const money = (n) =>
  n === null || n === undefined || Number.isNaN(n)
    ? '—'
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

async function testAlert() {
  toast.value = 'sending…'
  try {
    const r = await fetch('/api/test-alert', { method: 'POST' })
    const j = await r.json()
    toast.value = j.sent ? 'test alert delivered to Telegram' : `not delivered: ${j.reason}`
  } catch (e) {
    toast.value = 'test failed: ' + e.message
  }
  setTimeout(() => (toast.value = ''), 6000)
}

function onSaved() {
  showSettings.value = false
  fetchState()
}

const snapshotMode = new URLSearchParams(location.search).has('snapshot')

onMounted(() => {
  fetchState()
  // ?snapshot=1 renders a one-shot snapshot (used for screenshots / docs);
  // otherwise keep an SSE stream open so the panel updates live.
  if (!snapshotMode) connect()
  fallback = setInterval(() => {
    if (!connected.value) fetchState()
  }, 10000)
})

onBeforeUnmount(() => {
  es?.close()
  clearInterval(fallback)
})
</script>

<template>
  <div class="shell">
    <header class="top">
      <div class="brand">
        <span class="dot" :class="overall"></span>
        <h1>MT5 PANEL</h1>
        <span class="sub">{{ connected ? 'live' : 'disconnected' }}</span>
      </div>

      <div class="kpis">
        <div class="kpi">
          <span class="label">Bots</span>
          <span class="value">{{ totals.live ?? 0 }}/{{ totals.bots ?? 0 }}</span>
        </div>
        <div class="kpi">
          <span class="label">Rungs</span>
          <span class="value" :class="{ crit: totals.rungs >= critical * 3 }">{{ totals.rungs ?? 0 }}</span>
        </div>
        <div class="kpi">
          <span class="label">Floating</span>
          <span class="value" :class="(totals.floating ?? 0) >= 0 ? 'pos' : 'neg'">{{ money(totals.floating) }}</span>
        </div>
        <div class="kpi">
          <span class="label">Equity</span>
          <span class="value">{{ money(totals.equity) }}</span>
        </div>
        <div class="kpi">
          <span class="label">Balance</span>
          <span class="value">{{ money(totals.balance) }}</span>
        </div>
      </div>

      <button class="ghost" @click="testAlert">Test alert</button>
      <button class="primary" @click="showSettings = true">Settings</button>
    </header>

    <main class="grid">
      <BotCard
        v-for="bot in bots"
        :key="bot.name"
        :bot="bot"
        :warn="warn"
        :critical="critical"
      />
      <div v-if="!bots.length" class="empty">No bots configured — add them in Settings.</div>
    </main>

    <AlertsPanel :alerts="state.alerts || []" />

    <AgentConfig :bots="bots" :default-name="settings.agentBot || ''" />

    <div v-if="toast" class="hint" style="position:fixed;right:18px;bottom:18px;z-index:60">{{ toast }}</div>

    <SettingsModal
      v-if="showSettings"
      :bots="bots"
      :settings="settings"
      @close="showSettings = false"
      @saved="onSaved"
    />
  </div>
</template>
