import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(here, '..')
export const DATA_DIR = process.env.MT5PANEL_DATA
  ? path.resolve(process.env.MT5PANEL_DATA)
  : path.join(ROOT, 'data')

export const BOTS_FILE = process.env.MT5PANEL_BOTS
  ? path.resolve(process.env.MT5PANEL_BOTS)
  : path.join(DATA_DIR, 'bots.json')
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
export const STATE_FILE = path.join(DATA_DIR, 'state.json')
export const ALERTS_FILE = path.join(DATA_DIR, 'alerts.jsonl')
export const LOG_FILE = path.join(DATA_DIR, 'panel.log')

export const HERMES_HOME =
  process.env.HERMES_HOME || path.join(process.env.LOCALAPPDATA || '', 'hermes')
export const HERMES_ENV = path.join(HERMES_HOME, '.env')
export const HERMES_CONFIG = path.join(HERMES_HOME, 'config.yaml')
export const MT5_INSTANCES = path.join(
  process.env.APPDATA || '',
  'MetaQuotes',
  'Terminal'
)

export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(file, value) {
  ensureDirs()
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

export function defaultSettings() {
  return {
    pollSeconds: 15,
    warnRungs: 10,
    criticalRungs: 15,
    repeatAlertMinutes: 15,
    offlineRepeatMinutes: 30,
    escalationStep: 5,
    magic: '202401',
    agentProject: '',
    agentBot: '',
    metaEditorUrl: '',
    metaEditorToken: '',
    telegramEnabled: true,
    telegramChatId: '',
    telegramTokenFromHermes: true,
    telegramToken: '',
    alertOnStartup: false
  }
}

export function loadSettings() {
  return { ...defaultSettings(), ...readJson(SETTINGS_FILE, {}) }
}

export function saveSettings(s) {
  writeJson(SETTINGS_FILE, s)
}

export function loadBots() {
  const data = readJson(BOTS_FILE, null)
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data.servers)) return data.servers
  return []
}

export function saveBots(bots) {
  writeJson(BOTS_FILE, { servers: bots })
}

export function log(line) {
  const stamped = `${new Date().toISOString()} ${line}`
  try {
    ensureDirs()
    fs.appendFileSync(LOG_FILE, stamped + '\n')
  } catch {
    /* ignore */
  }
  if (process.env.MT5PANEL_QUIET !== '1') console.log(stamped)
}
