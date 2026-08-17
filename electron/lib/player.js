'use strict'

// The app's own video player.
//
// Three things a handed-off player cannot do, and this one can:
//
//   resume    VLC and QuickTime keep their bookmarks in their own stores, and
//             nothing lets another application read them. A player we own is the
//             only one we can ask where the user stopped.
//   subtitles Chromium will not expose a subtitle track muxed into an MP4 or an
//             MKV, so "altyazı eklendi" in the library and a blank screen in the
//             player were both true at once. Here the tracks are found in the
//             main process — sidecar files, embedded streams, or OpenSubtitles on
//             demand — turned into cues, and drawn by us.
//   privacy   opening a vaulted file with the OS player wrote its title into
//             QuickTime's recent documents, which outlives the decrypted copy.
//
// The window itself is deliberately inert: no node, context isolation on, a
// preload that exposes a fixed set of calls, and a page that ships inside the
// app. The video never travels as a file:// URL — it is streamed over a private
// scheme that only serves paths this module has explicitly registered.

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { Readable } = require('stream')
const { spawn, execFile } = require('child_process')
const { BrowserWindow, ipcMain, protocol, shell } = require('electron')
const { ffmpegPath, ffprobePath, toolEnv } = require('./binaries')
const store = require('./store')

const SCHEME = 'aiomedia'
const PAGE = path.join(__dirname, '..', 'player', 'index.html')
const PRELOAD = path.join(__dirname, '..', 'player-preload.js')

/** token -> absolute path. The only paths the private scheme will ever serve. */
const served = new Map()

/** webContents.id -> session state for that window. */
const sessions = new Map()

/** Windows playing a vaulted file, so locking the vault can close them. */
const vaultWindows = new Set()

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/webm', // Chromium reads Matroska through its WebM demuxer.
  '.ogv': 'video/ogg',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.opus': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
}

const SUBTITLE_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa', '.sub'])

/* -------------------------------------------------------------------------- */
/* serving the file                                                            */
/* -------------------------------------------------------------------------- */

/** Must run before the app is ready, so the scheme gets the privileges below. */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ])
}

/**
 * Range requests are the whole point: without a 206 the video element downloads
 * the file from the top every time the user drags the scrub bar, which on a
 * two-hour film means seeking does not work at all.
 */
function serve(filePath, rangeHeader) {
  let size
  try {
    size = fs.statSync(filePath).size
  } catch {
    return new Response('yok', { status: 404 })
  }
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
  const common = { 'Content-Type': type, 'Accept-Ranges': 'bytes' }

  const match = /bytes=(\d*)-(\d*)/i.exec(String(rangeHeader || ''))
  if (match) {
    let start = match[1] ? Number(match[1]) : 0
    let end = match[2] ? Number(match[2]) : size - 1
    // A suffix range ("bytes=-65536") asks for the tail, which is where an MP4
    // written without faststart keeps its index.
    if (!match[1] && match[2]) {
      start = Math.max(0, size - Number(match[2]))
      end = size - 1
    }
    if (!Number.isFinite(start) || start < 0 || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    }
    end = Math.min(Number.isFinite(end) ? end : size - 1, size - 1)
    const stream = fs.createReadStream(filePath, { start, end })
    return new Response(Readable.toWeb(stream), {
      status: 206,
      headers: {
        ...common,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
      },
    })
  }

  return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
    status: 200,
    headers: { ...common, 'Content-Length': String(size) },
  })
}

/** Called once the app is ready. */
function registerProtocol() {
  protocol.handle(SCHEME, (request) => {
    let token = ''
    try {
      token = new URL(request.url).pathname.replace(/^\/+/, '').split('/')[0]
    } catch {
      return new Response('kötü adres', { status: 400 })
    }
    const file = served.get(decodeURIComponent(token))
    if (!file) return new Response('yetki yok', { status: 403 })
    return serve(file, request.headers.get('range'))
  })
}

function tokenFor(filePath) {
  const token = crypto.randomBytes(16).toString('hex')
  served.set(token, filePath)
  return token
}

/* -------------------------------------------------------------------------- */
/* subtitles: finding them                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Subtitle files are still routinely written in a Windows code page, and a
 * Turkish one decoded as UTF-8 turns every ı, ş and ğ into a replacement
 * character. Try UTF-8 strictly first — a real UTF-8 file always survives it —
 * and fall back to the code page that covers Turkish.
 */
function decodeText(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.slice(3).toString('utf8')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    try {
      return new TextDecoder('windows-1254').decode(buffer)
    } catch {
      return buffer.toString('latin1')
    }
  }
}

function parseTimestamp(text) {
  // 00:01:02,500 and 00:01:02.500 both appear, and the hour is often dropped.
  const m = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/.exec(text)
  if (!m) return null
  const hours = Number(m[1] || 0)
  const minutes = Number(m[2])
  const seconds = Number(m[3])
  const millis = Number(m[4].padEnd(3, '0'))
  return hours * 3600 + minutes * 60 + seconds + millis / 1000
}

/**
 * SRT and WebVTT differ in the header and the decimal separator, and in nothing
 * else that matters here, so one parser reads both. The output is plain cues,
 * which is what the player draws — no TextTrack, no blob, no re-encoding when
 * the user nudges the timing.
 */
function parseCues(text) {
  const cues = []
  const blocks = String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n')
    const arrowAt = lines.findIndex((l) => l.includes('-->'))
    if (arrowAt < 0) continue
    const [left, right] = lines[arrowAt].split('-->')
    const start = parseTimestamp(left || '')
    const end = parseTimestamp(right || '')
    if (start === null || end === null || end <= start) continue
    const body = lines
      .slice(arrowAt + 1)
      .join('\n')
      .trim()
    if (!body) continue
    cues.push({ start, end, text: body })
  }
  cues.sort((a, b) => a.start - b.start)
  return cues
}

/** Anything ffmpeg can read becomes SRT on stdout, which parseCues understands. */
function cuesViaFfmpeg(args) {
  return new Promise((resolve) => {
    const bin = ffmpegPath()
    if (!bin) return resolve([])
    const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args, '-f', 'srt', '-'], {
      env: toolEnv(),
      windowsHide: true,
    })
    const chunks = []
    child.stdout.on('data', (c) => chunks.push(c))
    child.on('error', () => resolve([]))
    child.on('close', () => resolve(parseCues(decodeText(Buffer.concat(chunks)))))
  })
}

/** A two-letter guess from `Film.tr.srt`, or from the language word in the name. */
function languageOfName(stem, fileName) {
  const rest = path.basename(fileName, path.extname(fileName)).slice(stem.length).replace(/^[.\- _]+/, '')
  const tag = rest.split(/[.\- _]/).filter(Boolean).pop() || ''
  if (/^[a-z]{2,3}$/i.test(tag)) return tag.toLowerCase()
  if (/turk|türk/i.test(rest)) return 'tr'
  if (/eng|ingiliz/i.test(rest)) return 'en'
  return ''
}

const LANGUAGE_NAMES = {
  tr: 'Türkçe',
  en: 'İngilizce',
  de: 'Almanca',
  fr: 'Fransızca',
  es: 'İspanyolca',
  it: 'İtalyanca',
  pt: 'Portekizce',
  ru: 'Rusça',
  ar: 'Arapça',
  ja: 'Japonca',
  ko: 'Korece',
  zh: 'Çince',
  nl: 'Felemenkçe',
  el: 'Yunanca',
  fa: 'Farsça',
  hi: 'Hintçe',
  pl: 'Lehçe',
  sv: 'İsveççe',
}

function languageLabel(code) {
  const key = String(code || '').toLowerCase().slice(0, 2)
  return LANGUAGE_NAMES[key] || (code ? String(code).toUpperCase() : 'Bilinmeyen')
}

/** Subtitle files sitting beside the video, the way every player looks for them. */
function sidecarTracks(filePath) {
  const dir = path.dirname(filePath)
  const stem = path.basename(filePath, path.extname(filePath))
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const tracks = []
  for (const name of names) {
    const ext = path.extname(name).toLowerCase()
    if (!SUBTITLE_EXT.has(ext)) continue
    // Anchored on the dot that follows the stem, or "Dune.mp4" would happily
    // adopt the subtitles belonging to "Dune 2".
    if (!name.startsWith(`${stem}.`)) continue
    if (name === path.basename(filePath)) continue
    const lang = languageOfName(stem, name)
    tracks.push({
      id: `file:${name}`,
      kind: 'file',
      label: `${languageLabel(lang)} — dosya`,
      language: lang,
      path: path.join(dir, name),
    })
  }
  return tracks
}

/** Subtitle streams muxed into the container, which Chromium refuses to surface. */
function embeddedTracks(filePath) {
  return new Promise((resolve) => {
    const bin = ffprobePath()
    if (!bin) return resolve([])
    execFile(
      bin,
      [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        '-select_streams', 's',
        filePath,
      ],
      { env: toolEnv(), timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([])
        let streams = []
        try {
          streams = JSON.parse(stdout).streams || []
        } catch {
          return resolve([])
        }
        resolve(
          streams.map((s, index) => {
            const tags = s.tags || {}
            const lang = String(tags.language || '').toLowerCase()
            const title = tags.title ? ` (${tags.title})` : ''
            return {
              id: `embedded:${index}`,
              kind: 'embedded',
              label: `${languageLabel(lang)}${title} — gömülü`,
              language: lang,
              streamIndex: index,
            }
          })
        )
      }
    )
  })
}

async function listTracks(filePath) {
  return [...sidecarTracks(filePath), ...(await embeddedTracks(filePath))]
}

async function cuesFor(session, trackId) {
  const track = (session.tracks || []).find((t) => t.id === trackId)
  if (!track) return []
  if (track.cues) return track.cues

  let cues = []
  if (track.kind === 'file') {
    const ext = path.extname(track.path).toLowerCase()
    if (ext === '.ass' || ext === '.ssa' || ext === '.sub') {
      cues = await cuesViaFfmpeg(['-i', track.path])
    } else {
      try {
        cues = parseCues(decodeText(fs.readFileSync(track.path)))
      } catch {
        cues = []
      }
    }
  } else if (track.kind === 'embedded') {
    cues = await cuesViaFfmpeg(['-i', session.file, '-map', `0:s:${track.streamIndex}`])
  }
  // A fetched track arrives with its cues already attached and never reaches
  // here, because the cache check above answers it first.
  track.cues = cues
  return cues
}

/* -------------------------------------------------------------------------- */
/* subtitles: fetching one on demand                                           */
/* -------------------------------------------------------------------------- */

/**
 * What the user asked for: pick a language in the player, and the app goes and
 * looks right then. The hits come back ordered best to worst with the reason
 * spelled out, because "choose one of these forty release names" is not a choice
 * anyone can make well — what decides it is whether the timings were authored
 * against this exact file.
 */
async function searchSubtitles(session, language) {
  const subtitles = require('./subtitles')
  const settings = store.getState().settings
  if (!String(settings.subtitleApiKey || '').trim()) {
    return {
      ok: false,
      message: 'OpenSubtitles anahtarı yok. Ayarlar → Altyazı bölümünden ücretsiz bir anahtar ekle.',
    }
  }

  const wanted = String(language || 'tr').toLowerCase()
  let found
  try {
    found = await subtitles.search({
      filePath: session.file,
      title: session.title,
      languages: wanted,
      apiKey: settings.subtitleApiKey,
    })
  } catch (err) {
    return { ok: false, message: err.message || String(err) }
  }

  const hits = found.results.filter((r) => r.language.toLowerCase().startsWith(wanted))
  session.hits = new Map(hits.map((h) => [h.fileId, h]))
  if (!hits.length) {
    return { ok: false, message: `${languageLabel(wanted)} altyazı bulunamadı.` }
  }
  return {
    ok: true,
    results: hits.slice(0, 12).map((h) => ({
      fileId: h.fileId,
      release: h.release || h.fileName,
      language: h.language,
      downloads: h.downloads,
      hashMatch: h.hashMatch,
      why: h.why,
      recommended: !!h.recommended,
    })),
  }
}

/**
 * Take one of the hits.
 *
 * A hash match was authored for this exact file and needs no alignment; anything
 * else is aligned to the audio when ffsubsync is there, and otherwise offered
 * with the timing it came with — the delay control exists for that case, and what
 * the user sets there is remembered against the file.
 */
async function takeSubtitle(session, fileId) {
  const subtitles = require('./subtitles')
  const settings = store.getState().settings
  const hit = session.hits && session.hits.get(Number(fileId))
  if (!hit) return { ok: false, message: 'Bu altyazı artık listede değil, yeniden ara.' }

  const outcome = await subtitles.apply({
    // A vaulted file's decrypted copy is temporary and its folder is wiped on
    // lock, so nothing is written beside it — the cues go straight to the player.
    videoPath: session.vault ? null : session.file,
    fileId: hit.fileId,
    language: hit.language,
    hashMatch: hit.hashMatch,
    apiKey: settings.subtitleApiKey,
    sync: !session.vault && settings.syncSubtitles && !hit.hashMatch,
    embedTrack: false,
  })

  let cues = []
  try {
    cues = parseCues(decodeText(fs.readFileSync(outcome.path)))
  } catch {
    cues = []
  }
  if (session.vault) {
    try {
      fs.unlinkSync(outcome.path)
    } catch {
      /* it was a temp file anyway */
    }
  }
  if (!cues.length) return { ok: false, message: 'Altyazı indirildi ama okunamadı.' }

  const track = {
    id: `fetched:${hit.fileId}`,
    kind: 'fetched',
    label: `${languageLabel(hit.language)} — OpenSubtitles`,
    language: hit.language,
    cues,
    hashMatch: hit.hashMatch,
  }
  session.tracks = [...(session.tracks || []).filter((t) => t.id !== track.id), track]

  // The library row should say so too, so the file is not searched again later.
  if (!session.vault) {
    const download = store.getState().downloads.find((d) => d.filePath === session.file)
    if (download) {
      store.commit(() => {
        download.subtitlePath = outcome.path
        download.subtitleLanguage = hit.language
      })
    }
  }

  return {
    ok: true,
    track: publicTrack(track),
    cues,
    note: hit.hashMatch
      ? 'Dosya imzası birebir eşleşti — altyazı zaten senkron.'
      : outcome.synced
        ? 'Sese hizalandı.'
        : 'Bu sürüm için birebir eşleşme yoktu; kayarsa gecikmeyi G / H ile ayarla.',
  }
}

const publicTrack = (t) => ({ id: t.id, label: t.label, language: t.language, kind: t.kind })

/* -------------------------------------------------------------------------- */
/* the next episode                                                            */
/* -------------------------------------------------------------------------- */

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.ts'])

/**
 * The file that comes after this one.
 *
 * Two readings, in order of how much they can be trusted. If the name carries a
 * season and an episode, the successor is the file in the same folder with the
 * same season and the next episode — that is an answer, not a guess. Failing
 * that, we fall back to the neighbour in natural order, which is right for a
 * folder of numbered parts and is at least never surprising.
 *
 * Never for a vaulted file: its folder is a decrypted scratch directory holding
 * exactly one film, and looking around in it would be looking at nothing.
 */
function nextEpisode(session) {
  if (session.vault) return null
  const { parseName } = require('./subtitles')
  const dir = path.dirname(session.file)
  const current = path.basename(session.file)

  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => VIDEO_EXT.has(path.extname(n).toLowerCase()))
  } catch {
    return null
  }
  if (names.length < 2) return null

  const here = parseName(current)
  if (here.season && here.episode) {
    for (const name of names) {
      if (name === current) continue
      const other = parseName(name)
      if (other.season === here.season && other.episode === here.episode + 1) {
        return { path: path.join(dir, name), title: name, sure: true }
      }
    }
  }

  const sorted = names.sort((a, b) => a.localeCompare(b, 'tr', { numeric: true }))
  const at = sorted.indexOf(current)
  if (at >= 0 && at + 1 < sorted.length) {
    return { path: path.join(dir, sorted[at + 1]), title: sorted[at + 1], sure: false }
  }
  return null
}

/** Swap the window over to another file without building a second window. */
async function playNext(win, session) {
  const next = nextEpisode(session)
  if (!next || !fs.existsSync(next.path)) throw new Error('Sonraki bölüm bulunamadı.')

  for (const token of session.tokens) served.delete(token)
  // A container we had to rewrite for the last episode is of no use for this one.
  for (const temp of session.temps) {
    try {
      fs.unlinkSync(temp)
    } catch {
      /* already gone */
    }
  }
  session.temps = []
  const token = tokenFor(next.path)

  session.file = next.path
  session.title = next.title
  session.key = `file:${next.path}`
  session.tokens = [token]
  session.tracks = []
  session.hits = null
  session.src = `${SCHEME}://media/${token}`

  // The page reads everything it needs from `player:boot`, so reloading it is
  // the whole switch — no second window, no state left over from the last file.
  win.webContents.reload()
  return { path: next.path }
}

/* -------------------------------------------------------------------------- */
/* the window                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Chromium plays a narrower set of codecs than VLC does — an MKV carrying H.264
 * is the common miss. Rather than leaving the user with a black rectangle, the
 * container is rewritten to MP4 without touching the streams, which takes
 * seconds and keeps the quality identical.
 */
function remux(session) {
  return new Promise((resolve, reject) => {
    const bin = ffmpegPath()
    if (!bin) return reject(new Error('Dönüştürme için ffmpeg gerekiyor.'))
    const out = path.join(os.tmpdir(), `aio-play-${crypto.randomBytes(6).toString('hex')}.mp4`)
    const child = spawn(
      bin,
      [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', session.file,
        '-map', '0:v:0?', '-map', '0:a:0?',
        '-c', 'copy',
        '-movflags', '+faststart',
        out,
      ],
      { env: toolEnv(), windowsHide: true }
    )
    child.on('error', () => reject(new Error('Dönüştürme başlatılamadı.')))
    child.on('close', (code) => {
      if (code !== 0) {
        try {
          fs.unlinkSync(out)
        } catch {
          /* nothing written */
        }
        return reject(new Error('Bu dosya dönüştürülemedi. Sistem oynatıcısında açmayı dene.'))
      }
      session.temps.push(out)
      const token = tokenFor(out)
      session.tokens.push(token)
      resolve({ src: `${SCHEME}://media/${token}` })
    })
  })
}

/**
 * Open a file in the player.
 *
 * `key` is what the resume position is filed under: the path for a library file,
 * the entry id for a vaulted one — so a vaulted file remembers its place without
 * its name being written anywhere outside the vault.
 */
async function open({ file, title, key, vault = false }) {
  if (!fs.existsSync(file)) throw new Error('Dosya bulunamadı.')

  // Same file already on screen: raise that window instead of stacking another.
  for (const [id, session] of sessions) {
    if (session.file === file) {
      const existing = BrowserWindow.getAllWindows().find((w) => w.webContents.id === id)
      if (existing && !existing.isDestroyed()) {
        existing.show()
        existing.focus()
        return { path: file }
      }
    }
  }

  const win = new BrowserWindow({
    width: 1020,
    height: 660,
    minWidth: 480,
    minHeight: 320,
    backgroundColor: '#07080a',
    title: vault ? 'Kasa oynatıcısı' : 'Oynatıcı',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })

  const token = tokenFor(file)
  const session = {
    file,
    title: title || path.basename(file),
    key,
    vault,
    tokens: [token],
    temps: [],
    tracks: [],
    src: `${SCHEME}://media/${token}`,
  }
  sessions.set(win.webContents.id, session)
  if (vault) vaultWindows.add(win)

  // Nothing in this window may navigate or open anything.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  win.on('closed', () => {
    for (const t of session.tokens) served.delete(t)
    for (const temp of session.temps) {
      try {
        fs.unlinkSync(temp)
      } catch {
        /* already gone */
      }
    }
    sessions.delete(win.webContents.id)
    vaultWindows.delete(win)
  })

  await win.loadFile(PAGE)
  return { path: file }
}

/** Locking the vault deletes the decrypted copy; a window still showing it must go. */
function closeVaultWindows() {
  for (const win of vaultWindows) {
    try {
      if (!win.isDestroyed()) win.destroy()
    } catch {
      /* already gone */
    }
  }
  vaultWindows.clear()
}

/* -------------------------------------------------------------------------- */
/* ipc                                                                         */
/* -------------------------------------------------------------------------- */

function sessionOf(event) {
  const session = sessions.get(event.sender.id)
  if (!session) throw new Error('Bu pencere artık bir dosya oynatmıyor.')
  return session
}

function windowOf(event) {
  return BrowserWindow.getAllWindows().find((w) => w.webContents.id === event.sender.id) || null
}

function registerIpc() {
  ipcMain.handle('player:boot', async (event) => {
    const session = sessionOf(event)
    const settings = store.getState().settings
    session.tracks = await listTracks(session.file)
    const next = nextEpisode(session)
    return {
      title: session.title,
      src: session.src,
      vault: session.vault,
      resumeAt: store.positionOf(session.key),
      delay: store.delayOf(session.key),
      volume: Number.isFinite(settings.playerVolume) ? settings.playerVolume : 1,
      tracks: session.tracks.map(publicTrack),
      next: next ? { title: next.title, sure: next.sure } : null,
      languages: Object.entries(LANGUAGE_NAMES).map(([code, name]) => ({ code, name })),
      preferredLanguage:
        String(settings.subtitleLangs || 'tr')
          .split(',')[0]
          .trim()
          .toLowerCase() || 'tr',
      subtitleSize: settings.playerSubtitleSize || 'normal',
      hasKey: !!String(settings.subtitleApiKey || '').trim(),
    }
  })

  ipcMain.on('player:position', (event, { seconds, duration } = {}) => {
    const session = sessions.get(event.sender.id)
    if (session) store.rememberPosition(session.key, Number(seconds), Number(duration))
  })

  ipcMain.handle('player:tracks', async (event) => {
    const session = sessionOf(event)
    const fresh = await listTracks(session.file)
    // Anything fetched in this sitting has no file on disk to rediscover.
    const fetched = (session.tracks || []).filter((t) => t.kind === 'fetched')
    session.tracks = [...fresh, ...fetched]
    return session.tracks.map(publicTrack)
  })

  ipcMain.handle('player:cues', async (event, trackId) => cuesFor(sessionOf(event), trackId))

  ipcMain.handle('player:searchSubtitles', async (event, language) => {
    try {
      return await searchSubtitles(sessionOf(event), language)
    } catch (err) {
      return { ok: false, message: err.message || String(err) }
    }
  })

  ipcMain.handle('player:takeSubtitle', async (event, fileId) => {
    try {
      return await takeSubtitle(sessionOf(event), fileId)
    } catch (err) {
      return { ok: false, message: err.message || String(err) }
    }
  })

  ipcMain.on('player:delay', (event, seconds) => {
    const session = sessions.get(event.sender.id)
    if (session) store.rememberDelay(session.key, Number(seconds))
  })

  ipcMain.on('player:volume', (_event, value) => {
    const volume = Math.max(0, Math.min(1, Number(value)))
    if (!Number.isFinite(volume)) return
    store.commit((s) => {
      s.settings.playerVolume = volume
    })
  })

  ipcMain.handle('player:next', async (event) => {
    const session = sessionOf(event)
    const win = windowOf(event)
    if (!win) throw new Error('Pencere bulunamadı.')
    return playNext(win, session)
  })

  ipcMain.handle('player:remux', async (event) => remux(sessionOf(event)))

  ipcMain.handle('player:openExternally', async (event) => {
    const session = sessionOf(event)
    const err = await shell.openPath(session.file)
    if (err) throw new Error(err)
    return true
  })

  ipcMain.handle('player:subtitleSize', (event, size) => {
    const allowed = ['small', 'normal', 'large', 'huge']
    const value = allowed.includes(size) ? size : 'normal'
    store.commit((s) => {
      s.settings.playerSubtitleSize = value
    })
    return value
  })
}

module.exports = {
  registerScheme,
  registerProtocol,
  registerIpc,
  open,
  closeVaultWindows,
  // exported for the tests
  parseCues,
  decodeText,
  languageOfName,
  sidecarTracks,
  nextEpisode,
}
