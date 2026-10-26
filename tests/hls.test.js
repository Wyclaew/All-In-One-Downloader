'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const { root, load } = require('./helpers.cjs')
const own = load('electron/lib/ownengine.js') // Runtime HTTP dependency uses the Electron shim.
const hls = load('electron/lib/hls-native.js')
const { ffmpegPath, ffprobePath, toolEnv } = load('electron/lib/binaries.js')
const bin = ffmpegPath(), probe = ffprobePath()
let server, base, files, playlist, packed, offsets
const requests = []
const key = crypto.randomBytes(16)
test.before(async () => {
  if (!bin || !probe) return
  const fixture = path.join(root, 'fixture'); fs.mkdirSync(fixture)
  execFileSync(bin, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=128x96:r=10:d=4', '-f', 'lavfi', '-i', 'sine=frequency=400:duration=4', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-g', '10', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', path.join(fixture, 'movie.m3u8')], { env: toolEnv() })
  execFileSync(bin, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=128x96:r=10:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', '-hls_segment_type', 'fmp4', path.join(fixture, 'fragmented.m3u8')], { env: toolEnv() })
  execFileSync(bin, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=600:duration=3', '-c:a', 'aac', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', path.join(fixture, 'audio.m3u8')], { env: toolEnv() })
  files = Object.fromEntries(fs.readdirSync(fixture).map((name) => [name, fs.readFileSync(path.join(fixture, name))]))
  playlist = files['movie.m3u8'].toString()
  const segments = hls.parseMediaPlaylist(playlist, 'http://local/').segments
  let at = 0
  offsets = segments.map((s) => { const size = files[new URL(s.url).pathname.slice(1)].length; const offset = at; at += size; return { offset, size } })
  packed = Buffer.concat(segments.map((s) => files[new URL(s.url).pathname.slice(1)]))
  server = http.createServer((req, res) => {
    requests.push({ url: req.url, range: req.headers.range })
    const route = new URL(req.url, 'http://local').pathname.split('/').filter(Boolean)
    const mode = route.length > 1 ? route[0] : '', name = route.at(-1)
    if (name === 'waiting') return
    if (name === 'key') { res.end(key); return }
    if (mode === 'bad' && name.endsWith('.ts')) { res.writeHead(200); res.end('<html>Forbidden</html>'); return }
    if (mode === 'missing' && name === 'movie1.ts') { res.writeHead(404); res.end(); return }
    let data = files[name]
    if (!data) { res.writeHead(404); res.end(); return }
    if (name === 'movie.m3u8' && mode === 'aes') data = Buffer.from(playlist.replace('#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-KEY:METHOD=AES-128,URI="key"'))
    if (name.endsWith('.ts') && mode === 'aes') {
      const sequence = 7 + Number(name.match(/(\d+)\.ts/)[1])
      const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.from(sequence.toString(16).padStart(32, '0'), 'hex'))
      data = Buffer.concat([cipher.update(data), cipher.final()])
    }
    if (name === 'movie.m3u8' && mode === 'ranges') data = Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:1\n' + offsets.map((o, i) => `#EXTINF:1,\n#EXT-X-BYTERANGE:${o.size}${i ? '' : '@0'}\npacked.ts`).join('\n') + '\n#EXT-X-ENDLIST\n')
    if (name === 'packed.ts') data = packed
    if (mode === 'prefix' && name.endsWith('.ts')) data = Buffer.concat([Buffer.from('CDN marker\n'), data])
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/)
    if (range) {
      const start = Number(range[1]), end = Number(range[2])
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 }); data = data.subarray(start, end + 1)
    } else res.writeHead(200, { 'Content-Length': data.length, 'Content-Type': name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'application/octet-stream' })
    if (mode === 'slow' && name.endsWith('.ts')) setTimeout(() => res.end(data), 350)
    else res.end(data)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`
})
test.after(async () => { if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)) }; fs.rmSync(root, { recursive: true, force: true }) })
function options(name, mode = '') { return { url: `${base}/${mode ? mode + '/' : ''}movie.m3u8`, destPath: path.join(root, name + '.mp4'), download: { audioOnly: false }, settings: { connections: 4 }, onHandle() {}, onNote() {}, onProgress() {} } }
function inspect(file) { return JSON.parse(execFileSync(probe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { env: toolEnv() })) }
const skip = !bin || !probe

test('HLS parser preserves byte ranges, sequence IV and rejects live/DRM', () => {
  const p = hls.parseMediaPlaylist('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:1,\n#EXT-X-BYTERANGE:500@0\npacked.ts\n#EXTINF:1,\n#EXT-X-BYTERANGE:500\npacked.ts\n#EXT-X-ENDLIST', 'https://example.test/v/playlist')
  assert.deepEqual(p.segments[1].range, { start: 500, end: 999 })
  assert.equal(p.segments[1].key.iv, '00000000000000000000000000000008')
  assert.throws(() => hls.parseMediaPlaylist('#EXTM3U\n#EXTINF:1,\na.ts', 'https://example.test/'), { code: 'HLS_UNSUPPORTED' })
  assert.throws(() => hls.parseMediaPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST', 'https://example.test/'), /DRM/)
})
test('own HLS engine transfers plain, AES-128, byte-range and prefixed fragments to playable files', { skip }, async () => {
  // packed.ts is a generated concatenation, supplied below via server's lookup.
  files['packed.ts'] = packed
  for (const mode of ['', 'aes', 'ranges', 'prefix']) {
    const opts = options('output-' + (mode || 'plain'), mode)
    await hls.transferHls(opts)
    const info = inspect(opts.destPath)
    assert.ok(Number(info.format.duration) >= 3.8, mode)
    assert.ok(info.streams.some((s) => s.codec_type === 'video'))
    assert.equal(fs.existsSync(opts.destPath + '.segments'), false)
  }
  assert.ok(requests.some((r) => r.range?.startsWith('bytes=')))
})
test('fMP4 initialization maps and separate English audio are muxed locally', { skip }, async () => {
  const opts = { ...options('mapped'), url: base + '/fragmented.m3u8', audioUrl: base + '/audio.m3u8', audioLanguage: 'en-US' }
  await hls.transferHls(opts)
  const info = inspect(opts.destPath)
  assert.ok(info.streams.some((s) => s.codec_type === 'video'))
  assert.equal(info.streams.find((s) => s.codec_type === 'audio').tags.language, 'eng')
})

test('HDF-style Original Audio selects its actual separate packets and stays original, not falsely English', { skip }, async () => {
  const download = { id: 'named-original', title: 'Named original', url: base + '/master', quality: 720, preferredAudioLanguage: 'original',
    resolved: { kind: 'hls', preparedVariants: [{ url: base + '/master', mediaUrl: base + '/fragmented.m3u8', height: 96,
      audioTracks: [{ name: 'Turkish', default: true, url: base + '/movie.m3u8' }, { name: 'Original Audio', url: base + '/audio.m3u8' }] }] } }
  const before = requests.length
  const { filePath } = await own.transfer({ download, settings: { downloadDir: root, connections: 4 }, onHandle() {}, onProgress() {} })
  assert.equal(requests.slice(before).some((r) => r.url === '/movie.m3u8'), false)
  assert.equal(requests.slice(before).some((r) => r.url === '/audio.m3u8'), true)
  const audio = load('electron/lib/audio-selection.js')
  const selected = await audio.selectAudio(filePath, 'original')
  assert.equal(selected.matched, true); assert.equal(selected.language, null)
  const pcm = execFileSync(bin, ['-v', 'error', '-i', filePath, '-map', '0:a:0', '-t', '2', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { env: toolEnv() })
  const power = (frequency) => {
    let real = 0, imaginary = 0
    for (let sample = 0; sample < pcm.length / 2; sample += 4) {
      const angle = 2 * Math.PI * frequency * sample / 48000, value = pcm.readInt16LE(sample * 2)
      real += value * Math.cos(angle); imaginary += value * Math.sin(angle)
    }
    return real * real + imaginary * imaginary
  }
  assert.ok(power(600) > power(400) * 100, 'the original 600 Hz sound must dominate, not the 400 Hz dub')
})
test('pausing preserves verified fragments and resume skips completed network requests', { skip }, async () => {
  const opts = options('resumed', 'slow')
  opts.settings.connections = 1
  const controller = new AbortController(); opts.signal = controller.signal
  opts.onProgress = (p) => { if (p.percent > 0) controller.abort() }
  await assert.rejects(hls.transferHls(opts), { code: 'ABORTED' })
  const dir = opts.destPath + '.segments'
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json')))
  const saved = Object.keys(plan.completed)
  assert.ok(saved.length > 0 && saved.length < 4)
  const before = requests.length
  opts.signal = undefined; opts.onProgress = () => {}
  await hls.transferHls(opts)
  for (const index of saved) assert.ok(!requests.slice(before).some((r) => r.url === `/slow/movie${index}.ts`))
  assert.ok(Number(inspect(opts.destPath).format.duration) >= 3.8)
})
test('error HTML is never muxed as a successful video', { skip }, async () => {
  const opts = options('bad', 'bad')
  await assert.rejects(hls.transferHls(opts), (err) => err.status === 403)
  assert.equal(fs.existsSync(opts.destPath), false)
})
test('a missing middle segment fails native and remote FFmpeg paths without publishing an incomplete file', { skip }, async () => {
  const native = options('missing-native', 'missing')
  await assert.rejects(hls.transferHls(native), (error) => error.status === 404)
  assert.equal(fs.existsSync(native.destPath), false)
  let output
  await assert.rejects(own.transfer({ download: { id: 'missing-remote', url: native.url, title: 'missing-remote', duration: 4, resolved: { kind: 'hls' } },
    settings: { downloadDir: root, container: 'mp4', nativeHls: false, preferredAudioLanguage: 'auto' },
    onDest(file) { output = file }, onHandle() {}, onProgress() {}, onNote() {},
  }), { code: 'MEDIA_INCOMPLETE', exitCode: 0 })
  assert.equal(fs.existsSync(output), false)
  assert.equal(fs.existsSync(output + '.part'), false)
})
test('cancellation interrupts HLS header wait and foreign temporary data stays untouched', { skip }, async () => {
  const opts = { ...options('waiting'), url: base + '/waiting' }
  const controller = new AbortController(); opts.signal = controller.signal
  const work = hls.transferHls(opts); setTimeout(() => controller.abort(), 35)
  await assert.rejects(work, { code: 'ABORTED' })
  const foreign = options('foreign'); fs.mkdirSync(foreign.destPath + '.segments'); fs.writeFileSync(foreign.destPath + '.segments/important', 'keep')
  await assert.rejects(hls.transferHls(foreign), { code: 'HLS_UNSUPPORTED' })
  assert.equal(fs.readFileSync(foreign.destPath + '.segments/important', 'utf8'), 'keep')
})
test('a failed audio manifest cancels the sibling track still waiting for headers', { skip }, async () => {
  const opts = { ...options('manifest-failed'), url: base + '/waiting', audioUrl: base + '/not-found.m3u8' }
  const start = Date.now()
  await assert.rejects(hls.transferHls(opts), (err) => err.status === 404)
  assert.ok(Date.now() - start < 2000)
  assert.equal(fs.existsSync(opts.destPath), false)
})
