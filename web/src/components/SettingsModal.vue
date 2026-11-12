<script setup>
import { reactive, ref } from 'vue'

const props = defineProps({
  bots: { type: Array, default: () => [] },
  settings: { type: Object, default: () => ({}) }
})
const emit = defineEmits(['close', 'saved'])

const form = reactive({
  pollSeconds: props.settings.pollSeconds ?? 15,
  warnRungs: props.settings.warnRungs ?? 10,
  criticalRungs: props.settings.criticalRungs ?? 15,
  repeatAlertMinutes: props.settings.repeatAlertMinutes ?? 15,
  offlineRepeatMinutes: props.settings.offlineRepeatMinutes ?? 30,
  escalationStep: props.settings.escalationStep ?? 5,
  telegramEnabled: props.settings.telegramEnabled ?? true,
  telegramChatId: props.settings.telegramChatId ?? '',
  telegramTokenFromHermes: props.settings.telegramTokenFromHermes ?? true,
  telegramToken: ''
})

const rows = reactive(
  props.bots.map((b) => ({
    name: b.name,
    label: b.label || '',
    port: b.port,
    token: '',
    hasToken: b.hasToken,
    tokenHint: b.tokenHint,
    test: null,
    testing: false
  }))
)

const saving = ref(false)
const msg = ref('')

async function patch(url, body) {
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status)
  return r.json()
}

async function save() {
  saving.value = true
  msg.value = ''
  try {
    await patch('/api/settings', { ...form })
    for (const row of rows) {
      const body = { label: row.label, port: Number(row.port) }
      if (row.token.trim()) body.token = row.token.trim()
      await patch(`/api/bots/${row.name}`, body)
    }
    emit('saved')
    msg.value = 'saved'
  } catch (e) {
    msg.value = 'error: ' + e.message
  } finally {
    saving.value = false
  }
}

async function test(row) {
  row.testing = true
  row.test = null
  try {
    const r = await fetch(`/api/bots/${row.name}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: row.token.trim() || undefined })
    })
    row.test = await r.json()
  } catch (e) {
    row.test = { ok: false, error: e.message }
  } finally {
    row.testing = false
  }
}

async function importHermes() {
  msg.value = 'importing…'
  try {
    const r = await fetch('/api/import-hermes', { method: 'POST' })
    const j = await r.json()
    msg.value = j.ok ? `imported ${j.imported} key(s) from Hermes config — reopen settings to see them` : j.error
  } catch (e) {
    msg.value = 'import failed: ' + e.message
  }
}
</script>

<template>
  <div class="modal-bg" @click.self="emit('close')">
    <div class="modal">
      <h2>Settings</h2>

      <div class="grid2">
        <div class="field"><label>Poll interval (s)</label><input type="number" min="3" v-model.number="form.pollSeconds" /></div>
        <div class="field"><label>Warn at rungs</label><input type="number" min="1" v-model.number="form.warnRungs" /></div>
        <div class="field"><label>Critical at rungs</label><input type="number" min="1" v-model.number="form.criticalRungs" /></div>
        <div class="field"><label>Escalate every +n</label><input type="number" min="1" v-model.number="form.escalationStep" /></div>
        <div class="field"><label>Repeat alert (min)</label><input type="number" min="1" v-model.number="form.repeatAlertMinutes" /></div>
        <div class="field"><label>Offline repeat (min)</label><input type="number" min="1" v-model.number="form.offlineRepeatMinutes" /></div>
      </div>

      <hr />

      <div class="field"><label>Telegram alerts</label>
        <select v-model="form.telegramEnabled">
          <option :value="true">enabled</option>
          <option :value="false">disabled</option>
        </select>
      </div>
      <div class="field"><label>Telegram chat id</label><input v-model="form.telegramChatId" placeholder="e.g. 123456789" /></div>
      <div class="field"><label>Token source</label>
        <select v-model="form.telegramTokenFromHermes">
          <option :value="true">Hermes .env (TELEGRAM_BOT_TOKEN)</option>
          <option :value="false">custom token below</option>
        </select>
      </div>
      <div v-if="!form.telegramTokenFromHermes" class="field">
        <label>Bot token</label><input v-model="form.telegramToken" placeholder="123456:AA…" />
      </div>

      <hr />

      <h2 style="font-size:12px">Bots</h2>
      <div class="botrow" style="color:var(--muted);font-size:10px;letter-spacing:.08em;text-transform:uppercase">
        <span>name</span><span>port</span><span>api key</span><span></span>
      </div>
      <div v-for="row in rows" :key="row.name">
        <div class="botrow">
          <input class="nm" v-model="row.label" :placeholder="row.name" />
          <input v-model.number="row.port" type="number" />
          <input v-model="row.token" :placeholder="row.hasToken ? 'stored ' + row.tokenHint : 'paste from Tools → Options → MCP'" />
          <button :disabled="row.testing" @click="test(row)">{{ row.testing ? '…' : 'Test' }}</button>
        </div>
        <div v-if="row.test" class="status-line" :class="row.test.ok ? 'ok' : 'bad'">
          {{ row.test.ok ? `connected · ${row.test.toolCount} tools · ${row.test.ms}ms` : `failed: ${row.test.error}` }}
        </div>
      </div>

      <div class="modal-actions">
        <button class="ghost" @click="importHermes">Import keys from Hermes</button>
        <button class="ghost" @click="emit('close')">Cancel</button>
        <button class="primary" :disabled="saving" @click="save">{{ saving ? 'saving…' : 'Save' }}</button>
      </div>
      <div v-if="msg" class="empty">{{ msg }}</div>
    </div>
  </div>
</template>
