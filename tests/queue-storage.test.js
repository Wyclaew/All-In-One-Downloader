'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('fs'), path = require('path')
const { root, load } = require('./helpers.cjs')
const store = load('electron/lib/store.js')
const starts = [], transfers = new Map()
let lowSpace = false
const cookieLeases = new Set()
const downloader = load('electron/lib/downloader.js', {
  './cookie-files': { retain: (file) => { cookieLeases.add(file); return () => cookieLeases.delete(file) } },
  './disk-space': { MiB: 1024 * 1024, assertSpace: () => { if (lowSpace) throw Object.assign(new Error('Disk doldu; yer açıp sürdür.'), { code: 'ENOSPC' }) } },
  './network-context': { getContext: () => ({ kind: 'tor' }), ensureForSource: async () => 'socks5://127.0.0.1:32123' },
  './ownengine': { transfer: (options) => new Promise((resolve, reject) => {
    starts.push(options.download.title); transfers.set(options.download.id, { reject, options })
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'ABORTED' })), { once: true })
  }) },
})
store.commit = (fn) => fn(store.getState()); store.send = () => {}; store.toast = () => {}
const tick = () => new Promise((resolve) => setImmediate(resolve))
function reset() {
  downloader.killAll(); starts.length = 0; transfers.clear(); lowSpace = false
  const state = store.getState(); state.downloads = []; state.items = []; state.sources = []
  Object.assign(state.settings, { downloadDir: root, autoStartDownloads: false, useYtdlp: false, concurrency: 1, protectDiskSpace: true, autoRecover: true })
}
function enqueue(title) { return downloader.enqueue({ url: 'https://example.test/' + title, title }) }
test.after(() => { downloader.killAll(); fs.rmSync(root, { recursive: true, force: true }) })
test('real scheduler is FIFO, suppresses duplicates, and honors an explicit queued priority', async () => {
  reset()
  const first = enqueue('first'), second = enqueue('second'), third = enqueue('third')
  assert.equal(enqueue('first').id, first.id)
  assert.equal(store.getState().downloads.length, 3)
  downloader.pumpQueue(); await tick()
  assert.deepEqual(starts, ['first'])
  assert.equal(downloader.prioritize(third.id), true)
  downloader.pause(first.id); await tick(); await tick()
  assert.deepEqual(starts, ['first', 'third'])
  assert.equal(first.status, 'paused'); assert.equal(second.status, 'queued')
  downloader.pause(third.id); await tick(); await tick()
  assert.deepEqual(starts, ['first', 'third', 'second'])
  downloader.pause(second.id); await tick()
})
test('disk preflight pauses a large queue without starting transfers or recursively overflowing', async () => {
  reset(); lowSpace = true
  for (let i = 0; i < 1500; i++) enqueue(String(i))
  downloader.pumpQueue(); await tick()
  assert.equal(starts.length, 0)
  assert.ok(store.getState().downloads.every((d) => d.status === 'paused' && /Disk/.test(d.note)))
  lowSpace = false
  const chosen = store.getState().downloads[0]
  downloader.resume(chosen.id); await tick()
  assert.equal(chosen.status, 'running'); assert.equal(starts.length, 1)
  downloader.pause(chosen.id); await tick()
})
test('ENOSPC from an active transfer preserves its partial file and does not enter automatic retry', async () => {
  reset(); const d = enqueue('partial')
  downloader.pumpQueue(); await tick()
  const { reject, options } = transfers.get(d.id)
  const dest = path.join(root, 'partial.mp4'); options.onDest(dest)
  fs.writeFileSync(dest + '.part', 'already downloaded bytes')
  reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }))
  await tick(); await tick()
  assert.equal(d.status, 'paused'); assert.match(d.note, /ENOSPC/)
  assert.equal(d.recoveryCount, 0); assert.equal(d.retryAt, null)
  assert.equal(fs.readFileSync(dest + '.part', 'utf8'), 'already downloaded bytes')
})

test('direct jobs ignore an active Tor context and retain an explicit source preference', async () => {
  reset()
  const state = store.getState()
  state.settings.proxyUrl = 'socks5://127.0.0.1:9061'
  state.sources = [{ id: 'direct-source', useProxy: false }, { id: 'tor-source', useProxy: true }]
  const direct = downloader.enqueue({ item: { id: 'direct', sourceId: 'direct-source', title: 'direct', url: 'https://example.test/direct', resolved: { kind: 'file', useProxy: true } } })
  downloader.pumpQueue(); await tick()
  assert.equal(direct.useProxy, false)
  assert.equal(transfers.get(direct.id).options.settings.proxyUrl, '')
  downloader.pause(direct.id); await tick()
  const proxied = downloader.enqueue({ url: 'https://example.test/tor', title: 'tor', sourceId: 'tor-source' })
  downloader.pumpQueue(); await tick()
  assert.equal(proxied.useProxy, true)
  assert.equal(transfers.get(proxied.id).options.settings.proxyUrl, 'socks5://127.0.0.1:32123')
  downloader.pause(proxied.id); await tick()
})

test('per-download audio choices stay independent from defaults and duplicate detection', () => {
  reset()
  const settings = store.getState().settings
  settings.preferredAudioLanguage = 'en'
  const item = { id: 'language', title: 'language', url: 'https://example.test/lang', resolved: { pageUrl: 'https://example.test/page', kind: 'hls' }, audioTracks: [{ lang: 'en' }] }
  const turkish = downloader.enqueue({ item, preferredAudioLanguage: 'tr' })
  const english = downloader.enqueue({ item, preferredAudioLanguage: 'en' })
  assert.notEqual(turkish.id, english.id)
  assert.equal(turkish.preferredAudioLanguage, 'tr'); assert.equal(turkish.refreshPending, true)
  assert.equal(english.preferredAudioLanguage, 'en'); assert.equal(english.audioSelectionExplicit, true)
  settings.preferredAudioLanguage = 'tr'
  assert.equal(english.preferredAudioLanguage, 'en')
  assert.equal(downloader.enqueue({ item, preferredAudioLanguage: 'en' }).id, english.id)
  assert.throws(() => downloader.enqueue({ item, preferredAudioLanguage: 'invalid' }), /Ses dili/)
})

test('active transfers retain their captured session until pause settles', async () => {
  reset()
  const item = { id: 'captured', title: 'captured', url: 'https://example.test/captured.mp4', resolved: { kind: 'file', cookieFile: '/synthetic/cookies.txt' } }
  const download = downloader.enqueue({ item })
  downloader.pumpQueue(); await tick()
  assert.equal(cookieLeases.has(item.resolved.cookieFile), true)
  downloader.pause(download.id); await tick(); await tick()
  assert.equal(cookieLeases.has(item.resolved.cookieFile), false)
  assert.equal(download.status, 'paused')
})
