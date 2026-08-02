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
const APP_UA = 'EverythingDownloader v0.1'
const CHUNK = 65536

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

/** Pull a title and, for episodes, season/episode numbers out of a filename. */
function parseName(filePath) {
  const base = path.basename(filePath, path.extname(filePath))
  let text = base.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim()

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
async function search({ filePath, languages, apiKey, title: titleOverride }) {
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

  const hashed = filePath ? movieHash(filePath) : null
  const parsed = filePath ? parseName(filePath) : { title: titleOverride || '', season: null, episode: null }
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

  const query = (titleOverride || parsed.title || '').trim()
  if (query) {
    const params = new URLSearchParams({ query, languages: langs })
    if (parsed.season) params.set('season_number', String(parsed.season))
    if (parsed.episode) params.set('episode_number', String(parsed.episode))
    collect(await request(`${API}/subtitles?${params.toString()}`, apiKey), false)
  }

  // In-sync first, then by how many people have used it.
  results.sort((a, b) => Number(b.hashMatch) - Number(a.hashMatch) || b.downloads - a.downloads)
  return { results: results.slice(0, 40), parsed, hashed: !!hashed }
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

/** `<video>.<lang>.srt` beside the video, which is what players look for. */
function subtitlePathFor(videoPath, language) {
  const dir = path.dirname(videoPath)
  const base = path.basename(videoPath, path.extname(videoPath))
  const lang = (language || 'sub').toLowerCase().slice(0, 5)
  return path.join(dir, `${base}.${lang}.srt`)
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

/** Mux the subtitle into the container as a selectable track. */
function embed(videoPath, srtPath, language) {
  return new Promise((resolve) => {
    const bin = ffmpegPath()
    if (!bin) return resolve({ ok: false, reason: 'missing' })

    const ext = path.extname(videoPath).toLowerCase()
    const codec = ext === '.mp4' || ext === '.m4v' || ext === '.mov' ? 'mov_text' : 'srt'
    const temp = `${videoPath}.subbed${ext || '.mkv'}`

    execFile(
      bin,
      [
        '-y',
        '-i',
        videoPath,
        '-i',
        srtPath,
        '-map',
        '0',
        '-map',
        '1',
        '-c',
        'copy',
        '-c:s',
        codec,
        '-metadata:s:s:0',
        `language=${(language || 'und').slice(0, 3)}`,
        temp,
      ],
      { env: toolEnv(), timeout: 600000, windowsHide: true },
      (err) => {
        if (err) {
          try {
            fs.unlinkSync(temp)
          } catch {
            /* nothing to clean */
          }
          return resolve({ ok: false, reason: 'failed' })
        }
        try {
          fs.renameSync(temp, videoPath)
          resolve({ ok: true })
        } catch {
          resolve({ ok: false, reason: 'failed' })
        }
      }
    )
  })
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
  fs.writeFileSync(target, buffer)

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

  if (embedTrack && videoPath) {
    const result = await embed(videoPath, target, language)
    outcome.embedded = result.ok
    if (!result.ok) outcome.notes.push('Videoya gömme başarısız oldu; .srt dosyası yanında duruyor.')
  }

  return outcome
}

module.exports = { search, apply, movieHash, parseName, subtitlePathFor, ffsubsyncPath }
