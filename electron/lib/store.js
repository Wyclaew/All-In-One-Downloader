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
    downloadDir: path.join(app.getPath('downloads'), 'Everything Downloader'),
    concurrency: 2,
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

    // in-house page resolver, for sites yt-dlp has no extractor for
    useResolver: true,
    // Long enough that a pre-roll can finish and the real stream can start.
    resolverTimeout: 45000,
    // Streams shorter than this are treated as adverts when a longer one exists.
    minStreamSeconds: 120,

    // subtitles fetched from a provider, separate from yt-dlp's own --write-subs
    subtitleLangs: 'tr,en',
    subtitleApiKey: '',
    autoFetchSubtitles: false,
    syncSubtitles: true,
    embedSubtitleFile: false,
    // Don't put Turkish subtitles on a Turkish-language video.
    skipSameLanguageSubtitles: true,
  }
}

function emptyState() {
  return {
    version: STATE_VERSION,
    sources: [],
    items: [],
    downloads: [],
    categories: [],
    settings: defaultSettings(),
  }
}

let state = emptyState()
let stateFile = ''
let saveTimer = null
let broadcastTimer = null

function init() {
  stateFile = path.join(app.getPath('userData'), 'library.json')
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
    }
  }
  migrateCookieBrowser()

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
  ensureDownloadDir,
  defaultSettings,
}
