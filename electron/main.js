'use strict'

const path = require('path')
const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, Menu, powerMonitor } = require('electron')

const store = require('./lib/store')
const probe = require('./lib/probe')
const downloader = require('./lib/downloader')
const binaries = require('./lib/binaries')
const browsers = require('./lib/browsers')
const subtitles = require('./lib/subtitles')
const vault = require('./lib/vault')
const proxy = require('./lib/proxy')
const userscripts = require('./lib/userscripts')
const player = require('./lib/player')
const tor = require('./lib/tor')
const network = require('./lib/network-context')
const diagnostics = require('./lib/diagnostics')
const locate = require('./lib/locate')
const updater = require('./lib/updater')
const siteAccounts = require('./lib/site-accounts')
const cookieFiles = require('./lib/cookie-files')
let cookieSweepTimer = null
const collections = require('./lib/collections').createCollectionEditor({
  getDownloads: () => store.getState().downloads,
  commit: (fn) => store.commit(fn),
})
const mediaInspection = require('./lib/media-inspection').createMediaInspection({
  getDownload: (id) => store.findDownload(id),
  resolvePath: (download) => locateDownloadFile(download),
  inspect: (file, options) => player.inspectFileTiming(file, options),
  commit: (fn) => store.commit(fn),
})
const { uid, extractUrls, isProbablyUrl } = require('./lib/util')

// The player streams the file over a private scheme, and a scheme has to claim
// its privileges before the app is ready — after that the list is frozen.
player.registerScheme()
// Lets the player list and switch the audio tracks of a dual-language file.
app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks')

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
      // The preload needs nothing but the IPC bridge, so the renderer runs in
      // Chromium's sandbox like any web page would.
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
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
  // The only document this window may show is our own: the dev server in
  // development, dist/index.html otherwise. Any other file:// page would get the
  // full preload bridge.
  const ownPage = require('url').pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isLocal = (IS_DEV && url.startsWith(DEV_URL)) || url.split('#')[0].split('?')[0] === ownPage
    if (!isLocal) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    }
  })

  // Coming back to the window is when a file deleted in Finder in the meantime
  // should show up as missing, not the next time someone clicks "play" on it.
  let lastVerify = 0
  mainWindow.on('focus', () => {
    if (Date.now() - lastVerify < 5000) return
    lastVerify = Date.now()
    try {
      downloader.verifyFiles()
    } catch (err) {
      console.error('[verify]', err)
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
    (d) => (downloadId && d.id === downloadId) || (filePath && locate.samePath(d.filePath, filePath))
  )

  // Every plain-text trace of the file, not just the library row: its poster
  // frame, its kept subtitles, the watch history keyed by its path (which is its
  // title), and the browser cache holding the site's thumbnail of it.
  const paths = new Set([filePath, ...gone.map((d) => d.filePath)].filter(Boolean))
  for (const p of paths) {
    require('./lib/thumbs').forget(p)
    subtitles.forgetStored(p)
    store.forgetFile(p)
  }
  if (gone.some((d) => d.thumbnail) && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.session.clearCache().catch(() => {})
  }
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


function playVaulted(id) {
  return player.openVault(id)
}

/**
 * Where a finished download's file actually is.
 *
 * The recorded path can be stale: a post-processing step changed the extension,
 * the user renamed or moved the file, or the record predates a change in how
 * paths were resolved. Refusing to act on a file that is plainly sitting in the
 * download folder is worse than looking for it, so look — by the recorded name
 * first, then by the title the download was given.
 */
function locateDownloadFile(download) {
  return locate.locateDownload(download, store.getState().settings.downloadDir)
}

/**
 * The real location of a library file, or a clear error.
 *
 * The folder button used to hand a dead path to the OS, which silently did
 * nothing — so a file that had been moved looked like a button that was broken.
 * Now the path is looked for, the record corrected if it is found, and the user
 * told plainly if it is not.
 */
/**
 * Whether the renderer may ask us to open or reveal `p`.
 *
 * shell.openPath runs whatever it is given — an application, a script — so a
 * path from the interface is only honoured if it is something the app itself put
 * there: the download folder or a file in it, a library file wherever it lives,
 * or the vault folder (which only ever holds ciphertext).
 */
function mayTouch(p) {
  if (!p || typeof p !== 'string') return false
  const target = path.resolve(p).normalize('NFC')
  const inside = (dir) => {
    if (!dir) return false
    const base = path.resolve(dir).normalize('NFC')
    return target === base || target.startsWith(base + path.sep)
  }
  if (inside(store.getState().settings.downloadDir)) return true
  if (inside(vault.status().dir)) return true
  return store.getState().downloads.some((d) => d.filePath && locate.samePath(d.filePath, p))
}

function resolveLibraryPath(p) {
  if (!mayTouch(p)) throw new Error('Bu konum uygulamanın yönettiği bir dosya değil.')
  const fs = require('fs')
  if (!p) throw new Error('Dosya yolu yok.')
  if (fs.existsSync(p)) return p
  const download = store.getState().downloads.find((d) => locate.samePath(d.filePath, p))
  const found = locateDownloadFile(download || { filePath: p })
  if (found) {
    if (download) {
      store.commit(() => {
        download.filePath = found
        download.missing = false
      })
    }
    return found
  }
  if (download && !download.missing) {
    store.commit(() => {
      download.missing = true
    })
  }
  throw new Error('Dosya diskte yok — silinmiş ya da taşınmış. Kitaplıktan yeniden indirebilirsin.')
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
    const next = probeQueue.shift()
    const source = store.findSource(next.id)
    if (!source || source.status !== 'queued') continue
    activeProbes += 1
    const task = next.capture ? probe.captureSource(source.id) : probe.probeUrl(source.url, { sourceId: source.id })
    task
      .catch((err) => console.error('[probe]', err))
      .finally(() => {
        activeProbes -= 1
        pumpProbes()
      })
  }
}

function queueProbe(source, capture = false) {
  if (source.status === 'probing' || probeQueue.some((s) => s.id === source.id)) return
  store.commit(() => { source.status = 'queued'; source.note = null; source.error = null })
  probeQueue.push({ id: source.id, capture })
  pumpProbes()
}

function cancelSource(id) {
  const source = store.findSource(id)
  if (!source) return false
  for (let i = probeQueue.length - 1; i >= 0; i--) if (probeQueue[i].id === id) probeQueue.splice(i, 1)
  probe.cancelProbe(id)
  store.commit(() => { source.count = store.itemsOfSource(id).length; source.status = source.count ? 'ready' : 'canceled'; source.stage = null; source.note = 'Çözümleme durduruldu'; source.enriching = 0 })
  return true
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

  handle('proxy:presets', () => proxy.probePresets())

  /* ---- Tor, managed by us ------------------------------------------------ */

  handle('update:status', () => updater.getStatus())
  handle('update:check', () => updater.check({ manual: true }))
  handle('update:install', () => updater.install())
  // One way only: the token goes in, encrypted with the OS keystore, and never comes back out.
  handle('update:setToken', (value) => {
    updater.setToken(value)
    return updater.getStatus()
  })

  handle('tor:status', () => tor.getStatus())
  handle('tor:start', async () => {
    await tor.start()
    return tor.getStatus()
  })
  handle('tor:stop', () => {
    const usesTor = (id) => { const context = network.getContext(id); return context ? context.kind === 'tor' : network.isManagedProxy(store.getState().settings.proxyUrl) }
    for (const source of store.getState().sources) if (source.useProxy && usesTor(source.id) && (['queued', 'probing'].includes(source.status) || source.enriching)) cancelSource(source.id)
    for (const download of store.getState().downloads) if (download.useProxy && usesTor(download.sourceId || download.id) && ['running', 'queued'].includes(download.status)) downloader.pause(download.id)
    network.shutdown()
    tor.stopAndForget()
    return tor.getStatus()
  })

  handle('proxy:check', async () => {
    try {
      const started = Date.now()
      const url = await network.ensureForSource('__connection-check__', { settings: store.getState().settings })
      const seen = await proxy.checkProxy(url)
      return { ok: true, message: `Bağlandı (${Date.now() - started} ms). Dışarıya görünen adres: ${seen || 'okunamadı'}` }
    } catch (err) {
      return { ok: false, message: err.message }
    } finally { network.releaseSource('__connection-check__') }
  })

  handle('source:remove', (id) => {
    cancelSource(id)
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
    network.releaseSource(id)
    return true
  })

  handle('source:proxy', ({ id, useProxy }) => {
    const source = store.findSource(id)
    if (!source) return false
    cancelSource(id)
    for (const download of store.getState().downloads.filter((d) => d.sourceId === id)) {
      if (['running', 'queued'].includes(download.status)) downloader.pause(download.id)
      download.useProxy = !!useProxy
      if (download.resolved?.pageUrl) download.refreshPending = true
    }
    network.releaseSource(id)
    store.commit(() => { source.useProxy = !!useProxy; delete source.network })
    queueProbe(source)
    return true
  })

  handle('source:cancel', cancelSource)
  handle('source:cancelAll', () => {
    const busy = store.getState().sources.filter((s) => ['queued', 'probing'].includes(s.status) || s.enriching)
    for (const source of busy) cancelSource(source.id)
    return busy.length
  })
  handle('source:retryFailed', () => {
    const failed = store.getState().sources.filter((s) => ['error', 'canceled'].includes(s.status))
    for (const source of failed) queueProbe(source)
    return failed.length
  })
  handle('source:metadata', (id) => probe.refreshMetadata(id))
  handle('source:diagnostics', (id) => {
    const source = store.findSource(id)
    if (!source) throw new Error('Kaynak bulunamadı.')
    return diagnostics.report(source, store.itemsOfSource(id), store.getState().downloads.filter((d) => d.sourceId === id), app.getVersion())
  })

  handle('source:toggle', ({ id, collapsed }) => {
    const src = store.findSource(id)
    if (!src) return false
    store.commit(() => {
      src.collapsed = collapsed === undefined ? !src.collapsed : !!collapsed
    })
    return true
  })

  handle('source:rescan', (id) => {
    const src = store.findSource(id)
    if (!src) return false
    queueProbe(src)
    return true
  })

  handle('source:capture', (id) => {
    const src = store.findSource(id)
    if (!src) return false
    queueProbe(src, true)
    return true
  })

  handle('source:open', (id) => {
    const src = store.findSource(id)
    if (src) shell.openExternal(src.url)
    return true
  })

  handle('source:downloadAll', ({ sourceId, quality, audioOnly, categoryId, preferredAudioLanguage, skipDownloaded = true }) => {
    const items = store.itemsOfSource(sourceId)
    // Match on URL, not item id: ids change on rescan, the link doesn't.
    const chosenLanguage = preferredAudioLanguage ?? store.getState().settings.preferredAudioLanguage ?? 'en'
    const chosenQuality = quality === undefined ? store.getState().settings.defaultQuality : Number(quality) || 0
    const taken = store.getState().downloads.filter((d) => !['canceled', 'error'].includes(d.status) && d.quality === chosenQuality && !!d.audioOnly === !!audioOnly && (d.preferredAudioLanguage || 'en') === chosenLanguage)
    let count = 0
    for (const item of items) {
      if (skipDownloaded && taken.some((d) => require('./lib/queue-order').sameMedia(d, { item }))) continue
      const before = store.getState().downloads.length
      downloader.enqueue({ item, quality, audioOnly, categoryId, preferredAudioLanguage })
      count += Math.max(0, store.getState().downloads.length - before)
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

  handle('dl:add', ({ itemIds, url, quality, audioOnly, categoryId, preferredAudioLanguage }) => {
    const ids = Array.isArray(itemIds) ? itemIds : itemIds ? [itemIds] : []
    if (ids.length) {
      let count = 0
      for (const id of ids) {
        const item = store.findItem(id)
        if (!item) continue
        const before = store.getState().downloads.length
        downloader.enqueue({ item, quality, audioOnly, categoryId, preferredAudioLanguage })
        count += Math.max(0, store.getState().downloads.length - before)
      }
      return { count }
    }
    if (isProbablyUrl(url)) {
      const before = store.getState().downloads.length
      downloader.enqueue({ url, title: url, quality, audioOnly, categoryId, preferredAudioLanguage })
      return { count: Math.max(0, store.getState().downloads.length - before) }
    }
    throw new Error('İndirilecek bir şey belirtilmedi.')
  })

  handle('dl:prioritize', (id) => downloader.prioritize(id))
  handle('dl:pause', (id) => downloader.pause(id))
  handle('dl:resume', (id) => downloader.resume(id))
  handle('dl:cancel', (id) => downloader.cancel(id))
  handle('dl:retry', (payload) => typeof payload === 'string' ? downloader.retry(payload) : downloader.retry(payload?.id, payload || {}))
  handle('dl:remove', ({ id, deleteFile }) => downloader.remove(id, { deleteFile }))
  handle('dl:removeMany', ({ ids, deleteFile }) => {
    const list = Array.isArray(ids) ? ids : []
    for (const id of list) downloader.remove(id, { deleteFile: !!deleteFile })
    downloader.forgetMissing()
    return list.length
  })
  handle('dl:verify', () => downloader.verifyFiles())
  // Only for files the library knows about: this reads a file and hands back a
  // picture of it, and the renderer has no business pointing that elsewhere.
  handle('thumb:file', ({ path: p, duration } = {}) => {
    const known = store.getState().downloads.some((d) => d.filePath && locate.samePath(d.filePath, p))
    if (!known) return null
    return require('./lib/thumbs').thumbFor(p, duration)
  })
  handle('folder:tidy', () => runTidy())
  handle('dl:redownload', (id) => downloader.redownload(id))
  handle('dl:clearMissing', () => downloader.clearMissing())

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

  handle('dl:series', ({ id, series } = {}) => {
    const download = store.findDownload(id)
    if (!download) throw new Error('İndirme bulunamadı.')
    const name = typeof series === 'string' ? series.trim().slice(0, 160) : ''
    store.commit(() => { download.series = name || null })
    return true
  })

  handle('collection:preview', (payload) => collections.preview(payload))
  handle('collection:apply', (payload) => collections.apply(payload))
  handle('collection:undo', (token) => collections.undo(token))
  handle('dl:inspectMedia', async (id) => {
    try { return await mediaInspection.check(id) }
    catch (error) { if (error.code === 'ABORTED') return null; throw error }
  })
  handle('dl:inspectMedia:cancel', (id) => mediaInspection.cancel(id))

  handle('settings:update', (raw) => {
    // Settings the interface has no business writing: an executable path the
    // app will later spawn, a sealed credential, bookkeeping. A compromised page
    // in the main window must not be able to turn a settings write into running
    // a program of its choosing.
    const patch = { ...(raw && typeof raw === 'object' ? raw : {}) }
    for (const key of ['torPath', 'updateTokenSealed', 'settingsRev']) delete patch[key]
    store.commit((s) => {
      s.settings = { ...s.settings, ...patch }
    })
    if (patch && patch.vaultAutoLockMinutes !== undefined) {
      vault.configure({ autoLockMinutes: patch.vaultAutoLockMinutes })
      pushVault()
    }
    if (store.getState().settings.autoStartDownloads) downloader.pumpQueue()
    return store.getState().settings
  })

  handle('settings:backup', () => { const file = store.backup(); shell.showItemInFolder(file); return { path: file } })

  handle('accounts:status', () => siteAccounts.getStatus())
  handle('accounts:profile:set', (profile) => siteAccounts.setProfile(profile))
  handle('accounts:profile:clear', () => siteAccounts.clearProfile())
  handle('accounts:site:set', (policy) => siteAccounts.setSitePolicy(policy))
  handle('accounts:site:remove', (origin) => siteAccounts.removeSitePolicy(origin))

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
    const target = p === store.getState().settings.downloadDir ? p : resolveLibraryPath(p)
    // Opening is for media and folders; never hand the OS something it would run.
    if (/\.(app|command|sh|bat|cmd|exe|msi|scpt|jar|pkg|dmg|ps1|vbs|js|py|lnk|url|webloc|terminal|workflow)$/i.test(target)) {
      throw new Error('Bu dosya türü buradan açılmaz.')
    }
    const err = await shell.openPath(target)
    if (err) throw new Error(err)
    return true
  })

  handle('file:reveal', (p) => {
    shell.showItemInFolder(resolveLibraryPath(p))
    return true
  })

  handle('shell:external', (url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return true
  })

  /* ---- the in-app player ------------------------------------------------- */

  player.registerIpc()

  handle('file:play', async (filePath) => {
    const file = resolveLibraryPath(filePath)
    const download = store.getState().downloads.find((d) => locate.samePath(d.filePath, file))
    return player.open({
      file,
      title: download && download.title ? download.title : path.basename(file),
      key: `file:${file}`,
    })
  })

  handle('clipboard:read', () => clipboard.readText())

  handle('clipboard:write', (text) => {
    const value = String(text || '')
    if (!value) return false
    clipboard.writeText(value)
    return true
  })

  handle('subs:search', async ({ downloadId, query }) => {
    const settings = store.getState().settings
    const download = downloadId ? store.findDownload(downloadId) : null
    // The file is what makes the search good: its hash finds a subtitle timed
    // against this exact release, and its name is where the season and episode
    // come from. A stale path threw both away and searched on the bare title,
    // which for an episode is a query no provider can answer.
    const file = download ? locateDownloadFile(download) : null
    if (download && file && file !== download.filePath) {
      store.commit(() => {
        download.filePath = file
      })
    }
    return subtitles.search({
      filePath: file,
      title: query || (download ? download.title : ''),
      languages: settings.subtitleLangs,
      apiKey: settings.subtitleApiKey,
    })
  })

  handle('subs:apply', async ({ downloadId, fileId, language, hashMatch }) => {
    const settings = store.getState().settings
    const download = downloadId ? store.findDownload(downloadId) : null
    const videoPath = download ? locateDownloadFile(download) : null
    if (!videoPath) throw new Error('Altyazı eklenecek dosya bulunamadı.')

    const outcome = await subtitles.apply({
      videoPath,
      fileId,
      language,
      hashMatch,
      apiKey: settings.subtitleApiKey,
      sync: settings.syncSubtitles,
      // Never rewrite a file a player is reading: its next range request would
      // land in a different file. The subtitle waits in our folder instead,
      // where that player finds it straight away.
      embedTrack: settings.embedSubtitleFile !== false && !player.openFiles().has(videoPath),
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

  handle('vault:status', async () => {
    await vault.refreshBiometricStatus()
    pushVault()
    return vaultState()
  })
  handle('vault:touchIdSettings', async () => {
    if (!IS_MAC) return false
    await shell.openExternal('x-apple.systempreferences:com.apple.Touch-ID-Settings.extension')
    return true
  })

  handle('vault:create', async (passphrase) => {
    await vault.create(passphrase)
    vault.configure({ autoLockMinutes: store.getState().settings.vaultAutoLockMinutes })
    userscripts.ensureBuiltins()
    pushVault()
    return vaultState()
  })

  handle('vault:unlock', async (passphrase) => {
    try {
      await vault.unlock(passphrase)
    } catch (err) {
      // The wait after repeated failures has to reach the screen too.
      pushVault()
      throw err
    }
    vault.configure({ autoLockMinutes: store.getState().settings.vaultAutoLockMinutes })
    pushVault()
    return vaultState()
  })

  handle('vault:biometric:set', async (enabled) => {
    try { await vault.setBiometric(enabled === true) } finally { pushVault() }
    return vaultState()
  })

  handle('vault:biometric:unlock', async () => {
    try { await vault.unlockBiometric() } finally { pushVault() }
    return vaultState()
  })

  handle('vault:changePassphrase', async ({ current, next } = {}) => {
    await vault.changePassphrase(current, next)
    pushVault()
    return vaultState()
  })

  handle('vault:lock', () => {
    player.closeVaultWindows()
    vault.lock()
    pushVault()
    return vaultState()
  })

  /** Move a finished download into the vault: encrypt it, then drop the record. */
  handle('vault:takeDownload', async (downloadId) => {
    const download = store.findDownload(downloadId)
    if (!download) throw new Error('Kayıt bulunamadı.')

    const found = locateDownloadFile(download)
    if (!found) {
      throw new Error(
        download.filePath
          ? `Dosya bulunamadı: ${path.basename(download.filePath)}. Taşındıysa Kasa sekmesinden "Dosya ekle" ile ekleyebilirsin.`
          : 'Bu kaydın diskte bir dosyası yok.'
      )
    }
    // Put the record straight while we are here, so "open" works again too.
    if (found !== download.filePath) {
      store.commit(() => {
        download.filePath = found
      })
    }

    // A player reading the file would lose it mid-film when the original is
    // removed, and keep showing a title that is meant to be locked away.
    player.closeFile(found)
    const entry = await vault.addFile(found, {
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
        player.closeFile(file)
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

  handle('vault:open', (id) => playVaulted(id))
  // Kept for anyone who would rather use their own player, knowing the trade-off.
  handle('vault:openExternal', (id) => vault.openEntry(id))

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

/** Clear old player pages and loose subtitles out of the download folder. */
async function runTidy({ quiet = false } = {}) {
  const tidy = require('./lib/tidy')
  const state = store.getState()
  const busy = player.openFiles()
  for (const d of state.downloads) {
    if (d.filePath && (d.status === 'running' || d.status === 'queued' || d.status === 'paused')) {
      busy.add(d.filePath)
    }
  }
  try {
    const report = await tidy.tidyFolder(state.settings.downloadDir, { busy })
    const total = report.pages + report.embedded + report.removed + report.moved
    if (total || !quiet) {
      const parts = []
      if (report.embedded) parts.push(`${report.embedded} altyazı videonun içine gömüldü`)
      if (report.removed) parts.push(`${report.removed} yinelenen altyazı dosyası kaldırıldı`)
      if (report.moved) parts.push(`${report.moved} altyazı uygulamanın klasörüne taşındı`)
      if (report.pages) parts.push(`${report.pages} eski oynat.html silindi`)
      store.toast(
        total ? `İndirme klasörü toparlandı: ${parts.join(', ')}.` : 'İndirme klasöründe toparlanacak bir şey yok.',
        'ok'
      )
    }
    return report
  } catch (err) {
    console.error('[tidy]', err)
    return null
  }
}

// ---- lifecycle -----------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // OS updates and terminal shutdown must run the same pause/flush/lock path
  // as the Quit menu instead of abandoning active processes and partial state.
  process.once('SIGTERM', () => app.quit())
  process.once('SIGINT', () => app.quit())
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
    cookieFiles.setReferences(store.cookieReferences())
    browsers.cleanupCookieJars()
    cookieSweepTimer = setInterval(() => {
      cookieFiles.setReferences(store.cookieReferences())
      browsers.cleanupCookieJars()
    }, 60000)
    cookieSweepTimer.unref?.()
    player.registerProtocol()
    vault.configure({ autoLockMinutes: store.getState().settings.vaultAutoLockMinutes })
    // An idle lock has to reach the interface, or it would keep showing a list
    // whose files are no longer readable.
    vault.onLocked(() => {
      player.closeVaultWindows()
      pushVault()
    })
    vault.onChanged(() => pushVault())
    // Plaintext a crashed run left behind from "open in the system player".
    vault.sweepStaleTemps()
    // Walking away from the machine should not leave the vault open: sleep and
    // the screen lock both count as walking away.
    for (const event of ['suspend', 'lock-screen']) {
      powerMonitor.on(event, () => {
        if (!vault.isUnlocked()) return
        player.closeVaultWindows()
        vault.lock({ reason: event })
      })
    }
    registerIpc()
    buildMenu()
    createWindow()
    if (store.recoveryNotice()) setTimeout(() => store.toast(store.recoveryNotice(), 'warn'), 1500)
    await binaries.detectTools()
    store.send('state', store.getState())
    downloader.verifyFiles()
    if (store.getState().settings.autoStartDownloads) downloader.pumpQueue()
    // What older versions left lying in the download folder — the player page
    // and loose subtitle files — is cleared up once per launch, after the window
    // is up so it never delays it.
    setTimeout(() => runTidy({ quiet: true }), 8000)
    updater.schedule()
    // Tor was left running last time: bring it back up so the proxy address in
    // settings keeps meaning something across a restart.
    tor.restoreIfWanted()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch((err) => { dialog.showErrorBox('Uygulama başlatılamadı', err.message || 'Kitaplık açılamadı.'); app.quit() })

  app.on('window-all-closed', () => {
    if (!IS_MAC) app.quit()
  })

  app.on('before-quit', () => {
    clearInterval(cookieSweepTimer)
    mediaInspection.shutdown()
    downloader.killAll()
    probe.killAll()
    network.shutdown()
    // A background Tor belongs to this app; leaving it running after we quit
    // would be a process the user never started and cannot see.
    tor.stop()
    // Quitting locks the vault and takes the decrypted temp copies with it.
    vault.lock({ reason: 'quit' })
    store.flush()
    browsers.shutdownCookieJars()
    cookieFiles.shutdown({ referencedFiles: store.cookieReferences() })
  })
}
