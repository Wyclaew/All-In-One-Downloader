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
const { readableError, isRetryableWithoutCookies } = require('./probe')
const ownengine = require('./ownengine')

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

  if (settings.embedThumbnail && !download.noEmbedThumbnail) args.push('--embed-thumbnail')
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

/**
 * How long is left, when the engine won't say.
 *
 * yt-dlp reports `eta` as NA for most of a segmented download — which is exactly
 * the case where a two-hour film is being pulled in ten thousand pieces and the
 * user most wants a number. Two ways to get one honestly:
 *
 *   bytes      a target we believe in, divided by the rate we just measured.
 *   fragments  no byte total exists, but fragments land at a measurable rate.
 */
function estimateEta(job, download, fragIndex, fragCount) {
  const target = download.total || download.expectedSize || null
  if (target && download.speed > 0) {
    const remaining = target - download.downloaded
    if (remaining > 0) return Math.round(remaining / download.speed)
  }

  if (fragCount && fragIndex > 0 && job.fragmentsAt) {
    const elapsed = (Date.now() - job.fragmentsAt) / 1000
    const perFragment = elapsed / fragIndex
    // Later phases (the audio track of a merge) fetch their own fragments too.
    const remaining = fragCount - fragIndex + (job.phases - job.phase) * fragCount
    if (perFragment > 0 && remaining > 0) return Math.round(perFragment * remaining)
  }
  return null
}

function parseProgressLine(line, job, download) {
  const raw = line.slice(line.indexOf(TAG) + TAG.length)
  const [status, dl, total, totalEst, speed, eta, fragIndex, fragCount] = raw.split('|')

  const downloaded = num(dl) || 0
  const knownTotal = num(total) || num(totalEst)
  const fi = num(fragIndex)
  const fc = num(fragCount)
  if (fc && fi && !job.fragmentsAt) job.fragmentsAt = Date.now()

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
  } else if (download.expectedSize) {
    // Nothing to measure against, but the item told us its size before we started.
    percent = download.downloaded / download.expectedSize
  }

  download.eta = num(eta) ?? estimateEta(job, download, fi, fc)

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

/** ffmpeg refusing to write cover art into this container. */
function isThumbnailFailure(text) {
  return /unable to embed.*(?:ffmpeg|ffprobe)|embedthumbnail/i.test(String(text || ''))
}

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
    // Post-processing changes the extension (webm -> mp4, m4a -> mp3). Match on
    // `base.` and not `base`, or "Dune" would happily return "Dune 2.mp4".
    const dir = path.dirname(abs)
    const base = path.basename(abs, path.extname(abs))
    try {
      const sibling = fs
        .readdirSync(dir)
        .find((f) => f.startsWith(`${base}.`) && !f.endsWith('.part') && !f.endsWith('.ytdl'))
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

/** Everything both engines need in place before the first byte moves. */
function beginJob(download) {
  const job = {
    child: null,
    printFile: path.join(os.tmpdir(), `edl-${download.id}-${Date.now()}.txt`),
    paused: false,
    canceled: false,
    destinations: new Set(),
    errorLines: [],
    prevBytes: 0,
    phase: 1,
    phases: 1,
    maxPercent: 0,
    fragmentsAt: null,
    alreadyPath: null,
    stderrTail: '',
  }
  jobs.set(download.id, job)

  store.commit(() => {
    download.status = 'running'
    download.stage = 'starting'
    download.error = null
    download.note = null
    download.startedAt = download.startedAt || Date.now()
    download.attempts = (download.attempts || 0) + 1
    download.percent = download.percent && download.percent < 1 ? download.percent : 0
    download.phase = 1
    download.phases = 1
  })
  sendProgress(download, true)
  return job
}

/**
 * The terminal state of a transfer, whichever engine ran it. Kept in one place so
 * "done" means the same thing — and cleans up the same way — for both.
 */
function settle(job, download, settings, outcome) {
  // A failed spawn emits 'error' and then 'close', and both want to finish the
  // job. Without this the second call overwrites the first, specific message
  // ("spawn ENOENT") with the generic one derived from an empty stderr.
  if (job.settled) return
  job.settled = true
  jobs.delete(download.id)

  if (outcome.canceled) {
    deletePartials(job, settings)
    cleanupTemp(job)
    store.commit(() => {
      download.status = 'canceled'
      download.stage = null
      download.note = null
      download.speed = null
      download.eta = null
    })
    sendProgress(download, true)
    pump_queue()
    return
  }

  if (outcome.paused) {
    cleanupTemp(job)
    store.commit(() => {
      download.status = 'paused'
      download.stage = null
      download.note = null
      download.speed = null
      download.eta = null
    })
    sendProgress(download, true)
    pump_queue()
    return
  }

  cleanupTemp(job)

  if (outcome.ok) {
    const finalPath = outcome.filePath
    store.commit(() => {
      download.status = 'done'
      download.stage = null
      download.note = null
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
    pump_queue()
    return
  }

  store.commit(() => {
    download.status = 'error'
    download.stage = null
    download.note = null
    download.speed = null
    download.eta = null
    download.error = outcome.error || 'Aktarım başarısız.'
  })
  sendProgress(download, true)
  pump_queue()
}

function start(downloadId) {
  const download = store.findDownload(downloadId)
  if (!download || jobs.has(downloadId)) return
  const settings = store.getState().settings

  try {
    store.ensureDownloadDir()
  } catch (err) {
    store.commit(() => {
      download.status = 'error'
      download.error = `İndirme klasörü oluşturulamadı: ${err.message}`
    })
    return
  }

  if (settings.useYtdlp === false) return startOwn(download, settings)
  return startYtdlp(download, settings)
}

/**
 * The in-house engine: our resolver finds the stream, ffmpeg or a ranged GET
 * fetches it. No yt-dlp anywhere in the path.
 */
function startOwn(download, settings) {
  const job = beginJob(download)

  ownengine
    .transfer({
      download,
      settings,
      isStopped: () => job.paused || job.canceled,
      onHandle: (handle) => {
        job.child = handle
      },
      onDest: (dest) => job.destinations.add(dest),
      onStage: (stage) => {
        store.commit(() => {
          download.stage = stage
        })
      },
      onNote: (note) => {
        store.commit(() => {
          download.note = note
        })
      },
      onProgress: ({ downloaded, total, totalExact, speed, eta, percent }) => {
        download.downloaded = downloaded || 0
        // A measured length wins. Otherwise the manifest's figure beats an
        // extrapolation from how much of the timeline has been written.
        download.total = totalExact ? total : download.expectedSize || total || null
        download.speed = speed ?? null
        download.stage = 'downloading'
        if (percent !== null && percent !== undefined) {
          job.maxPercent = Math.max(job.maxPercent, clamp(percent, 0, 0.999))
          download.percent = job.maxPercent
        }
        download.eta = eta ?? estimateEta(job, download, 0, 0)
        sendProgress(download)
      },
    })
    .then(({ filePath }) => {
      // Cancelled on the last byte: the user asked for it gone, so honour that
      // rather than presenting a file they said they did not want.
      if (job.canceled) return settle(job, download, settings, { canceled: true })
      settle(job, download, settings, { ok: true, filePath })
    })
    .catch((err) => {
      if (job.canceled || (err && err.code === 'ABORTED' && !job.paused)) {
        return settle(job, download, settings, { canceled: true })
      }
      if (job.paused) return settle(job, download, settings, { paused: true })
      settle(job, download, settings, { error: (err && err.message) || String(err) })
    })
}

function startYtdlp(download, settings) {
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

  const job = beginJob(download)
  const args = buildArgs(download, settings, job.printFile)
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

  child.on('error', (err) => settle(job, download, settings, { error: err.message }))

  child.on('close', (code) => {
    if (job.canceled) return settle(job, download, settings, { canceled: true })
    if (job.paused) return settle(job, download, settings, { paused: true })

    if (code === 0) {
      settle(job, download, settings, { ok: true, filePath: resolveFinalPath(job, settings) })
    } else {
      const message = job.errorLines.length
        ? readableError(job.errorLines.join('\n'), code)
        : readableError(job.stderrTail, code)

      // A retry re-queues this download, and the queue refuses to start a job it
      // is already tracking — so release it before either retry path.
      const requeue = (reason) => {
        if (job.settled) return
        job.settled = true
        jobs.delete(download.id)
        cleanupTemp(job)
        store.commit(() => {
          download.status = 'queued'
          download.error = null
        })
        store.toast(reason, 'warn')
        pump_queue()
      }

      // Cover art is decoration. When ffmpeg refuses to write it into a
      // particular container the whole transfer was being marked failed, even
      // though the video itself had downloaded — retry without it instead.
      if (!download.noEmbedThumbnail && settings.embedThumbnail && isThumbnailFailure(message)) {
        download.noEmbedThumbnail = true
        return requeue('Kapak görseli gömülemedi; kapaksız yeniden deneniyor.')
      }

      // One retry without cookies. Covers an unreadable cookie store and, just
      // as often, a 403 caused by sending cookies in the first place.
      if (
        !download.noCookies &&
        settings.cookiesBrowser &&
        isRetryableWithoutCookies(job.stderrTail || message)
      ) {
        download.noCookies = true
        return requeue(`${message} Çerezsiz yeniden deneniyor.`)
      }

      settle(job, download, settings, { error: message })
    }
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

/**
 * The size this download is expected to be, taken from what the item already
 * knows. It gives the meter a target from the first byte and lets the estimate
 * work on segmented streams, which report no total of their own.
 */
function expectedSizeFor(item, quality, audioOnly) {
  if (!item) return null
  const sizes = item.sizes && typeof item.sizes === 'object' ? item.sizes : null
  // An audio-only transfer is the audio track, not a share of the video's size.
  if (audioOnly) return (sizes && sizes.audio) || null
  if (sizes) {
    const cap = Number(quality) || 0
    const heights = Object.keys(sizes)
      .map(Number)
      .filter((h) => Number.isFinite(h) && h > 0)
      .sort((a, b) => b - a)
    const pick = cap ? heights.find((h) => h <= cap) : heights[0]
    if (pick && sizes[pick]) return sizes[pick]
  }
  return item.filesize || null
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
    noEmbedThumbnail: false,
    status: 'queued',
    stage: null,
    note: null,
    percent: 0,
    downloaded: 0,
    total: null,
    expectedSize: expectedSizeFor(
      item,
      quality === undefined ? settings.defaultQuality : quality,
      audioOnly
    ),
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

/**
 * Drop throttling state for downloads that no longer exist. Called after a bulk
 * clear, which otherwise leaves an entry per removed transfer behind forever.
 */
function forgetMissing() {
  const alive = new Set(store.getState().downloads.map((d) => d.id))
  for (const id of progressLastSent.keys()) {
    if (!alive.has(id)) progressLastSent.delete(id)
  }
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
  forgetMissing,
  pumpQueue: pump_queue,
  activeCount,
}
