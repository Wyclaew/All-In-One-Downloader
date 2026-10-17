'use strict'

// Single source of truth for app data, owned by the main process.
// Renderer never mutates: it calls IPC, main mutates, main broadcasts.

const path = require('path')
const fs = require('fs')
const { app, BrowserWindow } = require('electron')
const { atomicWrite, readJson, uid } = require('./util')
const { detectBrowsers } = require('./browsers')

const STATE_VERSION = 1

function defaultSettings() {
  return {
    downloadDir: path.join(app.getPath('downloads'), 'All in One Downloader'),
    concurrency: 2,
    // Connections per file. A single TCP stream is usually shaped well below the
    // line's capacity, so several pieces at once is what fills it.
    connections: 4,
    defaultQuality: 1080, // 0 = en iyi
    container: 'mp4',
    audioFormat: 'mp3',
    filenameTemplate: '%(title).120B.%(ext)s',
    cookiesBrowser: '', // '' | chrome | safari | firefox | edge | brave
    writeSubs: false,
    subLangs: 'tr,en',
    embedThumbnail: true,
    embedMetadata: true,
    rateLimit: '', // ör. 4M
    // The interface is designed light-first now; follow the OS by default.
    theme: 'system', // dark | light | system
    autoDetectClipboard: true,
    autoStartDownloads: true,
    enrichLimit: 80,
    notifyOnFinish: true,
    // Whether removing a library record also deletes the file: ask every time,
    // always, or never. A checkbox that resets on every delete is a question the
    // user has already answered.
    deleteFileWithRecord: 'ask', // ask | always | never
    // Minutes of inactivity before the vault locks itself. 0 = never.
    vaultAutoLockMinutes: 15,

    // Per-link proxy. Empty disables it outright. The default address is where
    // Cloudflare WARP listens in proxy mode (`warp-cli mode proxy`).
    proxyUrl: 'socks5://127.0.0.1:40000',
    // Whether the toggle beside the URL field starts switched on.
    proxyByDefault: false,
    // The app runs its own tor when this is on, so nobody has to keep a terminal
    // open. Empty path means "find it": PATH first, then Tor Browser's copy.
    torAutoStart: false,
    // Ask GitHub for a newer version at start and every few hours.
    autoCheckUpdates: true,
    // A GitHub token for a private repository, encrypted with the OS keystore.
    // Empty unless the user enters one.
    updateTokenSealed: '',
    torPath: '',

    // yt-dlp does the probing and the fetching unless this is off, in which case
    // the in-house resolver finds the stream and ffmpeg/HTTP fetches it.
    useYtdlp: true,
    // in-house page resolver, for sites yt-dlp has no extractor for
    useResolver: true,
    // Site recipes: user-editable scripts that run inside the page.
    useUserScripts: true,
    // Long enough that a pre-roll can finish and the real stream can start.
    resolverTimeout: 45000,
    // Streams shorter than this are treated as adverts when a longer one exists.
    minStreamSeconds: 120,
    blockTrackers: true,
    extraBlockedHosts: '',
    // How many links to resolve at the same time.
    resolverConcurrency: 3,

    // subtitles fetched from a provider, separate from yt-dlp's own --write-subs
    subtitleLangs: 'tr,en',
    subtitleApiKey: '',
    autoFetchSubtitles: false,
    syncSubtitles: true,
    // Muxed into the video by default: loose .srt/.vtt files in the download
    // folder were the complaint. Off keeps them in the app's own folder instead.
    embedSubtitleFile: true,
    // Don't put Turkish subtitles on a Turkish-language video.
    skipSameLanguageSubtitles: true,
    // How big the app's own player draws subtitles, and how loud it starts.
    playerSubtitleSize: 'normal', // small | normal | large | huge
    playerVolume: 1,
    // Remembered from the player itself: speed, how far audio is boosted, how
    // the picture fills the window, and whether the next episode starts by itself.
    playerRate: 1,
    playerBoost: 1,
    playerFit: 'contain',
    playerAutoNext: true,
    playerSubtitleStyle: 'box',
  }
}

function emptyState() {
  return {
    version: STATE_VERSION,
    sources: [],
    items: [],
    downloads: [],
    categories: [],
    // host -> { engine, ads, ms, at }. What worked last time on this site, so a
    // repeat visit doesn't re-derive it from scratch.
    hostProfiles: {},
    // key -> { at, duration, seen }. Where a video was last left off. Keyed by
    // path for a library file and by id for a vault entry, so a vaulted file
    // remembers its place without its name appearing here.
    positions: {},
    // key -> seconds. A subtitle aligned by hand stays aligned: the same release
    // is off by the same amount every time it is opened.
    delays: {},
    // key -> when it was finished. Same keys as positions.
    watched: {},
    settings: defaultSettings(),
  }
}

let state = emptyState()
let stateFile = ''
let saveTimer = null
let broadcastTimer = null

/**
 * userData is derived from the product name, so renaming the app points it at an
 * empty directory. Carry the old library across once rather than losing it.
 */
function migrateLegacyState(target) {
  if (fs.existsSync(target)) return
  const legacyNames = ['Everything Downloader', 'everything-downloader']
  for (const name of legacyNames) {
    const candidate = path.join(app.getPath('appData'), name, 'library.json')
    try {
      if (!fs.existsSync(candidate)) continue
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(candidate, target)
      console.log(`[store] kitaplık taşındı: ${candidate} -> ${target}`)
      return
    } catch (err) {
      console.error('[store] eski kitaplık taşınamadı', err)
    }
  }
}

function init() {
  stateFile = path.join(app.getPath('userData'), 'library.json')
  migrateLegacyState(stateFile)
  const loaded = readJson(stateFile, null)
  if (loaded && typeof loaded === 'object') {
    state = {
      ...emptyState(),
      ...loaded,
      settings: { ...defaultSettings(), ...(loaded.settings || {}) },
      sources: Array.isArray(loaded.sources) ? loaded.sources : [],
      items: Array.isArray(loaded.items) ? loaded.items : [],
      downloads: Array.isArray(loaded.downloads) ? loaded.downloads : [],
      categories: Array.isArray(loaded.categories) ? loaded.categories : [],
      hostProfiles:
        loaded.hostProfiles && typeof loaded.hostProfiles === 'object' ? loaded.hostProfiles : {},
      positions: loaded.positions && typeof loaded.positions === 'object' ? loaded.positions : {},
      delays: loaded.delays && typeof loaded.delays === 'object' ? loaded.delays : {},
      watched: loaded.watched && typeof loaded.watched === 'object' ? loaded.watched : {},
    }
  }
  migrateCookieBrowser()
  migrateSettings()

  // Nothing survives a quit mid-transfer: park those so the user restarts them.
  for (const s of state.sources) {
    if (s.status === 'probing' || s.status === 'queued') {
      s.status = 'error'
      s.error = 'Çözümleme yarıda kaldı. Yeniden tara.'
    }
    s.enriching = 0
  }
  for (const d of state.downloads) {
    if (d.status === 'running') {
      d.status = 'paused'
      d.stage = null
    }
  }
  save()
  return state
}

/**
 * One-off corrections to stored settings, applied once each.
 *
 * A default that changes does not reach someone whose settings file already has
 * the old value written in it, so the changes that matter are carried over here.
 */
function migrateSettings() {
  const s = state.settings
  const rev = Number(s.settingsRev) || 0
  if (rev < 2) {
    // Subtitles go inside the video now, not beside it.
    s.embedSubtitleFile = true
  }
  s.settingsRev = 2
}

/**
 * A stored cookie-browser choice can go stale — most often "opera" picked before
 * we knew about Opera GX, whose profile lives somewhere yt-dlp never looks.
 * Point it at the closest browser we can actually read, or clear it.
 */
function migrateCookieBrowser() {
  const chosen = state.settings.cookiesBrowser
  if (!chosen) return
  const available = detectBrowsers()
  if (available.some((b) => b.id === chosen)) return

  const relative = available.find((b) => b.id.startsWith(chosen) || chosen.startsWith(b.id))
  state.settings.cookiesBrowser = relative ? relative.id : ''
  console.log(
    `[store] çerez tarayıcısı "${chosen}" bulunamadı, ${relative ? `"${relative.id}" ile değiştirildi` : 'temizlendi'}`
  )
}

function getState() {
  return state
}

function save() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      atomicWrite(stateFile, JSON.stringify(state))
    } catch (err) {
      console.error('[store] kaydedilemedi', err)
    }
  }, 400)
}

function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    atomicWrite(stateFile, JSON.stringify(state))
  } catch (err) {
    console.error('[store] kaydedilemedi', err)
  }
}

function send(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** Structural changes go out as a whole-state broadcast, coalesced per frame. */
function broadcast() {
  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    send('state', state)
  }, 40)
}

/** Mutate + persist + broadcast. */
function commit(fn) {
  const result = fn(state)
  save()
  broadcast()
  return result
}

function toast(message, kind = 'info') {
  send('toast', { id: uid('t'), message, kind })
}

// ---- lookups -------------------------------------------------------------

const findSource = (id) => state.sources.find((s) => s.id === id) || null
const findItem = (id) => state.items.find((i) => i.id === id) || null
const findDownload = (id) => state.downloads.find((d) => d.id === id) || null
const itemsOfSource = (sourceId) => state.items.filter((i) => i.sourceId === sourceId)

/** What worked on this host before, if it was recent enough to still be true. */
function getHostProfile(host) {
  if (!host) return null
  const profile = state.hostProfiles[host]
  if (!profile) return null
  const AGE_LIMIT = 30 * 24 * 3600 * 1000
  if (Date.now() - (profile.at || 0) > AGE_LIMIT) return null
  return profile
}

const MAX_HOST_PROFILES = 300

function rememberHostProfile(host, data) {
  if (!host) return
  commit((s) => {
    s.hostProfiles[host] = { ...(s.hostProfiles[host] || {}), ...data, at: Date.now() }

    // One entry per site would otherwise grow the state file forever. Keep the
    // most recent, since staleness is what makes an entry useless anyway.
    const hosts = Object.keys(s.hostProfiles)
    if (hosts.length > MAX_HOST_PROFILES) {
      hosts
        .sort((a, b) => (s.hostProfiles[a].at || 0) - (s.hostProfiles[b].at || 0))
        .slice(0, hosts.length - MAX_HOST_PROFILES)
        .forEach((stale) => delete s.hostProfiles[stale])
    }
  })
}

const MAX_POSITIONS = 500

/**
 * Where a video was last left off.
 *
 * Positions near the very start or the very end are not worth keeping: the first
 * is indistinguishable from not having watched it, and the second means it is
 * finished — offering to resume five seconds before the credits is worse than
 * offering nothing.
 */
function rememberPosition(key, seconds, duration) {
  if (!key || !Number.isFinite(seconds) || seconds < 20) return
  if (duration && seconds > duration - 25) {
    commit((s) => {
      delete s.positions[key]
      // Finished is worth remembering too: the home page marks it, the way a
      // video site greys out what you have already seen.
      s.watched[key] = Date.now()
      pruneByAge(s.watched)
    })
    return
  }
  commit((s) => {
    // Rewatching something takes it off the finished list until it is finished again.
    delete s.watched[key]
    s.positions[key] = { at: Math.round(seconds), duration: Math.round(duration || 0), seen: Date.now() }
    const keys = Object.keys(s.positions)
    if (keys.length > MAX_POSITIONS) {
      keys
        .sort((a, b) => (s.positions[a].seen || 0) - (s.positions[b].seen || 0))
        .slice(0, keys.length - MAX_POSITIONS)
        .forEach((stale) => delete s.positions[stale])
    }
  })
}

function pruneByAge(map) {
  const keys = Object.keys(map)
  if (keys.length <= MAX_POSITIONS) return
  keys
    .sort((a, b) => (map[a] || 0) - (map[b] || 0))
    .slice(0, keys.length - MAX_POSITIONS)
    .forEach((stale) => delete map[stale])
}

/**
 * Forget everything recorded against a file: where it was left, whether it was
 * finished, how its subtitle was nudged.
 *
 * These are keyed by path, and a path is a title. When a file moves into the
 * vault, leaving `file:/…/Its Title.mp4` behind in the plain-text state file
 * would put back on disk exactly the name the vault exists to hide.
 */
function forgetFile(filePath) {
  if (!filePath) return
  const want = `file:${filePath}`.normalize('NFC')
  commit((s) => {
    for (const map of [s.positions, s.watched, s.delays]) {
      for (const key of Object.keys(map)) {
        if (key.normalize('NFC') === want) delete map[key]
      }
    }
  })
}

/** Keep the history attached to a file that was found under a new path. */
function moveFileKey(from, to) {
  if (!from || !to || from === to) return
  commit((s) => {
    for (const map of [s.positions, s.watched, s.delays]) {
      if (map[`file:${from}`] !== undefined && map[`file:${to}`] === undefined) {
        map[`file:${to}`] = map[`file:${from}`]
      }
      delete map[`file:${from}`]
    }
  })
}

function positionOf(key) {
  const entry = key ? state.positions[key] : null
  return entry && entry.at > 0 ? entry.at : 0
}

/**
 * A subtitle nudged into place by hand.
 *
 * Worth keeping because the mismatch belongs to the pair, not to the sitting: the
 * same subtitle against the same release is off by the same amount tomorrow, and
 * asking the user to find the offset again every time is asking them to redo work
 * they have already done.
 */
function rememberDelay(key, seconds) {
  if (!key || !Number.isFinite(seconds)) return
  commit((s) => {
    if (!seconds) delete s.delays[key]
    else s.delays[key] = Math.round(seconds * 10) / 10

    const keys = Object.keys(s.delays)
    if (keys.length > MAX_POSITIONS) {
      // No timestamps here, so age is judged by the position record that goes
      // with the same key; anything with no position left is the stalest thing
      // in the file.
      keys
        .sort((a, b) => ((s.positions[a] || {}).seen || 0) - ((s.positions[b] || {}).seen || 0))
        .slice(0, keys.length - MAX_POSITIONS)
        .forEach((stale) => delete s.delays[stale])
    }
  })
}

function delayOf(key) {
  const value = key ? state.delays[key] : 0
  return Number.isFinite(value) ? value : 0
}

function ensureDownloadDir() {
  const dir = state.settings.downloadDir
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

module.exports = {
  init,
  getState,
  commit,
  save,
  flush,
  send,
  broadcast,
  toast,
  findSource,
  findItem,
  findDownload,
  itemsOfSource,
  getHostProfile,
  rememberHostProfile,
  ensureDownloadDir,
  rememberPosition,
  positionOf,
  rememberDelay,
  delayOf,
  forgetFile,
  moveFileKey,
  defaultSettings,
}
