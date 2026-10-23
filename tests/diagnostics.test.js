'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { redact, addEvent, report } = require('../electron/lib/diagnostics')
test('shareable reports remove URL credentials, query tokens and secret headers', () => {
  const result = redact('https://user:private@example.test/movie?token=private#key Authorization: Bearer secret\nCookie=session=private')
  assert.ok(!result.includes('private'))
  assert.ok(!result.includes('token='))
  assert.ok(!result.includes('secret'))
  assert.equal(redact('socks5://user:private@localhost:9061'), 'socks5://localhost:9061/…')
  const source = { site: 'example.test', useProxy: true, events: [], status: 'error', error: 'https://example.test/a?token=private' }
  const text = report(source, [{ url: 'https://cdn.test/media?token=private', filesize: 123 }], [], '0.14.0')
  assert.ok(!text.includes('private'))
  assert.ok(text.includes('cdn.test'))
})
test('event history is bounded and adjacent duplicate progress does not grow it', () => {
  const source = {}
  for (let i = 0; i < 100; i++) addEvent(source, 'resolver', `step ${i}`)
  addEvent(source, 'resolver', 'step 99')
  assert.equal(source.events.length, 60)
  assert.equal(source.events[0].message, 'step 40')
})
