'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const http = require('http')
const zlib = require('zlib')
const { root, load } = require('./helpers.cjs')
const resolver = load('electron/lib/resolver.js')
const media = load('electron/lib/mediainfo.js')
const { fetchVia } = require('../electron/lib/proxy')
const { parseTitle } = load('electron/lib/subtitles.js')
let server, base, flaky = 0
const seen = []
test('every injected browser program compiles before it reaches a player', () => {
  const { Script } = require('vm')
  for (const [name, source] of Object.entries(resolver.injectedScripts)) assert.doesNotThrow(() => new Script(source), name)
})
test('Packer extraction substitutes tokens once without executing player code', () => {
  const packed = `eval(function(p,a,c,k,e,d){throw new Error('never execute')}('0: "1"',36,2,'file|https://cdn.example.test/movie.m3u8'.split('|'),0,{}))`
  assert.equal(resolver.unpackPacked(packed), 'file: "https://cdn.example.test/movie.m3u8"')
  assert.equal(resolver.collectFromText(packed, base).candidates[0].url, 'https://cdn.example.test/movie.m3u8')
  for (const malformed of [packed.replace(',36,2,', ',999,2,'), packed.replace(',36,2,', ',36,999999,'), packed.replace('0: "1"', '\\\\'.repeat(10000))]) assert.doesNotThrow(() => resolver.unpackPacked(malformed))
  assert.equal(resolver.unpackPacked(packed.replace(',36,2,', ',999,2,')), '')
})
test('reversed URL decoding remains bounded with a long unrelated token before it', () => {
  const reversed = 'https://cdn.example.test/movie.m3u8'.split('').reverse().join('')
  const result = resolver.collectFromText('a'.repeat(200000) + '"' + reversed + '"', 'https://player.example.test/')
  assert.ok(result.candidates.some((c) => c.url === 'https://cdn.example.test/movie.m3u8'))
})
test('missing duration is preserved as unknown instead of being classified as an advert', () => {
  const unknown = { url: 'https://cdn.example.test/unknown', info: { playable: true, duration: null } }
  const feature = { url: 'https://cdn.example.test/feature', info: { playable: true, duration: 3600 } }
  const advert = { url: 'https://cdn.example.test/advert', info: { playable: true, duration: 15 } }
  const result = resolver.dropShortStreams([unknown, advert, feature], 120, 3600)
  assert.deepEqual(result.kept, [feature, unknown])
  assert.equal(result.dropped, 1)
})
test('only transient browser connection failures retry; certificate, cancellation and access errors do not', () => {
  for (const code of ['ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'ERR_TIMED_OUT', 'ERR_EMPTY_RESPONSE', 'ERR_NETWORK_CHANGED']) assert.equal(resolver.retryableNavigationError({ code }), true, code)
  for (const code of ['ERR_CERT_AUTHORITY_INVALID', 'ERR_ABORTED', 'ERR_ACCESS_DENIED', 'ERR_BLOCKED_BY_CLIENT']) assert.equal(resolver.retryableNavigationError({ code }), false, code)
})
test('independent iframe navigations cannot freeze the actual player, only repeated same-frame reloads', () => {
  let now = 0
  const guard = resolver.createNavigationGuard(() => now)
  for (let i = 0; i < 12; i++) assert.equal(guard({ frame: {}, isMainFrame: false, url: 'https://sync.example.test/' + i }), false)
  const player = {}
  for (let i = 0; i < 4; i++) assert.equal(guard({ frame: player, url: 'https://player.example.test/embed' }), false)
  assert.equal(guard({ frame: player, url: 'https://player.example.test/embed' }), true)
  assert.equal(guard({ frame: player, url: 'https://player.example.test/new-document' }), false)
  now = 7000
  assert.equal(guard({ frame: player, url: 'https://player.example.test/embed' }), false)
})
test('advert and cookie-sync frames are never retried as standalone video players', () => {
  for (const url of ['https://sync.ottadvisors.com/match', 'https://example.test/cdn-cgi/challenge-platform/x', 'https://capi.connatix.com/core/us']) assert.equal(resolver.usablePlayerFrame(url), false, url)
  for (const url of ['https://dbx.molystream.org/embed/one', 'https://example.test/wrapper']) assert.equal(resolver.usablePlayerFrame(url), true, url)
})
test('automatic account navigation needs actual watch/access evidence, not a normal login link', () => {
  for (const markup of ['<p>Login required</p><a href="/login">Log in</a>', '<p>Registration is required</p>', '<p>You must sign in to watch this video</p>', '<p>Bu videoyu izlemek için üye olmanız gerekiyor.</p>']) assert.equal(resolver.authenticationGateOf(markup), true, markup)
  for (const markup of ['<header><a href="/login">Log in</a></header><video></video>', '<p>Yorum yazmak için üye olmanız gerekiyor.</p>', '<script>"Login required"</script><video></video>']) assert.equal(resolver.authenticationGateOf(markup), false, markup)
})
test.before(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie })
    if (req.url === '/flaky' && flaky++ === 0) { res.writeHead(503); res.end('busy'); return }
    if (req.url === '/redirect') { res.writeHead(302, { Location: `http://localhost:${server.address().port}/cookie-target` }); res.end(); return }
    res.setHeader('Content-Type', 'text/html')
    if (req.url === '/gzip') { res.setHeader('Content-Encoding', 'gzip'); res.end(zlib.gzipSync('<video src="/movie.mp4"></video>')); return }
    if (req.url === '/large') { res.end('x'.repeat(30000)); return }
    if (req.url === '/page') {
      res.end('<title>A film</title><iframe src="/player"></iframe><script>file:"/movie.mp4"</script>'); return
    }
    if (req.url === '/auth-page') { res.end('<video><source src="/auth-stream" type="application/dash+xml"></video>'); return }
    if (req.url === '/network-gate') { res.end('<title>Site</title><h1>500 ERROR</h1><p>VPN veya Server ip adresi ile giriş yapmayınız</p>'); return }
    if (req.url === '/auth-stream') { res.writeHead(401); res.end('<title>Sign in</title><input type="password">'); return }
    if (req.url === '/duration-page') { res.end('<meta content="123.5" property="video:duration"><script type="application/ld+json">{"@type":"Recipe","duration":"PT999H"}</script>'); return }
    if (req.url === '/broken-master') { res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=128x96\n/not-video\n'); return }
    if (req.url === '/not-video') { res.end('<html>Unavailable</html>'); return }
    if (req.url === '/poster-source') { res.setHeader('Content-Type', 'image/png'); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC8sAAAAASUVORK5CYII=', 'base64')); return }
    if (req.url === '/player') { res.end('<script>file:"https://cdn.example.test/master.m3u8"</script>'); return }
    res.end('ok')
  })
  await new Promise((r) => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})
test.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); fs.rmSync(root, { recursive: true, force: true }) })

test('compressed pages are decompressed before looking for streams', async () => {
  const response = await fetchVia(base + '/gzip')
  assert.ok(response.text.includes('<video'))
  assert.equal(resolver.collectFromText(response.text, base).candidates[0].url, base + '/movie.mp4')
})
test('relative config sources, HTML entities and iframe srcdoc are readable', () => {
  const c = resolver.collectFromText('<script>file: "/master.m3u8?x=1&amp;y=2"</script>', base)
  assert.equal(c.candidates[0].url, base + '/master.m3u8?x=1&y=2')
  assert.deepEqual(resolver.collectIframes('<iframe srcdoc="&lt;iframe src=&quot;https://player.example.test/embed/one&quot;&gt;">', base), ['https://player.example.test/embed/one'])
  assert.equal(resolver.collectFromText('var url="https://schema.org/VideoObject"', base).candidates.length, 0)
})
test('typed sources remain typed and JSON ads/licenses are not revived by legacy scanning', () => {
  const html = `<iframe src="/player"></iframe><script type="application/ld+json">${JSON.stringify({ '@type': 'VideoObject', contentUrl: '/play.php?id=one', encodingFormat: 'application/dash+xml', embedUrl: '/embed', ads: { file: '/advert.mp4' }, license: { src: '/license.mpd' } })}</script>`
  const result = resolver.collectFromText(html, base)
  assert.deepEqual(result.candidates.map((c) => [c.url, c.kind]), [[base + '/play.php?id=one', 'dash']])
})
test('typed protected stream rejection preserves real authentication evidence', async () => {
  const result = await resolver.resolvePage(base + '/auth-page', { staticOnly: true })
  assert.equal(result.candidates.length, 0)
  assert.equal(result.accessRequired, true)
  assert.equal(result.challengeRequired, false)
  assert.equal(result.failure.status, 401)
})
test('static HTTP-200 IP denial is preserved as a site error rather than no video/offline', async () => {
  const result = await resolver.resolvePage(base + '/network-gate', { staticOnly: true })
  assert.equal(result.candidates.length, 0)
  assert.equal(result.failure.errorKind, 'network-blocked')
  assert.equal(result.failure.status, 200)
  assert.equal(result.accessRequired, false)
})
test('duration metadata works regardless of HTML attribute order', async () => {
  const result = await resolver.staticScan(base + '/duration-page', { maxFetches: 1 })
  assert.equal(result.expectedDuration, 124)
})
test('response byte bounds terminate with an error instead of hanging', async () => {
  await assert.rejects(fetchVia(base + '/large', { maxBytes: 1024, retries: 0 }), { code: 'RESPONSE_TOO_LARGE' })
})
test('a temporary HTTP server error is retried', async () => {
  assert.equal((await fetchVia(base + '/flaky')).status, 200)
  assert.equal(flaky, 2)
})
test('redirects do not leak cookies to another host', async () => {
  await fetchVia(base + '/redirect', { headers: { Cookie: 'private=yes' } })
  assert.equal(seen.find((r) => r.url === '/cookie-target').cookie, undefined)
})
test('cookie scope includes host-only, path, expiry and secure flags', () => {
  const jar = path.join(root, 'cookies.txt')
  fs.writeFileSync(jar, [
    '# Netscape HTTP Cookie File',
    'example.test\tFALSE\t/\tFALSE\t0\thostOnly\tyes',
    '.example.test\tTRUE\t/player\tTRUE\t0\tplayer\tyes',
    '.example.test\tTRUE\t/\tFALSE\t1\texpired\tyes',
  ].join('\n'))
  assert.equal(media.cookieHeaderFor(jar, 'http://example.test/play'), 'hostOnly=yes')
  assert.equal(media.cookieHeaderFor(jar, 'https://sub.example.test/player/one'), 'player=yes')
  assert.equal(media.cookieHeaderFor(jar, 'https://sub.example.test/player2/one'), '')
})
test('static scan carries cookies through nested same-host players', async () => {
  const jar = path.join(root, 'local-cookies.txt')
  fs.writeFileSync(jar, '127.0.0.1\tFALSE\t/\tFALSE\t0\tloggedIn\tyes\n')
  const result = await resolver.staticScan(base + '/page', { maxFetches: 4, browserCookieJar: jar })
  assert.ok(result.candidates.some((c) => c.url === 'https://cdn.example.test/master.m3u8' && c.cookieFile === jar))
  assert.equal(seen.find((r) => r.url === '/player').cookie, 'loggedIn=yes')
})
test('HLS keeps audio groups, separate English audio and Turkish subtitles', () => {
  const info = media.parseHls(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="dub",LANGUAGE="tr",NAME="Türkçe",DEFAULT=YES,URI="tr/audio.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="dub",LANGUAGE="en-US",NAME="English",URI="en/audio.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="tr",NAME="Türkçe",URI="tr/sub.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080,AUDIO="dub"
video.m3u8`, 'https://cdn.example.test/master.m3u8')
  assert.equal(info.audioTracks.length, 2)
  assert.equal(info.audioTracks[1].url, 'https://cdn.example.test/en/audio.m3u8')
  assert.equal(info.variants[0].audioGroup, 'dub')
  assert.equal(info.subtitles[0].lang, 'tr')
})
test('a master manifest pointing at an HTML response is not a verified video', async () => {
  const info = await media.describeStream(base + '/broken-master', { kind: 'unknown' })
  assert.equal(info.playable, false)
  assert.equal(info.rejected, true)
})
test('a real poster image cannot pass verification as a progressive video', async () => {
  const info = await media.describeStream(base + '/poster-source', { kind: 'file' })
  assert.equal(info.playable, false)
  assert.equal(info.rejected, true)
})
test('Turkish and release-style episode names group into the same series', () => {
  assert.deepEqual(parseTitle('3 Body Problem 1.Sezon 1.Bölüm - DiziBOX'), { title: '3 Body Problem', season: 1, episode: 1, year: null })
  assert.equal(parseTitle('3 Body Problem S01E02 1080p WEB-DL').title, '3 Body Problem')
})

test('external player subtitles include Turkish labels and exclude thumbnail VTT', () => {
  const { collectTextTracks } = require('../electron/lib/text-tracks')
  const tracks = collectTextTracks(`<track kind="subtitles" src="/sub/en.vtt" srclang="en" label="English">
    var tracks = [{file: '/sub/turkish.vtt', label: 'Türkçe', kind: 'captions'},
      {file: '/thumbs.vtt', kind: 'thumbnails'}]`, 'https://player.example.test/episode')
  assert.deepEqual(tracks.map((t) => t.lang), ['en', 'tr'])
  assert.equal(tracks[1].url, 'https://player.example.test/sub/turkish.vtt')
  const { normaliseTrack } = require('../electron/lib/text-tracks')
  assert.equal(normaliseTrack({ url: '/forced.vtt', lang: 'tr', forced: true }, base).forced, true)
  assert.equal(normaliseTrack({ url: '/forced.vtt', name: 'Türkçe forced' }, base).forced, true)
  assert.equal(collectTextTracks("var tracks = [{file:'/forced.vtt',lang:'tr',kind:'captions',forced:true}]", base)[0].forced, true)
  assert.equal(normaliseTrack({ url: 'https://user:private@example.test/sub.vtt' }, base), null)
  const { mergeTextTracks } = require('../electron/lib/text-tracks')
  assert.equal(mergeTextTracks([{ url: base + '/sub.vtt', lang: '', forced: false }], [{ url: base + '/sub.vtt', lang: 'tr', forced: true }])[0].lang, 'tr')
  assert.equal(mergeTextTracks([{ url: base + '/sub.vtt', lang: '', forced: false }], [{ url: base + '/sub.vtt', lang: 'tr', forced: true }])[0].forced, true)
})
