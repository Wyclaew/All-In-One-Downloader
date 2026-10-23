'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { root, load } = require('./helpers.cjs')
// Metadata fallbacks must remain useful when ffprobe is absent or cannot be
// sent through a user's selected tunnel.
const media = load('electron/lib/mediainfo.js', { './binaries': { ffprobePath: () => null, toolEnv: () => ({}) } })
let server, base
const requests = []
test.before(async () => {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, range: req.headers.range, cookie: req.headers.cookie })
    if (req.url === '/redirect') { res.writeHead(302, { Location: `http://localhost:${server.address().port}/file` }); res.end(); return }
    if (req.url === '/file' || req.url === '/range-file') {
      if (req.url === '/range-file' && req.method === 'HEAD') { res.writeHead(405); res.end(); return }
      res.setHeader('Content-Type', 'video/mp4')
      if (req.headers.range) { res.writeHead(206, { 'Content-Range': 'bytes 0-0/987654', 'Content-Length': '1' }); res.end('x'); return }
      res.writeHead(200, { 'Content-Length': '987654', 'Accept-Ranges': 'bytes' }); res.end(); return
    }
    if (req.url === '/ignored-range') { res.writeHead(req.method === 'HEAD' ? 405 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': '123456789' }); res.flushHeaders(); return }
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
    if (req.url === '/invalid-part') { res.end('#EXTM3U\n#EXT-X-PART:garbage\n#EXT-X-ENDLIST\n'); return }
    if (req.url === '/truncated-dash') { res.end('<MPD mediaPresentationDuration="PT10S"><Period><AdaptationSet contentType="video"><Representation height="720" bandwidth="800000"/>'); return }
    if (req.url === '/master') { res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,AVERAGE-BANDWIDTH=2400000,RESOLUTION=1920x1080\n/denied\n#EXT-X-STREAM-INF:BANDWIDTH=1600000,AVERAGE-BANDWIDTH=800000,RESOLUTION=1280x720\n/vod\n'); return }
    if (req.url === '/denied') { res.writeHead(404); res.end('not found'); return }
    if (req.url === '/vod' || req.url === '/live') { res.end('#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:4.25,\n/a.ts\n#EXTINF:3.5,\n/b.ts\n#EXTINF:2.25,\n/c.ts\n' + (req.url === '/vod' ? '#EXT-X-ENDLIST\n' : '')); return }
    if (['/a.ts', '/b.ts', '/c.ts'].includes(req.url)) { res.writeHead(206, { 'Content-Type': 'video/mp2t', 'Content-Range': `bytes 0-0/${{ '/a.ts': 425000, '/b.ts': 350000, '/c.ts': 225000 }[req.url]}`, 'Content-Length': 1 }); res.end('x'); return }
    if (req.url === '/ranges') { res.end('#EXTM3U\n#EXT-X-MAP:URI="all.mp4",BYTERANGE="100@0"\n#EXTINF:0.125,\n#EXT-X-BYTERANGE:1000@100\nall.mp4\n#EXTINF:0.25,\n#EXT-X-BYTERANGE:2000\nall.mp4\n#EXT-X-ENDLIST\n'); return }
    res.writeHead(404); res.end()
  })
  await new Promise((resolve) => server.listen(0, resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
test.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); fs.rmSync(root, { recursive: true, force: true }) })

test('HLS prefers average aggregate bitrate even when peak is listed first', () => {
  const hls = media.parseHls('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,AVERAGE-BANDWIDTH=2400000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"\nvideo.m3u8', base + '/master')
  assert.equal(hls.variants[0].bandwidth, 2400000)
  assert.equal(hls.variants[0].peakBandwidth, 4000000)
  assert.equal(hls.variants[0].codecs, 'avc1.640028,mp4a.40.2')
  assert.equal(hls.live, null)
})
test('HLS preserves subsecond clips and does not claim a complete duration for truncated playlists', () => {
  assert.equal(media.parseHls('#EXTM3U\n#EXTINF:0.125,\nclip.ts\n#EXT-X-ENDLIST', base).duration, 0.125)
  assert.equal(media.parseHls('#EXTM3U\n#EXTINF:0.125,\nclip.ts\n#EXTINF:100,\n#EXT-X-ENDLIST', base).duration, null)
  assert.equal(media.parseHls('#EXTM3U\n#EXTINF:10,\n#EXT-X-ENDLIST', base).duration, null)
})
test('only real low-latency HLS parts establish playable media', async () => {
  const invalid = await media.describeStream(base + '/invalid-part', { kind: 'hls', playerMetadata: { duration: 12345, height: 720 } })
  assert.equal(invalid.playable, false)
  assert.equal(invalid.duration, null)
  assert.equal(media.parseHls('#EXTM3U\n#EXT-X-PART:DURATION=0.5,URI="part.m4s"', base).hasParts, true)
  assert.equal(media.parseHls('#EXTM3U\n#EXT-X-PART:DURATION=0.5,URI="file:///private/file"', base).hasParts, false)
})
test('HLS validates a lower rendition after the highest child fails', async () => {
  const info = await media.describeStream(base + '/master', { kind: 'unknown' })
  assert.equal(info.playable, true)
  assert.equal(info.height, 720)
  assert.equal(info.duration, 10)
  assert.equal(info.durationSource, 'manifest')
  assert.equal(info.live, false)
  assert.equal(info.selectedVariantUrl, base + '/vod')
  assert.deepEqual(info.rejectedVariantUrls, [base + '/denied'])
  assert.equal(info.variants.length, 1)
  assert.equal(info.filesize, 1000000)
  assert.equal(info.filesizeEstimated, true)
  assert.equal(info.filesizeSource, 'manifest-bitrate')
})
test('media HLS without bitrate estimates size from at most three response headers', async () => {
  const before = requests.length
  const info = await media.describeStream(base + '/vod', { kind: 'hls' })
  assert.equal(info.duration, 10)
  assert.equal(info.filesize, 1000000)
  assert.equal(info.filesizeSource, 'segment-sample')
  assert.equal(info.filesizeEstimated, true)
  const samples = requests.slice(before).filter((r) => /\.ts$/.test(r.url))
  assert.equal(samples.length, 3)
  assert.ok(samples.every((r) => r.range === 'bytes=0-0'))
})
test('HLS complete byte ranges produce an honest payload estimate without sampling', async () => {
  const before = requests.length
  const info = await media.describeStream(base + '/ranges', { kind: 'hls' })
  assert.equal(info.duration, 0.375)
  assert.equal(info.filesize, 3100)
  assert.equal(info.filesizeSource, 'byte-ranges')
  assert.equal(info.filesizeEstimated, true) // A remuxed output can differ.
  assert.equal(requests.length - before, 1)
})
test('a live HLS window has no finite total duration or filesize', async () => {
  const before = requests.length
  const info = await media.describeStream(base + '/live', { kind: 'hls' })
  assert.equal(info.playable, true)
  assert.equal(info.live, true)
  assert.equal(info.duration, null)
  assert.equal(info.filesize, null)
  assert.equal(requests.length - before, 1)
})
test('DASH parses namespace prefixes, quote styles and inherited rendition dimensions', () => {
  const dash = media.parseDash(`<d:MPD xmlns:d='urn:mpeg:dash:schema:mpd:2011' mediaPresentationDuration='PT1.25S'><d:Period><d:AdaptationSet mimeType='video/mp4' height='720' width='1280'><d:Representation id='v' bandwidth='800000'/></d:AdaptationSet><d:AdaptationSet contentType='audio' lang='en'><d:Representation id='a' bandwidth='128000'/></d:AdaptationSet><d:AdaptationSet mimeType='text/vtt'><d:Representation id='s' bandwidth='12000'/></d:AdaptationSet></d:Period></d:MPD>`)
  assert.equal(dash.duration, 1.25)
  assert.equal(dash.height, 720)
  assert.equal(dash.width, 1280)
  assert.equal(dash.variants.length, 1)
  assert.equal(dash.audioTracks[0].lang, 'en')
  assert.equal(dash.audioBandwidth, 128000)
  assert.equal(dash.live, false)
})
test('DASH duration derives from finite timelines and sums multiple periods', () => {
  const dash = media.parseDash(`<MPD><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" presentationTimeOffset="9000"><SegmentTimeline><S t="9000" d="1250" r="3"/></SegmentTimeline></SegmentTemplate><Representation height="720" bandwidth="800000"/></AdaptationSet></Period><Period duration="PT2.5S"><AdaptationSet contentType="video"><Representation height="720" bandwidth="1600000"/></AdaptationSet></Period></MPD>`)
  assert.equal(dash.duration, 7.5)
  const info = { ...dash, kind: 'dash', filesize: null, sizes: {} }
  media.estimateVariantSizes(info)
  assert.equal(info.filesize, 1000000)
})
test('a finite DASH Period supplies the start that bounds the next open repeat', () => {
  const period = (repeat) => `<Period><AdaptationSet contentType="video"><SegmentTemplate><SegmentTimeline><S d="1" r="${repeat}"/></SegmentTimeline></SegmentTemplate><Representation height="720" bandwidth="800000"/></AdaptationSet></Period>`
  const dash = media.parseDash(`<MPD mediaPresentationDuration="PT10S">${period(4)}${period(-1)}</MPD>`)
  assert.deepEqual(dash.periods.map((p) => p.duration), [5, 5])
  const info = { ...dash, kind: 'dash', filesize: null, sizes: {} }
  media.estimateVariantSizes(info)
  assert.equal(info.filesize, 1000000)
})
test('DASH open repeats require an explicit bound and dynamic windows stay live', () => {
  const content = '<AdaptationSet><SegmentTemplate timescale="10"><SegmentTimeline><S d="20" r="-1"/></SegmentTimeline></SegmentTemplate><Representation height="720" bandwidth="800000"/></AdaptationSet>'
  assert.equal(media.parseDash(`<MPD><Period>${content}</Period></MPD>`).duration, null)
  assert.equal(media.parseDash(`<MPD><Period duration="PT10S">${content}</Period></MPD>`).duration, 10)
  const live = media.parseDash(`<MPD type="dynamic" mediaPresentationDuration="PT10S"><Period>${content}</Period></MPD>`)
  assert.equal(live.live, true)
  assert.equal(live.duration, null)
})
test('DASH invalid explicit timescales stay unknown instead of silently using seconds', () => {
  for (const timescale of ['0', '-10', 'bad', '0.5']) {
    const dash = media.parseDash(`<MPD><Period><AdaptationSet><SegmentTemplate timescale="${timescale}"><SegmentTimeline><S d="1000" r="2"/></SegmentTimeline></SegmentTemplate><Representation height="720" bandwidth="800000"/></AdaptationSet></Period></MPD>`)
    assert.equal(dash.duration, null, timescale)
  }
})
test('DASH requires a balanced document and a single MPD root before accepting metadata', async () => {
  const info = await media.describeStream(base + '/truncated-dash', { kind: 'dash' })
  assert.equal(info.playable, false)
  assert.equal(info.rejected, true)
  assert.equal(info.duration, null)
  assert.equal(media.parseDash('<MPD/><MPD/>').valid, false)
})
test('DASH generic CENC protection cannot be mistaken for clear media', () => {
  assert.equal(media.parseDash('<MPD><Period><AdaptationSet><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/><Representation height="720" bandwidth="800000"/></AdaptationSet></Period></MPD>').drm, true)
})
test('unknown DASH protection stays protected even when its XML is malformed', () => {
  const xml = '<MPD><Period><AdaptationSet><ContentProtection schemeIdUri="urn:uuid:unknown-key-system"/><Representation height="720" bandwidth="800000"/></AdaptationSet></Period></MPD>'
  assert.equal(media.parseDash(xml).drm, true)
  assert.equal(media.parseDash(xml.replace('</Period>', '</NotPeriod>')).drm, true)
})
test('audio-only DASH size uses its audio bitrate without inventing video', () => {
  const dash = media.parseDash('<MPD mediaPresentationDuration="PT10S"><Period><AdaptationSet contentType="audio" lang="en"><Representation bandwidth="128000"/></AdaptationSet></Period></MPD>')
  const info = { ...dash, kind: 'dash', filesize: null, sizes: {} }
  media.estimateVariantSizes(info)
  assert.equal(info.variants.length, 0)
  assert.equal(info.filesize, 160000)
  assert.equal(info.filesizeEstimated, true)
})
test('ISO durations retain fractional seconds and reject partial strings and calendar months', () => {
  assert.equal(media.parseIsoDuration('P1DT2H3M0.125S'), 93780.125)
  assert.equal(media.parseIsoDuration('oopsPT3S'), null)
  assert.equal(media.parseIsoDuration('P1M'), null)
})
test('files use exact server length while ready player metadata supplies unavailable duration', async () => {
  const info = await media.describeStream(base + '/file', { kind: 'file', playerMetadata: { duration: 25.5, width: 1280, height: 720 } })
  assert.equal(info.duration, 25.5)
  assert.equal(info.durationSource, 'player')
  assert.equal(info.filesize, 987654)
  assert.equal(info.filesizeEstimated, false)
  assert.equal(info.filesizeSource, 'content-length')
  assert.equal(info.playable, true)
})
test('file headers survive refused HEAD, ignored Range and cross-host redirects safely', async () => {
  assert.deepEqual(await media.probeFile(base + '/range-file'), { size: 987654, ranges: true, url: base + '/range-file', status: 206, contentType: 'video/mp4' })
  const ignored = await media.probeFile(base + '/ignored-range')
  assert.equal(ignored.size, 123456789)
  assert.equal(ignored.ranges, false)
  const jar = path.join(root, 'scope.txt')
  fs.writeFileSync(jar, '127.0.0.1\tFALSE\t/\tFALSE\t0\tprivate\tyes\n')
  const before = requests.length
  const redirected = await media.probeFile(base + '/redirect', { cookieFile: jar })
  assert.equal(redirected.size, 987654)
  assert.ok(redirected.url.startsWith('http://localhost:'))
  assert.equal(requests.slice(before).find((r) => r.url === '/redirect').cookie, 'private=yes')
  assert.equal(requests.slice(before).find((r) => r.url === '/file').cookie, undefined)
})
test('cancellation does not start fallback metadata requests', async () => {
  const controller = new AbortController(); controller.abort()
  const before = requests.length
  const info = await media.describeStream(base + '/vod', { kind: 'hls', signal: controller.signal })
  assert.equal(info.filesize, null)
  await media.probeFile(base + '/file', { signal: controller.signal })
  assert.equal(requests.length, before)
})
