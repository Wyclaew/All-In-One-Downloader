'use strict'
// Controlled local media and isolated app profile. Never opens user downloads.
const { app, session } = require('electron')
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict')
const { execFileSync } = require('child_process')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-media-health-ui-'))
app.setPath('userData', profile)
const file = path.join(profile, 'generated-gap.mp4')
const binaries = require('../../electron/lib/binaries')
execFileSync(binaries.ffmpegPath(), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=24:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
  '-vf', "select='not(between(t,2,4))'", '-af', "aselect='not(between(t,2,4))'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-metadata:s:a:0', 'language=eng', file], { env: binaries.toolEnv() })
fs.writeFileSync(path.join(profile, 'library.json'), JSON.stringify({ downloads: [{ id: 'gap', title: 'Generated gap fixture', url: 'https://example.test/movie', status: 'done', filePath: file, createdAt: 1, finishedAt: 1, audioOnly: false, quality: 1080 }], items: [], sources: [],
 settings: { downloadDir: profile, settingsRev: 3, autoCheckUpdates: false, autoDetectClipboard: false, torAutoStart: false, embedThumbnail: false } }))
const errors = []; let external = 0
app.on('web-contents-created', (_event, contents) => contents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message) }))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check) { const started = Date.now(); while (!await check()) { if (Date.now() - started > 10000) throw Error('Media check UI timed out'); await delay(40) } }
app.once('browser-window-created', (_event, win) => {
  const evaluate = (code) => win.webContents.executeJavaScript(code)
  win.webContents.once('did-finish-load', async () => {
    try {
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => { external++; callback({ cancel: true }) })
      await delay(600); win.webContents.send('menu', 'view:library'); await delay(150)
      await evaluate(`document.querySelector('.dl-actions button[title="Diğer işlemler"]').click()`)
      await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='Videonun zamanlamasını kontrol et').click()`)
      await until(() => evaluate(`document.querySelector('[role="dialog"]')?.textContent.includes('aynı noktalarda boşluklar')`))
      const result = await evaluate('window.api.getState()')
      assert.equal(result.ok, true); assert.ok(result.data.downloads[0].mediaInspection.correlatedGaps >= 1)
      assert.equal(result.data.downloads[0].filePath, file)
      win.setSize(1000, 620); await delay(80)
      assert.equal(await evaluate(`(()=>{const box=document.querySelector('[role=dialog]').getBoundingClientRect();return box.top>=0&&box.bottom<=innerHeight})()`), true)
      fs.writeFileSync('/tmp/aio-media-health-ui.png', (await win.webContents.capturePage()).toPNG())
      await evaluate(`Array.from(document.querySelectorAll('[role=dialog] button')).find(button=>button.textContent.trim()==='Kapat').click()`)
      assert.equal(await evaluate('!!document.querySelector("[role=dialog]")'), false)
      assert.equal(external, 0); assert.deepEqual(errors, [])
      console.log(JSON.stringify({ ok: true, realGapDetected: true, summaryStored: true, pathsUnchanged: true, localOnly: true, dialogFits: true, rendererErrors: errors }))
    } catch (error) { console.error(error); console.error('Renderer errors:', JSON.stringify(errors)); process.exitCode = 1 }
    finally { win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(process.exitCode || 0) }
  })
})
require('../../electron/main')
