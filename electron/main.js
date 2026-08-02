'use strict'

const path = require('path')
const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, Menu } = require('electron')

const store = require('./lib/store')
const probe = require('./lib/probe')
const downloader = require('./lib/downloader')
const binaries = require('./lib/binaries')
const browsers = require('./lib/browsers')
const subtitles = require('./lib/subtitles')
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
              { role: 'about', label: 'Everything Downloader Hakkında' },
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
          click: () => shell.openPath(store.getState().settings.downloadDir),
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

// Probes run one at a time — a channel URL is heavy and parallel probes just
// fight for bandwidth — but adding a link never blocks the renderer.
let probeChain = Promise.resolve()

function queueProbe(source) {
  probeChain = probeChain.then(() =>
    probe.probeUrl(source.url, { sourceId: source.id }).catch((err) => {
      console.error('[probe]', err)
    })
  )
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

  handle('source:add', (input) => {
    const urls = extractUrls(String(input || ''))
    if (!urls.length) throw new Error('Geçerli bir bağlantı bulunamadı.')
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
      queueProbe(probe.createSource(url))
      added += 1
    }
    return { added }
  })

  handle('source:remove', (id) => {
    probe.cancelProbe(id)
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
    store.flush()
  })
}
