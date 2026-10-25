'use strict'
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-ui-smoke-'))
const downloadsDir = path.join(profile, 'downloads')
fs.mkdirSync(downloadsDir)
app.setPath('userData', profile)
const snapshots = process.env.AIO_SMOKE_OUTPUT || '/tmp/aio-ui-smoke-results'
fs.mkdirSync(snapshots, { recursive: true })
const downloads = [1, 2, 3].map((episode) => {
  const filePath = path.join(downloadsDir, `3 Body Problem S01E0${episode}.mp4`)
  fs.writeFileSync(filePath, '')
  return { id: `episode-${episode}`, itemId: null, sourceId: null, title: `3 Body Problem 1. Sezon ${episode}. Bölüm`,
    url: 'https://example.test/episode', site: 'Yerel test', status: 'done', stage: null,
    series: '3 Body Problem', season: 1, episode, audioLanguage: 'en', subtitleLanguage: 'tr',
    filePath, fileSize: 0, quality: 1080, percent: 1, downloaded: 0, total: 0, audioOnly: false,
    createdAt: Date.now(), finishedAt: Date.now(), duration: 3635, attempts: 1 }
})
fs.writeFileSync(path.join(profile, 'library.json'), JSON.stringify({ version: 1, downloads,
  items: [{ id: 'audio-choice-item', sourceId: 'audio-choice-source', index: 0, url: 'https://example.test/dual.mp4', title: 'Ses seçimi denemesi', duration: 90, height: 1080, filesize: 1000000, site: 'Yerel test' }],
  sources: [{ id: 'audio-choice-source', url: 'https://example.test/source', title: 'Ses seçimi denemesi', site: 'Yerel test', status: 'ready', count: 1, collapsed: false, useProxy: false }], categories: [],
  settings: { downloadDir: downloadsDir, autoStartDownloads: false, settingsRev: 3, groupEpisodes: true, autoCheckUpdates: false, autoDetectClipboard: false, embedThumbnail: false } }))
const errors = []
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message) })
})
app.once('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    try {
      // Allow the initial IPC state and thumbnail lookups to settle.
      await new Promise((r) => setTimeout(r, 1200))
      let result = await win.webContents.executeJavaScript(`({ collections: document.querySelectorAll('.series-collection').length, text: document.body.innerText })`)
      if (result.collections !== 1) throw new Error('Expected a single series collection: ' + result.text.slice(-500))
      await win.webContents.executeJavaScript(`document.querySelector('.series-collection summary').click()`)
      await new Promise((r) => setTimeout(r, 250))
      fs.writeFileSync(path.join(snapshots, 'home.png'), (await win.webContents.capturePage()).toPNG())
      result = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.series-collection .card-v-title')).map(el => el.textContent)`)
      if (result.length !== 3 || !result[0].includes('1. Bölüm') || !result[2].includes('3. Bölüm')) throw new Error('Episode order is incorrect')
      win.webContents.send('menu', 'settings')
      await new Promise((r) => setTimeout(r, 300))
      const settingsText = await win.webContents.executeJavaScript(`document.body.innerText`)
      if (!settingsText.includes('Tercih edilen ses dili') || !settingsText.includes('Otomatik kurtarma')) throw new Error('Missing new settings')
      fs.writeFileSync(path.join(snapshots, 'settings.png'), (await win.webContents.capturePage()).toPNG())
      if (!await win.webContents.executeJavaScript('document.body.textContent.includes("Site hesapları")')) throw new Error('Missing site accounts settings')
      win.webContents.send('menu', 'view:sources')
      await new Promise((r) => setTimeout(r, 300))
      const selectAudio = async (value) => win.webContents.executeJavaScript(`{
        const select = document.querySelector('select[aria-label="Bu videonun indirilecek ses dili"]');
        if (!select) throw Error('Missing per-video audio selector');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select, ${JSON.stringify(value)});
        select.dispatchEvent(new Event('change',{bubbles:true}));
      }`)
      await selectAudio('tr')
      win.webContents.send('menu', 'settings'); await new Promise((r) => setTimeout(r, 100))
      win.webContents.send('menu', 'view:sources'); await new Promise((r) => setTimeout(r, 100))
      result = await win.webContents.executeJavaScript(`document.querySelector('select[aria-label="Bu videonun indirilecek ses dili"]').value`)
      if (result !== 'tr') throw new Error('Per-video audio selection was lost after navigation')
      await win.webContents.executeJavaScript(`document.querySelector('.row-actions button[title="İndir"]').click()`)
      await new Promise((r) => setTimeout(r, 200))
      result = await win.webContents.executeJavaScript('window.api.getState()')
      if (!result.ok || !result.data.downloads.some(d => d.itemId === 'audio-choice-item' && d.preferredAudioLanguage === 'tr' && d.audioSelectionExplicit)) throw new Error('Selected audio did not reach the queued job')
      win.setSize(1000, 720)
      await new Promise((r) => setTimeout(r, 100))
      result = await win.webContents.executeJavaScript('document.documentElement.scrollWidth <= window.innerWidth')
      if (!result) throw new Error('Source controls overflow at 1000px')
      fs.writeFileSync(path.join(snapshots, 'sources-audio.png'), (await win.webContents.capturePage()).toPNG())
      if (errors.length) throw new Error(errors.join('\n'))
      console.log(JSON.stringify({ ok: true, snapshots, collectionCount: 1, episodes: 3, audioChoicePersisted: true, audioChoiceQueued: true, sourceLayoutFits: true, rendererErrors: errors }))
    } catch (err) { console.error(err); process.exitCode = 1 }
    finally { app.quit() }
  })
})
require('../../electron/main')
app.once('quit', () => fs.rmSync(profile, { recursive: true, force: true }))
