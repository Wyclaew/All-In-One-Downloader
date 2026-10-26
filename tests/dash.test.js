'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const http = require('http')
const net = require('net')
const { execFileSync } = require('child_process')
const { root, load } = require('./helpers.cjs')
const own = load('electron/lib/ownengine.js')
const dash = load('electron/lib/dash-native.js')
const { ffmpegPath, ffprobePath, toolEnv } = load('electron/lib/binaries.js')
const bin = ffmpegPath(), probe = ffprobePath(), skip = !bin || !probe
const requests = []
let server, base, files = {}, generated, singleVideo, packed, packedRanges
const template = (attrs = '') => `<SegmentTemplate timescale="1000" initialization="init-$RepresentationID$.m4s" media="part-$RepresentationID$-$Time$.m4s" ${attrs}><SegmentTimeline><S t="9000" d="1000" r="3"/></SegmentTimeline></SegmentTemplate>`
function manifest(body, attrs = '') { return `<MPD type="static" mediaPresentationDuration="PT4S" ${attrs}><Period duration="PT4S">${body}</Period></MPD>` }

test('DASH native parser resolves inherited bases, finite Time/Number templates and preferred audio', () => {
  const parsed = dash.parseManifest(manifest(`<BaseURL>period/</BaseURL><AdaptationSet mimeType="video/mp4" height="720"><BaseURL>video/</BaseURL>${template('presentationTimeOffset="9000"')}<Representation id="v" bandwidth="900000"/></AdaptationSet><AdaptationSet mimeType="audio/mp4" lang="tr">${template('presentationTimeOffset="9000"')}<Representation id="tr" bandwidth="128000"/></AdaptationSet><AdaptationSet mimeType="audio/mp4" lang="en-US">${template('presentationTimeOffset="9000"')}<Representation id="en" bandwidth="64000"/></AdaptationSet>`, 'xmlns="urn:mpeg:dash:schema:mpd:2011"'), 'https://example.test/root/vod.mpd', { quality: 720, preferredAudioLanguage: 'en' })
  assert.equal(parsed.duration, 4)
  assert.equal(parsed.periods[0].tracks[0].segments[0].url, 'https://example.test/root/period/video/part-v-9000.m4s')
  assert.equal(parsed.periods[0].tracks[0].segments[0].map.url, 'https://example.test/root/period/video/init-v.m4s')
  assert.equal(parsed.periods[0].audioLanguage, 'en-US')
  assert.equal(parsed.periods[0].tracks[1].segments[0].url, 'https://example.test/root/period/part-en-9000.m4s')
  const numbers = dash.parseManifest(manifest('<AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="1" startNumber="7" initialization="init-$RepresentationID$.m4s" media="part-$Number%05d$.m4s"/><Representation id="v" height="720" bandwidth="9"/></AdaptationSet>'), 'https://example.test/v.mpd')
  assert.equal(numbers.periods[0].tracks[0].segments[3].url, 'https://example.test/part-00010.m4s')
})

test('DASH does not substitute a Turkish dub when the requested English rendition is absent', () => {
  const text = manifest(`<AdaptationSet mimeType="audio/mp4" lang="tr">${template('presentationTimeOffset="9000"')}<Representation id="tr" bandwidth="128000"/></AdaptationSet>`)
  assert.throws(() => dash.parseManifest(text, 'https://example.test/only-tr.mpd', { audioOnly: true, preferredAudioLanguage: 'en' }), { code: 'AUDIO_LANGUAGE_UNAVAILABLE' })
})
test('DASH native parser bounds open repeats and rejects DRM, live, gaps, unsupported addressing and over-cap quality', () => {
  const video = `<AdaptationSet mimeType="video/mp4">${template('presentationTimeOffset="9000"')}<Representation id="v" height="720" bandwidth="900000"/></AdaptationSet>`
  const open = manifest(video.replace('r="3"', 'r="-1"'))
  assert.equal(dash.parseManifest(open, 'https://example.test/v.mpd').periods[0].tracks[0].segments.length, 4)
  assert.throws(() => dash.parseManifest(manifest(video + '<ContentProtection schemeIdUri="unknown"/>'), 'https://example.test/v.mpd'), { code: 'DRM' })
  assert.equal(dash.parseManifest(manifest(video + '<!-- <ContentProtection schemeIdUri="unknown"/> -->'), 'https://example.test/v.mpd').periods[0].tracks.length, 1)
  assert.throws(() => dash.parseManifest(manifest(video).replace('type="static"', 'type="dynamic"'), 'https://example.test/v.mpd'), { code: 'DASH_UNSUPPORTED' })
  assert.throws(() => dash.parseManifest(manifest(video), 'https://example.test/v.mpd', { quality: 480 }), /kalite sınırına/)
  assert.throws(() => dash.parseManifest(manifest(video.replace('r="3"', 'r="1"') .replace('</SegmentTimeline>', '<S t="12000" d="1000"/></SegmentTimeline>')), 'https://example.test/v.mpd'), /boşluk|çakışma/)
  assert.throws(() => dash.parseManifest(manifest('<AdaptationSet mimeType="video/mp4"><Representation id="v" height="720"><BaseURL>movie.mp4</BaseURL><SegmentBase indexRange="0-99"/></Representation></AdaptationSet>'), 'https://example.test/v.mpd'), { code: 'DASH_UNSUPPORTED' })
  assert.throws(() => dash.parseManifest(manifest(video.replace('r="3"', 'r="50001"')), 'https://example.test/v.mpd'), { code: 'DASH_UNSUPPORTED' })
})

test('DASH progress includes later periods instead of presenting the current period ETA as the whole video', () => {
  const context = { elapsed: 10, periodDuration: 10, totalDuration: 30, savedBytes: 10000000, expectedSize: 30000000 }
  const report = dash.periodProgress({ downloaded: 5000000, total: 10000000, speed: 1000000, eta: 5, percent: 0.5 }, context)
  assert.equal(report.downloaded, 15000000)
  assert.equal(report.total, 30000000)
  assert.equal(report.percent, 0.5)
  assert.equal(report.eta, 15, 'the final ten-second period must remain in the estimate')
  assert.equal(report.totalExact, false)
  assert.equal(dash.periodProgress({ downloaded: 0, total: 10000000, speed: 1000000, eta: null, percent: 0 }, context).eta, null, 'warm-up remains unknown')
  assert.equal(dash.periodProgress({ downloaded: 5000000, total: 10000000, speed: 0, eta: null, percent: 0.5 }, context).eta, null, 'an idle connection has no ETA')
  const unknown = dash.periodProgress({ downloaded: 5000000, total: 10000000, speed: 1000000, eta: 5, percent: 0.5 }, { ...context, expectedSize: null })
  assert.equal(unknown.total, 30000000, 'measured period bytes estimate all remaining periods when metadata has no size')
  assert.equal(unknown.eta, 15)
})

test.before(async () => {
  if (skip) return
  const fixture = path.join(root, 'dash-fixture'); fs.mkdirSync(fixture)
  execFileSync(bin, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=128x96:r=10:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=400:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=600:duration=4',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-c:a', 'aac',
    '-metadata:s:a:0', 'language=tur', '-metadata:s:a:1', 'language=eng', '-f', 'dash', '-seg_duration', '1',
    '-use_template', '1', '-use_timeline', '1', '-init_seg_name', 'init-$RepresentationID$.m4s',
    '-media_seg_name', 'part-$RepresentationID$-$Number%05d$.m4s', path.join(fixture, 'vod.mpd')], { env: toolEnv() })
  files = Object.fromEntries(fs.readdirSync(fixture).map((name) => [name, fs.readFileSync(path.join(fixture, name))]))
  generated = files['vod.mpd'].toString()
  const period = generated.match(/<Period\b[\s\S]*<\/Period>/)[0]
  const videoSet = period.match(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/)[0]
  singleVideo = manifest(videoSet)
  const names = Object.keys(files).filter((name) => /^part-0-/.test(name)).sort()
  let at = files['init-0.m4s'].length
  packedRanges = names.map((name) => { const start = at; at += files[name].length; return { start, end: at - 1 } })
  packed = Buffer.concat([files['init-0.m4s'], ...names.map((name) => files[name])])
  server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://local').pathname
    requests.push({ url: route, range: req.headers.range, cookie: req.headers.cookie, host: req.headers.host })
    if (route.endsWith('/waiting')) return
    let data
    const name = route.split('/').at(-1)
    if (name === 'drm.mpd') data = Buffer.from(generated.replace('<Period ', '<ContentProtection schemeIdUri="unknown"/><Period '))
    else if (name === 'multi.mpd') data = Buffer.from(generated.replace(/mediaPresentationDuration="[^"]+"/, 'mediaPresentationDuration="PT8S"').replace(period, period.replace('<Period ', '<Period duration="PT4S" ') + period.replace(/<Period[^>]+>/, '<Period id="1" start="PT4S" duration="PT4S">')))
    else if (name === 'video.mpd') data = Buffer.from(singleVideo)
    else if (name === 'ranges.mpd' || name === 'wrong-ranges.mpd') data = Buffer.from(manifest(`<AdaptationSet mimeType="video/mp4"><Representation id="v" height="96" bandwidth="100000"><BaseURL>${name === 'wrong-ranges.mpd' ? 'wrong-packed.mp4' : 'packed.mp4'}</BaseURL><SegmentList timescale="1" duration="1"><Initialization range="0-${files['init-0.m4s'].length - 1}"/>${packedRanges.map((range) => `<SegmentURL mediaRange="${range.start}-${range.end}"/>`).join('')}</SegmentList></Representation></AdaptationSet>`))
    else if (/packed\.mp4$/.test(name)) data = packed
    else data = files[name]
    if (route.startsWith('/private/') && name.startsWith('part-')) { res.writeHead(302, { Location: `/public/${name}` }); res.end(); return }
    if (!data) { res.writeHead(404); res.end(); return }
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/)
    if (range) {
      const start = Number(range[1]), end = Number(range[2])
      res.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${name === 'wrong-packed.mp4' ? start + 1 : start}-${end}/${data.length}` })
      data = data.subarray(start, end + 1)
    } else res.writeHead(200, { 'Content-Length': data.length, 'Content-Type': name.endsWith('.mpd') ? 'application/dash+xml' : 'video/mp4' })
    if (route.startsWith('/slow/') && name.endsWith('.m4s')) setTimeout(() => res.end(data), 230)
    else res.end(data)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
test.after(async () => { if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) } fs.rmSync(root, { recursive: true, force: true }) })
function options(name, route = 'vod.mpd') { return { url: `${base}/${route}`, destPath: path.join(root, name + '.mp4'), download: { audioOnly: false, quality: 1080 }, settings: { connections: 4, preferredAudioLanguage: 'en' }, onHandle() {}, onNote() {}, onProgress() {} } }
function inspect(file) { return JSON.parse(execFileSync(probe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { env: toolEnv() })) }

test('native clear DASH transfers generated video and preferred English audio without remote FFmpeg', { skip }, async () => {
  const opts = options('normal')
  await dash.transferDash(opts)
  const info = inspect(opts.destPath)
  assert.ok(Number(info.format.duration) >= 3.9 && Number(info.format.duration) < 4.2)
  assert.equal(info.streams.find((stream) => stream.codec_type === 'video').height, 96)
  assert.equal(info.streams.find((stream) => stream.codec_type === 'audio').tags.language, 'eng')
  assert.equal(fs.existsSync(opts.destPath + '.dash'), false)
})
test('compatible multiple DASH periods are locally validated and concatenated', { skip }, async () => {
  const opts = options('multiple', 'multi.mpd')
  await dash.transferDash(opts)
  assert.ok(Number(inspect(opts.destPath).format.duration) >= 7.9)
})
test('DASH SegmentList byte ranges are exact and malformed ranges never complete', { skip }, async () => {
  const opts = options('ranges', 'ranges.mpd')
  await dash.transferDash(opts)
  assert.ok(Number(inspect(opts.destPath).format.duration) >= 3.9)
  const bad = options('wrong-ranges', 'wrong-ranges.mpd')
  await assert.rejects(dash.transferDash(bad), /bayt aralığı/)
  assert.equal(fs.existsSync(bad.destPath), false)
})
test('DASH pause retains hashed fragments; resume does not request completed fragments again', { skip }, async () => {
  const opts = options('resume', 'slow/video.mpd')
  opts.settings.connections = 1
  const controller = new AbortController(); opts.signal = controller.signal
  opts.onProgress = (progress) => { if (progress.percent > 0) controller.abort() }
  await assert.rejects(dash.transferDash(opts), { code: 'ABORTED' })
  const cached = path.join(opts.destPath + '.dash', 'period-0.mkv.segments', 'plan.json')
  const journal = JSON.parse(fs.readFileSync(cached, 'utf8'))
  assert.ok(Object.keys(journal.completed).length > 0)
  const before = requests.length
  opts.signal = undefined; opts.onProgress = () => {}
  try { await dash.transferDash(opts) } catch (error) { throw new Error('DASH resume failed: ' + error.message, { cause: error }) }
  assert.ok(!requests.slice(before).some((req) => req.url.endsWith('/init-0.m4s')))
  assert.ok(Number(inspect(opts.destPath).format.duration) >= 3.9)
})
test('DASH stays on the selected proxy and recomputes cookie path scope on fragment redirects', { skip }, async () => {
  const proxyServer = http.createServer()
  const sockets = new Set()
  proxyServer.on('connect', (_req, client, head) => {
    sockets.add(client); client.on('error', () => {}); client.once('close', () => sockets.delete(client))
    const remote = net.connect(server.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) remote.write(head)
      client.pipe(remote).pipe(client)
    })
    remote.on('error', () => client.destroy()); client.once('close', () => remote.destroy())
  })
  await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve))
  const jar = path.join(root, 'scope.txt')
  fs.writeFileSync(jar, '# Netscape HTTP Cookie File\ndash.example.invalid\tFALSE\t/private\tFALSE\t0\tprivate\tyes\n')
  const opts = { ...options('proxy'), url: 'http://dash.example.invalid/private/vod.mpd', proxy: `http://127.0.0.1:${proxyServer.address().port}`, resolved: { cookieFile: jar } }
  const before = requests.length
  try {
    await dash.transferDash(opts)
    const seen = requests.slice(before)
    assert.ok(seen.some((req) => req.url.startsWith('/private/') && req.cookie === 'private=yes'))
    assert.ok(seen.some((req) => req.url.startsWith('/public/') && !req.cookie))
    assert.ok(seen.every((req) => req.host === 'dash.example.invalid'))
  } finally {
    require('../electron/lib/proxy').releaseAgents(opts.proxy)
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => proxyServer.close(resolve))
  }
})
test('DRM manifests fail before fragments; foreign DASH cache stays untouched; stalled headers cancel', { skip }, async () => {
  const before = requests.length
  await assert.rejects(dash.transferDash(options('protected', 'drm.mpd')), { code: 'DRM' })
  assert.deepEqual(requests.slice(before).map((req) => req.url), ['/drm.mpd'])
  const foreign = options('foreign')
  fs.mkdirSync(foreign.destPath + '.dash'); fs.writeFileSync(path.join(foreign.destPath + '.dash', 'keep'), 'untouched')
  await assert.rejects(dash.transferDash(foreign), { code: 'DASH_UNSUPPORTED' })
  assert.equal(fs.readFileSync(path.join(foreign.destPath + '.dash', 'keep'), 'utf8'), 'untouched')
  const controller = new AbortController(), pending = options('waiting', 'waiting')
  const task = dash.transferDash({ ...pending, signal: controller.signal })
  setTimeout(() => controller.abort(), 25)
  await assert.rejects(task, { code: 'ABORTED' })
})
