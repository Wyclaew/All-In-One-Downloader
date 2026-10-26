'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { createCollectionEditor } = require('../electron/lib/collections')
function fixture() {
  const downloads = [
    { id: 'b', title: 'Episode 10', series: 'Old', season: 1, episode: 10, createdAt: 2, filePath: '/fixture/10.mp4', status: 'done' },
    { id: 'a', title: 'Episode 2', series: 'Old', season: 1, episode: 2, createdAt: 1, filePath: '/fixture/2.mp4', status: 'done' },
    { id: 'c', title: 'Episode 1', createdAt: 3, filePath: '/fixture/1.mp4', status: 'paused' },
  ]
  let commits = 0
  const editor = createCollectionEditor({ getDownloads: () => downloads, commit: (change) => { commits++; change() } })
  const request = { ids: ['b', 'a', 'c'], series: ' New  Series ', season: 2, episodeStart: 4, order: 'title' }
  const apply = (payload = request) => editor.apply({ ...payload, revision: editor.preview(payload).revision })
  return { editor, downloads, request, apply, commits: () => commits }
}
test('preview uses natural stable order and applies only library collection metadata with undo', () => {
  const { editor, downloads, request, apply, commits } = fixture()
  const before = JSON.parse(JSON.stringify(downloads))
  const preview = editor.preview(request)
  assert.deepEqual(preview.rows.map((row) => row.id), ['c', 'a', 'b'])
  assert.deepEqual(preview.rows.map((row) => row.after.episode), [4, 5, 6])
  assert.equal(preview.rows[0].after.series, 'New Series')
  assert.deepEqual(downloads, before); assert.equal(commits(), 0)
  const result = apply()
  assert.equal(result.count, 3); assert.ok(result.undoToken)
  assert.equal(commits(), 1)
  for (const record of downloads) {
    const old = before.find((item) => item.id === record.id)
    assert.equal(record.filePath, old.filePath); assert.equal(record.status, old.status)
    assert.equal(record.title, old.title); assert.equal(record.series, 'New Series')
  }
  assert.equal(editor.undo(result.undoToken).count, 3)
  for (const record of downloads) {
    const old = before.find((item) => item.id === record.id)
    assert.equal(record.series, old.series || null); assert.equal(record.season, old.season ?? null); assert.equal(record.episode, old.episode ?? null)
  }
  assert.throws(() => editor.undo(result.undoToken), /artık geri/)
})
test('preserve, clear, existing episode order, and created order are explicit', () => {
  const { editor, downloads } = fixture()
  const preserved = editor.preview({ ids: ['b', 'a', 'c'], series: null })
  assert.deepEqual(preserved.rows.map((row) => row.id), ['a', 'b', 'c'])
  assert.equal(preserved.rows[0].after.episode, 2); assert.equal(preserved.rows[0].after.season, 1)
  const mixed = editor.preview({ ids: ['a', 'c'], season: 3 })
  assert.equal(mixed.rows.find((row) => row.id === 'a').after.series, 'Old')
  assert.equal(mixed.rows.find((row) => row.id === 'c').after.series, null)
  const cleared = editor.preview({ ids: ['a', 'b'], series: null, season: null, episodeStart: null })
  assert.ok(cleared.rows.every((row) => Object.values(row.after).every((value) => value === null)))
  assert.deepEqual(editor.preview({ ids: ['c', 'b', 'a'], series: 'S', order: 'created' }).rows.map((row) => row.id), ['a', 'b', 'c'])
  assert.equal(downloads[0].series, 'Old')
})
test('invalid fields, missing rows, extreme sequence and stale preview never partially change records', () => {
  const { editor, downloads, request, commits } = fixture()
  const before = JSON.stringify(downloads)
  for (const change of [
    { ids: [] }, { ids: ['missing'] }, { series: 2 }, { series: 'x'.repeat(161) },
    { season: -1 }, { season: 1.2 }, { season: '1' }, { season: 1000 },
    { episodeStart: 0 }, { episodeStart: 1.1 }, { episodeStart: 9999 }, { order: 'random' },
    { ids: Array.from({ length: 1001 }, () => 'a') },
  ]) assert.throws(() => editor.preview({ ...request, ...change }))
  assert.throws(() => editor.apply(request), /Önizlemeden/)
  const preview = editor.preview(request)
  downloads[0].episode = 20
  assert.throws(() => editor.apply({ ...request, revision: preview.revision }), /değişti/)
  downloads[0].episode = 10
  assert.equal(JSON.stringify(downloads), before); assert.equal(commits(), 0)
})
test('undo refuses a changed or removed target and cannot overwrite another edit', () => {
  const { editor, downloads, apply } = fixture()
  const result = apply()
  downloads[0].series = 'Someone else changed this'
  const changed = JSON.stringify(downloads)
  assert.throws(() => editor.undo(result.undoToken), /üzerine yazılmadı/)
  assert.equal(JSON.stringify(downloads), changed)
  const next = apply({ ids: ['a'], series: 'Another', season: 3 })
  assert.throws(() => editor.undo(result.undoToken), /artık geri/)
  downloads.splice(downloads.findIndex((record) => record.id === 'a'), 1)
  assert.throws(() => editor.undo(next.undoToken), /üzerine yazılmadı/)
})
test('duplicates are deduplicated, no-op saves need no undo, and unrelated progress does not invalidate preview', () => {
  const { editor, downloads, commits } = fixture()
  const payload = { ids: ['a', 'a'], series: 'Old' }
  const preview = editor.preview(payload)
  downloads.find((record) => record.id === 'a').downloaded = 123
  const result = editor.apply({ ...payload, revision: preview.revision })
  assert.equal(result.count, 0); assert.equal(result.undoToken, null); assert.equal(commits(), 0)
})
