'use strict'
// Real Chromium + local controlled pages, isolated from the user's app data.
const { app } = require('electron')
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http')
const assert = require('assert/strict')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-fixture-browser-'))
app.setPath('userData', profile)
app.on('window-all-closed', () => {})
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_e, level, message) => { if (level >= 3) console.error('Fixture renderer:', message) })
})
let server, exitCode = 0
app.whenReady().then(async () => {
  const { resolvePage } = require('../../electron/lib/resolver')
  const { describeStream } = require('../../electron/lib/mediainfo')
  const { execFileSync } = require('child_process')
  const { ffmpegPath, toolEnv } = require('../../electron/lib/binaries')
  const moviePath = path.join(profile, 'runtime.mp4')
  const ffmpeg = ffmpegPath()
  if (ffmpeg) execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=128x96:r=10:d=2.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-movflags', '+faststart', moviePath], { env: toolEnv() })
  const received = []
  let base
  server = http.createServer((req, res) => {
    received.push({ path: req.url, method: req.method, referer: req.headers.referer, cookie: req.headers.cookie })
    res.setHeader('Content-Type', 'text/html')
    if (req.url.startsWith('/opaque')) { res.setHeader('Content-Type', 'image/png'); res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=128x96\n/child\n'); return }
    if (req.url === '/child') { res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); res.end('#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\n/fragment.ts\n#EXT-X-ENDLIST\n'); return }
    if (req.url === '/missing.mp4') { res.writeHead(404); res.end('<html>not found</html>'); return }
    if (req.url === '/poster.mp4') { res.end('<html>HTML disguised as mp4</html>'); return }
    if (req.url === '/exchange' && req.method === 'POST') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ playback: { sources: [{ url: '/opaque?post=1', type: 'application/x-mpegURL' }] } })); return }
    if (req.url === '/runtime') { res.setHeader('Set-Cookie', 'runtime=yes; Path=/'); res.end('<title>Runtime metadata fixture</title><video muted preload="metadata"></video><script>setTimeout(()=>{ document.querySelector("video").src="/runtime.mp4" },1200)</script>'); return }
    if (req.url === '/runtime.mp4' && ffmpeg) {
      if (!/runtime=yes/.test(req.headers.cookie || '')) { res.writeHead(403); res.end(); return }
      const bytes = fs.readFileSync(moviePath)
      res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Accept-Ranges', 'bytes')
      const range = String(req.headers.range || '').match(/^bytes=(\d+)-(\d*)$/)
      if (range) {
        const start = Number(range[1]), end = range[2] ? Math.min(bytes.length - 1, Number(range[2])) : bytes.length - 1
        res.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${bytes.length}` }); res.end(bytes.subarray(start, end + 1)); return
      }
      res.setHeader('Content-Length', bytes.length); res.end(req.method === 'HEAD' ? undefined : bytes); return
    }
    if (req.url === '/root') { res.end('<title>Nested fixture</title><track kind="subtitles" srclang="tr" src="/tr.vtt"><iframe src="/wrapper"></iframe>'); return }
    if (req.url === '/wrapper') { res.end('<iframe src="/dynamic"></iframe>'); return }
    const fetchScript = `fetch('/exchange', {method:'POST',body:'id=123'}).then(r=>r.json()).then(value=>window.playback=value)`
    if (req.url === '/dynamic') { res.end(`<title>POST fixture</title><script>setTimeout(()=>{${fetchScript}},1000)</script>`); return }
    if (req.url === '/alternative') { res.end(`<title>Alternative player</title><div class="player-options"><button onclick="${fetchScript}">English original</button></div>`); return }
    if (req.url === '/state') { res.end('<title>State fixture</title><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"sources":[{"url":"/opaque?state=1","type":"application/x-mpegURL"}]}}}</script>'); return }
    if (req.url === '/segments-only') { res.setHeader('Set-Cookie', 'derive=yes; Path=/'); res.end('<title>Segment fixture</title><script>setTimeout(()=>fetch("/content/fragment.ts"),1000)</script>'); return }
    if (req.url === '/content/fragment.ts') { res.setHeader('Content-Type', 'application/octet-stream'); res.end('fragment'); return }
    if (req.url === '/content/master.m3u8') return // Deliberately stalled CDN.
    if (req.url === '/drm') { res.setHeader('Content-Type', 'image/png'); res.end('<MPD mediaPresentationDuration="PT3S"><Period><AdaptationSet><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><Representation id="v" height="96" bandwidth="400000"/></AdaptationSet></Period></MPD>'); return }
    res.writeHead(404); res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`
  const results = []
  for (const route of ['/opaque', '/state', '/root', '/alternative']) {
    const result = await resolvePage(base + route, { timeoutMs: 12000, minStreamSeconds: 0, useUserScripts: false, onProgress: (note) => console.log(route + ': ' + note) })
    assert.ok(result.candidates.some((c) => c.kind === 'hls' && c.info?.duration === 3), `${route}: no verified stream; ${JSON.stringify({ result, received })}`)
    if (route === '/root') assert.ok(result.candidates[0].subtitles.some((t) => t.lang === 'tr' && t.url === base + '/tr.vtt'))
    results.push({ route, engine: result.engine, candidates: result.candidates.length })
  }
  assert.ok(received.some((r) => r.path === '/exchange' && r.method === 'POST'))
  if (ffmpeg) {
    const runtime = await resolvePage(base + '/runtime', { timeoutMs: 12000, minStreamSeconds: 0, useUserScripts: false })
    const candidate = runtime.candidates.find((c) => c.url === base + '/runtime.mp4')
    assert.ok(candidate, 'Loaded video runtime metadata was not associated with the source')
    assert.equal(candidate.info.durationSource, 'player')
    assert.equal(candidate.info.duration, 2.5)
    assert.equal(candidate.info.filesize, fs.statSync(moviePath).size)
    assert.equal(candidate.info.filesizeEstimated, false)
    assert.ok(received.some((r) => r.path === '/runtime.mp4' && /runtime=yes/.test(r.cookie)))
    results.push({ route: '/runtime', engine: runtime.engine, durationSource: candidate.info.durationSource, exactSize: true })
  }
  for (const route of ['/missing.mp4', '/poster.mp4']) assert.equal((await resolvePage(base + route, { staticOnly: true })).candidates.length, 0)
  const drm = await describeStream(base + '/drm', { kind: 'unknown' }); assert.ok(drm.drm); assert.equal(drm.kind, 'dash')
  const started = Date.now()
  const stalled = await resolvePage(base + '/segments-only', { timeoutMs: 8000, minStreamSeconds: 0, useUserScripts: false })
  assert.equal(stalled.candidates.length, 0)
  assert.ok(Date.now() - started < 15000, 'Manifest derivation escaped its time budget')
  assert.ok(received.some((r) => r.path === '/content/master.m3u8' && /derive=yes/.test(r.cookie)))
  const beforeReuse = received.length
  const reused = await resolvePage(base + '/dynamic', { timeoutMs: 12000, minStreamSeconds: 0, useUserScripts: false })
  assert.ok(reused.candidates.length)
  assert.ok(!received.slice(beforeReuse).some((r) => /derive=yes/.test(r.cookie)), 'Old browser session cookies leaked into a new scan')
  console.log(JSON.stringify({ ok: true, results, postResponse: true, rejectsHtmlAnd404: true, disguisedDashDrm: true, boundedStalledManifest: true, isolatedSessionReuse: true }))
}).catch((err) => { console.error(err); exitCode = 1 }).finally(async () => {
  if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)) }
  fs.rmSync(profile, { recursive: true, force: true }); app.exit(exitCode)
})
