'use strict'

// Finding a subtitle for a file we already have on disk.
//
// The trick that makes this worth doing is OpenSubtitles' movie hash: a 64-bit
// checksum of the file's size and its first and last 64 KiB. A subtitle uploaded
// against the exact same release matches that hash, which means its timings were
// authored for this file — it is in sync without any further work. So we search
// by hash first and only fall back to a title query, where timings are a guess.
//
// When the timings are a guess and ffsubsync is installed, we align the subtitle
// to the film's audio. That is the honest way to "auto-sync": shifting by a fixed
// offset would just move the mismatch around.

const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const { execFile } = require('child_process')
const { toolEnv, ffmpegPath, locate } = require('./binaries')

const API = 'https://api.opensubtitles.com/api/v1'
const APP_UA = 'AllInOneDownloader v0.2'
const CHUNK = 65536

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

/* -------------------------------------------------------------------------- */
/* hashing and name parsing                                                    */
/* -------------------------------------------------------------------------- */

/** OpenSubtitles hash: size + first 64 KiB + last 64 KiB, as 64-bit LE words. */
function movieHash(filePath) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const size = fs.fstatSync(fd).size
    if (size < CHUNK * 2) return null

    const mask = (1n << 64n) - 1n
    let hash = BigInt(size) & mask
    const buffer = Buffer.alloc(CHUNK)

    for (const position of [0, size - CHUNK]) {
      fs.readSync(fd, buffer, 0, CHUNK, position)
      for (let offset = 0; offset + 8 <= CHUNK; offset += 8) {
        hash = (hash + buffer.readBigUInt64LE(offset)) & mask
      }
    }
    return { hash: hash.toString(16).padStart(16, '0'), size }
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* already closed */
      }
    }
  }
}

/** The same hash from the two 64 KiB ends and the size, for a file we cannot open by path. */
function movieHashOf(size, head, tail) {
  if (size < CHUNK * 2 || head.length < CHUNK || tail.length < CHUNK) return null
  const mask = (1n << 64n) - 1n
  let hash = BigInt(size) & mask
  for (const buffer of [head, tail]) {
    for (let offset = 0; offset + 8 <= CHUNK; offset += 8) {
      hash = (hash + buffer.readBigUInt64LE(offset)) & mask
    }
  }
  return { hash: hash.toString(16).padStart(16, '0'), size }
}

/** Pull a title and, for episodes, season/episode numbers out of a filename. */
function parseName(filePath) {
  return parseTitle(path.basename(filePath, path.extname(filePath)))
}

/**
 * The same reading, for a name that is not a file.
 *
 * Worth its own entry point because `path.extname` is wrong for a title: given
 * "Mr. Robot 2. Sezon 1. Bölüm" it calls ". Bölüm" the extension and strips the
 * episode number off the end — and an episode query without an episode number is
 * one no provider can answer, which is exactly how a series ended up with no
 * subtitles at all.
 */
function parseTitle(base) {
  let text = String(base || '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim()

  let season = null
  let episode = null

  const patterns = [
    /\bS(\d{1,2})\s?E(\d{1,3})\b/i,
    /\b(\d{1,2})\s?x\s?(\d{1,3})\b/i,
    /(\d{1,2})\s*\.?\s*sezon\s*(\d{1,3})\s*\.?\s*b[öo]l[üu]m/i,
    /\bsezon\s*(\d{1,2}).*?b[öo]l[üu]m\s*(\d{1,3})/i,
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (m) {
      season = Number(m[1])
      episode = Number(m[2])
      text = text.slice(0, m.index).trim()
      break
    }
  }

  // Strip the usual release noise so the query is just the title.
  const title = text
    .replace(
      /\b(1080p|2160p|720p|480p|4k|uhd|hdr|x264|x265|h264|h265|hevc|av1|web-?dl|webrip|bluray|brrip|hdrip|dvdrip|aac|ac3|dts|10bit|dual|multi|tr|en|turkce|dublaj|altyazi|izle|full|hd)\b.*$/i,
      ''
    )
    .replace(/\(\d{4}\)|\b(19|20)\d{2}\b\s*$/g, (m) => m)
    .replace(/[-–—|]+\s*$/, '')
    .trim()

  const year = (base.match(/\b(19|20)\d{2}\b/) || [])[0] || null
  return { title: title || base, season, episode, year: year ? Number(year) : null }
}

/* -------------------------------------------------------------------------- */
/* provider: opensubtitles.com                                                 */
/* -------------------------------------------------------------------------- */

function headers(apiKey) {
  return {
    'Api-Key': apiKey,
    'User-Agent': APP_UA,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
}

async function request(url, apiKey, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const res = await fetch(url, { ...init, headers: headers(apiKey), signal: controller.signal })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* provider returned prose */
    }
    if (!res.ok) {
      const message =
        (json && (json.message || json.errors?.join(', '))) ||
        (res.status === 401 ? 'API anahtarı geçersiz.' : `Sağlayıcı ${res.status} döndü.`)
      throw new Error(message)
    }
    return json
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Search for subtitles matching a file.
 * Hash matches come first and are flagged, because those are the in-sync ones.
 */
async function search({ filePath, languages, apiKey, title: titleOverride, hash = null }) {
  if (!apiKey) {
    const err = new Error(
      'OpenSubtitles API anahtarı gerekiyor. Ayarlar → Altyazı bölümünden ekle (opensubtitles.com üzerinden ücretsiz alınır).'
    )
    err.code = 'NO_KEY'
    throw err
  }

  const langs = String(languages || 'tr,en')
    .split(',')
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean)
    .join(',')

  // A vaulted film has no path; its caller works the hash out from the decrypted
  // first and last 64 KiB instead and passes it in.
  const hashed = hash || (filePath ? movieHash(filePath) : null)

  // Read the filename when there is one, and the title otherwise — but if the
  // filename yields no episode number and the title does, believe the title. A
  // download named after the page it came from often keeps "3. Bölüm" when the
  // file on disk has already had it trimmed away.
  const parsed = filePath ? parseName(filePath) : parseTitle(titleOverride || '')
  if (!parsed.episode && titleOverride) {
    const fromTitle = parseTitle(titleOverride)
    if (fromTitle.episode) {
      parsed.season = fromTitle.season
      parsed.episode = fromTitle.episode
      if (!parsed.title || parsed.title.length < 2) parsed.title = fromTitle.title
    }
  }

  const results = []
  const seen = new Set()

  const collect = (json, viaHash) => {
    for (const row of (json && json.data) || []) {
      const a = row.attributes || {}
      const file = (a.files || [])[0] || {}
      if (!file.file_id || seen.has(file.file_id)) continue
      seen.add(file.file_id)
      results.push({
        fileId: file.file_id,
        fileName: file.file_name || a.release || 'altyazı.srt',
        language: a.language || '',
        release: a.release || '',
        downloads: Number(a.download_count) || 0,
        hearingImpaired: !!a.hearing_impaired,
        fps: a.fps || null,
        // A hash match was timed against this exact file.
        hashMatch: !!a.moviehash_match || viaHash,
        trusted: !!a.from_trusted,
        machine: !!a.ai_translated || !!a.machine_translated,
        uploader: (a.uploader && a.uploader.name) || '',
      })
    }
  }

  if (hashed) {
    const url = `${API}/subtitles?moviehash=${hashed.hash}&languages=${encodeURIComponent(langs)}`
    try {
      collect(await request(url, apiKey), true)
    } catch (err) {
      if (err.code === 'NO_KEY') throw err
      // A failed hash search shouldn't stop the query search.
    }
  }

  // The parsed title, not the raw one: "Mr Robot" finds the series, while
  // "Mr. Robot 2. Sezon 1. Bölüm" finds nothing at all.
  const query = (parsed.title || titleOverride || '').trim()
  if (query) {
    const params = new URLSearchParams({ query, languages: langs })
    if (parsed.season) params.set('season_number', String(parsed.season))
    if (parsed.episode) params.set('episode_number', String(parsed.episode))
    collect(await request(`${API}/subtitles?${params.toString()}`, apiKey), false)
  }

  // Best to worst, and say why. "Pick one of these forty" is not a choice anyone
  // can make well from release names alone — what actually decides it is whether
  // the timings were authored against this exact file, and after that how many
  // people have kept using it.
  for (const r of results) rate(r)
  results.sort((a, b) => b.score - a.score)
  const ranked = results.slice(0, 40)
  if (ranked.length) ranked[0].recommended = true

  return { results: ranked, parsed, hashed: !!hashed }
}

/** Score a hit and put the reason in words, since the reason is the useful part. */
function rate(hit) {
  let score = 0
  const why = []

  if (hit.hashMatch) {
    score += 1000
    why.push('dosyanla birebir eşleşiyor, senkron')
  }
  if (hit.trusted) {
    score += 60
    why.push('güvenilir yükleyici')
  }
  if (hit.machine) {
    score -= 150
    why.push('makine çevirisi')
  }
  if (hit.hearingImpaired) {
    score -= 15
    why.push('işitme engelli sürümü')
  }
  // Downloads say "this one worked for other people", but the difference between
  // 9 000 and 9 500 says nothing — so it is weighed on a log scale and capped.
  if (hit.downloads > 0) {
    score += Math.min(120, Math.log10(hit.downloads + 1) * 30)
    if (hit.downloads > 500) why.push(`${hit.downloads.toLocaleString('tr-TR')} indirme`)
  }

  hit.score = Math.round(score)
  hit.why = why.join(' · ')
  return hit
}

/** Resolve a file_id to bytes. */
async function fetchSubtitle(fileId, apiKey) {
  const json = await request(`${API}/download`, apiKey, {
    method: 'POST',
    body: JSON.stringify({ file_id: fileId }),
  })
  if (!json || !json.link) throw new Error('Sağlayıcı indirme bağlantısı vermedi.')

  const res = await fetch(json.link, { headers: { 'User-Agent': APP_UA } })
  if (!res.ok) throw new Error(`Altyazı indirilemedi (${res.status}).`)
  let buffer = Buffer.from(await res.arrayBuffer())

  // Some mirrors still hand back gzip.
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      buffer = zlib.gunzipSync(buffer)
    } catch {
      /* not actually gzip */
    }
  }
  return { buffer, fileName: json.file_name || `subtitle-${fileId}.srt`, remaining: json.remaining }
}

/* -------------------------------------------------------------------------- */
/* placing, syncing, embedding                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Where a video's loose subtitle files live: inside the app, not beside the video.
 *
 * A download folder full of `Film.tr.vtt`, `Film.en.srt` and `oynat.html` was the
 * complaint. Subtitles are either muxed into the video itself — which is where
 * every player looks first — or, when that is not possible, kept in a folder of
 * ours keyed by the video's path, where our player finds them and nobody else
 * has to look at them.
 */
function storeDirFor(videoPath) {
  const crypto = require('crypto')
  const { app } = require('electron')
  const id = crypto
    .createHash('sha1')
    .update(path.resolve(String(videoPath)).normalize('NFC'))
    .digest('hex')
  return path.join(app.getPath('userData'), 'subtitles', id)
}

function subtitlePathFor(videoPath, language) {
  const lang = (language || 'sub').toLowerCase().replace(/[^a-z-]/g, '').slice(0, 8) || 'sub'
  const dir = storeDirFor(videoPath)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${lang}.srt`)
}

/** Drop the stored subtitles of a video that is gone or moved into the vault. */
function forgetStored(videoPath) {
  try {
    fs.rmSync(storeDirFor(videoPath), { recursive: true, force: true })
  } catch {
    /* nothing stored */
  }
}

function ffsubsyncPath() {
  return locate('ffsubsync') || locate('subsync') || null
}

/**
 * Align a subtitle to the film's audio. Only worth doing when the subtitle was
 * not a hash match; ffsubsync is optional and absent by default.
 */
function syncToAudio(videoPath, srtPath) {
  return new Promise((resolve) => {
    const bin = ffsubsyncPath()
    if (!bin) return resolve({ ok: false, reason: 'missing' })

    const out = `${srtPath}.synced.srt`
    execFile(
      bin,
      [videoPath, '-i', srtPath, '-o', out],
      { env: toolEnv(), timeout: 300000, windowsHide: true },
      (err) => {
        if (err) return resolve({ ok: false, reason: 'failed' })
        try {
          fs.renameSync(out, srtPath)
          return resolve({ ok: true })
        } catch {
          return resolve({ ok: false, reason: 'failed' })
        }
      }
    )
  })
}

function probeStreams(videoPath) {
  return new Promise((resolve) => {
    const bin = require('./binaries').ffprobePath()
    if (!bin) return resolve(null)
    execFile(
      bin,
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', videoPath],
      { env: toolEnv(), timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, out) => {
        if (err) return resolve(null)
        try {
          resolve(JSON.parse(out).streams || [])
        } catch {
          resolve(null)
        }
      }
    )
  })
}

/** Two-letter to the three-letter tag containers carry. */
const ISO3 = {
  tr: 'tur', en: 'eng', de: 'ger', fr: 'fre', es: 'spa', it: 'ita', pt: 'por', ru: 'rus',
  ar: 'ara', ja: 'jpn', ko: 'kor', zh: 'chi', nl: 'dut', el: 'gre', fa: 'per', hi: 'hin',
  pl: 'pol', sv: 'swe',
}
const iso3 = (lang) => {
  const l = String(lang || '').toLowerCase()
  return ISO3[l.slice(0, 2)] || (l.length === 3 ? l : 'und')
}

/**
 * Mux subtitle files into the video as selectable tracks, in one pass.
 *
 * The language tag is set on the *new* track's index, after the tracks the file
 * already has — tagging `s:0` relabelled the first existing track instead. A
 * track for a language the file already carries is skipped rather than doubled.
 * The streams are copied, never re-encoded, so this takes seconds and the
 * picture is untouched.
 */
async function embedMany(videoPath, subs) {
  const bin = ffmpegPath()
  if (!bin || !subs.length) return { ok: false, reason: 'missing', embedded: [] }

  const ext = path.extname(videoPath).toLowerCase()
  const codec =
    ext === '.mp4' || ext === '.m4v' || ext === '.mov' ? 'mov_text' : ext === '.webm' ? 'webvtt' : 'srt'
  if (!['.mp4', '.m4v', '.mov', '.mkv', '.webm'].includes(ext)) {
    return { ok: false, reason: 'container', embedded: [] }
  }

  const streams = (await probeStreams(videoPath)) || []
  const existing = streams.filter((st) => st.codec_type === 'subtitle')
  const have = new Set(existing.map((st) => String((st.tags && st.tags.language) || '').toLowerCase()))
  const todo = subs.filter((sub) => sub.path && fs.existsSync(sub.path) && !have.has(iso3(sub.lang)))
  if (!todo.length) return { ok: true, embedded: [], already: true }

  const temp = `${videoPath}.aio-subs${ext}`
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', videoPath]
  for (const sub of todo) args.push('-i', sub.path)
  args.push('-map', '0')
  todo.forEach((_, i) => args.push('-map', String(i + 1)))
  args.push('-c', 'copy', '-c:s', codec)
  todo.forEach((sub, i) => {
    args.push(`-metadata:s:s:${existing.length + i}`, `language=${iso3(sub.lang)}`)
  })
  if (codec === 'mov_text') args.push('-movflags', '+faststart')
  args.push(temp)

  const ok = await new Promise((resolve) => {
    execFile(bin, args, { env: toolEnv(), timeout: 900000, windowsHide: true }, (err) => resolve(!err))
  })
  if (!ok || !fs.existsSync(temp) || fs.statSync(temp).size < fs.statSync(videoPath).size * 0.9) {
    fs.rmSync(temp, { force: true })
    return { ok: false, reason: 'failed', embedded: [] }
  }
  try {
    fs.renameSync(temp, videoPath)
  } catch {
    // Windows will not rename over a file something else has open.
    fs.rmSync(temp, { force: true })
    return { ok: false, reason: 'busy', embedded: [] }
  }
  return { ok: true, embedded: todo.map((t) => t.lang) }
}


/**
 * Download a chosen subtitle, put it beside the video, optionally align it to
 * the audio and optionally mux it in.
 */
async function apply({ videoPath, fileId, language, apiKey, sync, embedTrack, hashMatch }) {
  const { buffer } = await fetchSubtitle(fileId, apiKey)

  const target = videoPath
    ? subtitlePathFor(videoPath, language)
    : path.join(os.tmpdir(), `subtitle-${fileId}.srt`)
  // Stored as UTF-8 whatever it arrived as: ffmpeg refuses a Windows code page
  // SRT outright, and that refusal was quietly costing us the embed.
  fs.writeFileSync(target, decodeText(buffer), 'utf8')

  const outcome = { path: target, synced: false, embedded: false, notes: [] }

  // A hash match was authored for this exact file; re-aligning it can only hurt.
  if (sync && videoPath && !hashMatch) {
    const result = await syncToAudio(videoPath, target)
    outcome.synced = result.ok
    if (!result.ok) {
      outcome.notes.push(
        result.reason === 'missing'
          ? 'ffsubsync kurulu değil, hizalama atlandı (pip install ffsubsync).'
          : 'Sese hizalama başarısız oldu, altyazı olduğu gibi bırakıldı.'
      )
    }
  } else if (hashMatch) {
    outcome.notes.push('Dosya imzası birebir eşleşti — altyazı hâlihazırda senkron.')
  }

  // Muxed into the file unless the caller says not to: that is where every
  // player looks first, and it keeps the download folder free of loose .srt and
  // .vtt files. The copy we kept is dropped once it is inside the video, or our
  // own player would list the same subtitle twice.
  if (embedTrack !== false && videoPath) {
    const result = await embedMany(videoPath, [{ path: target, lang: language }])
    outcome.embedded = result.ok
    if (result.ok) {
      fs.rmSync(target, { force: true })
      outcome.path = null
    } else {
      outcome.notes.push('Videoya gömülemedi; altyazı uygulamanın kendi klasöründe saklanıyor ve oynatıcıda görünüyor.')
    }
  }

  return outcome
}

module.exports = {
  search,
  apply,
  movieHash,
  movieHashOf,
  parseName,
  parseTitle,
  subtitlePathFor,
  storeDirFor,
  forgetStored,
  embedMany,
  decodeText,
  ffsubsyncPath,
  iso3,
}
