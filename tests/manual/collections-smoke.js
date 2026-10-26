'use strict'
// Isolated real main IPC + renderer; library metadata only and synthetic files.
const { app } = require('electron')
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-collection-ui-'))
const folder = path.join(profile, 'downloads'); fs.mkdirSync(folder)
app.setPath('userData', profile)
const originals = [
  { id: 'ten', title: 'Episode 10', series: 'Old Series', season: 1, episode: 10 },
  { id: 'two', title: 'Episode 2', series: 'Old Series', season: 1, episode: 2 },
  { id: 'one', title: 'Episode 1', series: 'Another Series', season: null, episode: null },
].map((item, index) => {
  const filePath = path.join(folder, item.id + '.mp4'); fs.writeFileSync(filePath, '')
  return { ...item, itemId: null, sourceId: null, url: 'https://example.test/' + item.id, filePath,
    status: 'done', stage: null, createdAt: index + 1, finishedAt: index + 1, fileSize: 0,
    quality: 1080, percent: 1, downloaded: 0, total: 0, audioOnly: false, attempts: 1 }
})
fs.writeFileSync(path.join(profile, 'library.json'), JSON.stringify({ version: 1, downloads: originals, items: [], sources: [], categories: [],
  settings: { downloadDir: folder, settingsRev: 3, autoCheckUpdates: false, autoDetectClipboard: false, torAutoStart: false, embedThumbnail: false } }))
const errors = []
app.on('web-contents-created', (_event, contents) => contents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message) }))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
app.once('browser-window-created', (_event, win) => {
  const evaluate = (code) => win.webContents.executeJavaScript(code)
  const click = (text) => evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(text)}).click()`)
  const select = (label, value) => evaluate(`{const element=document.querySelector('select[aria-label='+JSON.stringify(${JSON.stringify(label)})+']');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('change',{bubbles:true}));}`)
  const input = (label, value) => evaluate(`{const element=document.querySelector('input[aria-label='+JSON.stringify(${JSON.stringify(label)})+']');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));}`)
  const state = async () => { const result = await evaluate('window.api.getState()'); assert.equal(result.ok, true); return result.data }
  win.webContents.once('did-finish-load', async () => {
    try {
      await wait(700); win.webContents.send('menu', 'view:library'); await wait(150)
      await evaluate(`document.querySelector('.section-head .dl-check input').click()`); await wait(100)
      await click('Dizi / bölüm düzenle'); await wait(100)
      assert.equal(await evaluate(`document.querySelector('select[aria-label="Koleksiyon adı düzenlemesi"]').value`), 'preserve', 'mixed names must be preserved by default')
      assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='Değişiklikleri kaydet').disabled`), true)
      await select('Koleksiyon adı düzenlemesi', 'set'); await input('Dizi / koleksiyon adı', 'Fixture Series')
      await select('Sezon düzenlemesi', 'set'); await input('Sezon numarası', '2')
      await select('Bölüm numarası düzenlemesi', 'set'); await input('İlk bölüm numarası', '4')
      await select('Bölüm sıralaması', 'title'); await click('Önizle'); await wait(120)
      assert.equal(await evaluate(`document.querySelectorAll('.collection-preview li').length`), 3)
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.collection-preview li > span:first-child')).map(element=>element.textContent)`), ['Episode 1', 'Episode 2', 'Episode 10'])
      win.setSize(1000, 620); await wait(100)
      assert.equal(await evaluate(`(()=>{const box=document.querySelector('[role=dialog]').getBoundingClientRect();return box.top>=0&&box.bottom<=innerHeight})()`), true, 'editor must fit the minimum window height')
      await evaluate(`{const buttons=document.querySelectorAll('[role=dialog] button');buttons[buttons.length-1].focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));}`)
      assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), 'Koleksiyon adı düzenlemesi', 'keyboard focus must remain inside the editor')
      fs.writeFileSync('/tmp/aio-collections-preview.png', (await win.webContents.capturePage()).toPNG())
      await click('Değişiklikleri kaydet'); await wait(150)
      let current = await state()
      assert.deepEqual(current.downloads.slice().sort((a,b)=>a.episode-b.episode).map((record)=>[record.id,record.series,record.season,record.episode]), [['one','Fixture Series',2,4],['two','Fixture Series',2,5],['ten','Fixture Series',2,6]])
      for (const record of current.downloads) assert.equal(record.filePath, originals.find((item)=>item.id===record.id).filePath)
      await click('Geri al'); await wait(150)
      current = await state()
      for (const record of current.downloads) {
        const old = originals.find((item)=>item.id===record.id)
        assert.equal(record.series,old.series); assert.equal(record.season,old.season); assert.equal(record.episode,old.episode)
      }
      assert.deepEqual(errors, [])
      console.log(JSON.stringify({ ok: true, mixedNamesPreserved: true, previewBeforeSave: true, naturalEpisodeOrder: true, metadataApplied: true, undo: true, filePathsPreserved: true, shortWindowFits: true, focusContained: true, rendererErrors: errors }))
    } catch (error) { console.error(error); console.error('Renderer errors:', JSON.stringify(errors)); process.exitCode = 1 }
    finally { win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(process.exitCode || 0) }
  })
})
require('../../electron/main')
app.once('quit', () => fs.rmSync(profile, { recursive: true, force: true }))
