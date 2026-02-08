// src/logger.js
// Service simple de logging in-app, avec persistence via @capacitor/preferences
import { Preferences } from '@capacitor/preferences'

const LOGS_KEY = 'app_logs_v1'
const MAX_IN_MEMORY = 1000
const FLUSH_INTERVAL_MS = 2000

class Logger {
  constructor() {
    this.logs = []
    this.subscribers = new Set()
    this._dirty = false
    this._flushTimer = null
    this._init()
  }

  async _init() {
    try {
      const res = await Preferences.get({ key: LOGS_KEY })
      if (res && res.value) {
        this.logs = JSON.parse(res.value) || []
      } else {
        this.logs = []
      }
    } catch (e) {
      this.logs = []
    }
    this._notify()
  }

  _notify() {
    const snapshot = [...this.logs]
    for (const cb of this.subscribers) {
      try { cb(snapshot) } catch (e) { /* ignore */ }
    }
  }

  subscribe(cb) {
    this.subscribers.add(cb)
    // send current logs immediately
    cb([...this.logs])
    return () => this.subscribers.delete(cb)
  }

  _scheduleFlush() {
    if (this._flushTimer) return
    this._flushTimer = setTimeout(() => this._flushTimerFn(), FLUSH_INTERVAL_MS)
  }

  async _flushTimerFn() {
    this._flushTimer = null
    if (!this._dirty) return
    try {
      await Preferences.set({ key: LOGS_KEY, value: JSON.stringify(this.logs) })
      this._dirty = false
    } catch (e) {
      // ignore persistence errors
    }
  }

  _push(level, msg) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: typeof msg === 'string' ? msg : JSON.stringify(msg)
    }
    this.logs.push(entry)
    // keep bounded
    if (this.logs.length > MAX_IN_MEMORY) this.logs.splice(0, this.logs.length - MAX_IN_MEMORY)
    this._dirty = true
    this._notify()
    this._scheduleFlush()
    // also mirror to browser console for debugging during dev
    try {
      if (level === 'error') console.error('[APP LOG]', entry.ts, entry.msg)
      else if (level === 'warn') console.warn('[APP LOG]', entry.ts, entry.msg)
      else console.log('[APP LOG]', entry.ts, entry.msg)
    } catch (e) {}
  }

  info(msg) { this._push('info', msg) }
  warn(msg) { this._push('warn', msg) }
  error(msg) { this._push('error', msg) }
  debug(msg) { this._push('debug', msg) }

  clear() {
    this.logs = []
    this._dirty = true
    this._notify()
    this._scheduleFlush()
  }

  getAll() {
    return [...this.logs]
  }
}

export default new Logger()
