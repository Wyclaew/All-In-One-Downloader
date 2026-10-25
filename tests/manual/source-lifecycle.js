'use strict'
// Real main-process IPC + renderer bridge, temporary profile and local fixtures.
const { app, shell } = require('electron')
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http')
const assert = require('assert/strict')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-source-ipc-'))
app.setPath('userData', profile)
fs.writeFileSync(path.join(profile, 'library.json'), JSON.stringify({ settings: {
  settingsRev: 3, autoCheckUpdates: false, autoDetectClipboard: false, useYtdlp: false,
  resolverConcurrency: 1, enrichLimit: 0, minStreamSeconds: 0, resolverTimeout: 8000,
  autoStartDownloads: false, proxyUrl: 'http://127.0.0.1:9',
} }))
let server, base, timeout
const seen = []
let shownBackup = null
shell.showItemInFolder = (file) => { shownBackup = file }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check) {
  for (let n = 0; n < 200; n++) { if (await check()) return; await delay(30) }
  throw new Error('State transition timed out')
}
app.once('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    const call = async (name, ...args) => {
      const result = await win.webContents.executeJavaScript(`window.api[${JSON.stringify(name)}](...${JSON.stringify(args)})`)
      assert.equal(result.ok, true, result.error); return result.data
    }
    const state = () => call('getState')
    try {
      await call('addSource', base + '/stall\n' + base + '/master.m3u8?token=fixture-secret', false)
      let current = await state()
      const stalled = current.sources.find((s) => s.url.endsWith('/stall'))
      const queued = current.sources.find((s) => s.id !== stalled.id)
      assert.equal(queued.status, 'queued')
      await call('cancelSource', queued.id)
      await call('cancelSource', stalled.id)
      await delay(150)
      assert.equal(seen.some((url) => url.startsWith('/master')), false, 'Canceled queued scan still made a request')
      assert.equal((await state()).sources.find((s) => s.id === queued.id).status, 'canceled')
      assert.equal(await call('retryFailedSources'), 2)
      await until(async () => (await state()).sources.find((s) => s.id === queued.id).status === 'ready')
      await call('cancelAllSources')
      current = await state()
      assert.ok(!current.sources.some((s) => ['queued', 'probing'].includes(s.status)))
      const item = current.items.find((i) => i.sourceId === queued.id)
      assert.ok(item)
      assert.equal(await call('refreshSourceMetadata', queued.id), true)
      current = await state()
      assert.equal(current.items.find((i) => i.sourceId === queued.id).id, item.id)
      const report = await call('sourceDiagnostics', queued.id)
      assert.doesNotThrow(() => JSON.parse(report))
      assert.equal(report.includes('fixture-secret'), false)
      assert.equal(report.includes('/master.m3u8'), false)
      const first = await call('download', { itemIds: [item.id], quality: 720 })
      assert.equal(first.count, 1)
      assert.equal((await call('download', { itemIds: [item.id], quality: 720 })).count, 0)
      assert.equal(await call('setSourceProxy', queued.id, true), true)
      await call('cancelSource', queued.id)
      current = await state()
      assert.equal(current.sources.find((s) => s.id === queued.id).useProxy, true)
      assert.equal(current.downloads[0].status, 'paused')
      assert.equal(current.downloads[0].useProxy, true)
      assert.equal(current.downloads[0].refreshPending, true)
      assert.equal(await call('setSourceProxy', queued.id, false), true)
      await until(async () => (await state()).sources.find((s) => s.id === queued.id).status === 'ready')
      const backup = await call('backupLibrary')
      assert.equal(backup.path, shownBackup)
      assert.ok(fs.existsSync(backup.path))
      assert.ok(backup.path.startsWith(path.join(profile, 'backups')))
      console.log(JSON.stringify({ ok: true, queuedCancel: true, batchRetry: true, batchStop: true, metadataPreservesId: true, reportRedacted: true, routeSwitchPauses: true, duplicateCount: true, backup: true }))
    } catch (err) { console.error(err); process.exitCode = 1 }
    finally { clearTimeout(timeout); app.quit() }
  })
})
server = http.createServer((req, res) => {
  seen.push(req.url)
  if (req.url === '/stall') return
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
  if (req.url.startsWith('/master.m3u8')) { res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=128x96\n/vod.m3u8\n'); return }
  if (req.url === '/vod.m3u8') { res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/fragment.ts\n#EXT-X-ENDLIST\n'); return }
  res.setHeader('Content-Type', 'video/mp2t'); res.setHeader('Content-Length', '188'); res.end(Buffer.alloc(188))
})
server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`
  timeout = setTimeout(() => { console.error('Source IPC fixture timed out'); process.exitCode = 1; app.quit() }, 30000)
  require('../../electron/main')
})
app.once('quit', () => { server.closeAllConnections(); server.close(); fs.rmSync(profile, { recursive: true, force: true }) })
