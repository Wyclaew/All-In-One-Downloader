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
const { BrowserWindow, ipcMain, protocol, shell, clipboard } = require('electron')
const { ffmpegPath, ffprobePath, toolEnv } = require('./binaries')
const { createTimingAnalyzer } = require('../player/timing')
const store = require('./store')
const { createShowTrackerBridge, reportTitle } = require('./show-tracker')

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
  if (header === null || header === undefined || header === '') return null
  if (!Number.isSafeInteger(size) || size < 0) return 'bad'
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim())
  if (!match || (!match[1] && !match[2])) return 'bad'
  let start = match[1] ? Number(match[1]) : 0
  let end = match[2] ? Number(match[2]) : size - 1
  // A suffix range ("bytes=-65536") asks for the tail, which is where an MP4
  // written without faststart keeps its index.
  if (!match[1] && match[2]) {
    start = Math.max(0, size - Number(match[2]))
    end = size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size) return 'bad'
  end = Math.min(end, size - 1)
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
    if (!/^[a-f0-9]{32}$/.test(token)) return new Response('kötü adres', { status: 400 })
    const source = served.get(token)
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
let toolStarting = null
const toolServed = new Map()

function toolUrlFor(source) {
  const token = crypto.randomBytes(16).toString('hex')
  toolServed.set(token, source)
  return { token, url: () => `http://127.0.0.1:${toolPort}/${token}` }
}

function startToolServer() {
  if (toolStarting) return toolStarting
  if (toolServer?.listening) return Promise.resolve()
  toolStarting = new Promise((resolve, reject) => {
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
    toolServer.on('error', (err) => { toolServer = null; toolPort = 0; reject(err) })
    toolServer.listen(0, '127.0.0.1', () => {
      toolPort = toolServer.address().port
      toolServer.unref()
      resolve()
    })
  })
  const pending = toolStarting
  pending.then(() => { toolStarting = null }, () => { toolStarting = null })
  return pending
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
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})(?:\s|$)/.exec(text)
  if (!m) return null
  const hours = Number(m[1] || 0)
  const minutes = Number(m[2])
  const seconds = Number(m[3])
  const millis = Number(m[4].padEnd(3, '0'))
  const total = hours * 3600 + minutes * 60 + seconds + millis / 1000
  return minutes < 60 && seconds < 60 && Number.isFinite(total) ? total : null
}

/**
 * SRT and WebVTT differ in the header and the decimal separator, and in nothing
 * else that matters here, so one parser reads both. The output is plain cues,
 * which is what the player draws — no TextTrack, no blob, no re-encoding when
 * the user nudges the timing.
 */
function parseCues(text) {
  const cues = []
  const blocks = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/)
  for (const block of blocks) {
    if (/^\s*(?:NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/.test(block)) continue
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
function cuesViaFfmpeg(args, signal) {
  return new Promise((resolve) => {
    const bin = ffmpegPath()
    if (!bin) return resolve([])
    const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args, '-f', 'srt', '-'], {
      env: toolEnv(),
      windowsHide: true,
      signal,
    })
    const chunks = []
    let bytes = 0, overflow = false
    const timer = setTimeout(() => { overflow = true; child.kill() }, 60000)
    child.stdout.on('data', (c) => {
      bytes += c.length
      if (bytes > 16 * 1024 * 1024) { overflow = true; child.kill(); return }
      chunks.push(c)
    })
    child.stderr.on('data', () => {})
    child.on('error', () => { clearTimeout(timer); resolve([]) })
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 && !overflow && !signal?.aborted ? parseCues(decodeText(Buffer.concat(chunks))) : []) })
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
const LOCAL_MEDIA_FORMATS = 'mov,matroska,webm,mpegts,mpeg,mpegvideo,avi,asf,mp3,aac,ac3,eac3,flac,wav,ogg'
const localProbeArgs = () => ['-protocol_whitelist', 'file', '-format_whitelist', LOCAL_MEDIA_FORMATS]

function probeMedia(input, signal, { localOnly = false } = {}) {
  return new Promise((resolve) => {
    const empty = { subs: [], audio: [], chapters: [], video: null }
    const bin = ffprobePath()
    if (!bin) return resolve(empty)
    execFile(
      bin,
      ['-v', 'quiet', ...(localOnly ? localProbeArgs() : []), '-print_format', 'json', '-show_streams', '-show_chapters', input],
      { env: toolEnv(), signal, timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(empty)
        let data = {}
        try {
          data = JSON.parse(stdout)
        } catch {
          return resolve(empty)
        }
        const streams = Array.isArray(data?.streams) ? data.streams.filter((stream) => stream && typeof stream === 'object') : []
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
              forced: !!st.disposition?.forced,
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
              codec: String(st.codec_name || ''),
              default: !!st.disposition?.default,
              streamIndex: Number.isInteger(st.index) ? st.index : null,
              sampleRate: positiveNumber(st.sample_rate),
            }
          })
        const picture = streams.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
        const video = picture ? {
          streamIndex: Number.isInteger(picture.index) ? picture.index : null,
          codec: String(picture.codec_name || '').slice(0, 60),
          pixelFormat: String(picture.pix_fmt || '').slice(0, 60),
          width: positiveNumber(picture.width), height: positiveNumber(picture.height),
          frameRate: frameRateOf(picture.avg_frame_rate) || frameRateOf(picture.r_frame_rate),
        } : null
        const chapters = (Array.isArray(data?.chapters) ? data.chapters : []).filter((chapter) => chapter && typeof chapter === 'object')
          .map((c) => ({
            start: Number(c.start_time),
            title: String((c.tags && c.tags.title) || '').slice(0, 120),
          }))
          .filter((c) => Number.isFinite(c.start) && c.start >= 0)
          .sort((a, b) => a.start - b.start)
        resolve({ subs, audio, chapters, video })
      }
    )
  })
}

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function frameRateOf(value) {
  const match = /^(\d+)(?:\/(\d+))?$/.exec(String(value || ''))
  if (!match) return null
  const rate = Number(match[1]) / (match[2] ? Number(match[2]) : 1)
  return rate > 0 && rate <= 1000 ? rate : null
}

/** Explicit, bounded packet scan. Regular opening/playback never starts it. */
function probeTiming(session) {
  if (session.timing) return Promise.resolve(session.timing)
  if (session.timingPromise) return session.timingPromise
  const epoch = session.epoch || 0
  const pending = (async () => {
    const bin = ffprobePath()
    if (!bin) throw new Error('Zamanlama kontrolü için ffprobe gerekiyor.')
    const media = session.media || await probeMedia(inputOf(session), session.controller?.signal, { localOnly: !!session.localOnly })
    if (session.controller?.signal.aborted || (session.epoch || 0) !== epoch) throw new Error('Kontrol iptal edildi.')
    if (!media.video && !media.audio.length) throw new Error('Kontrol edilebilen görüntü veya ses akışı bulunamadı.')
    const analyzer = createTimingAnalyzer(media)
    const report = await new Promise((resolve, reject) => {
      let child, timer, buffer = '', bytes = 0, completed = false
      const finish = (err) => {
        if (completed) return
        completed = true; clearTimeout(timer)
        if (err) { child?.kill(); reject(err) }
        else {
          try { if (buffer.trim()) analyzer.push(buffer); resolve(analyzer.finish()) }
          catch (error) { reject(error) }
        }
      }
      try {
        child = spawn(bin, ['-v', 'error', ...(session.localOnly ? localProbeArgs() : []), '-show_entries', 'packet=stream_index,pts_time,dts_time,duration_time',
          '-of', 'compact=p=0:nk=0', inputOf(session)], { env: toolEnv(), windowsHide: true, signal: session.controller?.signal })
        timer = setTimeout(() => finish(new Error('Kontrol iki dakika içinde tamamlanamadı.')), 120000)
        child.stdout.on('data', (chunk) => {
          if (completed) return
          bytes += chunk.length
          if (bytes > 96 * 1024 * 1024) return finish(new Error('Dosya kontrol sınırını aştı; tarama durduruldu.'))
          buffer += chunk.toString('utf8')
          try {
            let end
            while ((end = buffer.indexOf('\n')) >= 0) { analyzer.push(buffer.slice(0, end)); buffer = buffer.slice(end + 1) }
            if (buffer.length > 65536) finish(new Error('Dosya zamanlaması okunamadı.'))
          } catch (error) { finish(error) }
        })
        let readError = false
        child.stderr.on('data', (chunk) => { if (String(chunk).trim()) readError = true })
        child.on('error', () => finish(new Error('Zamanlama kontrolü başlatılamadı veya iptal edildi.')))
        child.on('close', (code) => {
          if (code !== 0 || readError || session.controller?.signal.aborted || (session.epoch || 0) !== epoch) finish(new Error('Dosya tamamen okunamadı veya kontrol iptal edildi.'))
          else finish()
        })
      } catch { finish(new Error('Zamanlama kontrolü başlatılamadı.')) }
    })
    if (session.controller?.signal.aborted || (session.epoch || 0) !== epoch) throw new Error('Kontrol iptal edildi.')
    if (!report.packetCount) throw new Error('Dosyada kontrol edilebilen paket bulunamadı.')
    session.timing = report
    return report
  })()
  session.timingPromise = pending
  const clear = () => { if (session.timingPromise === pending) session.timingPromise = null }
  pending.then(clear, clear)
  return pending
}

/** Library inspection shares the player's bounded scanner, without opening it. */
async function inspectFileTiming(file, { signal } = {}) {
  const before = fs.statSync(file)
  if (!before.isFile()) throw new Error('Kontrol edilecek video dosyası bulunamadı.')
  const session = { file, controller: new AbortController(), localOnly: true }
  const abort = () => session.controller.abort()
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  try {
    session.media = await probeMedia(file, session.controller.signal, { localOnly: true })
    const report = await probeTiming(session)
    const after = fs.statSync(file)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Dosya kontrol sırasında değişti. Yeniden kontrol et.')
    return { ...report, checkedAt: Date.now(), fileSize: after.size, fileModifiedAt: after.mtimeMs,
      video: session.media.video,
      audio: session.media.audio.map((track) => ({ language: String(track.language || '').slice(0, 32), codec: track.codec, sampleRate: track.sampleRate })) }
  } finally {
    signal?.removeEventListener('abort', abort)
    releaseSession(session)
  }
}

async function listTracks(session) {
  const epoch = session.epoch || 0
  const media = await probeMedia(inputOf(session), session.controller?.signal)
  if ((session.epoch || 0) !== epoch || session.controller?.signal.aborted) throw new Error('Video değişti veya oynatıcı kapandı.')
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
      cues = await cuesViaFfmpeg(['-i', track.path], session.controller?.signal)
    } else {
      try {
        if (fs.statSync(track.path).size <= 16 * 1024 * 1024) cues = parseCues(decodeText(fs.readFileSync(track.path)))
      } catch {
        cues = []
      }
    }
  } else if (track.kind === 'embedded') {
    cues = await cuesViaFfmpeg(['-i', inputOf(session), '-map', `0:s:${track.streamIndex}`], session.controller?.signal)
  }
  // A fetched track arrives with its cues already attached and never reaches
  // here, because the cache check above answers it first.
  if (session.controller?.signal.aborted || !(session.tracks || []).includes(track)) return []
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
  const epoch = session.epoch || 0
  const file = session.file, title = session.title
  const hash = session.vault ? await hashOfSource(session.source) : null
  if ((session.epoch || 0) !== epoch || session.controller?.signal.aborted) return { ok: false, message: 'Video değişti veya oynatıcı kapandı.' }
  let found
  try {
    found = await subtitles.search({
      filePath: session.vault ? null : file,
      hash,
      title,
      languages: wanted,
      apiKey: settings.subtitleApiKey,
    })
  } catch (err) {
    return { ok: false, message: err.message || String(err) }
  }

  if ((session.epoch || 0) !== epoch || session.controller?.signal.aborted) return { ok: false, message: 'Video değişti veya oynatıcı kapandı.' }

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
  const epoch = session.epoch || 0
  const file = session.file, vaulted = session.vault

  const outcome = await subtitles.apply({
    // A vaulted file's decrypted copy is temporary and its folder is wiped on
    // lock, so nothing is written beside it — the cues go straight to the player.
    videoPath: vaulted ? null : file,
    fileId: hit.fileId,
    language: hit.language,
    hashMatch: hit.hashMatch,
    apiKey: settings.subtitleApiKey,
    sync: !vaulted && settings.syncSubtitles && !hit.hashMatch,
    embedTrack: false,
  })

  if ((session.epoch || 0) !== epoch || session.controller?.signal.aborted) {
    if (vaulted) try { fs.rmSync(outcome.path, { force: true }) } catch { /* best effort */ }
    return { ok: false, message: 'Video değişti veya oynatıcı kapandı.' }
  }

  let cues = []
  try {
    cues = parseCues(decodeText(fs.readFileSync(outcome.path)))
  } catch {
    cues = []
  }
  if (vaulted) {
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
  if (!vaulted) {
    const download = store.getState().downloads.find((d) => d.filePath === file)
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

const publicTrack = (t) => ({ id: t.id, label: t.label, language: t.language, kind: t.kind, forced: !!t.forced })

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
  if (here.season !== null && here.episode !== null) {
    // Episodes of the same show only — a file of another show in the same
    // folder is not "the one before", however the names happen to sort.
    const { nameKey } = require('./locate')
    const show = nameKey(here.title)
    const episodes = names
      .map((name) => ({ name, info: parseName(name) }))
      .filter((e) => e.name !== current && e.info.season !== null && e.info.episode !== null && nameKey(e.info.title) === show)
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
  session.controller = new AbortController()
  session.src = `${SCHEME}://media/${token}`

  // The page reads everything it needs from `player:boot`, so reloading it is
  // the whole switch — no second window, no state left over from the last file.
  win.webContents.reload()
  return { path: target.path }
}

/** Drop the tokens and temp files a session holds. */
function releaseSession(session) {
  session.epoch = (session.epoch || 0) + 1
  session.controller?.abort()
  session.remuxPromise = null
  session.timingPromise = null
  session.timing = null
  for (const t of session.tokens || []) served.delete(t)
  for (const t of session.toolTokens || []) toolServed.delete(t)
  for (const temp of session.temps || []) {
    try {
      fs.unlinkSync(temp)
    } catch {
      /* already gone */
    }
  }
  for (const dir of session.tempDirs || []) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* already gone */ }
  }
  session.tokens = []
  session.toolTokens = []
  session.temps = []
  session.tempDirs = []
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
  if (session.remuxPromise) return session.remuxPromise
  const epoch = session.epoch || 0
  const pending = new Promise((resolve, reject) => {
    const bin = ffmpegPath()
    if (!bin) return reject(new Error('Dönüştürme için ffmpeg gerekiyor.'))
    let dir, timer
    const discard = () => {
      clearTimeout(timer)
      if (dir) try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
      session.tempDirs = (session.tempDirs || []).filter((item) => item !== dir)
    }
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-play-'))
      const out = path.join(dir, 'video.mp4')
      fs.writeFileSync(out, '', { flag: 'wx', mode: 0o600 })
      session.tempDirs ||= []
      session.tempDirs.push(dir)
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
        { env: toolEnv(), windowsHide: true, signal: session.controller?.signal }
      )
      timer = setTimeout(() => child.kill(), 10 * 60 * 1000)
      child.stderr.on('data', () => {})
      child.stdout.on('data', () => {})
      child.on('error', () => { discard(); reject(new Error('Dönüştürme başlatılamadı veya iptal edildi.')) })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0 || session.controller?.signal.aborted || (session.epoch || 0) !== epoch) {
          discard()
          return reject(new Error('Bu dosya dönüştürülemedi. Sistem oynatıcısında açmayı dene.'))
        }
        let valid = false
        try { valid = fs.statSync(out).size > 0 } catch { /* output removed */ }
        if (!valid) { discard(); return reject(new Error('Dönüştürülmüş dosya boş. Sistem oynatıcısında açmayı dene.')) }
        session.temps.push(out)
        const token = tokenFor(out)
        session.tokens.push(token)
        session.src = `${SCHEME}://media/${token}`
        resolve({ src: session.src })
      })
    } catch { discard(); reject(new Error('Dönüştürme başlatılamadı.')) }
  })
  session.remuxPromise = pending
  const clear = () => { if (session.remuxPromise === pending) session.remuxPromise = null }
  pending.then(clear, clear)
  return pending
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
      backgroundThrottling: false,
      // Track selection is already implemented by Chromium but its DOM list is
      // behind this one API flag. No other experimental features are enabled.
      enableBlinkFeatures: 'AudioVideoTracks',
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
  session.controller = new AbortController()
  const win = makeWindow(vault)
  sessions.set(win.webContents.id, session)
  if (vault) vaultWindows.add(win)
  win.on('closed', () => {
    reportToShowTracker(session, false)
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
    key: key || `file:${file}`,
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

const showTracker = createShowTrackerBridge({
  enabled: () => store.getState().settings.showTrackerSync !== false,
  fetchImpl: (url, init) => fetch(url, init),
})

function reportToShowTracker(session, playing) {
  if (session.vault || !Number.isFinite(session.lastSeconds)) return
  const fileName = path.basename(session.file)
  const record = store.getState().downloads.find((d) => d.filePath === session.file)
  showTracker.report(session, {
    title: reportTitle({ ...record, fileName }),
    seconds: session.lastSeconds,
    duration: session.lastDuration,
    playing,
  })
}

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
      mediaInfo: session.media?.video || null,
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
      subtitlesEnabled: false,
    }
  })

  ipcMain.on('player:position', (event, { seconds, duration } = {}) => {
    const session = sessions.get(event.sender.id)
    if (session) store.rememberPosition(session.key, Number(seconds), Number(duration))
    if (session) {
      session.lastSeconds = Number(seconds)
      session.lastDuration = Number(duration)
      reportToShowTracker(session, true)
    }
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

  ipcMain.handle('player:timing', async (event) => probeTiming(sessionOf(event)))

  ipcMain.handle('player:copyDiagnostics', (event, input = {}) => {
    const session = sessionOf(event)
    const stats = {}
    for (const key of ['position', 'duration', 'bufferAhead', 'decodedFrames', 'droppedFrames', 'readyState', 'rate']) {
      if (typeof input?.[key] === 'number' && Number.isFinite(input[key]) && input[key] >= 0 && input[key] < 1e12) stats[key] = input[key]
    }
    // Deliberately omit title, absolute paths, private media tokens and cues.
    clipboard.writeText(JSON.stringify({ video: session.media?.video || null,
      audio: (session.media?.audio || []).map(({ codec, sampleRate }) => ({ codec, sampleRate })),
      playback: stats, timing: session.timing || null }, null, 2))
    return true
  })

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

  ipcMain.on('player:volume', (event, value) => {
    if (!sessions.has(event.sender.id)) return
    const volume = Math.max(0, Math.min(1, Number(value)))
    if (!Number.isFinite(volume)) return
    store.commit((s) => {
      s.settings.playerVolume = volume
    })
  })

  /** Playback preferences that should outlive the window. Validated, never trusted. */
  ipcMain.on('player:prefs', (event, prefs = {}) => {
    if (!sessions.has(event.sender.id) || !prefs || typeof prefs !== 'object') return
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
    sessionOf(event)
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
  probeMedia,
  inspectFileTiming,
  _internals: { listTracks, releaseSession, remux, probeTiming, frameRateOf },
}
