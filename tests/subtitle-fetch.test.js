'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const http = require('http')
const { root, load } = require('./helpers.cjs')
load('electron/lib/mediainfo.js')
const { fetchSubtitle, cleanupSubtitle } = require('../electron/lib/subtitle-fetch')
let server, base
const seen = []
const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nA caption\n'
test.before(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie })
    res.setHeader('Content-Type', 'text/vtt')
    if (req.url === '/redirect') { res.writeHead(302, { Location: `http://localhost:${server.address().port}/direct.vtt` }); res.end(); return }
    if (req.url === '/direct.vtt' || req.url === '/opaque-caption') { if (req.url === '/opaque-caption') res.setHeader('Content-Type', 'application/octet-stream'); res.end(vtt); return }
    if (req.url === '/direct.srt') { res.setHeader('Content-Type', 'application/x-subrip'); res.end('1\n00:00:00,000 --> 00:00:01,000\nA caption\n'); return }
    if (req.url === '/master.m3u8') { res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n/subs.m3u8\n'); return }
    if (req.url === '/subs.m3u8' || req.url === '/broken.m3u8') { res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/one.vtt\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\n' + (req.url === '/broken.m3u8' ? '/stall.vtt\n' : '/two.vtt\n') + '#EXT-X-ENDLIST\n'); return }
    if (req.url === '/one.vtt' || req.url === '/two.vtt') { res.end(vtt); return }
    if (req.url === '/stall.vtt') return
    if (req.url === '/live.m3u8') { res.end('#EXTM3U\n#EXTINF:2,\n/one.vtt\n'); return }
    if (req.url === '/drm.m3u8') { res.end('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://license.example.test/key"\n#EXTINF:2,\n/one.vtt\n#EXT-X-ENDLIST\n'); return }
    if (req.url === '/large.vtt') { res.end('WEBVTT\n' + 'x'.repeat(3 * 1024 * 1024)); return }
    if (req.url === '/html.vtt') { res.setHeader('Content-Type', 'text/html'); res.end('<html>login</html>'); return }
    res.writeHead(404); res.end()
  })
  await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`
})
test.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); fs.rmSync(root, { recursive: true, force: true }) })

test('single subtitle is local before conversion, with scoped redirects and exclusive cleanup', async () => {
  const jar = path.join(root, 'jar.txt'), out = path.join(root, 'single-input')
  fs.writeFileSync(jar, '127.0.0.1\tFALSE\t/\tFALSE\t0\tprivate\tyes\n')
  const local = await fetchSubtitle(base + '/redirect', out, { resolved: { cookieFile: jar } })
  assert.equal(local, out)
  assert.equal(fs.readFileSync(local, 'utf8'), vtt)
  assert.equal(seen.find((r) => r.url === '/redirect').cookie, 'private=yes')
  assert.equal(seen.find((r) => r.url === '/direct.vtt').cookie, undefined)
  await cleanupSubtitle(out)
  assert.equal(fs.existsSync(local), false)
  fs.writeFileSync(out, 'existing user data')
  await assert.rejects(fetchSubtitle(base + '/direct.vtt', out), { code: 'EEXIST' })
  assert.equal(fs.readFileSync(out, 'utf8'), 'existing user data')
})
test('segmented WebVTT becomes a local-only playlist preserving timing and discontinuities', async () => {
  const out = path.join(root, 'hls-input')
  const local = await fetchSubtitle(base + '/master.m3u8', out)
  const playlist = fs.readFileSync(local, 'utf8')
  assert.ok(playlist.includes('#EXT-X-DISCONTINUITY'))
  assert.ok(playlist.includes('hls-input.parts/0.vtt'))
  assert.ok(!/https?:|URI=/.test(playlist))
  assert.equal(fs.readFileSync(out + '.parts/1.vtt', 'utf8'), vtt)
  await cleanupSubtitle(out)
  assert.equal(fs.existsSync(out + '.parts'), false)
})
test('SubRip with its standard application MIME remains a supported text input', async () => {
  const out = path.join(root, 'subrip-input')
  const local = await fetchSubtitle(base + '/direct.srt', out)
  assert.ok(fs.readFileSync(local, 'utf8').includes('00:00:00,000 -->'))
  await cleanupSubtitle(out)
})
test('fetched subtitles can be converted by FFmpeg with networking disabled', async (t) => {
  const { ffmpegPath, toolEnv } = load('electron/lib/binaries.js')
  const bin = ffmpegPath()
  if (!bin) return t.skip('FFmpeg unavailable')
  const { execFileSync } = require('child_process')
  for (const route of ['/direct.vtt', '/subs.m3u8']) {
    const out = path.join(root, route === '/direct.vtt' ? 'convert-direct' : 'convert-hls')
    const local = await fetchSubtitle(base + route, out)
    try {
      const args = ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file']
      if (local.endsWith('.m3u8')) args.push('-allowed_extensions', 'ALL')
      args.push('-i', local, '-c:s', 'srt', '-f', 'srt', 'pipe:1')
      const converted = execFileSync(bin, args, { env: toolEnv(), timeout: 10000 }).toString()
      assert.ok(converted.includes('A caption'), route)
    } finally { await cleanupSubtitle(out) }
  }
})
test('live, DRM, HTML and oversized subtitles are rejected with no temporary leftovers', async () => {
  for (const route of ['/live.m3u8', '/drm.m3u8', '/html.vtt', '/large.vtt']) {
    const out = path.join(root, route.slice(1))
    await assert.rejects(fetchSubtitle(base + route, out))
    assert.equal(fs.existsSync(out), false)
    assert.equal(fs.existsSync(out + '.parts'), false)
  }
  assert.ok(!seen.some((r) => r.url === '/key'))
})
test('cancelled subtitle workers finish before their temporary directory is removed', async () => {
  const out = path.join(root, 'cancel-input'), controller = new AbortController()
  const pending = fetchSubtitle(base + '/broken.m3u8', out, { signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(pending)
  assert.equal(fs.existsSync(out + '.parts'), false)
})

test('valid extensionless WebVTT survives a CDN generic binary MIME label', async () => {
  const out = path.join(root, 'opaque-caption')
  try {
    assert.equal(await fetchSubtitle(base + '/opaque-caption', out), out)
    assert.ok(fs.readFileSync(out, 'utf8').startsWith('WEBVTT'))
  } finally { await cleanupSubtitle(out) }
})
