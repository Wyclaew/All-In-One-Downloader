'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { assertSpace, freeSpace, MiB } = require('../electron/lib/disk-space')
const { queuedInOrder, activeDuplicate, bringToFront } = require('../electron/lib/queue-order')
test('disk preflight reserves space and tells the user how to safely continue', () => {
  assert.throws(() => assertSpace('.', { availableBytes: 100 * MiB, requiredBytes: 90 * MiB, reserveBytes: 20 * MiB }), { code: 'ENOSPC' })
  assert.equal(assertSpace('.', { availableBytes: 120 * MiB, requiredBytes: 90 * MiB, reserveBytes: 20 * MiB }).freeBytes, 120 * MiB)
  assert.equal(assertSpace('.', { availableBytes: null }), null)
  assert.ok(freeSpace(__dirname) === null || freeSpace(__dirname) > 0)
})
test('newest-first library rows execute FIFO, explicit priorities preserve every queued item', () => {
  const list = [{ id: 'c', createdAt: 3, status: 'queued' }, { id: 'b', createdAt: 2, status: 'queued' }, { id: 'a', createdAt: 1, status: 'queued' }, { id: 'running', status: 'running' }]
  assert.deepEqual(queuedInOrder(list).map((d) => d.id), ['a', 'b', 'c'])
  assert.equal(bringToFront(list, 'c'), true)
  assert.deepEqual(queuedInOrder(list).map((d) => d.id), ['c', 'a', 'b'])
  assert.equal(bringToFront(list, 'running'), false)
})
test('duplicate protection distinguishes quality and audio without blocking completed redownloads', () => {
  const d = { url: 'https://example.test/v', quality: 720, audioOnly: false, status: 'running' }
  assert.equal(activeDuplicate([d], { url: d.url, quality: 720 }), d)
  assert.equal(activeDuplicate([d], { url: d.url, quality: 1080 }), null)
  assert.equal(activeDuplicate([{ ...d, status: 'done' }], { url: d.url, quality: 720 }), null)
})
