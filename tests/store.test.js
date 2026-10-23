'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), path = require('path')
const { root, load } = require('./helpers.cjs')
const store = load('electron/lib/store.js')
test('restart clears dead network and metadata activity and preserves explicit proxy preferences', () => {
  fs.writeFileSync(path.join(root, 'library.json'), JSON.stringify({
    sources: [{ id: 's', status: 'probing', stage: 'network', enriching: 2, note: 'Tor', network: { kind: 'tor' } }],
    items: [{ id: 'i', metadataStatus: 'loading' }],
    downloads: [{ id: 'd', status: 'running', stage: 'downloading', speed: 1000, eta: 4 }],
    settings: { settingsRev: 3, proxyUrl: 'socks5://127.0.0.1:40000', autoStartTor: false },
  }))
  const state = store.init()
  assert.equal(state.sources[0].status, 'error')
  assert.equal(state.sources[0].stage, null)
  assert.equal(state.sources[0].network, undefined)
  assert.equal(state.sources[0].enriching, 0)
  assert.equal(state.items[0].metadataStatus, 'partial')
  assert.equal(state.downloads[0].status, 'paused')
  assert.equal(state.downloads[0].eta, null)
  assert.equal(state.settings.proxyUrl, 'socks5://127.0.0.1:40000')
  assert.equal(state.settings.autoStartTor, false)
  assert.equal(state.settings.isolateTorSources, true)
  store.flush()
})
test.after(() => { store.flush(); fs.rmSync(root, { recursive: true, force: true }) })
