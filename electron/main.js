'use strict'

const path = require('path')
const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, Menu } = require('electron')

const store = require('./lib/store')
const probe = require('./lib/probe')
const downloader = require('./lib/downloader')
const binaries = require('./lib/binaries')
const browsers = require('./lib/browsers')
const subtitles = require('./lib/subtitles')
const vault = require('./lib/vault')
const proxy = require('./lib/proxy')
const userscripts = require('./lib/userscripts')
const { uid, extractUrls, isProbablyUrl } = require('./lib/util')

// Load from the Vite dev server only when we were actually started by `npm run
// dev`; a plain `electron .` should use the built bundle in dist/.
const IS_DEV = process.env.NODE_ENV === 'development' || !!process.env.VITE_DEV_SERVER_URL
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'
const IS_MAC = process.platform === 'darwin'

let mainWindow = null

const ICON_PNG = path.join(__dirname, '..', 'build', 'icon.png')

// ---- window --------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#0F1318',
    // macOS gets an inset traffic-light bar we draw around; Windows keeps its
    // native frame so it feels like a normal Windows app.
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: IS_MAC ? { x: 16, y: 20 } : undefined,
    // Windows and Linux read the window icon; macOS uses the bundle's .icns.
    icon: IS_MAC ? undefined : ICON_PNG,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  if (IS_DEV) {
    mainWindow.loadURL(DEV_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  // Links open in the real browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isLocal = url.startsWith(DEV_URL) || url.startsWith('file://')
    if (!isLocal) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * What the renderer is allowed to know about the vault. Entry names only exist
 * while it is unlocked; locked, there is nothing to send but the count of
 * nothing.
 */
function vaultState() {
  return { ...vault.status(), entries: vault.isUnlocked() ? vault.list() : [] }
}

function pushVault() {
  store.send('vault', vaultState())
}

/**
 * Forget every trace of a file that has moved into the vault.
 *
 * The file is no longer where the library record and the source row say it is, so
 * leaving either behind means offering the user a broken "open" and a download
 * button for something they already have. The source heading itself goes when its
 * last item leaves — a group with nothing under it is just a stale title.
 *
 * Matched on the path as well as the id, so a file added straight from disk
 * cleans up the record that was pointing at it too.
 */
function forgetVaultedFile({ downloadId = null, filePath = null }) {
  const state = store.getState()
  const gone = state.downloads.filter(
    (d) => (downloadId && d.id === downloadId) || (filePath && d.filePath === filePath)
  )
  if (!gone.length && !downloadId) return

  const urls = new Set(gone.map((d) => d.url).filter(Boolean))
  const itemIds = new Set(gone.map((d) => d.itemId).filter(Boolean))
  const touchedSources = new Set(gone.map((d) => d.sourceId).filter(Boolean))

  for (const d of gone) downloader.remove(d.id, { deleteFile: false })

  store.commit((s) => {
    const before = new Map()
    for (const src of s.sources) before.set(src.id, s.items.filter((i) => i.sourceId === src.id).length)

    s.items = s.items.filter((i) => !itemIds.has(i.id) && !urls.has(i.url))

    for (const src of s.sources) {
      src.count = s.items.filter((i) => i.sourceId === src.id).length
      if (src.count === 0 && before.get(src.id) > 0) touchedSources.add(src.id)
    }
    // Only drop a source that has just been emptied — never one that arrived
    // empty, because that one is still showing the user why it found nothing.
    s.sources = s.sources.filter(
      (src) => !(touchedSources.has(src.id) && before.get(src.id) > 0 && src.count === 0)
    )
  })
}

function toRenderer(action) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu', action)
}

function buildMenu() {
  const template = [
    ...(IS_MAC
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: `${app.name} Hakkında` },
              { type: 'separator' },
              { label: 'Ayarlar…', accelerator: 'Cmd+,', click: () => toRenderer('settings') },
              { type: 'separator' },
              { role: 'hide', label: 'Gizle' },
              { role: 'hideOthers', label: 'Diğerlerini Gizle' },
              { role: 'unhide', label: 'Tümünü Göster' },
              { type: 'separator' },
              { role: 'quit', label: 'Çık' },
            ],
          },
        ]
      : []),
    {
      label: 'Dosya',
      submenu: [
        {
          label: 'Bağlantı Ekle…',
          accelerator: 'CmdOrCtrl+N',
          click: () => toRenderer('focus-url'),
        },
        {
          label: 'Panodan Ekle',
          accelerator: 'CmdOrCtrl+Shift+V',
          click: () => toRenderer('paste-add'),
        },
        { type: 'separator' },
        {
          label: 'İndirme Klasörünü Aç',
          // Nothing has been downloaded yet on a fresh install, so the folder
          // may not exist; creating it beats an error about a missing path.
          click: () => shell.openPath(store.ensureDownloadDir()),
        },
        ...(IS_MAC ? [] : [{ type: 'separator' }, { label: 'Ayarlar…', accelerator: 'Ctrl+,', click: () => toRenderer('settings') }, { role: 'quit', label: 'Çık' }]),
      ],
    },
    {
      label: 'Düzen',
      submenu: [
        { role: 'undo', label: 'Geri Al' },
        { role: 'redo', label: 'Yinele' },
        { type: 'separator' },
        { role: 'cut', label: 'Kes' },
        { role: 'copy', label: 'Kopyala' },
        { role: 'paste', label: 'Yapıştır' },
        { role: 'selectAll', label: 'Tümünü Seç' },
        { type: 'separator' },
        { label: 'Ara', accelerator: 'CmdOrCtrl+F', click: () => toRenderer('search') },
      ],
    },
    {
      label: 'Görünüm',
      submenu: [
        { label: 'Kaynaklar', accelerator: 'CmdOrCtrl+1', click: () => toRenderer('view:sources') },
        { label: 'Kitaplık', accelerator: 'CmdOrCtrl+2', click: () => toRenderer('view:library') },
        { type: 'separator' },
        { role: 'reload', label: 'Yenile' },
        { role: 'toggleDevTools', label: 'Geliştirici Araçları' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Gerçek Boyut' },
        { role: 'zoomIn', label: 'Yakınlaştır' },
        { role: 'zoomOut', label: 'Uzaklaştır' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Tam Ekran' },
      ],
    },
    {
      label: 'Pencere',
      submenu: [
        { role: 'minimize', label: 'Küçült' },
        { role: 'zoom', label: 'Büyüt' },
        ...(IS_MAC ? [{ role: 'front', label: 'Tümünü Öne Getir' }] : [{ role: 'close', label: 'Kapat' }]),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---- ipc -----------------------------------------------------------------

/**
 * A pool of resolvers rather than a queue of one.
 *
 * Each browser scan already runs in its own isolated session with its own
 * window, so several sites can be worked through at once without interfering —
 * and since most of a resolve is spent waiting on a page to load and a player to
 * start, the wall-clock saving is close to linear. Adding a link still returns
 * immediately either way.
 */
const probeQueue = []
let activeProbes = 0

function probeLimit() {
  return Math.max(1, Math.min(6, Number(store.getState().settings.resolverConcurrency) || 3))
}

function pumpProbes() {
  while (activeProbes < probeLimit() && probeQueue.length) {
    const source = probeQueue.shift()
    activeProbes += 1
    probe
      .probeUrl(source.url, { sourceId: source.id })
      .catch((err) => console.error('[probe]', err))
      .finally(() => {
        activeProbes -= 1
        pumpProbes()
      })
  }
}

function queueProbe(source) {
  probeQueue.push(source)
  pumpProbes()
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return { ok: true, data: await fn(payload) }
    } catch (err) {
      console.error(`[ipc] ${channel}`, err)
      return { ok: false, error: err && err.message ? err.message : String(err) }
    }
  })
}

function registerIpc() {
  handle('app:state', () => store.getState())
  handle('tools:get', () => binaries.detectTools())
  handle('browsers:list', () => browsers.detectBrowsers({ force: true }))
  handle('tools:refresh', () => binaries.detectTools({ force: true }))
  handle('tools:update', () => binaries.updateYtdlp())

  handle('source:add', ({ input, useProxy = false } = {}) => {
    const urls = extractUrls(String(input || ''))
    if (!urls.length) throw new Error('Geçerli bir bağlantı bulunamadı.')
    const settings = store.getState().settings
    if (useProxy && !String(settings.proxyUrl || '').trim()) {
      throw new Error('Vekil adresi boş. Ayarlar → Erişim bölümünden gir.')
    }
    const existing = store.getState().sources
    let added = 0
    for (const url of urls) {
      const dupe = existing.find((s) => s.url === url)
      if (dupe) {
        store.toast('Bu bağlantı listede zaten var.', 'warn')
        store.commit(() => {
          dupe.collapsed = false
        })
        continue
      }
      // The choice belongs to the link and travels with it: this source resolves
      // and downloads through the proxy while the one beside it does not.
      queueProbe(probe.createSource(url, { useProxy }))
      added += 1
    }
    return { added }
  })

  handle('proxy:check', async () => {
    const url = String(store.getState().settings.proxyUrl || '').trim()
    if (!url) return { ok: false, message: 'Vekil adresi boş.' }
    const parsed = proxy.parseProxy(url)
    if (!parsed) return { ok: false, message: 'Adres anlaşılamadı. Örnek: socks5://127.0.0.1:40000' }
    try {
      const started = Date.now()
      const seen = await proxy.checkProxy(url)
      return {
        ok: true,
        message: `Bağlandı (${Date.now() - started} ms). Dışarıya görünen adres: ${seen || 'okunamadı'}`,
      }
    } catch (err) {
      return { ok: false, message: err.message }
    }
  })

  handle('source:remove', (id) => {
    probe.cancelProbe(id)
    // Removing the group has to stop what it started. Leaving a transfer running
    // for a source that no longer exists is how a download becomes impossible to
    // stop: nothing on screen owns it any more.
    for (const d of store.getState().downloads) {
      if (d.sourceId === id && (d.status === 'running' || d.status === 'queued' || d.status === 'paused')) {
        downloader.cancel(d.id)
      }
    }
    store.commit((s) => {
      s.sources = s.sources.filter((x) => x.id !== id)
      s.items = s.items.filter((x) => x.sourceId !== id)
    })
    return true
  })

  handle('source:toggle', ({ id, collapsed }) => {
    const src = store.findSource(id)
    if (!src) return false
    store.commit(() => {
      src.collapsed = collapsed === undefined ? !src.collapsed : !!collapsed
    })
    return true
  })

  handle('source:rescan', async (id) => {
    const src = store.findSource(id)
    if (!src) return false
    await probe.probeUrl(src.url, { sourceId: id })
    return true
  })

  handle('source:capture', async (id) => {
    const src = store.findSource(id)
    if (!src) return false
    await probe.captureSource(id)
    return true
  })

  handle('source:open', (id) => {
    const src = store.findSource(id)
    if (src) shell.openExternal(src.url)
    return true
  })

  handle('source:downloadAll', ({ sourceId, quality, audioOnly, categoryId, skipDownloaded = true }) => {
    const items = store.itemsOfSource(sourceId)
    // Match on URL, not item id: ids change on rescan, the link doesn't.
    const taken = new Set(
      store
        .getState()
        .downloads.filter((d) => d.status !== 'canceled' && d.status !== 'error')
        .map((d) => d.url)
    )
    let count = 0
    for (const item of items) {
      if (skipDownloaded && taken.has(item.url)) continue
      downloader.enqueue({ item, quality, audioOnly, categoryId })
      count += 1
    }
    if (!count) store.toast('Sıraya eklenecek yeni öğe yok.', 'warn')
    return { count }
  })

  handle('item:remove', (id) => {
    store.commit((s) => {
      s.items = s.items.filter((x) => x.id !== id)
      for (const src of s.sources) {
        src.count = s.items.filter((i) => i.sourceId === src.id).length
      }
    })
    return true
  })

  handle('item:open', (id) => {
    const item = store.findItem(id)
    if (item && item.url) shell.openExternal(item.url)
    return true
  })

  handle('dl:add', ({ itemIds, url, quality, audioOnly, categoryId }) => {
    const ids = Array.isArray(itemIds) ? itemIds : itemIds ? [itemIds] : []
    if (ids.length) {
      let count = 0
      for (const id of ids) {
        const item = store.findItem(id)
        if (!item) continue
        downloader.enqueue({ item, quality, audioOnly, categoryId })
        count += 1
      }
      return { count }
    }
    if (isProbablyUrl(url)) {
      downloader.enqueue({ url, title: url, quality, audioOnly, categoryId })
      return { count: 1 }
    }
    throw new Error('İndirilecek bir şey belirtilmedi.')
  })

  handle('dl:pause', (id) => downloader.pause(id))
  handle('dl:resume', (id) => downloader.resume(id))
  handle('dl:cancel', (id) => downloader.cancel(id))
  handle('dl:retry', (id) => downloader.retry(id))
  handle('dl:remove', ({ id, deleteFile }) => downloader.remove(id, { deleteFile }))

  handle('dl:category', ({ ids, categoryId }) => {
    const list = Array.isArray(ids) ? ids : [ids]
    store.commit(() => {
      for (const id of list) {
        const dl = store.findDownload(id)
        if (dl) dl.categoryId = categoryId || null
      }
    })
    return true
  })

  handle('dl:clear', (which) => {
    store.commit((s) => {
      s.downloads = s.downloads.filter((d) => {
        if (which === 'done') return d.status !== 'done'
        if (which === 'failed') return d.status !== 'error' && d.status !== 'canceled'
        return true
      })
    })
    downloader.forgetMissing()
    return true
  })

  handle('cat:add', (name) => {
    const clean = String(name || '').trim()
    if (!clean) throw new Error('Kategori adı boş olamaz.')
    const state = store.getState()
    if (state.categories.some((c) => c.name.toLowerCase() === clean.toLowerCase())) {
      throw new Error('Bu kategori zaten var.')
    }
    const palette = ['#F0A03C', '#6FBF8F', '#5FA8D3', '#C98BDB', '#E06C5A', '#D8C25A', '#7FC7C0']
    const category = {
      id: uid('cat'),
      name: clean,
      color: palette[state.categories.length % palette.length],
      createdAt: Date.now(),
    }
    store.commit((s) => {
      s.categories.push(category)
    })
    return category
  })

  handle('cat:rename', ({ id, name }) => {
    const clean = String(name || '').trim()
    if (!clean) throw new Error('Kategori adı boş olamaz.')
    const cat = store.getState().categories.find((c) => c.id === id)
    if (!cat) return false
    store.commit(() => {
      cat.name = clean
    })
    return true
  })

  handle('cat:remove', (id) => {
    store.commit((s) => {
      s.categories = s.categories.filter((c) => c.id !== id)
      for (const d of s.downloads) if (d.categoryId === id) d.categoryId = null
    })
    return true
  })

  handle('settings:update', (patch) => {
    store.commit((s) => {
      s.settings = { ...s.settings, ...patch }
    })
    if (patch && patch.vaultAutoLockMinutes !== undefined) {
      vault.configure({ autoLockMinutes: patch.vaultAutoLockMinutes })
      pushVault()
    }
    downloader.pumpQueue()
    return store.getState().settings
  })

  handle('settings:reset', () => {
    store.commit((s) => {
      s.settings = store.defaultSettings()
    })
    return store.getState().settings
  })

  handle('settings:pickDir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'İndirme klasörünü seç',
      defaultPath: store.getState().settings.downloadDir,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths.length) return null
    const dir = result.filePaths[0]
    store.commit((s) => {
      s.settings.downloadDir = dir
    })
    return dir
  })

  handle('file:open', async (p) => {
    if (!p) throw new Error('Dosya yolu yok.')
    // The download folder is the one path that may legitimately not exist yet.
    if (p === store.getState().settings.downloadDir) store.ensureDownloadDir()
    const err = await shell.openPath(p)
    if (err) throw new Error(err)
    return true
  })

  handle('file:reveal', (p) => {
    if (!p) throw new Error('Dosya yolu yok.')
    shell.showItemInFolder(p)
    return true
  })

  handle('shell:external', (url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return true
  })

  handle('clipboard:read', () => clipboard.readText())

  handle('subs:search', async ({ downloadId, query }) => {
    const settings = store.getState().settings
    const download = downloadId ? store.findDownload(downloadId) : null
    return subtitles.search({
      filePath: download && download.filePath ? download.filePath : null,
      title: query || (download ? download.title : ''),
      languages: settings.subtitleLangs,
      apiKey: settings.subtitleApiKey,
    })
  })

  handle('subs:apply', async ({ downloadId, fileId, language, hashMatch }) => {
    const settings = store.getState().settings
    const download = downloadId ? store.findDownload(downloadId) : null
    if (!download || !download.filePath) throw new Error('Altyazı eklenecek dosya bulunamadı.')

    const outcome = await subtitles.apply({
      videoPath: download.filePath,
      fileId,
      language,
      hashMatch,
      apiKey: settings.subtitleApiKey,
      sync: settings.syncSubtitles,
      embedTrack: settings.embedSubtitleFile,
    })

    store.commit(() => {
      download.subtitlePath = outcome.path
      download.subtitleLanguage = language || null
    })
    return outcome
  })

  handle('subs:tools', () => ({ ffsubsync: !!subtitles.ffsubsyncPath() }))

  /* ---- site recipes ------------------------------------------------------ */

  handle('scripts:list', () => ({
    dir: userscripts.dir(),
    scripts: userscripts.load().map((s) => ({
      file: s.file,
      name: s.name,
      description: s.description,
      matches: s.matches,
      runAt: s.runAt,
      enabled: s.enabled,
      bytes: s.bytes,
    })),
  }))

  handle('scripts:open', async () => {
    userscripts.ensureBuiltins()
    const err = await shell.openPath(userscripts.dir())
    if (err) throw new Error(err)
    return true
  })

  /* ---- vault ------------------------------------------------------------- *
   * The passphrase crosses the bridge once, on the way in, and is never stored
   * or echoed back. Entry names live in the encrypted index, so the renderer only
   * ever sees them while the vault is unlocked.
   */

  handle('vault:status', () => vaultState())

  handle('vault:create', async (passphrase) => {
    await vault.create(passphrase)
    vault.configure({ autoLockMinutes: store.getState().settings.vaultAutoLockMinutes })
    userscripts.ensureBuiltins()
    pushVault()
    return vaultState()
  })

  handle('vault:unlock', async (passphrase) => {
    await vault.unlock(passphrase)
    vault.configure({ autoLockMinutes: store.getState().settings.vaultAutoLockMinutes })
    pushVault()
    return vaultState()
  })

  handle('vault:lock', () => {
    vault.lock()
    pushVault()
    return vaultState()
  })

  /** Move a finished download into the vault: encrypt it, then drop the record. */
  handle('vault:takeDownload', async (downloadId) => {
    const download = store.findDownload(downloadId)
    if (!download) throw new Error('Kayıt bulunamadı.')
    if (!download.filePath) throw new Error('Bu kaydın diskte bir dosyası yok.')

    const entry = await vault.addFile(download.filePath, {
      title: download.title,
      site: download.site,
      duration: download.duration,
      sourceUrl: download.url,
    })
    forgetVaultedFile({ downloadId })
    pushVault()
    return entry
  })

  handle('vault:addFiles', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Kasaya eklenecek dosyaları seç',
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled || !result.filePaths.length) return { added: 0 }
    let added = 0
    for (const file of result.filePaths) {
      try {
        await vault.addFile(file, { title: path.basename(file) })
        // The picker can point at a file the library downloaded, and that record
        // would otherwise keep pointing at a path that no longer exists.
        forgetVaultedFile({ filePath: file })
        added += 1
      } catch (err) {
        store.toast(`${path.basename(file)} eklenemedi: ${err.message}`, 'error')
      }
    }
    pushVault()
    return { added }
  })

  handle('vault:open', (id) => vault.openEntry(id))

  handle('vault:export', async (id) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Şifresiz kopya nereye çıkarılsın?',
      defaultPath: store.getState().settings.downloadDir,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths.length) return null
    const out = await vault.exportEntry(id, result.filePaths[0])
    store.toast('Şifresiz kopya çıkarıldı. Kasadaki şifreli hâli yerinde duruyor.', 'ok')
    return out
  })

  handle('vault:remove', async (id) => {
    const ok = await vault.removeEntry(id)
    pushVault()
    return ok
  })

  handle('vault:audit', () => vault.audit())
}

// ---- lifecycle -----------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    // Unpackaged runs would otherwise show Electron's own logo in the Dock.
    if (IS_MAC && !app.isPackaged) {
      try {
        app.dock.setIcon(ICON_PNG)
      } catch {
        /* icon not built yet */
      }
    }
    store.init()
    vault.configure({ autoLockMinutes: store.getState().settings.vaultAutoLockMinutes })
    // An idle lock has to reach the interface, or it would keep showing a list
    // whose files are no longer readable.
    vault.onLocked(() => pushVault())
    registerIpc()
    buildMenu()
    createWindow()
    await binaries.detectTools()
    store.send('state', store.getState())
    downloader.pumpQueue()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (!IS_MAC) app.quit()
  })

  app.on('before-quit', () => {
    downloader.killAll()
    probe.killAll()
    // Quitting locks the vault and takes the decrypted temp copies with it.
    vault.lock({ reason: 'quit' })
    store.flush()
  })
}
