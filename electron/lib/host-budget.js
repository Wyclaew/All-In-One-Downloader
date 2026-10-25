'use strict'

// Admission control is shared by transfers to the same origin through the same
// route. It changes how many requests may start; an in-flight writer is never
// replaced or raced by another writer over the same bytes.
const crypto = require('crypto')
const { failureKind } = require('./recovery')
const aborted = () => Object.assign(new Error('Aktarım durduruldu.'), { code: 'ABORTED' })

function createHostBudget({ now = Date.now, minCooldownMs = 1000, maxCooldownMs = 120000,
  recoveryEvery = 6, maxEntries = 128 } = {}) {
  const states = new Map()
  const admissions = []
  const entryLimit = Math.max(1, Math.floor(Number(maxEntries) || 128))
  function keyFor(url, proxy) {
    return new URL(url).origin + '|' + crypto.createHash('sha256').update(String(proxy || '')).digest('hex')
  }
  function pump(state) {
    clearTimeout(state.timer)
    state.timer = null
    while (state.queue.length && state.active < state.limit && now() >= state.until) {
      const waiter = state.queue.shift()
      if (waiter.signal?.aborted) { waiter.reject(aborted()); continue }
      waiter.signal?.removeEventListener('abort', waiter.abort)
      state.active += 1
      let released = false
      waiter.resolve({ release(error = null) {
        if (released) return
        released = true
        state.active -= 1
        state.lastAt = now()
        const kind = error ? failureKind(error) : null
        if (kind === 'busy' || kind === 'network') {
          state.limit = Math.max(1, kind === 'busy' ? Math.floor(state.limit / 2) : state.limit - 1)
          state.successes = 0
          const seconds = error?.retryAfter == null ? NaN : Number(error.retryAfter)
          const date = error?.retryAfter ? Date.parse(error.retryAfter) : NaN
          const requested = Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
            : Number.isFinite(date) ? Math.max(0, date - now()) : 0
          state.until = Math.max(state.until, now() + Math.min(maxCooldownMs,
            Math.max(kind === 'busy' ? minCooldownMs : Math.min(250, minCooldownMs), requested)))
        } else if (!error) {
          state.successes += 1
          if (state.successes >= Math.max(recoveryEvery, state.limit * 2) && now() >= state.until) {
            state.limit = Math.min(state.ceiling, state.limit + 1)
            state.successes = 0
          }
        }
        pump(state)
        admitWaiting()
      } })
    }
    if (state.queue.length && now() < state.until) {
      state.timer = setTimeout(() => pump(state), Math.max(1, state.until - now()))
    }
  }
  function retireInactive() {
    if (states.size < entryLimit) return true
    for (const [id, old] of states) if (!old.active && !old.queue.length) {
      clearTimeout(old.timer); states.delete(id); return true
    }
    return false
  }
  function admitWaiting() {
    while (admissions.length && retireInactive()) {
      const waiter = admissions.shift()
      waiter.signal?.removeEventListener('abort', waiter.abort)
      acquire(waiter.url, waiter.options).then(waiter.resolve, waiter.reject)
    }
  }
  function acquire(url, { proxy = '', maximum = 8, signal } = {}) {
    if (signal?.aborted) return Promise.reject(aborted())
    const ceiling = Math.max(1, Math.min(16, Math.floor(Number(maximum) || 8)))
    const key = keyFor(url, proxy)
    let state = states.get(key)
    if (!state) {
      // Only inactive entries may be retired. Outstanding permits and waiters
      // always refer to the same state until they have finished.
      if (!retireInactive()) return new Promise((resolve, reject) => {
        const waiter = { url, options: { proxy, maximum, signal }, signal, resolve, reject, abort: null }
        waiter.abort = () => {
          const index = admissions.indexOf(waiter)
          if (index >= 0) admissions.splice(index, 1)
          signal.removeEventListener('abort', waiter.abort)
          reject(aborted())
        }
        signal?.addEventListener('abort', waiter.abort, { once: true })
        admissions.push(waiter)
      })
      state = { limit: ceiling, ceiling, active: 0, queue: [], until: 0, successes: 0, timer: null, lastAt: now() }
      states.set(key, state)
    } else state.ceiling = Math.max(state.ceiling, ceiling)
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: null }
      waiter.abort = () => {
        const index = state.queue.indexOf(waiter)
        if (index < 0) return
        state.queue.splice(index, 1)
        signal.removeEventListener('abort', waiter.abort)
        reject(aborted())
        pump(state)
        // A cooling origin can have no active permits. Cancelling its final
        // waiter makes the slot retireable without any future release event.
        admitWaiting()
      }
      signal?.addEventListener('abort', waiter.abort, { once: true })
      state.queue.push(waiter)
      pump(state)
    })
  }
  function snapshot(url, proxy = '') {
    const state = states.get(keyFor(url, proxy))
    return state ? { limit: state.limit, active: state.active, waiting: state.queue.length,
      coolingDown: now() < state.until } : null
  }
  return { acquire, snapshot }
}

module.exports = { ...createHostBudget(), createHostBudget }
