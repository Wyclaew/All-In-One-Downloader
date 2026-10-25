'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('vm')
const { DISCOVERY_SCRIPT } = require('../electron/lib/browser-discovery')

function fixture(body, { media = [], scripts = [] } = {}) {
  const response = { url: 'https://api.example.test/v2/config', headers: { get: () => '' },
    clone: () => ({ body: { getReader: () => {
      let sent = false
      return { read: async () => sent ? { done: true } : (sent = true, { value: new TextEncoder().encode(body), done: false }), cancel: async () => {} }
    } } }) }
  const context = { location: { href: 'https://page.example.test/watch/one' },
    document: { baseURI: 'https://page.example.test/assets/', querySelectorAll: (selector) => selector.includes('script') ? scripts : media },
    performance: { getEntriesByType: () => [] },
    XMLHttpRequest: function () {}, fetch: async () => response, TextDecoder, URL,
    setTimeout: () => 1, setInterval: () => 1, clearInterval: () => {}, clearTimeout: () => {} }
  context.XMLHttpRequest.prototype.open = () => {}
  context.window = context
  vm.runInNewContext(DISCOVERY_SCRIPT, context)
  return context
}
test('browser response sources resolve against the actual API response location', async () => {
  const context = fixture(JSON.stringify({ sources: [{ url: 'renditions/main', type: 'application/dash+xml' }], ads: { sources: [{ file: '/advert.mp4' }] } }))
  await context.fetch('/config', { method: 'POST' })
  await new Promise(setImmediate)
  const sources = Array.from(context.__aioSeen || []).filter((s) => s.url)
  assert.equal(sources.length, 1)
  assert.equal(sources[0].url, 'https://api.example.test/v2/renditions/main')
  assert.equal(sources[0].kind, 'dash')
})
test('browser media MIME hints and loaded-player metadata are offered together', () => {
  const listeners = {}
  const media = { currentSrc: 'https://cdn.example.test/opaque', src: '', tagName: 'VIDEO', readyState: 1,
    duration: 12.5, videoWidth: 640, videoHeight: 360, getAttribute: () => 'application/dash+xml',
    addEventListener: (event, fn) => { listeners[event] = fn }, closest: () => null }
  const context = fixture('', { media: [media] })
  assert.ok(context.__aioSeen.some((s) => s.url === media.currentSrc && s.kind === 'dash'))
  assert.ok(context.__aioSeen.some((s) => s.playerMetadata?.duration === 12.5))
  listeners.encrypted({ isTrusted: false })
  assert.ok(!context.__aioSeen.some((s) => s.drm))
  listeners.encrypted({ isTrusted: true })
  assert.ok(context.__aioSeen.some((s) => s.drm && s.from === 'encrypted-media-event'))
})
test('browser typed JSON-LD sources are read without treating embed pages as streams', () => {
  const scripts = [{ textContent: JSON.stringify({ '@type': 'VideoObject', contentUrl: '/stream', encodingFormat: 'video/mp4', embedUrl: '/player' }) }]
  const context = fixture('', { scripts })
  assert.equal(context.__aioSeen.filter((s) => s.url).length, 1)
  assert.equal(context.__aioSeen[0].url, 'https://page.example.test/stream')
  assert.equal(context.__aioSeen[0].kind, 'file')
})
