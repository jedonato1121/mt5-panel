<script setup>
import { ref, computed, watch } from 'vue'

const props = defineProps({
  bots: { type: Array, default: () => [] },
  defaultName: { type: String, default: '' }
})

const selected = ref('')
const data = ref(null)
const loading = ref(false)
const copied = ref('')
const error = ref('')

const copyable = computed(() => {
  if (!data.value) return []
  return [
    { key: 'mcp', title: '.mcp.json — Claude Code', path: '.mcp.json', text: data.value.mcpJson },
    { key: 'codex', title: '.codex/config.toml — Codex', path: '.codex/config.toml', text: data.value.codexToml }
  ]
})

async function load() {
  if (!selected.value) return
  loading.value = true
  error.value = ''
  try {
    const r = await fetch('/api/agent-config?bot=' + encodeURIComponent(selected.value))
    if (!r.ok) throw new Error('HTTP ' + r.status)
    data.value = await r.json()
  } catch (e) {
    error.value = e.message
    data.value = null
  } finally {
    loading.value = false
  }
}

async function copy(item) {
  try {
    await navigator.clipboard.writeText(item.text)
    copied.value = item.key
    setTimeout(() => (copied.value = ''), 1500)
  } catch {
    copied.value = ''
  }
}

watch(selected, load)

// bots arrive asynchronously over SSE; pick a default terminal once they exist
watch(
  () => props.bots,
  (list) => {
    if (selected.value || !list || !list.length) return
    const preferred =
      (props.defaultName && list.find((b) => b.name === props.defaultName)) ||
      list.find((b) => b.name === 'mt5_5') ||
      list.find((b) => b.hasToken) ||
      list[0]
    selected.value = preferred.name
  },
  { immediate: true }
)
</script>

<template>
  <section class="agentpanel">
    <div class="agent-head">
      <h2>Agent MCP config</h2>
      <span class="muted">Claude Code + Codex, pointed at one terminal</span>
    </div>

    <div class="agent-bar">
      <label>
        Terminal
        <select v-model="selected">
          <option v-for="b in bots" :key="b.name" :value="b.name">
            {{ b.name }} · {{ b.label || '—' }} · :{{ b.port }}
          </option>
        </select>
      </label>
      <span v-if="data" class="muted">
        {{ data.url }}<template v-if="!data.tokenSet"> · no API key stored for this bot</template>
        <template v-if="data.metaEditor"> · MetaEditor {{ data.metaEditor.url }}</template>
      </span>
      <span v-if="loading" class="muted">loading…</span>
      <span v-if="error" class="neg">{{ error }}</span>
    </div>

    <p v-if="data?.project" class="muted small">
      Drop these into <code>{{ data.project }}</code> (project root). Both files contain the terminal API key — local machine only, keep them out of git.
    </p>
    <p v-else class="muted small">
      Drop these into your project root. Both files contain the terminal API key — local machine only, keep them out of git.
    </p>

    <div class="agent-grid">
      <div v-for="item in copyable" :key="item.key" class="snippet">
        <div class="snippet-head">
          <span>{{ item.title }}</span>
          <span class="snippet-actions">
            <code class="muted">{{ item.path }}</code>
            <button class="ghost tiny" @click="copy(item)">
              {{ copied === item.key ? 'copied' : 'copy' }}
            </button>
          </span>
        </div>
        <pre>{{ item.text }}</pre>
      </div>
    </div>
  </section>
</template>

<style scoped>
.agentpanel {
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
}
.agent-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 6px;
}
.agent-head h2 {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
}
.agent-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: 6px 0 8px;
}
.agent-bar label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--muted, #8b98a5);
}
.agent-bar select {
  background: #0e141b;
  color: inherit;
  border: 1px solid #223041;
  border-radius: 6px;
  padding: 5px 8px;
  font: inherit;
}
.agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 12px;
}
.snippet {
  border: 1px solid #1f2a37;
  border-radius: 8px;
  background: #0c1219;
  overflow: hidden;
}
.snippet-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid #1f2a37;
  font-size: 12px;
  color: #c8d3de;
}
.snippet-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.snippet pre {
  margin: 0;
  padding: 10px;
  font-size: 11.5px;
  line-height: 1.45;
  overflow-x: auto;
  color: #a8d1ff;
}
.ghost.tiny {
  padding: 3px 8px;
  font-size: 11px;
}
.small {
  font-size: 11.5px;
}
code {
  font-size: 11.5px;
}
</style>
