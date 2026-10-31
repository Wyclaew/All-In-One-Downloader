'use strict'
// Real Electron run: live TVmaze lookup, the vault switch, and a real player
// session reported to a stand-in for Show Tracker's loopback bridge.
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('child_process')
const fs = require('fs'), http = require('http'), os = require('os'), path = require('path')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-shows-smoke-'))
const dir = path.join(profile, 'downloads')
fs.mkdirSync(dir)
app.setPath('userData', profile)
const filePath = path.join(dir, 'Breaking Bad S01E01.mp4')
execFileSync(process.env.FFMPEG || 'ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=d=40:s=160x90:r=5', '-pix_fmt', 'yuv420p', filePath])
const downloads = [{ id: 'e1', title: 'Pilot', url: 'https://example.test/1', site: 'Yerel', status: 'done', series: 'Breaking Bad', season: 1, episode: 1,
  filePath, fileSize: fs.statSync(filePath).size, percent: 1, audioOnly: false, createdAt: Date.now(), finishedAt: Date.now(), attempts: 1 }]
fs.writeFileSync(path.join(profile, 'library.json'), JSON.stringify({ version: 1, downloads, items: [], sources: [],
  settings: { downloadDir: dir, autoStartDownloads: false, settingsRev: 3, autoCheckUpdates: false } }))
const reports = []
http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => { reports.push(JSON.parse(b)); res.statusCode = 204; res.end() }) }).listen(7423, '127.0.0.1')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const errors = []
app.on('web-contents-created', (_e, c) => c.on('console-message', (_x, level, message) => { if (level >= 3) errors.push(message) }))
app.once('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code)
    const clickRail = (label) => js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(label)})).click()`)
    try {
      await wait(1000)
      await clickRail('Diziler')
      for (let i = 0; i < 40 && !(await js(`document.body.innerText.includes('sezon ·')`)); i++) await wait(250)
      const text = await js(`document.querySelector('.shows').innerText`)
      if (!/Breaking Bad · 1 bölüm var · 61 eksik/.test(text)) throw new Error('Unexpected show summary: ' + text)
      fs.writeFileSync(path.join(profile, 'shows.png'), (await win.webContents.capturePage()).toPNG())
      const rail = () => js(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Kasa')`)
      if (!await rail()) throw new Error('Vault missing while enabled')
      await js(`window.api.updateSettings({ vaultEnabled: false })`); await wait(300)
      if (await rail()) throw new Error('Vault still shown when disabled')
      const take = await js(`window.api.vaultTakeDownload('e1')`)
      if (take.ok) throw new Error('Vault accepted a file while disabled')
      await js(`window.api.updateSettings({ vaultEnabled: true })`); await wait(300)
      if (!await rail()) throw new Error('Vault did not come back')
      const before = BrowserWindow.getAllWindows().length
      await js(`window.api.playFile(${JSON.stringify(filePath)})`)
      for (let i = 0; i < 80 && !reports.length; i++) await wait(250)
      if (BrowserWindow.getAllWindows().length <= before) throw new Error('Player did not open')
      if (!reports.length) throw new Error('No Show Tracker report')
      if (reports[0].title !== 'Breaking Bad S01E01' || reports[0].url.includes(profile)) throw new Error('Bad report ' + JSON.stringify(reports[0]))
      BrowserWindow.getAllWindows().filter((w) => w !== win).forEach((w) => w.close())
      await wait(500)
      if (reports.at(-1).playing !== false) throw new Error('No final pause report')
      if (errors.length) throw new Error(errors.join('\n'))
      console.log(JSON.stringify({ ok: true, summary: text.split('\n').slice(0, 3), reports: reports.length, first: reports[0], screenshot: path.join(profile, 'shows.png') }))
      app.exit(0)
    } catch (err) { console.error(err); app.exit(1) }
  })
})
require('../../electron/main.js')
