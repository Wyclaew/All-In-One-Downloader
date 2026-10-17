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
      // corsEnabled + the header below let the page draw frames to a canvas and
      // route audio through Web Audio: the page is file:// and the media is not,
      // and without CORS both would see silence and a tainted canvas.
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ])
}

/**
 * Something the player can read: a file on disk, or a vault entry decrypted in
 * memory a chunk at a time. Either way it is a size and a way to read a range.
 */
function fileSource(filePath) {
  return {
    name: path.basename(filePath),
    size: () => fs.statSync(filePath).size,
    read: (start, end) => fs.createReadStream(filePath, { start, end }),
  }
}

function vaultSource(src) {
  return {
    name: src.name,
    size: () => src.size,
    read: (start, end) => src.read(start, end),
  }
}

/** Parse a Range header against `size`: [start, end] inclusive, or null, or 'bad'. */
function rangeOf(header, size) {
  const match = /bytes=(\d*)-(\d*)/i.exec(String(header || ''))
  if (!match) return null
  let start = match[1] ? Number(match[1]) : 0
  let end = match[2] ? Number(match[2]) : size - 1
  // A suffix range ("bytes=-65536") asks for the tail, which is where an MP4
  // written without faststart keeps its index.
  if (!match[1] && match[2]) {
    start = Math.max(0, size - Number(match[2]))
    end = size - 1
  }
  if (!Number.isFinite(start) || start < 0 || start >= size) return 'bad'
  end = Math.min(Number.isFinite(end) ? end : size - 1, size - 1)
  if (end < start) return 'bad'
  return [start, end]
}

/**
 * Range requests are the whole point: without a 206 the video element downloads
 * the file from the top every time the user drags the scrub bar, which on a
 * two-hour film means seeking does not work at all.
 */
function serve(source, rangeHeader) {
  let size
  try {
    size = source.size()
  } catch {
    return new Response('yok', { status: 404 })
  }
  const type = MIME[path.extname(source.name).toLowerCase()] || 'application/octet-stream'
  const common = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' }
  const range = rangeOf(rangeHeader, size)
  if (range === 'bad') {
    return new Response(null, { status: 416, headers: { ...common, 'Content-Range': `bytes */${size}` } })
  }
  if (range) {
    const [start, end] = range
    return new Response(Readable.toWeb(source.read(start, end)), {
      status: 206,
      headers: {
        ...common,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
      },
    })
  }
  return new Response(size ? Readable.toWeb(source.read(0, size - 1)) : null, {
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
    const source = served.get(decodeURIComponent(token))
    if (!source) return new Response('yetki yok', { status: 403 })
    return serve(source, request.headers.get('range'))
  })
}

function tokenFor(source) {
  const token = crypto.randomBytes(16).toString('hex')
  served.set(token, typeof source === 'string' ? fileSource(source) : source)
  return token
}

/* -------------------------------------------------------------------------- */
/* a door for ffmpeg                                                           */
/* -------------------------------------------------------------------------- */

/**
 * ffprobe and ffmpeg cannot read our private scheme, and a vaulted film has no
 * file for them to open — on purpose. So they get an HTTP address on the
 * loopback interface instead: bound to 127.0.0.1 only, one random 128-bit token
 * per window, with the same range support the player uses. The token dies with
 * the window, and nothing outside this machine can reach the port at all.
 */
let toolServer = null
let toolPort = 0
const toolServed = new Map()

function toolUrlFor(source) {
  const token = crypto.randomBytes(16).toString('hex')
  toolServed.set(token, source)
  return { token, url: () => `http://127.0.0.1:${toolPort}/${token}` }
}

function startToolServer() {
  if (toolServer) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const http = require('http')
    toolServer = http.createServer((req, res) => {
      const token = String(req.url || '').replace(/^\/+/, '').split(/[/?]/)[0]
      const source = toolServed.get(token)
      if (!source || (req.method !== 'GET' && req.method !== 'HEAD')) {
        res.writeHead(403)
        return res.end()
      }
      let size
      try {
        size = source.size()
      } catch {
        res.writeHead(404)
        return res.end()
      }
      const range = rangeOf(req.headers.range, size)
      if (range === 'bad') {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` })
        return res.end()
      }
      const [start, end] = range || [0, size - 1]
      res.writeHead(range ? 206 : 200, {
        'Content-Type': 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(size ? end - start + 1 : 0),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      })
      if (req.method === 'HEAD' || !size) return res.end()
      const stream = source.read(start, end)
      stream.on('error', () => res.destroy())
      res.on('close', () => stream.destroy())
      stream.pipe(res)
    })
    toolServer.on('error', reject)
    toolServer.listen(0, '127.0.0.1', () => {
      toolPort = toolServer.address().port
      resolve()
    })
  })
}

/** What ffmpeg should be given as `-i`: the path for a file, the loopback URL for a vault entry. */
function inputOf(session) {
  return session.vault ? session.toolUrl() : session.file
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
  return require('./subtitles').decodeText(buffer)
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

// Containers tag tracks with three-letter codes; both bibliographic and
// terminological forms turn up ("ger" and "deu").
const ISO3_TO_2 = {
  tur: 'tr', eng: 'en', ger: 'de', deu: 'de', fre: 'fr', fra: 'fr', spa: 'es', ita: 'it',
  por: 'pt', rus: 'ru', ara: 'ar', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', dut: 'nl',
  nld: 'nl', gre: 'el', ell: 'el', per: 'fa', fas: 'fa', hin: 'hi', pol: 'pl', swe: 'sv',
}

function languageLabel(code) {
  const raw = String(code || '').toLowerCase()
  if (!raw || raw === 'und') return 'Bilinmeyen dil'
  const key = (ISO3_TO_2[raw] || raw).slice(0, 2)
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

  // And the ones we keep for it ourselves, out of the download folder.
  let stored = []
  const storeDir = storeDirFor(filePath)
  try {
    stored = fs.readdirSync(storeDir)
  } catch {
    stored = []
  }
  for (const name of stored) {
    if (!SUBTITLE_EXT.has(path.extname(name).toLowerCase())) continue
    const lang = path.basename(name, path.extname(name)).split(/[-.]/)[0]
    tracks.push({
      id: `store:${name}`,
      kind: 'file',
      label: `${languageLabel(lang)} — indirilen`,
      language: lang,
      path: path.join(storeDir, name),
    })
  }
  return tracks
}

function storeDirFor(filePath) {
  return require('./subtitles').storeDirFor(filePath)
}

/**
 * One ffprobe pass for everything the player wants to know about the container:
 * the subtitle streams Chromium refuses to surface, the audio streams (so a
 * dual-language episode can switch), and the chapter marks.
 */
function probeMedia(input) {
  return new Promise((resolve) => {
    const empty = { subs: [], audio: [], chapters: [] }
    const bin = ffprobePath()
    if (!bin) return resolve(empty)
    execFile(
      bin,
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_chapters', input],
      { env: toolEnv(), timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(empty)
        let data = {}
        try {
          data = JSON.parse(stdout)
        } catch {
          return resolve(empty)
        }
        const streams = data.streams || []
        const subs = streams
          .filter((st) => st.codec_type === 'subtitle')
          // Picture-based subtitles (DVD/Blu-ray bitmaps) cannot become text.
          .map((st, index) => ({ st, index }))
          .filter(({ st }) => !/pgs|dvd_sub|dvb_sub|hdmv/i.test(String(st.codec_name || '')))
          .map(({ st, index }) => {
            const tags = st.tags || {}
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
        const audio = streams
          .filter((st) => st.codec_type === 'audio')
          .map((st, index) => {
            const tags = st.tags || {}
            const lang = String(tags.language || '').toLowerCase()
            return {
              index,
              language: lang,
              label: `${languageLabel(lang === 'und' ? '' : lang)}${tags.title ? ` (${tags.title})` : ''}`,
            }
          })
        const chapters = (data.chapters || [])
          .map((c) => ({
            start: Number(c.start_time) || 0,
            title: String((c.tags && c.tags.title) || '').slice(0, 120),
          }))
          .filter((c) => Number.isFinite(c.start))
        resolve({ subs, audio, chapters })
      }
    )
  })
}

async function listTracks(session) {
  const media = await probeMedia(inputOf(session))
  session.media = media
  // A vaulted film has no folder of its own to look in.
  const loose = session.vault ? [] : sidecarTracks(session.file)
  return [...loose, ...media.subs]
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
    cues = await cuesViaFfmpeg(['-i', inputOf(session), '-map', `0:s:${track.streamIndex}`])
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
/** OpenSubtitles' hash of a source we may only read in ranges. */
async function hashOfSource(source) {
  const readAll = (stream) =>
    new Promise((resolve, reject) => {
      const parts = []
      stream.on('data', (c) => parts.push(c))
      stream.on('end', () => resolve(Buffer.concat(parts)))
      stream.on('error', reject)
    })
  try {
    const size = source.size()
    if (size < 131072) return null
    const head = await readAll(source.read(0, 65535))
    const tail = await readAll(source.read(size - 65536, size - 1))
    return require('./subtitles').movieHashOf(size, head, tail)
  } catch {
    return null
  }
}

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
      filePath: session.vault ? null : session.file,
      hash: session.vault ? await hashOfSource(session.source) : null,
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
/* neighbouring episodes                                                       */
/* -------------------------------------------------------------------------- */

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.ts'])

/**
 * The file that comes `step` places after this one (−1 for the one before).
 *
 * Two readings, in order of how much they can be trusted. If the name carries a
 * season and an episode, the neighbour is the file in the same folder with the
 * same season and the adjacent episode — an answer, not a guess. Failing that,
 * the neighbour in natural order, which is right for a folder of numbered parts.
 *
 * Never for a vaulted file: it has no folder, and looking around would mean
 * looking at nothing.
 */
function neighbour(session, step) {
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

  const titleOf = (file) => {
    const download = store.getState().downloads.find((d) => d.filePath && path.resolve(d.filePath) === path.resolve(file))
    return download && download.title ? download.title : path.basename(file, path.extname(file))
  }

  const here = parseName(current)
  if (here.season && here.episode) {
    // Episodes of the same show only — a file of another show in the same
    // folder is not "the one before", however the names happen to sort.
    const { nameKey } = require('./locate')
    const show = nameKey(here.title)
    const episodes = names
      .map((name) => ({ name, info: parseName(name) }))
      .filter((e) => e.name !== current && e.info.season && e.info.episode && nameKey(e.info.title) === show)
    const order = (e) => e.info.season * 10000 + e.info.episode
    const mine = here.season * 10000 + here.episode
    const candidates = episodes
      .filter((e) => (step > 0 ? order(e) > mine : order(e) < mine))
      .sort((a, b) => (step > 0 ? order(a) - order(b) : order(b) - order(a)))
    const pick = candidates[0]
    if (!pick) return null
    const file = path.join(dir, pick.name)
    // "Sure" only when it is the very next number in the same season.
    const sure = pick.info.season === here.season && Math.abs(pick.info.episode - here.episode) === 1
    return { path: file, title: titleOf(file), sure }
  }

  const sorted = names.sort((a, b) => a.localeCompare(b, 'tr', { numeric: true }))
  const at = sorted.indexOf(current)
  const other = sorted[at + step]
  if (at >= 0 && other) {
    const file = path.join(dir, other)
    return { path: file, title: titleOf(file), sure: false }
  }
  return null
}

const nextEpisode = (session) => neighbour(session, 1)

/** Swap the window over to another file without building a second window. */
async function switchTo(win, session, step) {
  const target = neighbour(session, step)
  if (!target || !fs.existsSync(target.path)) {
    throw new Error(step > 0 ? 'Sonraki bölüm bulunamadı.' : 'Önceki bölüm bulunamadı.')
  }
  releaseSession(session)
  const token = tokenFor(target.path)
  const tool = toolUrlFor(fileSource(target.path))

  session.file = target.path
  session.title = target.title
  session.key = `file:${target.path}`
  session.tokens = [token]
  session.toolTokens = [tool.token]
  session.toolUrl = tool.url
  session.source = served.get(token)
  session.tracks = []
  session.hits = null
  session.media = null
  session.src = `${SCHEME}://media/${token}`

  // The page reads everything it needs from `player:boot`, so reloading it is
  // the whole switch — no second window, no state left over from the last file.
  win.webContents.reload()
  return { path: target.path }
}

/** Drop the tokens and temp files a session holds. */
function releaseSession(session) {
  for (const t of session.tokens || []) served.delete(t)
  for (const t of session.toolTokens || []) toolServed.delete(t)
  for (const temp of session.temps || []) {
    try {
      fs.unlinkSync(temp)
    } catch {
      /* already gone */
    }
  }
  session.tokens = []
  session.toolTokens = []
  session.temps = []
}

/* -------------------------------------------------------------------------- */
/* the window                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Chromium plays a narrower set of codecs than VLC does — an MKV carrying H.264
 * is the common miss. Rather than leaving the user with a black rectangle, the
 * container is rewritten to MP4 without touching the streams, which takes
 * seconds and keeps the quality identical.
 *
 * Not for a vaulted film: the rewritten copy would be a plaintext file on disk,
 * which is the one thing the vault promises never to leave behind.
 */
function remux(session) {
  if (session.vault) {
    return Promise.reject(
      new Error('Kasadaki bu dosya pencere içinde açılamıyor ve kasa düz kopya yazmaz. "Sistem oynatıcısında aç" ile açabilirsin.')
    )
  }
  return new Promise((resolve, reject) => {
    const bin = ffmpegPath()
    if (!bin) return reject(new Error('Dönüştürme için ffmpeg gerekiyor.'))
    const out = path.join(os.tmpdir(), `aio-play-${crypto.randomBytes(6).toString('hex')}.mp4`)
    const child = spawn(
      bin,
      [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', session.file,
        '-map', '0:v:0?', '-map', '0:a?',
        '-c', 'copy',
        '-movflags', '+faststart',
        out,
      ],
      { env: toolEnv(), windowsHide: true }
    )
    child.on('error', () => reject(new Error('Dönüştürme başlatılamadı.')))
    child.on('close', (code) => {
      if (code !== 0) {
        fs.rmSync(out, { force: true })
        return reject(new Error('Bu dosya dönüştürülemedi. Sistem oynatıcısında açmayı dene.'))
      }
      session.temps.push(out)
      const token = tokenFor(out)
      session.tokens.push(token)
      resolve({ src: `${SCHEME}://media/${token}` })
    })
  })
}

function makeWindow(vault) {
  const win = new BrowserWindow({
    width: 1080,
    height: 680,
    minWidth: 480,
    minHeight: 320,
    backgroundColor: '#07080a',
    title: vault ? 'Kasa oynatıcısı' : 'Oynatıcı',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
    },
  })
  // Nothing in this window may navigate, open anything or ask for anything.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  return win
}

async function launch({ session, vault }) {
  await startToolServer()
  const win = makeWindow(vault)
  sessions.set(win.webContents.id, session)
  if (vault) vaultWindows.add(win)
  win.on('closed', () => {
    releaseSession(session)
    sessions.delete(win.webContents.id)
    vaultWindows.delete(win)
  })
  await win.loadFile(PAGE)
  return win
}

function raiseExisting(match) {
  for (const [id, session] of sessions) {
    if (!match(session)) continue
    const existing = BrowserWindow.getAllWindows().find((w) => w.webContents.id === id)
    if (existing && !existing.isDestroyed()) {
      existing.show()
      existing.focus()
      return true
    }
  }
  return false
}

/**
 * Open a library file in the player.
 *
 * `key` is what the resume position is filed under: the path for a library file.
 */
async function open({ file, title, key }) {
  if (!fs.existsSync(file)) throw new Error('Dosya bulunamadı.')
  if (raiseExisting((s) => !s.vault && s.file === file)) return { path: file }

  const token = tokenFor(file)
  const tool = toolUrlFor(fileSource(file))
  const session = {
    file,
    title: title || path.basename(file),
    key,
    vault: false,
    tokens: [token],
    toolTokens: [tool.token],
    toolUrl: tool.url,
    source: served.get(token),
    temps: [],
    tracks: [],
    src: `${SCHEME}://media/${token}`,
  }
  await launch({ session, vault: false })
  return { path: file }
}

/**
 * Open a vault entry, streamed and decrypted in memory a chunk at a time.
 *
 * There is no file: the video element reads ranges over the private scheme and
 * ffprobe reads them over the loopback door, both from the same decrypting
 * source. Locking the vault closes the window and the tokens die with it.
 */
async function openVault(id) {
  const vault = require('./vault')
  if (raiseExisting((s) => s.vault && s.vaultId === id)) return { ok: true }
  const src = await vault.streamSource(id)
  const source = vaultSource(src)
  const token = crypto.randomBytes(16).toString('hex')
  served.set(token, source)
  const tool = toolUrlFor(source)
  const session = {
    file: null,
    vaultId: id,
    title: src.title,
    key: `vault:${id}`,
    vault: true,
    tokens: [token],
    toolTokens: [tool.token],
    toolUrl: tool.url,
    source,
    temps: [],
    tracks: [],
    src: `${SCHEME}://media/${token}`,
  }
  await launch({ session, vault: true })
  return { ok: true }
}

/** Locking the vault makes the source unreadable; a window still showing it must go. */
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

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

function registerIpc() {
  ipcMain.handle('player:boot', async (event) => {
    const session = sessionOf(event)
    const settings = store.getState().settings
    session.tracks = await listTracks(session)
    const next = neighbour(session, 1)
    const prev = neighbour(session, -1)
    return {
      title: session.title,
      src: session.src,
      vault: session.vault,
      resumeAt: store.positionOf(session.key),
      delay: store.delayOf(session.key),
      volume: Number.isFinite(settings.playerVolume) ? settings.playerVolume : 1,
      rate: RATES.includes(Number(settings.playerRate)) ? Number(settings.playerRate) : 1,
      boost: [1, 1.5, 2].includes(Number(settings.playerBoost)) ? Number(settings.playerBoost) : 1,
      fit: ['contain', 'cover', 'fill'].includes(settings.playerFit) ? settings.playerFit : 'contain',
      autoNext: settings.playerAutoNext !== false,
      tracks: session.tracks.map(publicTrack),
      audio: (session.media && session.media.audio) || [],
      chapters: (session.media && session.media.chapters) || [],
      next: next ? { title: next.title, sure: next.sure } : null,
      prev: prev ? { title: prev.title, sure: prev.sure } : null,
      languages: Object.entries(LANGUAGE_NAMES).map(([code, name]) => ({ code, name })),
      preferredLanguage:
        String(settings.subtitleLangs || 'tr')
          .split(',')[0]
          .trim()
          .toLowerCase() || 'tr',
      subtitleSize: settings.playerSubtitleSize || 'normal',
      subtitleStyle: ['box', 'outline'].includes(settings.playerSubtitleStyle) ? settings.playerSubtitleStyle : 'box',
      hasKey: !!String(settings.subtitleApiKey || '').trim(),
    }
  })

  ipcMain.on('player:position', (event, { seconds, duration } = {}) => {
    const session = sessions.get(event.sender.id)
    if (session) store.rememberPosition(session.key, Number(seconds), Number(duration))
    if (session && session.vault) require('./vault').touch()
  })

  ipcMain.handle('player:tracks', async (event) => {
    const session = sessionOf(event)
    const fresh = await listTracks(session)
    // Anything fetched in this sitting has no file on disk to rediscover.
    const fetched = (session.tracks || []).filter((t) => t.kind === 'fetched')
    session.tracks = [...fresh, ...fetched]
    return session.tracks.map(publicTrack)
  })

  ipcMain.handle('player:cues', async (event, trackId) => cuesFor(sessionOf(event), String(trackId || '')))

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

  /** Playback preferences that should outlive the window. Validated, never trusted. */
  ipcMain.on('player:prefs', (_event, prefs = {}) => {
    const patch = {}
    if (RATES.includes(Number(prefs.rate))) patch.playerRate = Number(prefs.rate)
    if ([1, 1.5, 2].includes(Number(prefs.boost))) patch.playerBoost = Number(prefs.boost)
    if (['contain', 'cover', 'fill'].includes(prefs.fit)) patch.playerFit = prefs.fit
    if (typeof prefs.autoNext === 'boolean') patch.playerAutoNext = prefs.autoNext
    if (['box', 'outline'].includes(prefs.subtitleStyle)) patch.playerSubtitleStyle = prefs.subtitleStyle
    if (!Object.keys(patch).length) return
    store.commit((s) => {
      Object.assign(s.settings, patch)
    })
  })

  ipcMain.handle('player:next', async (event) => {
    const win = windowOf(event)
    if (!win) throw new Error('Pencere bulunamadı.')
    return switchTo(win, sessionOf(event), 1)
  })

  ipcMain.handle('player:prev', async (event) => {
    const win = windowOf(event)
    if (!win) throw new Error('Pencere bulunamadı.')
    return switchTo(win, sessionOf(event), -1)
  })

  ipcMain.handle('player:onTop', (event, on) => {
    const win = windowOf(event)
    if (!win) return false
    win.setAlwaysOnTop(!!on, 'floating')
    return win.isAlwaysOnTop()
  })

  /**
   * Save the frame on screen as a PNG in Pictures. Refused for a vaulted film:
   * a screenshot is a plaintext picture of exactly what the vault is hiding.
   */
  ipcMain.handle('player:screenshot', async (event, { dataUrl, at } = {}) => {
    const session = sessionOf(event)
    if (session.vault) throw new Error('Kasadaki videolardan ekran görüntüsü alınmaz.')
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''))
    if (!match) throw new Error('Görüntü alınamadı.')
    const png = Buffer.from(match[1], 'base64')
    if (png.length > 40 * 1024 * 1024 || png.subarray(1, 4).toString() !== 'PNG') throw new Error('Görüntü alınamadı.')
    const { app } = require('electron')
    const dir = path.join(app.getPath('pictures'), 'All in One Downloader')
    fs.mkdirSync(dir, { recursive: true })
    const base = String(session.title || 'kare').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'kare'
    const stamp = clockName(Number(at) || 0)
    let file = path.join(dir, `${base} ${stamp}.png`)
    let n = 2
    while (fs.existsSync(file)) file = path.join(dir, `${base} ${stamp} (${n++}).png`)
    fs.writeFileSync(file, png)
    return { path: file }
  })

  ipcMain.handle('player:reveal', (event, file) => {
    sessionOf(event)
    const { app } = require('electron')
    const dir = path.join(app.getPath('pictures'), 'All in One Downloader')
    // Only ever a screenshot this window just saved.
    if (typeof file === 'string' && path.resolve(file).startsWith(dir + path.sep)) shell.showItemInFolder(file)
    return true
  })

  ipcMain.handle('player:remux', async (event) => remux(sessionOf(event)))

  ipcMain.handle('player:openExternally', async (event) => {
    const session = sessionOf(event)
    if (session.vault) {
      await require('./vault').openEntry(session.vaultId)
      return true
    }
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

function clockName(seconds) {
  const t = Math.max(0, Math.floor(seconds))
  const pad = (n) => String(n).padStart(2, '0')
  return `${Math.floor(t / 3600)}.${pad(Math.floor((t % 3600) / 60))}.${pad(t % 60)}`
}

/** Close any window playing `file` — it is about to be moved or rewritten. */
function closeFile(file) {
  const { samePath } = require('./locate')
  for (const [id, session] of sessions) {
    if (!session.file || !samePath(session.file, file)) continue
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.id === id)
    if (win && !win.isDestroyed()) win.close()
  }
}

/** Files open in a player window right now; nothing should rewrite them. */
function openFiles() {
  return new Set([...sessions.values()].filter((session) => session.file).map((session) => session.file))
}

module.exports = {
  openFiles,
  closeFile,
  registerScheme,
  registerProtocol,
  registerIpc,
  open,
  openVault,
  closeVaultWindows,
  // exported for the tests
  parseCues,
  decodeText,
  languageOfName,
  sidecarTracks,
  nextEpisode,
  neighbour,
  rangeOf,
}
