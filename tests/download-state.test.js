'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), vm = require('node:vm')
const { transformSync } = require('esbuild')
const mod = { exports: {} }
vm.runInNewContext(transformSync(fs.readFileSync('src/download-state.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module: mod, exports: mod.exports })
const { downloadForItem, mergeProgress, mediaPreferenceKey } = mod.exports
const { sameMedia } = require('../electron/lib/queue-order')
const item = { id: 'new-id', sourceId: 'source', title: 'The Mentalist 1. Sezon 8. Bölüm', url: 'https://cdn-new.test/master', resolved: { pageUrl: 'https://page.test/episode8', kind: 'hls' } }
const job = { id: 'job', sourceId: 'source', itemId: 'old-id', title: item.title + ' · akış 1', url: 'https://cdn-old.test/master', status: 'running', createdAt: 1, attempts: 2, progressSequence: 10, percent: .4, resolved: item.resolved }
test('source rows and duplicate detection retain job identity after rescan/CDN refresh', () => {
  assert.equal(downloadForItem(item, [job]), job)
  assert.equal(sameMedia(job, { item }), true)
  assert.equal(downloadForItem({ ...item, sourceId: 'other' }, [job]), null)
  const failed = { ...job, id: 'failed', status: 'error', createdAt: 50 }
  assert.equal(downloadForItem(item, [failed, job]), job)
  assert.equal(downloadForItem({ ...item, title: 'Different episode' }, [job]), null)
  assert.equal(mediaPreferenceKey(item), mediaPreferenceKey({ ...item, id: 'rescanned', url: 'https://cdn-changed.test/master', title: item.title + ' · akış 1' }))
})
test('old attempt/sequence and stale download progress cannot overwrite retry or processing state', () => {
  const live = { id: job.id, status: 'running', stage: 'downloading', percent: .9, attempt: 1, sequence: 100 }
  assert.equal(mergeProgress(job, live), job)
  assert.equal(mergeProgress(job, { ...live, attempt: 2, sequence: 9 }), job)
  assert.equal(mergeProgress({ ...job, stage: 'processing' }, { ...live, attempt: 2, sequence: 11 }).stage, 'processing')
  assert.equal(mergeProgress(job, { ...live, attempt: 2, sequence: 11 }).percent, .9)
})
test('audio and subtitle rendition rows disappear only beside their parent video in the same source', () => {
  const { withoutRenditionRows } = require('../electron/lib/media-catalog')
  const parent = { ...item, height: 720, audioTracks: [{ url: 'https://cdn.test/audio' }] }
  const audio = { ...item, id: 'audio', height: null, url: 'https://cdn.test/audio' }
  const independent = { ...audio, id: 'other-source-audio', sourceId: 'other' }
  assert.deepEqual(withoutRenditionRows([parent, audio, independent]).map((i) => i.id), [parent.id, independent.id])
  assert.deepEqual(withoutRenditionRows([audio]), [audio])
})
