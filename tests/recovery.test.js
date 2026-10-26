'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { failureKind, retryDelay } = require('../electron/lib/recovery')
const { TransferStats } = require('../electron/lib/transfer-stats')
const { formatSelector, rankCandidates } = require('../electron/lib/media-preferences')
const { load, root } = require('./helpers.cjs')
const fs = require('fs')
const downloader = load('electron/lib/downloader.js')
const store = load('electron/lib/store.js')
// No timers or persistence are needed for a pure queue simulation.
store.commit = (fn) => fn(store.getState())
store.send = () => {}

test.after(() => { downloader.killAll(); fs.rmSync(root, { recursive: true, force: true }) })
test('recover only temporary network errors; do not retry login, DRM or disk errors', () => {
  assert.equal(failureKind(Object.assign(new Error('aborted'), { code: 'ECONNRESET' })), 'network')
  assert.equal(failureKind({ code: 'ABORTED' }), 'aborted')
  assert.equal(failureKind(new Error('HTTP Error 403')), 'expired')
  assert.equal(failureKind(new Error('HTTP Error 429: Too many requests')), 'busy')
  assert.equal(failureKind(new Error('Login required')), 'auth')
  assert.equal(failureKind(new Error('ENOSPC')), 'disk')
  assert.equal(failureKind(new Error('Widevine DRM')), 'protected')
  assert.ok(retryDelay(2) > retryDelay(0))
})
test('rolling ETA excludes preexisting resume bytes and ages out stalls', () => {
  const stats = new TransferStats(1000000, 0)
  assert.equal(stats.update(1001000, 2000000, 1000).eta, null)
  assert.equal(stats.update(1002000, 2000000, 2000).speed, 1000)
  assert.equal(stats.update(1002000, 2000000, 12000).speed, 0)
  assert.equal(stats.update(1002000, 2000000, 13000).eta, null)
})
test('English audio selectors precede unknown/default dub and respect the quality cap', () => {
  const selector = formatSelector({ quality: 720, audioOnly: false }, { preferredAudioLanguage: 'en' })
  assert.ok(selector.startsWith('bv[height<=?720]+ba[language^=en]/b[height<=?720][language^=en]'))
  assert.ok(!formatSelector({ audioOnly: true, preferredAudioLanguage: 'auto' }).includes('language'))
  const args = downloader.buildArgs({ id: 'x', title: 'A', url: 'https://example.test/video', quality: 1080 }, { downloadDir: root, connections: 8, writeSubs: true, subLangs: 'tr' }, '/tmp/aio-print.txt')
  assert.ok(args.includes('--abort-on-unavailable-fragments'))
  assert.equal(args[args.indexOf('--sub-langs') + 1], 'tr')
})
test('preferred audio ranks known English above Turkish without inventing a language', () => {
  const candidates = [{ id: 'tr', info: { audioTracks: [{ lang: 'tur' }] } }, { id: 'unknown' }, { id: 'en', info: { audioTracks: [{ lang: 'en-US' }] } }]
  assert.deepEqual(rankCandidates(candidates).map((x) => x.id), ['en', 'unknown', 'tr'])
})
test('queue estimate visits every queued item, even after the active list shrinks', () => {
  store.getState().settings.concurrency = 2
  store.getState().downloads = [
    { id: 'a', status: 'running', stage: 'downloading', speed: 1000, total: 10000, downloaded: 0 },
    ...Array.from({ length: 20 }, (_, i) => ({ id: `q${i}`, status: 'queued', expectedSize: 10000 })),
  ]
  const result = downloader.outlook()
  assert.equal(Object.keys(result.etas).length, 21)
  assert.equal(result.total, 210)
})
test('a pending auto-retry can be paused and manual retry starts a fresh budget', () => {
  const d = { id: 'recovery-test', url: 'https://example.test/video', status: 'running', resolved: { pageUrl: 'https://example.test/page' } }
  store.getState().downloads = [d]
  assert.equal(downloader.scheduleRecovery(d, { recoveryAttempts: 3 }, 'HTTP Error 403'), true)
  assert.equal(d.refreshPending, true)
  assert.ok(d.retryAt > Date.now())
  downloader.pause(d.id)
  assert.equal(d.status, 'paused')
  d.recoveryCount = 3
  assert.equal(downloader.scheduleRecovery(d, { recoveryAttempts: 3 }, 'ECONNRESET'), false)
})

test('repeated transient connection resets preserve the manifest instead of rotating CDN URLs and losing the journal', () => {
  const download = { id: 'stable-journal', url: 'https://cdn.example.test/master', status: 'running', recoveryCount: 1, resolved: { pageUrl: 'https://example.test/page' } }
  store.getState().downloads = [download]
  assert.equal(downloader.scheduleRecovery(download, { recoveryAttempts: 3 }, { code: 'ECONNRESET' }), true)
  assert.equal(download.refreshPending, false)
  downloader.pause(download.id)
})
test('unsupported extraction does not become an internet-offline error', () => {
  const { readableError } = load('electron/lib/probe.js')
  assert.ok(!readableError('ERROR: Unable to download webpage: HTTP Error 403').includes('Ağa ulaşılamadı'))
  assert.ok(!readableError('ERROR: Unable to download webpage: extractor failed').includes('Ağa ulaşılamadı'))
})

test('separate video/audio phases keep cumulative bytes and do not finish on the video phase', () => {
  const job = { prevBytes: 0, phase: 1, phases: 2, maxPercent: 0 }
  const d = { id: 'phase-test', downloaded: 0, expectedSize: null }
  downloader.parseProgressLine('@P@downloading|800|1000|NA|100|2|80|100', job, d)
  assert.equal(d.eta, null)
  downloader.parseProgressLine('@P@finished|1000|1000|NA|NA|0|100|100', job, d)
  assert.equal(d.stage, 'downloading')
  downloader.parseProgressLine('@P@downloading|50|100|NA|20|3|5|10', job, d)
  assert.equal(d.downloaded, 1050)
  downloader.parseProgressLine('@P@finished|100|100|NA|NA|0|10|10', job, d)
  assert.equal(d.downloaded, 1100)
  assert.equal(d.stage, 'processing')
})

test('yt-dlp receives an explicit route for direct and proxied jobs while Tor is configured', () => {
  const settings = { downloadDir: root, proxyUrl: 'socks5://127.0.0.1:9061' }
  for (const useProxy of [false, true]) {
    const args = downloader.buildArgs({ id: 'route', title: 'route', url: 'https://example.test/video', useProxy }, settings, '/tmp/aio-print.txt')
    assert.ok(args.includes('--proxy'))
    assert.equal(args[args.indexOf('--proxy') + 1], useProxy ? settings.proxyUrl : '')
  }
})
