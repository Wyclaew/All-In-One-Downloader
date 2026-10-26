'use strict'
// Real main IPC/renderer with synthetic media and an isolated profile only.
const { app } = require('electron')
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('node:assert/strict')
const { execFileSync } = require('child_process')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-transfer-ui-'))
app.setPath('userData', profile)
const binaries = require('../../electron/lib/binaries')
const sample = path.join(profile, 'original.mkv')
execFileSync(binaries.ffmpegPath(), ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=64x64:r=10:d=1', '-f', 'lavfi', '-i', 'sine=frequency=600:duration=1',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-metadata:s:a:0', 'title=Original Audio', sample], { env: binaries.toolEnv() })
const resolved = { pageUrl: 'https://example.test/episode8', kind: 'hls', cookieFile: null }
const source = { id: 'source', url: resolved.pageUrl, title: 'The Mentalist 1. Sezon 8. Bölüm', status: 'ready', collapsed: false, site: 'Fixture', count: 2 }
const item = { id: 'new-item', sourceId: source.id, index: 0, title: source.title + ' · akış 1', url: 'https://new-cdn.example.test/master', height: 720, duration: 1, filesize: 100000, variants: [720],
  resolved, audioTracks: [{ name: 'Turkish', url: 'https://new-cdn.example.test/audio-tr' }, { name: 'Original Audio', url: 'https://new-cdn.example.test/audio-original' }] }
const download = { id: 'job', itemId: 'previous-item', sourceId: source.id, title: source.title, url: 'https://previous-cdn.example.test/master', resolved,
  status: 'paused', stage: null, preferredAudioLanguage: 'en', quality: 720, createdAt: 1, downloaded: 40000, total: 100000, percent: .4, attempts: 2, progressSequence: 10 }
fs.writeFileSync(path.join(profile, 'library.json'), JSON.stringify({ sources: [source], items: [item, { ...item, id: 'audio-rendition', index: 1, height: null, variants: [], url: item.audioTracks[0].url, audioTracks: [] }], downloads: [download],
  settings: { settingsRev: 3, downloadDir: profile, concurrency: 2, autoStartDownloads: false, autoCheckUpdates: false, autoDetectClipboard: false, preferredAudioLanguage: 'auto', writeSubs: false, autoFetchSubtitles: false, protectDiskSpace: false, embedThumbnail: false } }))
const transfers = [], errors = []
require('../../electron/lib/ownengine').transfer = async ({ download: live, onDest }) => {
  transfers.push(live.preferredAudioLanguage)
  const filePath = path.join(profile, 'finished.mkv'); fs.copyFileSync(sample, filePath); onDest(filePath)
  return { filePath }
}
app.on('web-contents-created', (_event, contents) => contents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message) }))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check) { const start = Date.now(); while (!await check()) { if (Date.now() - start > 10000) throw Error('UI state timed out'); await delay(30) } }
let code = 0
app.once('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    const store = require('../../electron/lib/store')
    const evaluate = (script) => win.webContents.executeJavaScript(script)
    try {
      await delay(600)
      assert.equal(store.getState().items.length, 1, 'persisted audio child is removed from the video catalog')
      store.commit(() => { const live = store.findDownload('job'); live.status = 'running'; live.stage = 'downloading' })
      win.webContents.send('menu', 'view:sources')
      await until(() => evaluate(`!!document.querySelector('.row-actions button[title="Duraklat"]')`))
      assert.equal(await evaluate(`document.querySelectorAll('.row-actions button[title="İndir"]').length`), 0, 'old CDN address must still show the running job')
      assert.equal(await evaluate(`document.querySelectorAll('select[aria-label="Bu kaynağın indirilecek ses dili"]').length`), 0, 'one-video source does not duplicate the row controls')
      const progress = { id: 'job', status: 'running', stage: 'downloading', attempt: 1, sequence: 99, percent: .95, downloaded: 95000, total: 100000, speed: 10000, eta: 1, phase: 1, phases: 1 }
      store.send('progress', progress); await delay(100)
      assert.equal(await evaluate(`document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')`), '40')
      store.send('progress', { ...progress, attempt: 2, sequence: 11, percent: .45, parts: Array.from({ length: 6 }, () => ({ done: 100, size: 100 })) })
      await until(() => evaluate(`document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')==='45'`))
      win.webContents.send('menu', 'view:library')
      await until(() => evaluate(`!!document.querySelector('.dl')`))
      assert.equal(await evaluate(`document.querySelector('.dl .meter').getAttribute('aria-valuenow')`), '45')
      assert.equal(await evaluate(`document.querySelectorAll('.dl .meter .meter-fill').length`), 1)
      store.commit(() => { const live = store.findDownload('job'); Object.assign(live, { status: 'error', stage: null, errorCode: 'AUDIO_LANGUAGE_UNAVAILABLE', error: 'İstenen İngilizce ses bulunamadı.', pendingFilePath: sample }) })
      win.webContents.send('menu', 'view:sources')
      await until(() => evaluate(`!!document.querySelector('.row-actions button[title="Seçilen ses ve kaliteyle yeniden dene"]')`))
      assert.equal(await evaluate(`document.querySelectorAll('.row-actions button[title="Yeniden dene"]').length`), 0)
      await evaluate(`{const select=document.querySelector('select[aria-label="Bu videonun indirilecek ses dili"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'original');select.dispatchEvent(new Event('change',{bubbles:true}));}`)
      await evaluate(`document.querySelector('.row-actions button[title="Seçilen ses ve kaliteyle yeniden dene"]').click()`)
      await until(() => store.findDownload('job').status === 'done')
      await until(() => evaluate("document.querySelector('.row-actions')?.textContent.includes('İndi')"))
      assert.deepEqual(transfers, ['original'])
      assert.equal(store.getState().downloads.length, 1)
      assert.equal(store.findDownload('job').rejectedAudioFilePath, sample)
      assert.equal(fs.existsSync(sample), true)
      assert.equal(store.findDownload('job').audioLanguage, null, 'Original Audio is not a verified English language tag')
      win.setSize(1000, 720); await delay(100)
      assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true)
      fs.writeFileSync('/tmp/aio-017-transfer-ui.png', (await win.webContents.capturePage()).toPNG())
      assert.deepEqual(errors, [])
      console.log(JSON.stringify({ ok: true, identityAfterCdnRefresh: true, staleProgressIgnored: true, aggregateMeter: true, renditionPruned: true, singleRetry: true, changedAudioReachedEngine: true, originalVerified: true, oldFilePreserved: true, noExtraRecord: true, narrowLayout: true, rendererErrors: errors }))
    } catch (error) { code = 1; console.error(error) }
    finally { app.exit(code) }
  })
})
require('../../electron/main')
app.once('quit', () => fs.rmSync(profile, { recursive: true, force: true }))
