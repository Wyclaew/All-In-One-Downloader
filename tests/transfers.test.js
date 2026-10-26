'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const http = require('http')
const net = require('net')
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
    if (req.url === '/nested-master') { res.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="outer",LANGUAGE="tr",DEFAULT=YES,URI="/audio-tr"\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,AUDIO="outer"\n/inner-master\n'); return }
    if (req.url === '/inner-master') { res.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="inner",LANGUAGE="en-US",DEFAULT=YES,URI="/audio-en"\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,AUDIO="inner"\n/media-leaf\n'); return }
    if (req.url === '/media-leaf') { res.end('#EXTM3U\n#EXTINF:1,\n/movie.ts\n#EXT-X-ENDLIST\n'); return }
    if (req.url === '/cycle-master') { res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n/cycle-master\n'); return }
    if (/^\/depth\/\d+$/.test(req.url)) { res.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n/depth/${Number(req.url.split('/').at(-1)) + 1}\n`); return }
    if (req.url === '/waiting') return
    if (req.url === '/reject') { res.writeHead(429); res.end(); return }
    if (req.url === '/partial') { res.writeHead(206, { 'Content-Range': `bytes 0-99/${payload.length}`, 'Content-Length': 100 }); res.end(payload.subarray(0, 100)); return }
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
    if (req.url === '/stalled-body') {
      res.write(payload.subarray(start, Math.min(end + 1, start + 16001)))
    } else if (req.url === '/drop' && !dropped && end > 0) {
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
  assert.equal(own.readPlan(opts.destPath + '.part.parts', payload.length, '"test-v1"', base + '/other-resource'), null)
  const damaged = plan.parts.find((p) => p.done > 0)
  const fd = fs.openSync(opts.destPath + '.part', 'r+')
  fs.writeSync(fd, Buffer.from([payload[damaged.start] ^ 0xff]), 0, 1, damaged.start); fs.closeSync(fd)
  const before = requests.length
  opts.onProgress = () => {}
  await own.fetchFileParallel(opts)
  matches(opts.destPath)
  assert.ok(requests.slice(before).some((req) => req.range === `bytes=${damaged.start}-${damaged.end}`), 'a corrupted saved prefix must be fetched again')
})
test('cancel interrupts a request still waiting for headers', async () => {
  const opts = options('pending.mp4', '/waiting')
  let handle
  opts.onHandle = (h) => { handle = h }
  const promise = own.fetchFileParallel(opts)
  setTimeout(() => handle.kill(), 40)
  await assert.rejects(promise, { code: 'ABORTED' })
})

test('an AbortSignal alone cancels plain transfers, closes writers and preserves resumable bytes', async () => {
  for (const connections of [1, 4]) {
    const controller = new AbortController()
    const download = { id: `signal-${connections}`, url: base + '/slow', title: `signal-${connections}`, resolved: { kind: 'file' } }
    let destination
    const config = { download, settings: { downloadDir: root, connections }, signal: controller.signal,
      onDest: (file) => { destination = file }, onHandle() {}, onNote() {},
      onProgress: (progress) => { if (progress.downloaded > 64000) controller.abort() } }
    await assert.rejects(own.transfer(config), { code: 'ABORTED' })
    assert.equal(fs.existsSync(destination), false)
    const partialSize = fs.statSync(destination + '.part').size
    const partialHash = crypto.createHash('sha256').update(fs.readFileSync(destination + '.part')).digest('hex')
    assert.ok(partialSize > 0)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(fs.statSync(destination + '.part').size, partialSize, 'no writer survives signal cancellation')
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(destination + '.part')).digest('hex'), partialHash, 'a preallocated file must not keep changing after cancellation')
    await own.transfer({ ...config, signal: undefined, onProgress() {} })
    matches(destination)
  }
})

test('simultaneous language jobs with identical titles do not share partials when one stops', async () => {
  const controller = new AbortController(), destinations = []
  const config = (index) => ({
    download: { id: `same-title-${index}`, url: base + '/slow', title: 'Same concurrent title', preferredAudioLanguage: index ? 'tr' : 'en', resolved: { kind: 'file' } },
    settings: { downloadDir: root, connections: 1 }, signal: index ? undefined : controller.signal,
    onDest: (file) => { destinations[index] = file }, onHandle() {}, onNote() {},
    onProgress: (progress) => { if (!index && progress.downloaded > 64000) controller.abort() },
  })
  const first = config(0), second = config(1)
  const outcomes = await Promise.allSettled([own.transfer(first), own.transfer(second)])
  assert.equal(outcomes[0].status, 'rejected'); assert.equal(outcomes[0].reason.code, 'ABORTED')
  assert.equal(outcomes[1].status, 'fulfilled')
  assert.notEqual(destinations[0], destinations[1])
  matches(destinations[1])
  await own.transfer({ ...first, signal: undefined, onProgress() {} })
  matches(destinations[0]); matches(destinations[1])
  assert.equal(fs.existsSync(destinations[0] + '.aio-owner'), false)
  assert.equal(fs.existsSync(destinations[1] + '.aio-owner'), false)
})

test('already-aborted file requests never create output and signal cancels a header wait', async () => {
  for (const transfer of [own.fetchFile, own.fetchFileParallel]) {
    const controller = new AbortController(); controller.abort()
    const opts = options('never-' + transfer.name + '.mp4', '/file')
    await assert.rejects(transfer({ ...opts, signal: controller.signal }), { code: 'ABORTED' })
    assert.equal(fs.existsSync(opts.destPath + '.part'), false)
  }
  const controller = new AbortController()
  const opts = options('signal-headers.mp4', '/waiting')
  const pending = own.fetchFile({ ...opts, signal: controller.signal })
  setTimeout(() => controller.abort(), 25)
  await assert.rejects(pending, { code: 'ABORTED' })
})

test('the native socket watchdog also interrupts a response that stalls after body bytes', async () => {
  const response = await own.openStream(base + '/stalled-body', {})
  assert.equal(response.stream.socket.timeout, 15000)
  // Keep the actual production timeout handler, shortening only this fixture's
  // inactivity interval so the regression does not sleep fifteen seconds.
  response.request.setTimeout(80)
  let received = 0
  await assert.rejects((async () => {
    for await (const bytes of response.stream) received += bytes.length
  })(), (error) => ['ECONNRESET', 'ETIMEDOUT'].includes(error.code))
  assert.ok(received > 0 && received < payload.length)
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
  fs.writeFileSync(opts.destPath + '.part.single', JSON.stringify({ version: 2,
    resource: crypto.createHash('sha256').update(opts.url).digest('hex'), validator: opts.validator,
    size: 17777, hash: crypto.createHash('sha256').update(payload.subarray(0, 17777)).digest('hex') }))
  const before = requests.length
  await own.fetchFile(opts)
  matches(opts.destPath)
  assert.ok(requests.slice(before).some((req) => req.range === 'bytes=17777-'))
  const wrong = options('single-wrong.mp4', '/partial')
  await assert.rejects(own.fetchFile(wrong), /Sürdürme aralığı/)
  assert.equal(fs.existsSync(wrong.destPath), false)
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

test('nested HLS selection preserves child audio scope and bounds cycles/depth', async () => {
  const picked = await own.pickVariant(base + '/nested-master', {}, 1080, null, '', 'en')
  assert.deepEqual(picked, { url: base + '/media-leaf', height: 720, audioUrl: base + '/audio-en', audioLanguage: 'en-us' })
  await assert.rejects(own.pickVariant(base + '/cycle-master'), /döngü/)
  await assert.rejects(own.pickVariant(base + '/depth/0'), /sınır/)
})

test('prepared verified HLS leaves preserve quality and audio without fetching unverified branches', async () => {
  const before = requests.length
  const preparedVariants = [{ url: base + '/nested-master', mediaUrl: base + '/verified-leaf', height: 720,
    audioTracks: [{ url: base + '/tr', lang: 'tr', default: true }, { url: base + '/en', lang: 'en-US' }] }]
  const picked = await own.pickVariant(base + '/master', { preparedVariants }, 1080, null, '', 'en')
  assert.deepEqual(picked, { url: base + '/verified-leaf', height: 720, audioUrl: base + '/en', audioLanguage: 'en-US' })
  assert.equal(requests.length, before)
})

test('direct simultaneous transfers ignore a configured active proxy and ambient proxy variables', async () => {
  let proxyBytes = 0
  const clients = new Set()
  const proxyServer = http.createServer()
  proxyServer.on('connect', (_req, client, head) => {
    clients.add(client); client.on('error', () => {}); client.once('close', () => clients.delete(client))
    const remote = net.connect(server.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) { proxyBytes += head.length; remote.write(head) }
      client.on('data', (chunk) => { proxyBytes += chunk.length })
      client.pipe(remote).pipe(client)
    })
    remote.on('error', () => client.destroy()); client.once('close', () => remote.destroy())
  })
  await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve))
  const proxy = `http://127.0.0.1:${proxyServer.address().port}`
  const inherited = Object.fromEntries(['http_proxy', 'https_proxy', 'ALL_PROXY'].map((key) => [key, process.env[key]]))
  try {
    await own.probeVia(base + '/file', {}, proxy)
    assert.ok(proxyBytes > 0, 'the control request proves that this live proxy works')
    const before = proxyBytes
    for (const key of Object.keys(inherited)) process.env[key] = proxy
    const transfer = (index) => own.transfer({
      download: { id: `direct-${index}`, url: base + '/file', title: `direct-${index}`, useProxy: false, resolved: { kind: 'file' } },
      settings: { proxyUrl: proxy, downloadDir: root, connections: 4 },
      onProgress() {}, onHandle() {}, onNote() {},
    })
    const outputs = await Promise.all([transfer(1), transfer(2)])
    outputs.forEach((output) => matches(output.filePath))
    assert.equal(proxyBytes, before, 'neither direct transfer sent any bytes to the active proxy')
  } finally {
    for (const [key, value] of Object.entries(inherited)) value === undefined ? delete process.env[key] : process.env[key] = value
    require('../electron/lib/proxy').releaseAgents(proxy)
    for (const client of clients) client.destroy()
    await new Promise((resolve) => proxyServer.close(resolve))
  }
})
