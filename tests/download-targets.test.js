'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const targets = require('../electron/lib/download-targets')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-targets-test-'))
test.after(() => fs.rmSync(dir, { recursive: true, force: true }))
test('unfinished native jobs claim separate targets and only their owner can release them', () => {
  const options = { dir, base: 'Same title', ext: 'mp4' }
  const a = targets.reserve({ ...options, id: 'english' })
  const b = targets.reserve({ ...options, id: 'turkish' })
  assert.notEqual(a, b)
  assert.equal(targets.reserve({ ...options, id: 'english', preferred: a }), a)
  assert.equal(targets.release(a, 'turkish'), false)
  assert.equal(targets.owned(a, 'english'), true)
  fs.writeFileSync(b + '.part', 'other job')
  assert.equal(targets.release(a, 'english'), true)
  assert.equal(fs.readFileSync(b + '.part', 'utf8'), 'other job')
})
test('existing final/partial media and foreign owner markers are preserved', () => {
  const options = { dir, base: 'Existing', ext: 'mkv' }
  fs.writeFileSync(path.join(dir, 'Existing.mkv'), 'finished')
  fs.writeFileSync(path.join(dir, 'Existing (2).mkv.part'), 'legacy partial')
  fs.writeFileSync(path.join(dir, 'Existing (3).mkv.aio-owner'), 'foreign')
  const file = targets.reserve({ ...options, id: 'new' })
  assert.equal(path.basename(file), 'Existing (4).mkv')
  assert.equal(fs.readFileSync(path.join(dir, 'Existing.mkv'), 'utf8'), 'finished')
  assert.equal(fs.readFileSync(path.join(dir, 'Existing (2).mkv.part'), 'utf8'), 'legacy partial')
})
test('a paused legacy path can be adopted once and remains resumable across manager reloads', () => {
  const file = path.join(dir, 'Legacy.mp4'); fs.writeFileSync(file + '.part', 'resume bytes')
  const options = { dir, base: 'Legacy', ext: 'mp4', preferred: file }
  assert.equal(targets.reserve({ ...options, id: 'old' }), file)
  assert.notEqual(targets.reserve({ ...options, id: 'other' }), file)
  delete require.cache[require.resolve('../electron/lib/download-targets')]
  assert.equal(require('../electron/lib/download-targets').reserve({ ...options, id: 'old' }), file)
  assert.equal(fs.readFileSync(file + '.part', 'utf8'), 'resume bytes')
})
test('yt-dlp isolates language/quality jobs while keeping a stable resume template', () => {
  for (const template of ['Title.%(ext)s', '%(title).120B.%(ext)s', 'custom-name', 'movie.mp4']) {
    const a = targets.outputTemplate(template, 'en'), b = targets.outputTemplate(template, 'tr')
    assert.notEqual(a, b)
    assert.equal(targets.outputTemplate(template, 'en'), a)
    if (template.endsWith('.%(ext)s')) assert.ok(a.endsWith('.%(ext)s'))
    if (template.endsWith('.mp4')) assert.ok(a.endsWith('.mp4'))
  }
})
