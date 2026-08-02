'use strict'

// The transfer queue. One yt-dlp process per download, progress read from a
// machine-readable --progress-template so we never scrape the pretty progress bar.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { Notification } = require('electron')
const store = require('./store')
const { toolEnv, ytdlpPathOrThrow, ffmpegPath } = require('./binaries')
const { resolveCookieArg } = require('./browsers')
const { uid, num, clamp, fileSizeOf, resolvedArgs, safeName } = require('./util')
const { readableError, isCookieFailure } = require('./probe')

const TAG = '@P@'
const PROGRESS_TEMPLATE =
  `download:${TAG}%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s` +
  `|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s` +
  `|%(progress.fragment_index)s|%(progress.fragment_count)s`

/** id -> { child, paused, canceled, destinations:Set, printFile } */
const jobs = new Map()
const progressLastSent = new Map()

function activeCount() {
  return store.getState().downloads.filter((d) => d.status === 'running').length
}

function formatSelector(download) {
  if (download.audioOnly) return 'ba/b'
  const h = Number(download.quality) || 0
  if (!h) return 'bv*+ba/b'
  return `bv*[height<=${h}]+ba/b[height<=${h}]/bv*[height<=${h}]/b[height<=${h}]/bv*+ba/b`
}

function buildArgs(download, settings, printFile) {
  const args = [
    '--ignore-config',
    '--no-warnings',
    '--newline',
    '--progress',
    '--no-quiet',
    '--progress-delta',
    '0.3',
    '--progress-template',
    PROGRESS_TEMPLATE,
    '--print-to-file',
    'after_move:filepath',
    printFile,
    '--no-playlist',
    '--continue',
    '--retries',
    '5',
    '--fragment-retries',
    '15',
    '--socket-timeout',
    '20',
    '--no-mtime',
    '-P',
    settings.downloadDir,
    '-o',
    // A resolved stream has no metadata title — `master.m3u8` would become the
    // filename — so name the file after the page we found it on.
    download.resolved
      ? `${safeName(download.title)}.%(ext)s`
      : settings.filenameTemplate || '%(title).120B.%(ext)s',
  ]

  const ff = ffmpegPath()
  if (ff) args.push('--ffmpeg-location', ff)

  if (download.resolved) {
    // The page's own headers and cookies; a browser-profile cookie jar would be
    // the wrong origin here.
    args.push(...resolvedArgs(download.resolved))
  } else if (settings.cookiesBrowser && !download.noCookies) {
    const cookies = resolveCookieArg(settings.cookiesBrowser)
    if (cookies) args.push('--cookies-from-browser', cookies)
  }
  if (settings.rateLimit) args.push('--limit-rate', String(settings.rateLimit))

  args.push('-f', formatSelector(download))

  if (download.audioOnly) {
    args.push('-x', '--audio-format', settings.audioFormat || 'mp3', '--audio-quality', '0')
  } else if (settings.container && settings.container !== 'auto') {
    args.push('--merge-output-format', settings.container)
  }

  if (settings.embedThumbnail) args.push('--embed-thumbnail')
  if (settings.embedMetadata) args.push('--embed-metadata')
  if (settings.writeSubs) {
    args.push('--write-subs', '--write-auto-subs', '--sub-langs', settings.subLangs || 'tr,en')
    if (!download.audioOnly) args.push('--embed-subs')
  }

  args.push(download.url)
  return args
}

/** Progress is high-frequency, so it rides its own channel instead of a full state broadcast. */
function sendProgress(download, force = false) {
  const now = Date.now()
  const last = progressLastSent.get(download.id) || 0
  if (!force && now - last < 180) return
  progressLastSent.set(download.id, now)
  store.send('progress', {
    id: download.id,
    status: download.status,
    stage: download.stage,
    percent: download.percent,
    speed: download.speed,
    eta: download.eta,
    downloaded: download.downloaded,
    total: download.total,
    phase: download.phase,
    phases: download.phases,
  })
}

function parseProgressLine(line, job, download) {
  const raw = line.slice(line.indexOf(TAG) + TAG.length)
  const [status, dl, total, totalEst, speed, eta, fragIndex, fragCount] = raw.split('|')

  const downloaded = num(dl) || 0
  const knownTotal = num(total) || num(totalEst)
  const fi = num(fragIndex)
  const fc = num(fragCount)

  if (status === 'finished') {
    job.prevBytes += knownTotal || downloaded
    job.phase = Math.min(job.phase + 1, job.phases)
    download.stage = job.phase >= job.phases ? 'processing' : 'downloading'
    download.speed = null
    download.eta = null
    sendProgress(download, true)
    return
  }

  download.stage = 'downloading'
  download.speed = num(speed)
  download.eta = num(eta)
  download.downloaded = job.prevBytes + downloaded
  download.phase = job.phase
  download.phases = job.phases

  let percent = null
  if (knownTotal) {
    // The audio track of a merged download is a small tail; pad the estimate so
    // the meter doesn't hit 100% and then sit there.
    const tail = job.phase < job.phases ? knownTotal * 0.07 : 0
    const est = job.prevBytes + knownTotal + tail
    download.total = est
    percent = est > 0 ? (job.prevBytes + downloaded) / est : null
  } else if (fc) {
    percent = (job.phase - 1 + fi / fc) / job.phases
    download.total = null
  }

  if (percent === null) {
    download.percent = null
  } else {
    // Never let the meter walk backwards: the audio stream of a merge restarts
    // byte counting, and a dropping bar reads as a bug.
    const next = clamp(percent, 0, 0.999)
    job.maxPercent = Math.max(job.maxPercent, next)
    download.percent = job.maxPercent
  }
  sendProgress(download)
}

// "Downloading 1 format(s): 399+251" — the count is format groups, but a '+'
// spec means two separate downloads, so count the streams in the spec instead.
const RE_TOTAL_FORMATS = /Downloading\s+\d+\s+format\(s\):\s*(\S+)/i
const RE_DESTINATION = /^\[(?:download|ExtractAudio|Merger)\]\s+Destination:\s*(.+)$/
const RE_MERGING = /^\[Merger\] Merging formats into "(.+)"$/
const RE_ALREADY = /^\[download\]\s+(.+?)\s+has already been downloaded/
const RE_MOVING = /^\[MoveFiles\] Moving file .* to "(.+)"$/
const RE_POST = /^\[(ExtractAudio|EmbedThumbnail|Metadata|FixupM4a|FixupM3u8|VideoConvertor|EmbedSubtitle|SponsorBlock)\]/

function handleLine(line, job, download) {
  if (!line) return
  if (line.includes(TAG)) {
    parseProgressLine(line, job, download)
    return
  }

  const formats = line.match(RE_TOTAL_FORMATS)
  if (formats) {
    job.phases = Math.max(1, formats[1].split(/[+,]/).filter(Boolean).length)
    download.phases = job.phases
  }

  const dest = line.match(RE_DESTINATION)
  if (dest) job.destinations.add(dest[1].trim())

  const merging = line.match(RE_MERGING)
  if (merging) {
    job.destinations.add(merging[1].trim())
    download.stage = 'merging'
    download.speed = null
    download.eta = null
    sendProgress(download, true)
  }

  const moving = line.match(RE_MOVING)
  if (moving) job.destinations.add(moving[1].trim())

  const already = line.match(RE_ALREADY)
  if (already) {
    job.alreadyPath = already[1].trim()
    download.percent = 1
  }

  if (RE_POST.test(line)) {
    download.stage = 'processing'
    download.speed = null
    download.eta = null
    sendProgress(download, true)
  }

  if (/^ERROR:/i.test(line)) job.errorLines.push(line)
}

function resolveFinalPath(job, settings) {
  const candidates = []
  try {
    const printed = fs.readFileSync(job.printFile, 'utf8').trim()
    if (printed) candidates.push(...printed.split('\n').map((l) => l.trim()).filter(Boolean))
  } catch {
    /* nothing printed */
  }
  if (job.alreadyPath) candidates.push(job.alreadyPath)
  candidates.push(...[...job.destinations].reverse())

  for (const c of candidates) {
    const abs = path.isAbsolute(c) ? c : path.resolve(settings.downloadDir, c)
    if (fs.existsSync(abs)) return abs
    // Post-processing changes the extension (webm -> mp4, m4a -> mp3).
    const dir = path.dirname(abs)
    const base = path.basename(abs, path.extname(abs))
    try {
      const sibling = fs
        .readdirSync(dir)
        .find((f) => f.startsWith(base) && !f.endsWith('.part') && !f.endsWith('.ytdl'))
      if (sibling) return path.join(dir, sibling)
    } catch {
      /* dir gone */
    }
  }
  return null
}

function cleanupTemp(job) {
  try {
    fs.unlinkSync(job.printFile)
  } catch {
    /* fine */
  }
}

function deletePartials(job, settings) {
  for (const c of job.destinations) {
    const abs = path.isAbsolute(c) ? c : path.resolve(settings.downloadDir, c)
    for (const p of [`${abs}.part`, `${abs}.ytdl`, abs]) {
      try {
        fs.unlinkSync(p)
      } catch {
        /* nothing to remove */
      }
    }
  }
}

function start(downloadId) {
  const download = store.findDownload(downloadId)
  if (!download || jobs.has(downloadId)) return
  const settings = store.getState().settings

  let bin
  try {
    bin = ytdlpPathOrThrow()
  } catch {
    store.commit(() => {
      download.status = 'error'
      download.error = 'yt-dlp bulunamadı. Ayarlar → Araçlar bölümünden kontrol et.'
    })
    return
  }

  try {
    store.ensureDownloadDir()
  } catch (err) {
    store.commit(() => {
      download.status = 'error'
      download.error = `İndirme klasörü oluşturulamadı: ${err.message}`
    })
    return
  }

  const printFile = path.join(os.tmpdir(), `edl-${download.id}-${Date.now()}.txt`)
  const job = {
    child: null,
    printFile,
    paused: false,
    canceled: false,
    destinations: new Set(),
    errorLines: [],
    prevBytes: 0,
    phase: 1,
    phases: 1,
    maxPercent: 0,
    alreadyPath: null,
    stderrTail: '',
  }
  jobs.set(download.id, job)

  store.commit(() => {
    download.status = 'running'
    download.stage = 'starting'
    download.error = null
    download.startedAt = download.startedAt || Date.now()
    download.attempts = (download.attempts || 0) + 1
    download.percent = download.percent && download.percent < 1 ? download.percent : 0
    download.phase = 1
    download.phases = 1
  })
  sendProgress(download, true)

  const args = buildArgs(download, settings, printFile)
  const child = spawn(bin, args, { env: toolEnv(), windowsHide: true })
  job.child = child

  const pump = (stream) => {
    let buffer = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      buffer += chunk
      // yt-dlp uses \r for in-place progress even with --newline in some paths.
      const parts = buffer.split(/\r\n|\n|\r/)
      buffer = parts.pop() || ''
      for (const line of parts) handleLine(line.trim(), job, download)
    })
    stream.on('end', () => {
      if (buffer.trim()) handleLine(buffer.trim(), job, download)
    })
  }
  pump(child.stdout)
  pump(child.stderr)
  child.stderr.on('data', (chunk) => {
    job.stderrTail = (job.stderrTail + chunk).slice(-8000)
  })

  child.on('error', (err) => {
    store.commit(() => {
      download.status = 'error'
      download.error = err.message
      download.stage = null
    })
    jobs.delete(download.id)
    cleanupTemp(job)
    pump_queue()
  })

  child.on('close', (code) => {
    jobs.delete(download.id)

    if (job.canceled) {
      deletePartials(job, settings)
      cleanupTemp(job)
      store.commit(() => {
        download.status = 'canceled'
        download.stage = null
        download.speed = null
        download.eta = null
      })
      sendProgress(download, true)
      pump_queue()
      return
    }

    if (job.paused) {
      cleanupTemp(job)
      store.commit(() => {
        download.status = 'paused'
        download.stage = null
        download.speed = null
        download.eta = null
      })
      sendProgress(download, true)
      pump_queue()
      return
    }

    if (code === 0) {
      const finalPath = resolveFinalPath(job, settings)
      cleanupTemp(job)
      store.commit(() => {
        download.status = 'done'
        download.stage = null
        download.percent = 1
        download.speed = null
        download.eta = null
        download.filePath = finalPath
        download.fileSize = finalPath ? fileSizeOf(finalPath) : null
        download.finishedAt = Date.now()
        download.error = finalPath ? null : 'İndirildi ama dosya yolu bulunamadı.'
      })
      sendProgress(download, true)
      store.send('finished', { id: download.id, title: download.title })
      if (settings.autoFetchSubtitles && finalPath) {
        autoSubtitles(download, finalPath, settings).catch(() => {})
      }
      if (settings.notifyOnFinish && Notification.isSupported()) {
        new Notification({ title: 'İndirme tamamlandı', body: download.title || '' }).show()
      }
    } else {
      const message = job.errorLines.length
        ? readableError(job.errorLines.join('\n'), code)
        : readableError(job.stderrTail, code)
      cleanupTemp(job)

      // Same rule as probing: a bad cookie setting gets one silent retry
      // without cookies rather than failing the transfer outright.
      if (!download.noCookies && settings.cookiesBrowser && isCookieFailure(job.stderrTail || message)) {
        store.commit(() => {
          download.noCookies = true
          download.status = 'queued'
          download.error = null
        })
        store.toast(`${message} Çerezsiz yeniden denendi.`, 'warn')
        pump_queue()
        return
      }

      store.commit(() => {
        download.status = 'error'
        download.stage = null
        download.speed = null
        download.eta = null
        download.error = message
      })
      sendProgress(download, true)
    }
    pump_queue()
  })
}

/**
 * Best-effort subtitle right after a download. Only takes a hash match — those
 * were timed against this exact file, so they need no alignment and can't be
 * the wrong release. Anything less certain is left for the user to choose.
 */
async function autoSubtitles(download, filePath, settings) {
  const subtitles = require('./subtitles')
  const { audioLanguages, normaliseLanguage } = require('./mediainfo')

  let wanted = String(settings.subtitleLangs || 'tr,en')
    .split(',')
    .map((l) => normaliseLanguage(l) || l.trim().toLowerCase())
    .filter(Boolean)

  // Subtitling a Turkish video in Turkish is noise. Drop any language the file
  // already speaks — from the file's own audio tags first, then whatever the
  // extractor told us. An untagged file means "unknown", so nothing is dropped.
  if (settings.skipSameLanguageSubtitles !== false) {
    const spoken = new Set(await audioLanguages(filePath))
    const declared = normaliseLanguage(download.language)
    if (declared) spoken.add(declared)
    if (spoken.size) {
      const before = wanted.length
      wanted = wanted.filter((l) => !spoken.has(l))
      if (!wanted.length) {
        store.toast(
          `Altyazı atlandı: video zaten ${[...spoken].join(', ')} dilinde.`,
          'info'
        )
        return
      }
      if (wanted.length < before) {
        store.commit(() => {
          download.audioLanguage = [...spoken][0]
        })
      }
    }
  }

  let found
  try {
    found = await subtitles.search({
      filePath,
      title: download.title,
      languages: settings.subtitleLangs,
      apiKey: settings.subtitleApiKey,
    })
  } catch (err) {
    if (err && err.code === 'NO_KEY') return
    store.toast(`Altyazı aranamadı: ${err.message}`, 'warn')
    return
  }

  let pick = null
  for (const lang of wanted) {
    pick = found.results.find((r) => r.hashMatch && r.language.toLowerCase() === lang)
    if (pick) break
  }
  if (!pick) return

  try {
    const outcome = await subtitles.apply({
      videoPath: filePath,
      fileId: pick.fileId,
      language: pick.language,
      hashMatch: true,
      apiKey: settings.subtitleApiKey,
      sync: false,
      embedTrack: settings.embedSubtitleFile,
    })
    store.commit(() => {
      download.subtitlePath = outcome.path
      download.subtitleLanguage = pick.language
    })
    store.toast(`Altyazı eklendi (${pick.language}): ${download.title}`, 'ok')
  } catch (err) {
    store.toast(`Altyazı eklenemedi: ${err.message}`, 'warn')
  }
}

/** Start queued transfers up to the concurrency limit. */
function pump_queue() {
  const state = store.getState()
  const limit = Math.max(1, Number(state.settings.concurrency) || 1)
  let free = limit - activeCount()
  if (free <= 0) return
  for (const d of state.downloads) {
    if (free <= 0) break
    if (d.status === 'queued' && !jobs.has(d.id)) {
      start(d.id)
      free -= 1
    }
  }
}

/** Create a download for a media item (or plain URL) and queue it. */
function enqueue({ item, url, title, site, sourceId, quality, audioOnly, categoryId }) {
  const settings = store.getState().settings
  const download = {
    id: uid('dl'),
    itemId: item ? item.id : null,
    sourceId: sourceId || (item ? item.sourceId : null),
    url: url || (item ? item.url : ''),
    title: title || (item ? item.title : url),
    site: site || (item ? item.site : ''),
    thumbnail: item ? item.thumbnail : null,
    duration: item ? item.duration : null,
    resolved: item && item.resolved ? item.resolved : null,
    language: item && item.language ? item.language : null,
    quality: quality === undefined ? settings.defaultQuality : Number(quality) || 0,
    audioOnly: !!audioOnly,
    categoryId: categoryId || null,
    noCookies: false,
    status: 'queued',
    stage: null,
    percent: 0,
    downloaded: 0,
    total: null,
    speed: null,
    eta: null,
    phase: 1,
    phases: 1,
    attempts: 0,
    filePath: null,
    fileSize: null,
    error: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
  }

  store.commit((s) => {
    s.downloads.unshift(download)
    if (item) {
      const live = store.findItem(item.id)
      if (live) live.downloadId = download.id
    }
  })

  if (settings.autoStartDownloads) pump_queue()
  return download
}

function pause(id) {
  const job = jobs.get(id)
  const download = store.findDownload(id)
  if (!download) return
  if (!job) {
    if (download.status === 'queued') {
      store.commit(() => {
        download.status = 'paused'
      })
    }
    return
  }
  job.paused = true
  try {
    job.child.kill(process.platform === 'win32' ? undefined : 'SIGTERM')
  } catch {
    /* already exited */
  }
}

function resume(id) {
  const download = store.findDownload(id)
  if (!download || jobs.has(id)) return
  store.commit(() => {
    download.status = 'queued'
    download.error = null
  })
  pump_queue()
}

function cancel(id) {
  const download = store.findDownload(id)
  if (!download) return
  const job = jobs.get(id)
  if (job) {
    job.canceled = true
    try {
      job.child.kill(process.platform === 'win32' ? undefined : 'SIGTERM')
    } catch {
      /* already exited */
    }
    return
  }
  store.commit(() => {
    download.status = 'canceled'
    download.stage = null
    download.speed = null
    download.eta = null
  })
  pump_queue()
}

function retry(id) {
  const download = store.findDownload(id)
  if (!download || jobs.has(id)) return
  store.commit(() => {
    download.status = 'queued'
    download.error = null
    download.percent = 0
    download.downloaded = 0
    download.total = null
  })
  pump_queue()
}

function remove(id, { deleteFile = false } = {}) {
  const download = store.findDownload(id)
  if (!download) return
  const job = jobs.get(id)
  if (job) {
    job.canceled = true
    try {
      job.child.kill(process.platform === 'win32' ? undefined : 'SIGTERM')
    } catch {
      /* already exited */
    }
  }
  if (deleteFile && download.filePath) {
    try {
      fs.unlinkSync(download.filePath)
    } catch {
      /* already gone */
    }
  }
  store.commit((s) => {
    s.downloads = s.downloads.filter((d) => d.id !== id)
    for (const i of s.items) if (i.downloadId === id) i.downloadId = null
  })
  progressLastSent.delete(id)
  pump_queue()
}

function killAll() {
  for (const [, job] of jobs) {
    job.paused = true
    try {
      job.child.kill()
    } catch {
      /* already exited */
    }
  }
  jobs.clear()
}

module.exports = {
  enqueue,
  start,
  pause,
  resume,
  cancel,
  retry,
  remove,
  killAll,
  pumpQueue: pump_queue,
  activeCount,
}
