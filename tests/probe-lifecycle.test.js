'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const { root, load } = require('./helpers.cjs')
const state = { sources: [], items: [], downloads: [], settings: { useYtdlp: false, useResolver: true, enrichLimit: 5, proxyUrl: 'socks5://127.0.0.1:9061' } }
const store = {
  getState: () => state, commit: (fn) => fn(state),
  findSource: (id) => state.sources.find((s) => s.id === id), findItem: (id) => state.items.find((i) => i.id === id),
  itemsOfSource: (id) => state.items.filter((i) => i.sourceId === id), getHostProfile: () => null,
  rememberHostProfile() {}, toast() {},
}
let failNetwork = false, blockMetadata = false, seenProxy = '', aborted = false, delayAbort = false, inspectNetwork = null
const heldCookies = new Set()
const probe = load('electron/lib/probe.js', {
  './store': store,
  './cookie-files': { retain: (file) => { if (file) heldCookies.add(file); return () => heldCookies.delete(file) } },
  './network-context': { ensureForSource: async () => { await inspectNetwork?.(); if (failNetwork) throw new Error('Tor başlatılamadı'); return 'socks5://127.0.0.1:32123' }, getContext: () => ({ kind: 'tor', isolated: true, label: 'Tor' }) },
  './resolver': {
    embedCandidatesFor: () => [],
    resolvePage: async (_url, options) => { seenProxy = options.proxy; return { title: 'Video', engine: 'static', candidates: [{ url: 'https://cdn.example.test/video.m3u8', kind: 'hls', info: { duration: 1800, height: 1080, live: false } }] } },
    assistedCapture: async () => null,
  },
  './mediainfo': { describeStream: async (_url, opts) => {
    if (blockMetadata) await new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => { aborted = true; if (delayAbort) setTimeout(() => reject(new Error('aborted')), 60); else reject(new Error('aborted')) }, { once: true })
    })
    return { duration: 1800, height: 1080, filesize: 1200000, filesizeEstimated: true, filesizeSource: 'manifest-bitrate', durationSource: 'manifest', live: false }
  } },
  './browsers': { resolveCookieArg: () => null, exportCookieJar: async () => null },
})
async function settled(source) {
  for (let i = 0; i < 50 && source.enriching; i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(source.enriching, 0)
}
test.after(() => { probe.killAll(); fs.rmSync(root, { recursive: true, force: true }) })
test('proxied discovery boots the source route and fills missing size without replacing the item', async () => {
  const source = probe.createSource('https://site.example.test/video', { useProxy: true })
  await probe.probeUrl(source.url, { sourceId: source.id })
  await settled(source)
  assert.equal(source.status, 'ready')
  assert.equal(seenProxy, 'socks5://127.0.0.1:32123')
  assert.equal(source.network.isolated, true)
  const item = store.itemsOfSource(source.id)[0]
  assert.equal(item.filesize, 1200000)
  assert.equal(item.metadataStatus, 'complete')
  assert.equal(item.filesizeSource, 'manifest-bitrate')
  const id = item.id
  await probe.refreshMetadata(source.id)
  assert.equal(store.itemsOfSource(source.id)[0].id, id)
  assert.equal(source.status, 'ready')
})
test('metadata can be canceled after initial discovery has completed', async () => {
  const source = state.sources[0]
  blockMetadata = true
  const task = probe.refreshMetadata(source.id)
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(source.enriching, 1)
  probe.cancelProbe(source.id)
  await task
  blockMetadata = false
  assert.equal(aborted, true)
  assert.equal(source.enriching, 0)
  assert.notEqual(store.itemsOfSource(source.id)[0].metadataStatus, 'loading')
})
test('a rescan does not inherit an old canceled metadata job still cleaning up', async () => {
  const source = state.sources[0]
  blockMetadata = true; delayAbort = true
  const old = probe.refreshMetadata(source.id)
  await new Promise((r) => setTimeout(r, 5))
  probe.cancelProbe(source.id)
  blockMetadata = false
  await probe.probeUrl(source.url, { sourceId: source.id })
  await settled(source)
  assert.equal(store.itemsOfSource(source.id)[0].filesize, 1200000)
  await old
  delayAbort = false
  assert.equal(source.enriching, 0)
})
test('network bootstrap failure becomes a terminal source error for discovery and capture', async () => {
  failNetwork = true
  const source = probe.createSource('https://site.example.test/fail', { useProxy: true })
  await probe.probeUrl(source.url, { sourceId: source.id })
  assert.equal(source.status, 'error')
  assert.equal(source.stage, null)
  assert.match(source.error, /Tor/)
  await probe.captureSource(source.id)
  assert.equal(source.status, 'error')
  assert.equal(source.stage, null)
})

test('rescans retain the previous cookie before removing items and release it after network success or failure', async () => {
  for (const capture of [false, true]) for (const fail of [false, true]) {
    failNetwork = fail
    const source = probe.createSource('https://site.example.test/retained', { useProxy: true })
    const jar = `/synthetic/${source.id}/cookies.txt`
    state.items.push({ id: 'previous', sourceId: source.id, resolved: { cookieFile: jar } })
    let reached = false
    inspectNetwork = async () => {
      reached = true
      assert.equal(store.itemsOfSource(source.id).length, 0)
      assert.equal(heldCookies.has(jar), true, 'the old library reference is gone, but the rescan owns a lease')
      await Promise.resolve()
      assert.equal(heldCookies.has(jar), true)
    }
    if (capture) await probe.captureSource(source.id)
    else await probe.probeUrl(source.url, { sourceId: source.id })
    assert.equal(reached, true)
    assert.equal(heldCookies.has(jar), false)
  }
  inspectNetwork = null; failNetwork = false
})
