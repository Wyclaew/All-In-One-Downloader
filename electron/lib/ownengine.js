'use strict'

// Downloading without yt-dlp.
//
// The resolver was always ours; the transfer was not. With yt-dlp switched off in
// settings this module does the fetching instead, using the two things a stream
// actually needs: HTTP for a plain file, and ffmpeg for anything segmented.
//
//   plain file   ranged GET straight to disk. Resumable, byte-exact progress.
//   HLS / DASH   ffmpeg reads the manifest and writes one container. Progress
//                comes from -progress, which reports media time rather than
//                bytes — so the estimate is against the video's own timeline and
//                does not wobble with bitrate.
//
// Quality is chosen the honest way: the master playlist lists its renditions with
// heights, so the variant at or below the requested height is fetched directly
// rather than asking ffmpeg to guess.

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { Readable, Transform } = require('stream')
const { pipeline } = require('stream/promises')
const { toolEnv, ffmpegPath } = require('./binaries')
const {
  fetchHeaders,
  fetchManifest,
  ffprobeHeaderArgs,
  headSize,
  parseHls,
} = require('./mediainfo')
const { safeName } = require('./util')

const AUDIO_CODECS = {
  mp3: ['libmp3lame', '-q:a', '2'],
  m4a: ['aac', '-b:a', '192k'],
  opus: ['libopus', '-b:a', '160k'],
  flac: ['flac'],
  wav: ['pcm_s16le'],
}

/** Thrown when the transfer was stopped on purpose; the caller knows why. */
function abortError() {
  const err = new Error('Aktarım durduruldu.')
  err.code = 'ABORTED'
  return err
}

/* -------------------------------------------------------------------------- */
/* naming                                                                      */
/* -------------------------------------------------------------------------- */

function extensionFor(download, settings, streamUrl, kind) {
  if (download.audioOnly) return settings.audioFormat || 'mp3'
  if (kind === 'file') {
    const guess = (path.extname(new URL(streamUrl, 'http://x').pathname) || '').replace('.', '')
    if (/^(mp4|webm|m4v|mkv|mov|flv|ts)$/i.test(guess)) return guess.toLowerCase()
  }
  // Copying segments into webm is not possible for h264/aac, which is most of the
  // web; mkv takes anything, mp4 is what people expect. Nothing else is safe.
  return settings.container === 'mkv' ? 'mkv' : 'mp4'
}

/** A free path in the download folder, so a second run never overwrites the first. */
function freePath(dir, base, ext) {
  let candidate = path.join(dir, `${base}.${ext}`)
  let n = 2
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${base} (${n++}).${ext}`)
  return candidate
}

/* -------------------------------------------------------------------------- */
/* stream selection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Turn a download into a concrete stream: its URL, the headers it needs, and what
 * shape it is. A download made from a resolved item already carries all of this;
 * a bare page URL is resolved here, because without yt-dlp nothing else will.
 */
async function locateStream(download, settings, onNote) {
  if (download.resolved && download.url) {
    return { url: download.url, resolved: download.resolved, kind: download.resolved.kind || 'file' }
  }

  const { resolvePage } = require('./resolver')
  const { exportCookieJar } = require('./browsers')
  const { settingNumber } = require('./util')

  onNote?.('sayfa çözümleniyor')
  let browserCookieJar = null
  if (settings.cookiesBrowser) {
    browserCookieJar = await exportCookieJar(settings.cookiesBrowser).catch(() => null)
  }

  const result = await resolvePage(download.url, {
    browserCookieJar,
    blockRules: {
      extraBlockedHosts: settings.extraBlockedHosts,
      blockTrackers: settings.blockTrackers,
    },
    minStreamSeconds: settingNumber(settings.minStreamSeconds, 120),
    timeoutMs: Math.max(8000, settingNumber(settings.resolverTimeout, 45000)),
    onProgress: (message) => onNote?.(message),
  })

  const candidate = (result && result.candidates && result.candidates[0]) || null
  if (!candidate) {
    throw new Error(
      'Bu bağlantıda indirilebilir bir akış bulunamadı. yt-dlp kapalı olduğu için yalnızca kendi çözümleyicim denendi.'
    )
  }
  if (candidate.info && candidate.info.drm) {
    throw new Error('Bu akış DRM korumalı — indirilemez.')
  }

  return {
    url: candidate.url,
    kind: candidate.kind,
    resolved: {
      pageUrl: download.url,
      referer: candidate.referer || download.url,
      origin: candidate.origin || '',
      userAgent: result.userAgent,
      cookieFile: candidate.cookieFile || null,
      kind: candidate.kind,
    },
  }
}

/**
 * Swap a master playlist for the rendition the user asked for. Falls back to the
 * playlist itself when there is nothing to choose between.
 */
async function pickVariant(url, resolved, quality, onNote) {
  const { text, finalUrl } = await fetchManifest(url, resolved)
  if (!text || !/#EXTM3U/i.test(text)) return { url, height: null }
  const hls = parseHls(text, finalUrl)
  if (!hls.variants.length) return { url, height: null }

  // Sorted tallest first. A master playlist can also list a rendition with no
  // RESOLUTION at all — an audio-only one — and that must never be what "best"
  // or a failed cap lands on.
  const video = hls.variants.filter((v) => v.height)
  const ranked = video.length ? video : hls.variants
  const cap = Number(quality) || 0

  let chosen
  if (!cap) {
    chosen = ranked[0]
  } else {
    chosen = ranked.find((v) => (v.height || 0) <= cap) || ranked[ranked.length - 1]
  }

  if (chosen.height && chosen.height !== ranked[0].height) {
    onNote?.(`${chosen.height}p akış seçildi`)
  }
  return { url: chosen.url || url, height: chosen.height || null }
}

/* -------------------------------------------------------------------------- */
/* plain file over HTTP                                                        */
/* -------------------------------------------------------------------------- */

async function fetchFile({ url, resolved, destPath, onProgress, onHandle }) {
  const partPath = `${destPath}.part`
  let already = 0
  try {
    already = fs.statSync(partPath).size
  } catch {
    /* nothing to resume */
  }

  const controller = new AbortController()
  let stopped = false
  onHandle({
    kill() {
      stopped = true
      controller.abort()
    },
  })

  const headers = { ...fetchHeaders(url, resolved) }
  if (already > 0) headers.Range = `bytes=${already}-`

  const res = await fetch(url, { redirect: 'follow', headers, signal: controller.signal }).catch(
    (err) => {
      if (stopped) throw abortError()
      throw err
    }
  )
  if (!res.ok && res.status !== 206) {
    throw new Error(`Sunucu ${res.status} döndü.`)
  }

  // A redirect to a login wall or an error page answers 200 with HTML. Copying
  // those bytes would produce a .mp4 that is really a web page — saved, listed as
  // finished, and unplayable.
  const type = (res.headers.get('content-type') || '').toLowerCase()
  if (/^(text\/|application\/(x?html|json|xml))/.test(type)) {
    try {
      await res.body?.cancel()
    } catch {
      /* already closed */
    }
    throw new Error(`Bağlantı video değil, ${type.split(';')[0]} döndürdü — akış adresi geçmiş olabilir.`)
  }

  // A server that ignores Range restarts the file; keeping the old bytes would
  // corrupt it, so start over rather than append.
  let resuming = already > 0 && res.status === 206
  if (already > 0 && !resuming) already = 0

  // No Content-Length means no total. Adding what we already have to a zero would
  // report the part we resumed from as the whole file — a meter stuck at 100%.
  const declared = Number(res.headers.get('content-length')) || 0
  const total = declared ? (resuming ? already + declared : declared) : null

  const out = fs.createWriteStream(partPath, { flags: resuming ? 'a' : 'w' })
  let downloaded = already
  let lastAt = Date.now()
  let lastBytes = downloaded

  // Count inside the pipeline rather than on a 'data' listener: subscribing to
  // 'data' starts the stream flowing before pipeline has hooked up the sink, and
  // the first chunks go on the floor.
  const report = () => {
    const now = Date.now()
    const span = now - lastAt
    const speed = span > 0 ? ((downloaded - lastBytes) * 1000) / span : null
    lastAt = now
    lastBytes = downloaded
    onProgress({
      downloaded,
      total,
      // Content-Length is a real length, not a guess — say so, so the caller
      // doesn't second-guess it with an estimate.
      totalExact: !!total,
      speed,
      eta: total && speed > 0 ? Math.round((total - downloaded) / speed) : null,
      percent: total ? downloaded / total : null,
    })
  }

  const meter = new Transform({
    transform(chunk, _enc, done) {
      downloaded += chunk.length
      if (Date.now() - lastAt >= 400) report()
      done(null, chunk)
    },
    // A small file can finish inside one reporting window, which would leave the
    // meter showing nothing at all. Report once more on the way out.
    flush(done) {
      report()
      done()
    },
  })

  try {
    await pipeline(Readable.fromWeb(res.body), meter, out)
  } catch (err) {
    if (stopped) throw abortError()
    throw err
  }

  fs.renameSync(partPath, destPath)
  return destPath
}

/* -------------------------------------------------------------------------- */
/* segmented streams through ffmpeg                                            */
/* -------------------------------------------------------------------------- */

/**
 * ffmpeg picks its output format from the file extension, and we write to a
 * `.part` file, so the muxer has to be named outright.
 */
const MUXERS = {
  mp4: 'mp4',
  m4v: 'mp4',
  mkv: 'matroska',
  webm: 'webm',
  mov: 'mov',
  flv: 'flv',
  ts: 'mpegts',
  mp3: 'mp3',
  m4a: 'ipod',
  opus: 'opus',
  flac: 'flac',
  wav: 'wav',
}

function ffmpegArgs({ url, resolved, destPath, workPath, download, settings }) {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-progress',
    'pipe:1',
    '-rw_timeout',
    '20000000',
    ...ffprobeHeaderArgs(url, resolved),
    '-i',
    url,
  ]

  if (download.audioOnly) {
    const codec = AUDIO_CODECS[settings.audioFormat] || AUDIO_CODECS.mp3
    args.push('-vn', '-c:a', ...codec)
  } else {
    // Copy, never re-encode: a transcode of a two-hour film would take longer
    // than the download and lose quality doing it.
    args.push('-c', 'copy')
  }

  const ext = path.extname(destPath).replace('.', '').toLowerCase()
  if (ext === 'mp4') args.push('-movflags', '+faststart')
  args.push('-f', MUXERS[ext] || 'mp4', workPath)
  return args
}

function runFfmpeg({ url, resolved, destPath, workPath, download, settings, onProgress, onHandle }) {
  return new Promise((resolve, reject) => {
    const bin = ffmpegPath()
    if (!bin) return reject(new Error('ffmpeg bulunamadı. yt-dlp kapalıyken indirme ona dayanır.'))

    const child = spawn(
      bin,
      ffmpegArgs({ url, resolved, destPath, workPath, download, settings }),
      { env: toolEnv(), windowsHide: true }
    )
    onHandle(child)

    const duration = Number(download.duration) || 0
    let buffer = ''
    let stderr = ''
    let lastBytes = 0
    let lastAt = Date.now()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      const fields = {}
      for (const line of lines) {
        const [rawKey, rawValue] = line.split('=')
        if (rawKey && rawValue !== undefined) fields[rawKey.trim()] = rawValue.trim()
      }
      if (!Object.keys(fields).length) return

      const outSeconds = Number(fields.out_time_us || fields.out_time_ms || 0) / 1e6
      const bytes = Number(fields.total_size) || 0
      const now = Date.now()
      const elapsed = now - lastAt
      const speed = elapsed > 0 && bytes > lastBytes ? ((bytes - lastBytes) * 1000) / elapsed : null
      if (bytes > lastBytes) {
        lastBytes = bytes
        lastAt = now
      }

      const percent = duration && outSeconds ? Math.min(0.999, outSeconds / duration) : null
      // ffmpeg says "1.7x", meaning it is writing 1.7 seconds of video per second.
      // Remaining media time divided by that rate is the truest estimate here.
      const rate = parseFloat(String(fields.speed || '').replace('x', ''))
      let eta = null
      if (duration && outSeconds && Number.isFinite(rate) && rate > 0.01) {
        eta = Math.round((duration - outSeconds) / rate)
      }

      onProgress({
        downloaded: bytes,
        // Extrapolated from how much of the timeline is done, so it is wild for
        // the first few percent. Flagged as inexact; the caller has a better
        // figure from the manifest and should prefer it.
        total: percent > 0.05 && bytes ? Math.round(bytes / percent) : null,
        totalExact: false,
        speed,
        eta,
        percent,
      })
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000)
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        try {
          fs.renameSync(workPath, destPath)
        } catch (err) {
          return reject(err)
        }
        return resolve(destPath)
      }
      // ffmpeg output cannot be resumed, so a stopped transfer leaves nothing
      // behind to be confused with a finished file.
      try {
        fs.rmSync(workPath, { force: true })
      } catch {
        /* fine */
      }
      const line = stderr
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .pop()
      const err = new Error(line || `ffmpeg ${code} koduyla çıktı.`)
      err.exitCode = code
      reject(err)
    })
  })
}

/* -------------------------------------------------------------------------- */
/* public                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Fetch one download without yt-dlp. Resolves with the finished file's path;
 * rejects with an ABORTED error when the caller killed it.
 */
async function transfer({
  download,
  settings,
  onProgress,
  onHandle,
  onStage,
  onNote,
  onDest,
  isStopped,
}) {
  // Resolving a gated page can take most of a minute, and during that stretch
  // there is no process to kill — so pause and cancel are checked at each phase
  // boundary instead of being silently ignored until the first byte moves.
  const halt = () => {
    if (isStopped && isStopped()) throw abortError()
  }

  const located = await locateStream(download, settings, onNote)
  halt()
  let { url } = located
  const { resolved, kind } = located

  if (kind === 'hls' && !download.audioOnly) {
    const picked = await pickVariant(url, resolved, download.quality, onNote)
    url = picked.url
    halt()
  }

  const dir = settings.downloadDir
  fs.mkdirSync(dir, { recursive: true })
  const base = safeName(download.title || 'video')
  const destPath = freePath(dir, base, extensionFor(download, settings, url, kind))
  // Tell the caller where we are writing, so a cancelled transfer can clean up
  // after itself the same way the yt-dlp path does.
  onDest?.(destPath)

  onStage?.('downloading')

  // A plain file is a byte copy, and a byte copy can be resumed. Anything
  // segmented has to be assembled, and only ffmpeg does that properly.
  const plain = kind === 'file' && !download.audioOnly
  if (plain) {
    // Ask for the length first so the meter has a target from the first byte.
    const size = await headSize(url, resolved).catch(() => null)
    halt()
    if (size) {
      onProgress({ downloaded: 0, total: size, totalExact: true, speed: null, eta: null, percent: 0 })
    }
    return { filePath: await fetchFile({ url, resolved, destPath, onProgress, onHandle }) }
  }

  const filePath = await runFfmpeg({
    url,
    resolved,
    destPath,
    workPath: `${destPath}.part`,
    download,
    settings,
    onProgress,
    onHandle,
  })
  return { filePath }
}

module.exports = { transfer, pickVariant }
