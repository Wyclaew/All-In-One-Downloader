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
