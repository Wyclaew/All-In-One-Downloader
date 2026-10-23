'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const fs = require('fs')
const { root, load } = require('./helpers.cjs')
const { createTorManager } = load('electron/lib/tor.js')

function fixture(options = {}) {
  const settings = { proxyUrl: 'socks5://127.0.0.1:9061', torAutoStart: false }
  const processes = []
  let finds = 0
  const manager = createTorManager({
    find: () => { finds += 1; return '/mock/tor' }, freePort: async () => 9061,
    directory: () => '/mock/data', configure: () => '/mock/torrc',
    stateStore: { send() {}, getState: () => ({ settings }), commit: (fn) => fn({ settings }) },
    launch() {
      const proc = new EventEmitter()
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter()
      proc.kills = []
      proc.kill = (signal) => {
        proc.kills.push(signal)
        queueMicrotask(() => { proc.signalCode = signal; proc.emit('close', null) })
        return true
      }
      processes.push(proc)
      return proc
    }, ...options,
  })
  return { manager, settings, processes, finds: () => finds }
}
async function launched(f) { await new Promise((resolve) => setImmediate(resolve)); return f.processes.at(-1) }
function ready(proc) { proc.stdout.emit('data', 'Bootstrapped 100% (done): Done\n') }

test.after(() => fs.rmSync(root, { recursive: true, force: true }))
test('simultaneous callers share startup, handle split log chunks, and automatic startup preserves preferences', async () => {
  const f = fixture()
  const progress = []
  const a = f.manager.ensureStarted({ onProgress: (s) => progress.push(s.percent) })
  const b = f.manager.ensureStarted()
  const proc = await launched(f)
  assert.equal(f.processes.length, 1)
  proc.stdout.emit('data', 'Bootstrapped 4')
  proc.stdout.emit('data', '0% (loading): Loading\nBootstrapped 1')
  proc.stdout.emit('data', '00% (done): Done\n')
  assert.equal((await a).state, 'on')
  assert.equal((await b).port, 9061)
  assert.ok(progress.includes(40))
  assert.equal(f.settings.torAutoStart, false)
  f.manager.stop()
})
test('cancelling one startup waiter keeps the other source running', async () => {
  const f = fixture()
  const controller = new AbortController()
  const cancelled = f.manager.ensureStarted({ signal: controller.signal })
  const other = f.manager.ensureStarted()
  const proc = await launched(f)
  controller.abort()
  await assert.rejects(cancelled, { code: 'ABORTED' })
  assert.deepEqual(proc.kills, [])
  ready(proc)
  assert.equal((await other).state, 'on')
  f.manager.stop()
})
test('last cancelled waiter stops the daemon and stop rejects an in-flight start', async () => {
  const f = fixture()
  const controller = new AbortController()
  const pending = f.manager.ensureStarted({ signal: controller.signal })
  const proc = await launched(f)
  controller.abort()
  await assert.rejects(pending, { code: 'ABORTED' })
  assert.deepEqual(proc.kills, ['SIGTERM'])
  assert.equal(f.manager.getStatus().state, 'off')
  const again = f.manager.ensureStarted()
  await launched(f)
  f.manager.stop()
  await assert.rejects(again, { code: 'ABORTED' })
})
test('stop while port selection is pending prevents a late orphan process', async () => {
  let choosePort
  const f = fixture({ freePort: () => new Promise((resolve) => { choosePort = resolve }) })
  const pending = f.manager.ensureStarted()
  f.manager.stop()
  choosePort(9061)
  await assert.rejects(pending, { code: 'ABORTED' })
  await launched(f)
  assert.equal(f.processes.length, 0)
})
test('missing binary and a bootstrap timeout fail closed', async () => {
  const missing = fixture({ find: () => null })
  await assert.rejects(missing.manager.ensureStarted(), /Tor bulunamadı/)
  const f = fixture({ bootstrapTimeoutMs: 10 })
  await assert.rejects(f.manager.ensureStarted(), /bağlanamadı/)
  assert.equal(f.manager.getStatus().state, 'error')
  assert.deepEqual(f.processes[0].kills, ['SIGTERM'])
})
test('manual start remembers Tor without replacing a selected custom proxy', async () => {
  const f = fixture()
  f.settings.proxyUrl = 'http://corporate.example:8080'
  const pending = f.manager.start()
  ready(await launched(f))
  await pending
  assert.equal(f.settings.proxyUrl, 'http://corporate.example:8080')
  assert.equal(f.settings.torAutoStart, true)
  f.processes[0].emit('close', 1)
  assert.equal(f.manager.getStatus().state, 'error')
})
