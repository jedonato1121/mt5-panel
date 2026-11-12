<script setup>
defineProps({
  alerts: { type: Array, default: () => [] }
})

function when(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function kindClass(k) {
  if (k === 'critical' || k === 'escalation' || k === 'negative') return 'crit'
  return k
}
</script>

<template>
  <aside class="alerts">
    <div class="alerts-head">
      <h2>Alerts</h2>
      <span class="alerts-count">{{ alerts.length }} recent</span>
      <span class="muted" style="margin-left:auto;font-size:10.5px">newest first</span>
    </div>
    <div class="alert-list">
      <div v-for="(a, i) in alerts" :key="i" class="alert">
        <div class="top">
          <span class="kind" :class="kindClass(a.kind)">{{ a.kind }}</span>
          <span class="muted">{{ a.bot }} · {{ a.label || a.account }}</span>
          <span class="muted" style="margin-left:auto">{{ when(a.ts) }}</span>
        </div>
        <div class="body">
          Rungs {{ a.rungs ?? '—' }}
          <span v-if="a.floating !== null && a.floating !== undefined"> · floating {{ Number(a.floating).toFixed(2) }}</span>
        </div>
        <div class="meta">
          <span :class="{ undelivered: !a.delivered }">
            {{ a.delivered ? 'delivered' : 'not delivered: ' + (a.reason || 'unknown') }}
          </span>
        </div>
      </div>
      <div v-if="!alerts.length" class="empty">No alerts yet. Thresholds fire here and to Telegram.</div>
    </div>
  </aside>
</template>
