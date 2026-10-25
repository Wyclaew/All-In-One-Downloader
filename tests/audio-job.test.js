'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('fs'), path = require('path')
const { root, load } = require('./helpers.cjs')
const store = load('electron/lib/store.js')
const chosen = []
const audio = { selectAudio: async (_file, preferred) => { chosen.push(preferred); return { language: 'en', availableLanguages: ['en'], warning: preferred === 'tr' ? 'Türkçe ses bulunamadı; mevcut ses: en.' : null } } }
load('electron/lib/audio-selection.js')
require.cache[require.resolve('../electron/lib/audio-selection.js')].exports = audio
const downloader = load('electron/lib/downloader.js', {
  './ownengine': { transfer: async ({ download }) => { const filePath = path.join(root, download.id + '.mp4'); fs.writeFileSync(filePath, 'fixture'); return { filePath } } },
})
store.commit = (fn) => fn(store.getState()); store.send = () => {}; store.toast = () => {}
async function finish(download) { for (let i = 0; i < 100 && !['done', 'error'].includes(download.status); i++) await new Promise((r) => setTimeout(r, 5)); return download }
test.after(() => { downloader.killAll(); fs.rmSync(root, { recursive: true, force: true }) })
test('an explicit unavailable language is not marked complete as a different dub, and source choice permits it', async () => {
  const state = store.getState()
  Object.assign(state.settings, { downloadDir: root, autoStartDownloads: false, useYtdlp: false, concurrency: 1, preferredAudioLanguage: 'en', writeSubs: false, autoFetchSubtitles: false, autoRecover: true })
  const missing = downloader.enqueue({ url: 'https://example.test/movie', title: 'fixture', preferredAudioLanguage: 'tr' })
  downloader.pumpQueue(); await finish(missing)
  assert.equal(missing.status, 'error'); assert.match(missing.error, /Türkçe ses/)
  assert.match(missing.audioWarning, /Türkçe/); assert.equal(missing.audioLanguage, 'en')
  assert.equal(missing.finishedAt, null); assert.ok(fs.existsSync(missing.pendingFilePath)); assert.equal(missing.recoveryCount, 0)
  const fallback = downloader.enqueue({ url: missing.url, title: 'fixture', preferredAudioLanguage: 'auto' })
  downloader.pumpQueue(); await finish(fallback)
  assert.equal(fallback.status, 'done'); assert.equal(fallback.audioLanguage, 'en')
  state.settings.preferredAudioLanguage = 'tr'
  const english = downloader.enqueue({ url: missing.url, title: 'fixture', preferredAudioLanguage: 'en' })
  downloader.pumpQueue(); await finish(english)
  assert.equal(english.status, 'done'); assert.deepEqual(chosen, ['tr', 'auto', 'en'])
})
