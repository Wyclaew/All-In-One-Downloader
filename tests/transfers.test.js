'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const { root, load } = require('./helpers.cjs')
const own = load('electron/lib/ownengine.js')
const payload = crypto.randomBytes(9 * 1024 * 1024 + 371)
let server, base
const requests = []
let dropped = false

test.before(async () => {
  server = http.createServer((req, res) => {
    requests.push({ path: req.url, range: req.headers.range, cookie: req.headers.cookie })
    if (req.url === '/private/start') { res.writeHead(302, { Location: '/public/file' }); res.end(); return }
    if (req.url === '/master') { res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\n/denied\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\n/viable\n'); return }
    if (req.url === '/waiting') return
    if (req.url === '/reject') { res.writeHead(429); res.end(); return }
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
    const start = Number(range?.[1] || 0)
    const end = range?.[2] ? Number(range[2]) : payload.length - 1
    if (req.url === '/no-range') {
      res.writeHead(200, { 'Content-Length': payload.length, 'Content-Type': 'video/mp4' })
      res.end(payload); return
    }
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/mp4', 'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${req.url === '/wrong-range' ? start + 1 : start}-${end}/${payload.length}` } : {}),
      ETag: '"test-v1"',
    })
    if (req.url === '/drop' && !dropped && end > 0) {
      dropped = true
      res.write(payload.subarray(start, start + 16001))
      setTimeout(() => res.destroy(), 20)
    } else if (req.url === '/slow') {
      let at = start
      const interval = setInterval(() => {
        if (at > end) { clearInterval(interval); res.end(); return }
        const to = Math.min(end + 1, at + 64000)
        res.write(payload.subarray(at, to)); at = to
      }, 8)
      res.once('close', () => clearInterval(interval))
    } else res.end(payload.subarray(start, end + 1))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
test.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); fs.rmSync(root, { recursive: true, force: true }) })
function options(name, route) {
  return { url: base + route, resolved: null, destPath: path.join(root, name), size: payload.length,
    connections: 4, validator: '"test-v1"', onHandle() {}, onNote() {}, onProgress() {} }
}
const matches = (p) => assert.equal(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'), crypto.createHash('sha256').update(payload).digest('hex'))

test('dynamic range workers produce an exact file, using many small tasks', async () => {
  const opts = options('parallel.mp4', '/file')
  await own.fetchFileParallel(opts)
  matches(opts.destPath)
  assert.ok(requests.filter((r) => r.path === '/file').length > 4)
  assert.equal(fs.existsSync(opts.destPath + '.part.parts'), false)
})
test('a dropped part retries just its missing bytes', async () => {
  const opts = options('drop.mp4', '/drop')
  await own.fetchFileParallel(opts)
  matches(opts.destPath)
  assert.ok(requests.some((r) => r.path === '/drop' && r.range.startsWith('bytes=16001-')))
})
test('wrong Content-Range and ignored Range never become a completed file', async () => {
  for (const route of ['/wrong-range', '/no-range']) {
    const opts = options(route.slice(1) + '.mp4', route)
    await assert.rejects(own.fetchFileParallel(opts), { code: 'NO_RANGE' })
    assert.equal(fs.existsSync(opts.destPath), false)
    const size = fs.statSync(opts.destPath + '.part').size
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(fs.statSync(opts.destPath + '.part').size, size)
  }
})
test('pause persists a safe journal and resumes without corrupting bytes', async () => {
  const opts = options('resume.mp4', '/slow')
  let handle
  opts.onHandle = (h) => { handle = h }
  let stopped = false
  opts.onProgress = (p) => { if (!stopped && p.downloaded > 100000) { stopped = true; handle.kill() } }
  await assert.rejects(own.fetchFileParallel(opts), { code: 'ABORTED' })
  const plan = own.readPlan(opts.destPath + '.part.parts', payload.length, '"test-v1"')
  assert.ok(plan.parts.some((p) => p.done > 0))
  assert.equal(own.readPlan(opts.destPath + '.part.parts', payload.length, '"changed"'), null)
  opts.onProgress = () => {}
  await own.fetchFileParallel(opts)
  matches(opts.destPath)
})
test('cancel interrupts a request still waiting for headers', async () => {
  const opts = options('pending.mp4', '/waiting')
  let handle
  opts.onHandle = (h) => { handle = h }
  const promise = own.fetchFileParallel(opts)
  setTimeout(() => handle.kill(), 40)
  await assert.rejects(promise, { code: 'ABORTED' })
})
test('an overlapping or incomplete resume plan is rejected', () => {
  const file = path.join(root, 'bad.parts')
  for (const parts of [[{ start: 0, end: 10, done: 0 }, { start: 5, end: 99, done: 0 }], [{ start: 0, end: 98, done: 0 }]]) {
    fs.writeFileSync(file, JSON.stringify({ size: 100, validator: null, parts }))
    assert.equal(own.readPlan(file, 100), null)
  }
})
test('single connection resumes only a correct range', async () => {
  const opts = options('single.mp4', '/file')
  fs.writeFileSync(opts.destPath + '.part', payload.subarray(0, 17777))
  await own.fetchFile(opts)
  matches(opts.destPath)
})

test('file probes and transfers recompute cookie path scope on same-origin redirects', async () => {
  const jar = path.join(root, 'scoped.txt')
  fs.writeFileSync(jar, '# Netscape HTTP Cookie File\n127.0.0.1\tFALSE\t/private\tFALSE\t0\tprivate\tyes\n')
  const before = requests.length
  const result = await own.probeVia(base + '/private/start', { cookieFile: jar }, '')
  assert.equal(result.size, payload.length)
  const seen = requests.slice(before)
  assert.equal(seen[0].cookie, 'private=yes')
  assert.equal(seen[1].cookie, undefined)
})
test('file metadata probing responds to cancellation while headers are stalled', async () => {
  const controller = new AbortController()
  const task = own.probeVia(base + '/waiting', {}, '', controller.signal)
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(task, (err) => err.name === 'AbortError' || err.code === 'ABORT_ERR')
})

test('transfer quality selection skips variants already rejected during verification', async () => {
  const picked = await own.pickVariant(base + '/master', { rejectedVariantUrls: [base + '/denied'] }, 1080)
  assert.equal(picked.url, base + '/viable')
  assert.equal(picked.height, 720)
  await assert.rejects(own.pickVariant(base + '/master', { rejectedVariantUrls: [base + '/denied', base + '/viable'] }, 1080), /geçerli değil/)
})
