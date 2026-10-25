'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('fs'), path = require('path'), os = require('os')
const backup = require('../electron/lib/library-backup')
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-backup-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, 'library.json') }
test('a damaged library recovers from a validated backup and preserves the original', (t) => {
  const file = fixture(t), data = { version: 1, downloads: [{ id: 'kept' }], settings: {} }
  backup.writeLibrary(file, data); backup.snapshot(file)
  fs.writeFileSync(file, '{broken')
  const recovered = backup.loadLibrary(file)
  assert.deepEqual(recovered.data, data); assert.match(recovered.notice, /kurtarıldı/)
  assert.ok(fs.readdirSync(path.dirname(file)).some((n) => n.startsWith('library.json.damaged-')))
})
test('a malformed backup is ignored and the rolling last-good copy survives failed data', (t) => {
  const file = fixture(t)
  backup.writeLibrary(file, { downloads: [{ id: 'old' }] })
  backup.writeLibrary(file, { downloads: [{ id: 'new' }] })
  assert.throws(() => backup.writeLibrary(file, { downloads: 'invalid' }))
  fs.writeFileSync(file, '{broken')
  assert.equal(backup.loadLibrary(file).data.downloads[0].id, 'old')
})
test('backup retention is bounded and snapshots are private', (t) => {
  const file = fixture(t); backup.writeLibrary(file, { downloads: [] })
  let latest
  for (let n = 0; n < 12; n++) latest = backup.snapshot(file)
  assert.equal(fs.readdirSync(path.dirname(latest)).length, 8)
  if (process.platform !== 'win32') assert.equal(fs.statSync(latest).mode & 0o777, 0o600)
})
