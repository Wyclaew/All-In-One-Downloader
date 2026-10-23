'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('fs'), path = require('path'), { EventEmitter } = require('events')
const { root, load } = require('./helpers.cjs')
const store = load('electron/lib/store.js')
let prepared = 0, captionRoute
const downloader = load('electron/lib/downloader.js', {
  './network-context': { getContext: () => null, ensureForSource: async () => { prepared++; return 'socks5://127.0.0.1:32123' } },
  './audio-selection': { selectAudio: async () => ({ language: 'en' }) },
  './subtitle-fetch': { fetchSubtitle: async (_url, out, options) => { captionRoute = options.proxy; fs.writeFileSync(out, 'WEBVTT'); return out }, cleanupSubtitle: async () => {} },
  './subtitles': { subtitlePathFor: () => path.join(root, 'caption.srt'), embedMany: async () => ({ ok: true }) },
  './binaries': { ffmpegPath: () => 'fake-ffmpeg', toolEnv: () => ({}), ytdlpPathOrThrow: () => 'fake-ytdlp' },
  child_process: { spawn: (_bin, args) => { const child = new EventEmitter(); child.kill = () => {}; setImmediate(() => { fs.writeFileSync(args.at(-1), 'converted'); child.emit('close', 0) }); return child } },
})
for (const [file, stub] of [
  ['audio-selection', { selectAudio: async () => ({ language: 'en' }) }],
  ['subtitle-fetch', { fetchSubtitle: async (_url, out, options) => { captionRoute = options.proxy; fs.writeFileSync(out, 'WEBVTT'); return out }, cleanupSubtitle: async () => {} }],
  ['subtitles', { subtitlePathFor: () => path.join(root, 'caption.srt'), embedMany: async () => ({ ok: true }) }],
]) {
  load('electron/lib/' + file + '.js')
  require.cache[require.resolve('../electron/lib/' + file + '.js')].exports = stub
}
store.commit = (fn) => fn(store.getState()); store.send = () => {}; store.toast = () => {}
test('resuming a downloaded file prepares the isolated source route before fetching captions', async () => {
  const state = store.getState()
  Object.assign(state.settings, { downloadDir: root, autoStartDownloads: false, proxyUrl: '', writeSubs: true, subLangs: 'tr' })
  state.sources = [{ id: 'source', useProxy: true }]
  const item = { id: 'item', sourceId: 'source', title: 'Postprocessing fixture', url: 'https://example.test/stream',
    resolved: { kind: 'hls', pageUrl: 'https://example.test/page' }, subtitles: [{ url: 'https://example.test/tr.vtt', lang: 'tr' }] }
  const download = downloader.enqueue({ item })
  const pending = path.join(root, 'pending.mp4'); fs.writeFileSync(pending, 'downloaded video fixture')
  download.pendingFilePath = pending
  downloader.pumpQueue()
  for (let i = 0; i < 100 && download.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(download.status, 'done', download.error)
  assert.equal(prepared, 1)
  assert.equal(captionRoute, 'socks5://127.0.0.1:32123')
  assert.equal(download.subtitleLanguage, 'tr')
})
test.after(() => { downloader.killAll(); fs.rmSync(root, { recursive: true, force: true }) })
