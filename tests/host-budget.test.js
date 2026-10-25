'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createHostBudget } = require('../electron/lib/host-budget')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('host admission limits active requests, queues in order and cancels waiters', async () => {
  const budget = createHostBudget()
  const url = 'https://one.example/video'
  const first = await budget.acquire(url, { maximum: 1 })
  const controller = new AbortController()
  const cancelled = budget.acquire(url, { maximum: 1, signal: controller.signal })
  const next = budget.acquire(url, { maximum: 1 })
  assert.deepEqual(budget.snapshot(url), { limit: 1, active: 1, waiting: 2, coolingDown: false })
  controller.abort()
  await assert.rejects(cancelled, { code: 'ABORTED' })
  first.release(); first.release()
  const second = await next
  assert.equal(budget.snapshot(url).active, 1)
  second.release()
  assert.equal(budget.snapshot(url).active, 0)
})

test('429 halves shared concurrency, bounds Retry-After and recovers gradually', async () => {
  const budget = createHostBudget({ minCooldownMs: 15, maxCooldownMs: 35, recoveryEvery: 1 })
  const url = 'https://busy.example/video'
  const permit = await budget.acquire(url, { maximum: 4 })
  const start = Date.now()
  permit.release(Object.assign(new Error('HTTP 429'), { retryAfter: '90' }))
  assert.deepEqual(budget.snapshot(url), { limit: 2, active: 0, waiting: 0, coolingDown: true })
  const next = await budget.acquire(url, { maximum: 4 })
  assert.ok(Date.now() - start >= 25)
  next.release()
  for (let i = 0; i < 3; i += 1) (await budget.acquire(url, { maximum: 4 })).release()
  assert.equal(budget.snapshot(url).limit, 3)
  for (let i = 0; i < 6; i += 1) (await budget.acquire(url, { maximum: 4 })).release()
  assert.equal(budget.snapshot(url).limit, 4)
})

test('budgets are separated by route and bound retained origins without losing active permits', async () => {
  const budget = createHostBudget({ maxEntries: 2 })
  const url = 'https://same.example/video'
  const first = await budget.acquire(url, { proxy: 'socks5://user:secret@127.0.0.1:9061', maximum: 1 })
  const direct = await budget.acquire(url, { maximum: 1 })
  assert.equal(budget.snapshot(url).active, 1)
  const controller = new AbortController()
  const cancelled = budget.acquire('https://cancelled.example/', { signal: controller.signal })
  const pending = budget.acquire('https://next.example/')
  controller.abort()
  await assert.rejects(cancelled, { code: 'ABORTED' })
  await delay(10)
  assert.equal(budget.snapshot('https://next.example/'), null)
  first.release()
  const next = await pending
  assert.equal(budget.snapshot('https://next.example/').active, 1)
  assert.equal(budget.snapshot(url).active, 1)
  direct.release(); next.release()
})

test('cancelling the last cooling waiter admits a different origin immediately', { timeout: 1500 }, async () => {
  const budget = createHostBudget({ maxEntries: 1, minCooldownMs: 60000 })
  const first = await budget.acquire('https://cooling.example/')
  first.release(new Error('HTTP 429'))
  const controller = new AbortController()
  const cooling = budget.acquire('https://cooling.example/', { signal: controller.signal })
  const rejected = assert.rejects(cooling, { code: 'ABORTED' })
  const other = budget.acquire('https://ready.example/')
  controller.abort()
  await rejected
  const permit = await other
  assert.equal(budget.snapshot('https://cooling.example/'), null)
  assert.equal(budget.snapshot('https://ready.example/').active, 1)
  permit.release()
})
