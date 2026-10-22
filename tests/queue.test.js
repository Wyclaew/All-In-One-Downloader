'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const http = require('http')
const { execFileSync } = require('child_process')
const { root, load } = require('./helpers.cjs')
const binaries = load('electron/lib/binaries.js')
const store = load('electron/lib/store.js')
const downloader = load('electron/lib/downloader.js')
const { ffmpegPath, locate, toolEnv } = binaries
const ffmpeg = ffmpegPath()
const ytdlp = locate('yt-dlp')
const stages = []
store.commit = (fn) => { const out = fn(store.getState()); stages.push(store.getState().downloads[0]?.status); return out }
store.send = () => {}
store.toast = () => {}
let server

test.after(async () => {
  downloader.killAll()
  if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)) }
  fs.rmSync(root, { recursive: true, force: true })
})

test('both transfer engines automatically refresh an expired stream and complete', { skip: !ffmpeg || !ytdlp, timeout: 45000 }, async () => {
  const mediaDir = path.join(root, 'origin')
  const outDir = path.join(root, 'downloads')
  fs.mkdirSync(mediaDir); fs.mkdirSync(outDir)
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=128x96:r=10:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=400:duration=3', '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-g', '10', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0',
    path.join(mediaDir, 'master.m3u8')], { env: toolEnv() })
  let base = ''
  server = http.createServer((req, res) => {
    if (req.headers.cookie !== 'session=ok') { res.writeHead(401); res.end('session missing'); return }
    if (req.url === '/expired/master.m3u8') { res.writeHead(403); res.end('expired'); return }
    if (req.url === '/page') { res.setHeader('Content-Type', 'text/html'); res.end(`<title>Queue fixture</title><video src="${base}/fresh/master.m3u8"></video>`); return }
    const file = path.join(mediaDir, path.basename(req.url))
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return }
    res.setHeader('Content-Type', req.url.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t')
    fs.createReadStream(file).pipe(res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  Object.assign(store.getState().settings, { downloadDir: outDir, autoStartDownloads: false, useYtdlp: true,
    writeSubs: false, autoFetchSubtitles: false, embedThumbnail: false, embedMetadata: false, cookiesBrowser: '',
    preferredAudioLanguage: 'auto', recoveryAttempts: 3, autoRecover: true, connections: 4 })
  const source = { id: 'source', url: base + '/page', useProxy: false }
  store.getState().sources = [source]
  const jar = path.join(root, 'captured-session.txt')
  fs.writeFileSync(jar, '# Netscape HTTP Cookie File\n127.0.0.1\tFALSE\t/\tFALSE\t0\tsession\tok\n')
  const item = { id: 'item', sourceId: source.id, url: base + '/expired/master.m3u8', title: 'Queue fixture', duration: 3,
    resolved: { pageUrl: base + '/page', cookieFile: jar, kind: 'hls', referer: base + '/page', userAgent: 'Mozilla/5.0' } }
  store.getState().items = [item]
  for (const nativeHls of [false, true]) {
    store.getState().settings.nativeHls = nativeHls
    const download = downloader.enqueue({ item })
    downloader.pumpQueue()
    const until = Date.now() + 20000
    while (!['done', 'error'].includes(download.status) && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
    assert.equal(download.status, 'done', JSON.stringify({ nativeHls, error: download.error, note: download.note, status: download.status }))
    assert.equal(download.recoveryCount, 1)
    assert.ok(download.attempts >= 2)
    assert.equal(download.url, base + '/fresh/master.m3u8')
    assert.ok(fs.statSync(download.filePath).size > 0)
  }
  assert.ok(stages.includes('queued'))
})
