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
const { uid, num, clamp, fileSizeOf, resolvedArgs, safeName, settingNumber } = require('./util')
const { readableError, isRetryableWithoutCookies } = require('./probe')
const ownengine = require('./ownengine')
const { failureKind, retryDelay } = require('./recovery')
const { formatSelector, rankCandidates, languageCode } = require('./media-preferences')
const { TransferStats } = require('./transfer-stats')
const { locateDownload } = require('./locate')
const network = require('./network-context')
const queueOrder = require('./queue-order')
const disk = require('./disk-space')

const TAG = '@P@'
const PROGRESS_TEMPLATE =
  `download:${TAG}%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s` +
  `|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s` +
  `|%(progress.fragment_index)s|%(progress.fragment_count)s`

/** id -> { child, paused, canceled, destinations:Set, printFile } */
const jobs = new Map()
const progressLastSent = new Map()
const retryTimers = new Map()
let pumping = false

function activeCount() {
  return store.getState().downloads.filter((d) => d.status === 'running').length
}

/**
 * The proxy this particular transfer should use, if any.
 *
 * Stored on the download as a flag rather than a resolved address, so correcting
 * a mistyped proxy in settings fixes the retry instead of baking the old value in.
 */
function proxyFor(download, settings) {
  if (!download.useProxy) return ''
  return String(settings.proxyUrl || '').trim()
}


async function prepareNetwork(download, settings, job) {
  if (!download.useProxy) return { ...settings, proxyUrl: '' }
  const key = download.sourceId || download.id
  const hadContext = !!network.getContext(key)
  const proxyUrl = await network.ensureForSource(key, { settings, signal: job.abort.signal,
    onProgress: (status) => {
      if (!job.paused && !job.canceled) store.commit(() => { download.note = status.message || 'Güvenli bağlantı hazırlanıyor' })
    } })
  if (!hadContext && download.resolved?.pageUrl) download.refreshPending = true
  return { ...settings, proxyUrl }
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
    '--retry-sleep', 'http:exp=1:12',
    '--retry-sleep', 'fragment:exp=1:8',
    '--extractor-retries', '3',
    '--abort-on-unavailable-fragments',
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

  // The single biggest speed lever for a streaming site. An HLS video arrives as
  // thousands of small fragments, and yt-dlp fetches them one at a time by
  // default — so the transfer runs at one round-trip per fragment no matter how
  // wide the line is. Asking for several at once is what fills it.
  const connections = Math.floor(clamp(settingNumber(download.recoveryConnections ?? settings.connections, 8), 1, 16))
  if (connections > 1) args.push('--concurrent-fragments', String(connections))

  // Per download, because the link decided this, not the app.
  const proxy = proxyFor(download, settings)
  // Empty explicitly disables yt-dlp's environment/OS proxy discovery.
  args.push('--proxy', proxy)

  if (download.resolved) {
    // The page's own headers and cookies; a browser-profile cookie jar would be
    // the wrong origin here.
    args.push(...resolvedArgs(download.resolved))
  } else if (settings.cookiesBrowser && !download.noCookies) {
    const cookies = resolveCookieArg(settings.cookiesBrowser)
    if (cookies) args.push('--cookies-from-browser', cookies)
  }
  if (settings.rateLimit) args.push('--limit-rate', String(settings.rateLimit))

  args.push('-f', formatSelector(download, settings))

  if (download.audioOnly) {
    args.push('-x', '--audio-format', settings.audioFormat || 'mp3', '--audio-quality', '0')
  } else if (settings.container && settings.container !== 'auto') {
    args.push('--merge-output-format', settings.container)
  }

  if (settings.embedThumbnail && !download.noEmbedThumbnail) args.push('--embed-thumbnail')
  if (settings.embedMetadata) args.push('--embed-metadata')
  // An audio file has nowhere to put a subtitle, so it gets none — the .vtt files
  // left beside an mp3 were pure clutter. For video, the tracks are muxed in and
  // the loose files removed: `no-keep-subs` is what tells yt-dlp to delete them
  // after embedding, because asking for `--write-subs` explicitly otherwise makes
  // it keep a copy of every one beside the video.
  if (settings.writeSubs && !download.audioOnly) {
    args.push(
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      settings.subLangs || 'tr',
      '--embed-subs',
      '--compat-options',
      'no-keep-subs'
    )
  }

  // `--` ends the options: whatever the address turns out to be, yt-dlp reads it
  // as an address and never as a flag (an `--exec` smuggled in as a URL would
  // otherwise run a command).
  args.push('--', download.url)
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
    parts: download.parts || null,
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
  if (target && download.speed > 0 && download.downloaded < target) {
    return Math.ceil((target - download.downloaded) / download.speed)
  }
  if (fragCount > fragIndex && fragIndex > 0) {
    if (!job.fragmentBaseline) job.fragmentBaseline = { at: Date.now(), index: fragIndex }
    const elapsed = (Date.now() - job.fragmentBaseline.at) / 1000
    const moved = fragIndex - job.fragmentBaseline.index
    if (elapsed >= 2 && moved >= 3) return Math.ceil(elapsed / moved * (fragCount - fragIndex))
  }
  return null
}

/**
 * How long is left for everything, not just for one transfer.
 *
 * A per-download ETA answers "at this rate, when is this file done" — and gets it
 * wrong twice over. Three transfers sharing one line all slow each other down,
 * and the moment one finishes the other two speed up; a download still sitting in
 * the queue is reported as having no estimate at all, when in fact its start time
 * is perfectly predictable.
 *
 * So the whole board is simulated instead. The line delivers what it is measurably
 * delivering right now, shared evenly between whatever is active, and the clock is
 * advanced to the next completion — at which point a queued item moves into the
 * free slot and the shares are recalculated. Cheap (a handful of steps), and it
 * degrades honestly: with nothing measured yet it returns nothing rather than a
 * number made up out of defaults.
 */
function outlook() {
  const state = store.getState()
  const slots = Math.max(1, Number(state.settings.concurrency) || 1)
  const running = state.downloads.filter((d) => d.status === 'running' && d.stage === 'downloading')
  const queued = queueOrder.queuedInOrder(state.downloads)
  if (!running.length) return null

  const lineSpeed = running.reduce((sum, d) => sum + (Number(d.speed) > 0 ? Number(d.speed) : 0), 0)
  if (lineSpeed <= 0) return null

  const sizeOf = (d) => Number(d.total) || Number(d.expectedSize) || 0
  const known = [...running, ...queued].map(sizeOf).filter((n) => n > 0)
  if (!known.length) return null
  // A download of unknown size still takes a slot and still takes time, so it is
  // treated as an average one rather than as free.
  const typical = known.reduce((a, b) => a + b, 0) / known.length
  const allKnown = [...running, ...queued].every((d) => sizeOf(d) > 0)

  const active = running.map((d) => ({
    id: d.id,
    left: Math.max(1, (sizeOf(d) || typical) - (Number(d.downloaded) || 0)),
  }))
  const waiting = queued.map((d) => ({ id: d.id, left: sizeOf(d) || typical }))

  const etas = {}
  let clock = 0
  // One step per completion, so the bound is the number of transfers plus slack.
  const maxSteps = active.length + waiting.length
  for (let step = 0; active.length && step < maxSteps; step += 1) {
    const share = lineSpeed / active.length
    const dt = Math.min(...active.map((job) => job.left / share))
    clock += dt
    for (const job of active) job.left -= share * dt
    for (const job of active) {
      if (job.left <= 1) etas[job.id] = Math.round(clock)
    }
    const survivors = active.filter((job) => job.left > 1)
    active.length = 0
    active.push(...survivors)
    while (active.length < slots && waiting.length) active.push(waiting.shift())
  }

  const delayed = queued.some((d) => d.retryAt > Date.now())
  const processing = state.downloads.some((d) => d.status === 'running' && d.stage !== 'downloading')
  return { etas, total: allKnown && !delayed && !processing ? Math.round(clock) : null, lineSpeed }
}

let outlookTimer = null

/**
 * The estimate only moves when the transfers do, so it rides its own slow timer
 * rather than being recomputed on every progress line — and stops entirely once
 * there is nothing left to estimate.
 */
function broadcastOutlook() {
  const result = outlook()
  store.send('outlook', result || { etas: {}, total: null, lineSpeed: 0 })

  // Nothing running means nothing to measure, and a queue with the auto-start
  // switch off can sit there for hours — so the timer stops rather than ticking
  // forever over a board it cannot say anything about. Starting a transfer arms
  // it again.
  const running = store.getState().downloads.some((d) => d.status === 'running')
  if (!running && outlookTimer) {
    clearInterval(outlookTimer)
    outlookTimer = null
  }
}

function startOutlook() {
  if (outlookTimer) return
  outlookTimer = setInterval(broadcastOutlook, 1000)
  if (outlookTimer.unref) outlookTimer.unref()
  broadcastOutlook()
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
    download.downloaded = job.prevBytes + downloaded
    job.prevBytes += downloaded
    job.fragmentBaseline = null
    job.stats = new TransferStats(job.prevBytes)
    const lastPhase = job.phase >= job.phases
    job.phase = Math.min(job.phase + 1, job.phases)
    download.stage = lastPhase ? 'processing' : 'downloading'
    download.speed = null
    download.eta = null
    sendProgress(download, true)
    return
  }

  download.stage = 'downloading'
  download.downloaded = job.prevBytes + downloaded
  if (!job.stats) job.stats = new TransferStats(download.downloaded)
  const measured = job.stats.update(download.downloaded, null)
  download.speed = measured.speed ?? num(speed)
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

  download.eta = estimateEta(job, download, fi, fc) ?? num(eta)
  if (job.phase < job.phases && !download.expectedSize) download.eta = null

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
  job.lastActivity = Date.now()
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
    // yt-dlp announces subtitle and cover files as "destinations" too; those are
    // never the download.
    if (/\.(vtt|srt|ass|ssa|lrc|json|jpe?g|png|webp|description)$/i.test(abs)) continue
    if (fs.existsSync(abs)) return abs
    // Post-processing changes the extension (webm -> mp4, m4a -> mp3). Match on
    // `base.` and not `base`, or "Dune" would happily return "Dune 2.mp4".
    const dir = path.dirname(abs)
    const base = path.basename(abs, path.extname(abs))
    try {
      const sibling = fs
        .readdirSync(dir)
        .find((f) => f.startsWith(`${base}.`) && require('./locate').isMedia(f))
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

/**
 * Everything a stopped transfer leaves behind.
 *
 * Cancelling has to mean the disk looks as it did before, and a half-file is not
 * the only leftover: yt-dlp writes `.part-FragN` per fragment and our own engine
 * writes a `.part.parts` journal beside the partial. Listing the directory
 * catches all of them without having to know each engine's naming by heart.
 */
function deletePartials(job, settings) {
  for (const c of job.destinations) {
    const abs = path.isAbsolute(c) ? c : path.resolve(settings.downloadDir, c)
    require('./hls-native').cleanCache(abs)
    require('./dash-native').cleanCache(abs)
    for (const p of [`${abs}.part`, `${abs}.ytdl`, `${abs}.part.parts`, `${abs}.part.single`, abs]) {
      try {
        fs.unlinkSync(p)
      } catch {
        /* nothing to remove */
      }
    }

    const dir = path.dirname(abs)
    const base = path.basename(abs)
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith(base)) continue
        if (!/\.(part(-Frag\d+)?|ytdl|parts|single)$/i.test(name)) continue
        try {
          fs.unlinkSync(path.join(dir, name))
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* directory gone */
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
    abort: new AbortController(),
    lastActivity: Date.now(),
  }
  jobs.set(download.id, job)

  store.commit(() => {
    download.status = 'running'
    download.stage = 'starting'
    download.error = null
    download.note = null
    download.speed = null
    download.eta = null
    download.total = null
    download.parts = null
    download.retryAt = null
    download.startedAt = download.startedAt || Date.now()
    download.attempts = (download.attempts || 0) + 1
    download.percent = download.percent && download.percent < 1 ? download.percent : 0
    download.phase = 1
    download.phases = 1
  })
  sendProgress(download, true)
  startOutlook()
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
  if (!outcome.canceled && (outcome.raw?.code === 'ENOSPC' || /ENOSPC|no space left|disk full/i.test(outcome.error || ''))) {
    outcome.paused = true; job.paused = true; job.pauseReason ||= outcome.error || 'Disk doldu. Yer açıp indirmeyi sürdürebilirsin.'
  }
  job.settled = true
  clearInterval(job.diskWatch)
  clearInterval(job.watchdog)
  jobs.delete(download.id)

  if (outcome.canceled) {
    deletePartials(job, settings)
    cleanupTemp(job)
    // A cancelled transfer leaves nothing behind — not the half file, and not a
    // record. The source row returns to idle, ready for another quality.
    store.commit((s) => {
      s.downloads = s.downloads.filter((d) => d.id !== download.id)
      for (const i of s.items) if (i.downloadId === download.id) i.downloadId = null
    })
    progressLastSent.delete(download.id)
    pump_queue()
    return
  }

  if (outcome.paused) {
    cleanupTemp(job)
    store.commit(() => {
      download.status = 'paused'
      download.stage = null
      download.note = job.pauseReason || null
      download.speed = null
      download.eta = null
    })
    sendProgress(download, true)
    pump_queue()
    return
  }

  cleanupTemp(job)

  if (outcome.ok) {
    // "Done" has to mean "the file is on disk". A transfer whose engine exited
    // cleanly but whose output we cannot find used to be marked done anyway, with
    // an error line underneath — which read as "downloaded" in every list while
    // the folder had nothing in it. Look for it once more, then call it a failure.
    const finalPath =
      outcome.filePath && fs.existsSync(outcome.filePath)
        ? outcome.filePath
        : locateDownload({ ...download, filePath: outcome.filePath }, settings.downloadDir)
    if (!finalPath) {
      store.commit(() => {
        download.status = 'error'
        download.stage = null
        download.note = null
        download.speed = null
        download.eta = null
        download.parts = null
        download.error = 'İndirme bitti ama dosya klasörde bulunamadı. Tekrar dene.'
      })
      sendProgress(download, true)
      pump_queue()
      return
    }
    store.commit(() => {
      download.status = 'done'
      download.stage = null
      download.note = null
      download.percent = 1
      download.speed = null
      download.eta = null
      download.parts = null
      download.filePath = finalPath
      download.fileSize = fileSizeOf(finalPath)
      download.finishedAt = Date.now()
      download.missing = false
      download.pendingFilePath = null
      download.error = null
    })
    sendProgress(download, true)
    store.send('finished', { id: download.id, title: download.title })

    if (settings.notifyOnFinish && Notification.isSupported()) {
      new Notification({ title: 'İndirme tamamlandı', body: download.title || '' }).show()
    }
    pump_queue()
    return
  }

  if (scheduleRecovery(download, settings, outcome.raw || outcome.error)) { pump_queue(); return }
  store.commit(() => {
    download.status = 'error'
    download.stage = null
    download.note = null
    download.speed = null
    download.eta = null
    download.parts = null
    download.error = outcome.error || 'Aktarım başarısız.'
  })
  sendProgress(download, true)
  pump_queue()
}

async function completeJob(job, download, settings, filePath) {
  if (job.canceled) return settle(job, download, settings, { canceled: true })
  if (filePath && fs.existsSync(filePath)) download.pendingFilePath = filePath
  if (job.paused) return settle(job, download, settings, { paused: true })
  if (!filePath || !fs.existsSync(filePath)) return settle(job, download, settings, { ok: true, filePath })
  try {
    store.commit(() => { download.stage = 'processing'; download.speed = null; download.eta = null; download.note = 'Ses ve altyazılar hazırlanıyor…' })
    const selected = await require('./audio-selection').selectAudio(filePath, download.preferredAudioLanguage || settings.preferredAudioLanguage || 'en', {
      onHandle: (child) => { job.child = child }, isStopped: () => job.paused || job.canceled,
    })
    download.audioLanguage = selected.language || null
    download.audioWarning = selected.warning || null
    download.audioAvailableLanguages = selected.availableLanguages || []
    if (selected.warning) store.toast(`${download.title}: ${selected.warning}`, 'warn')
    const wanted = languageCode(download.preferredAudioLanguage)
    if (download.audioSelectionExplicit && wanted && wanted !== 'auto' &&
        (selected.availableLanguages?.length && !selected.availableLanguages.includes(wanted) || selected.language && languageCode(selected.language) !== wanted)) {
      const available = selected.availableLanguages?.includes(wanted)
      throw Object.assign(new Error(`İstenen ${wanted === 'tr' ? 'Türkçe' : 'İngilizce'} ses ${available ? 'dosyada var ancak seçilemedi. Araçları kontrol edip yeniden dene.' : 'bu dosyada bulunamadı. Başka bir kaynak seç veya ses seçimini değiştir.'}`), { code: 'AUDIO_LANGUAGE_UNAVAILABLE' })
    }
    if (!download.audioOnly) {
      if (!job.paused && !job.canceled && settings.writeSubs) {
        const { found, saved, embedded } = await fetchStreamSubtitles(download, filePath, settings, job).catch((err) => {
          store.toast(`Altyazı eklenemedi: ${err.message}`, 'warn')
          return { found: 0, saved: [], embedded: false }
        })
        if (saved.length) {
          download.subtitlePath = embedded ? null : saved[0].path
          download.subtitleLanguage = saved.map((s) => s.lang).join(', ')
          if (!embedded) store.toast('Altyazı dosyası kaydedildi; videoya gömülemedi.', 'warn')
        } else if (download.resolved) {
          store.toast(`${download.title}: ${found ? 'istenen dilde altyazı yok' : 'akışta altyazı bulunamadı'}.`, 'info')
        }
      }
      if (!job.paused && !job.canceled && settings.autoFetchSubtitles) await autoSubtitles(download, filePath, settings).catch((err) => store.toast(`Altyazı eklenemedi: ${err.message}`, 'warn'))
    }
    return settle(job, download, settings, { paused: job.paused, canceled: job.canceled, ok: true, filePath })
  } catch (err) {
    return settle(job, download, settings, { paused: job.paused, canceled: job.canceled, error: err.message, raw: err })
  }
}

function clearRecovery(id) {
  clearTimeout(retryTimers.get(id))
  retryTimers.delete(id)
}

function scheduleRecovery(download, settings, error) {
  if (settings.autoRecover === false) return false
  let kind = failureKind(error)
  if (download.resolved?.pageUrl && /(?:HTTP[^\n]*404|requested format is not available|no video formats found)/i.test(String(error?.message || error))) kind = 'expired'
  const count = download.recoveryCount || 0
  const limit = Math.floor(settingNumber(settings.recoveryAttempts, 3, { min: 0, max: 6 }))
  if (!['network', 'busy', 'expired'].includes(kind) || count >= limit) return false
  if (kind === 'expired' && !download.resolved?.pageUrl) return false
  const delay = retryDelay(count, kind)
  store.commit(() => {
    download.recoveryCount = count + 1
    download.refreshPending = !!download.resolved?.pageUrl && (kind === 'expired' || count > 0)
    if (kind === 'busy') download.recoveryConnections = Math.max(1, Math.floor((download.recoveryConnections || settings.connections || 8) / 2))
    download.status = 'queued'
    download.stage = null
    download.note = `${Math.ceil(delay / 1000)} sn sonra otomatik denenecek (${count + 1}/${limit})`
    download.retryAt = Date.now() + delay
    download.error = null
    download.speed = null
    download.eta = null
    download.parts = null
  })
  clearRecovery(download.id)
  retryTimers.set(download.id, setTimeout(() => {
    retryTimers.delete(download.id)
    if (store.findDownload(download.id)?.status === 'queued') pump_queue()
  }, delay))
  return true
}

async function prepareRecovery(download, settings, job) {
  if (download.refreshPending && download.resolved?.pageUrl) {
    store.commit(() => { download.note = 'Akış adresi yenileniyor…' })
    const { resolvePage } = require('./resolver')
    const { exportCookieJar } = require('./browsers')
    let jar = settings.cookiesBrowser ? await exportCookieJar(settings.cookiesBrowser, { signal: job.abort.signal }).catch(() => null) : null
    if (!jar && download.resolved.cookieFile && fs.existsSync(download.resolved.cookieFile)) jar = download.resolved.cookieFile
    const result = await resolvePage(download.resolved.pageUrl, {
      browserCookieJar: jar, proxy: proxyFor(download, settings), signal: job.abort.signal,
      timeoutMs: settingNumber(settings.resolverTimeout, 45000),
      preferredAudioLanguage: download.preferredAudioLanguage || settings.preferredAudioLanguage || 'en',
      minStreamSeconds: settingNumber(settings.minStreamSeconds, 120),
      useUserScripts: settings.useUserScripts !== false,
      blockRules: settings,
      onProgress: (message) => { if (!job.paused && !job.canceled) store.commit(() => { download.note = message }) },
    })
    const candidates = rankCandidates((result.candidates || []).filter((c) => !c.info?.drm), download.preferredAudioLanguage)
    const candidate = candidates.find((c) => !download.duration || !c.info?.duration || Math.abs(c.info.duration - download.duration) < Math.max(30, download.duration * 0.15))
    if (!candidate && !job.abort.signal.aborted) throw new Error('Akış adresi yenilenemedi. Kaynağı yeniden tara veya Tarayıcıda yakala ile oturumunu aç.')
    if (candidate && !job.abort.signal.aborted) store.commit(() => {
      download.url = candidate.url
      download.resolved = { ...download.resolved, referer: candidate.referer || download.resolved.pageUrl,
        origin: candidate.origin || '', userAgent: candidate.userAgent || result.userAgent,
        cookieFile: candidate.cookieFile || null, kind: candidate.kind,
        selectedVariantUrl: candidate.info?.selectedVariantUrl || null, rejectedVariantUrls: candidate.info?.rejectedVariantUrls || [],
        selectedVariantChain: candidate.info?.selectedVariantChain?.slice(0, 4) || [],
        preparedVariants: candidate.info?.preparedVariants?.slice(0, 8) || [] }
      download.streamSubtitles = require('./text-tracks').mergeTextTracks(candidate.info?.subtitles || [], candidate.subtitles || [])
      download.streamAudioTracks = candidate.info?.audioTracks || []
      download.refreshPending = false
      download.percent = 0
      download.downloaded = 0
    })
  }
  if (job.paused || job.canceled) throw Object.assign(new Error('Aktarım durduruldu.'), { code: 'ABORTED' })
}

function prepareStorage(download, settings, job) {
  if (settings.protectDiskSpace === false) return
  const reserveBytes = settingNumber(settings.diskReserveMB, 256, { min: 64, max: 4096 }) * disk.MiB
  const check = (preflight) => {
    try {
      disk.assertSpace(settings.downloadDir, { reserveBytes,
        requiredBytes: preflight && !download.pendingFilePath ? Math.max(0, (download.expectedSize || 0) - (download.downloaded || 0)) : 0 })
    } catch (err) {
      job.pauseReason = err.message
      job.paused = true
      job.abort.abort()
      try { job.child?.kill('SIGTERM') } catch {}
      throw err
    }
  }
  check(true)
  job.diskWatch = setInterval(() => {
    if (job.settled || job.canceled || job.paused) return
    try { check(false) } catch { store.toast(job.pauseReason, 'warn') }
  }, 3000)
  job.diskWatch.unref?.()
}

function prioritize(id) {
  let changed = false
  store.commit((state) => { changed = queueOrder.bringToFront(state.downloads, id) })
  if (changed) { broadcastOutlook(); pump_queue() }
  return changed
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

  if (download.pendingFilePath && fs.existsSync(download.pendingFilePath)) {
    const job = beginJob(download)
    try { prepareStorage(download, settings, job) } catch (err) { return settle(job, download, settings, { paused: job.paused, error: err.message, raw: err }) }
    job.destinations.add(download.pendingFilePath)
    prepareNetwork(download, settings, job)
      .then((effective) => completeJob(job, download, effective, download.pendingFilePath))
      .catch((err) => settle(job, download, settings, { paused: job.paused, canceled: job.canceled, error: err.message, raw: err }))
    return
  }
  if (settings.useYtdlp === false || (download.resolved?.kind === 'hls' && settings.nativeHls !== false) || (download.resolved?.kind === 'dash' && settings.nativeDash !== false) || (download.resolved?.kind === 'file' && !download.audioOnly && !settings.rateLimit)) return startOwn(download, settings)
  return startYtdlp(download, settings)
}

/**
 * The in-house engine: our resolver finds the stream, ffmpeg or a ranged GET
 * fetches it. No yt-dlp anywhere in the path.
 */
async function startOwn(download, settings) {
  const job = beginJob(download)
  try { prepareStorage(download, settings, job); settings = await prepareNetwork(download, settings, job); await prepareRecovery(download, settings, job) } catch (err) {
    return settle(job, download, settings, { paused: job.paused, canceled: job.canceled, error: err.message, raw: err })
  }

  ownengine
    .transfer({
      download,
      settings,
      isStopped: () => job.paused || job.canceled,
      signal: job.abort.signal,
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
      onProgress: ({ downloaded, total, totalExact, speed, eta, percent, parts }) => {
        job.lastActivity = Date.now()
        download.downloaded = downloaded || 0
        download.parts = parts || null
        // Once enough fragments have arrived, their measured bytes per second
        // are more useful than a manifest's nominal maximum bandwidth.
        download.total = total || download.expectedSize || null
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
      return completeJob(job, download, settings, filePath)
    })
    .catch((err) => {
      if (job.canceled || (err && err.code === 'ABORTED' && !job.paused)) {
        return settle(job, download, settings, { canceled: true })
      }
      if (job.paused) return settle(job, download, settings, { paused: true })
      settle(job, download, settings, { error: (err && err.message) || String(err), raw: err })
    })
}

async function startYtdlp(download, settings) {
  let bin
  try {
    bin = ytdlpPathOrThrow()
  } catch {
    return startOwn(download, settings)
  }

  const job = beginJob(download)
  try { prepareStorage(download, settings, job); settings = await prepareNetwork(download, settings, job); await prepareRecovery(download, settings, job) } catch (err) {
    return settle(job, download, settings, { paused: job.paused, canceled: job.canceled, error: err.message, raw: err })
  }
  const args = buildArgs(download, settings, job.printFile)
  const child = spawn(bin, args, { env: toolEnv(), windowsHide: true })
  job.child = child
  job.watchdog = setInterval(() => {
    if (job.settled || job.paused || job.canceled || !['starting', 'downloading'].includes(download.stage)) return
    if (Date.now() - job.lastActivity < 90000) return
    job.stderrTail += '\nERROR: network transfer timed out'
    child.kill('SIGTERM')
    const insist = setTimeout(() => { if (jobs.get(download.id) === job) child.kill('SIGKILL') }, 1500)
    insist.unref?.()
  }, 10000)
  job.watchdog.unref?.()

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

  child.on('error', (err) => settle(job, download, settings, { error: err.message, raw: err }))

  child.on('close', (code) => {
    if (job.canceled) return settle(job, download, settings, { canceled: true })
    if (job.paused) return settle(job, download, settings, { paused: true })

    if (code === 0) {
      completeJob(job, download, settings, resolveFinalPath(job, settings)).catch((err) => settle(job, download, settings, { error: err.message, raw: err }))
    } else {
      const message = job.errorLines.length
        ? readableError(job.errorLines.join('\n'), code)
        : readableError(job.stderrTail, code)

      // A retry re-queues this download, and the queue refuses to start a job it
      // is already tracking — so release it before either retry path.
      const requeue = (reason) => {
        if (job.settled) return
        job.settled = true
        clearInterval(job.diskWatch)
        clearInterval(job.watchdog)
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
        !download.resolved &&
        isRetryableWithoutCookies(job.stderrTail || message)
      ) {
        download.noCookies = true
        return requeue(`${message} Çerezsiz yeniden deneniyor.`)
      }

      settle(job, download, settings, { error: message, raw: job.stderrTail || message })
    }
  })
}


/**
 * Subtitles the manifest itself advertised.
 *
 * This is the answer to "the subtitles never appeared in VLC". `--write-subs`
 * asks the extractor, and a bare m3u8 scraped off a series site has no extractor
 * to ask — so yt-dlp reported nothing and the app said nothing, which looked
 * identical to "there are none". The tracks were listed in the master playlist
 * the whole time.
 *
 * Scoped HTTP fetches keep cookies and the selected route attached to every
 * subtitle hop. FFmpeg converts only the prepared local files.
 */
async function fetchStreamSubtitles(download, filePath, settings, job = null) {
  const tracks = Array.isArray(download.streamSubtitles) ? download.streamSubtitles : []
  if (!tracks.length) return { found: 0, saved: [] }

  const bin = ffmpegPath()
  if (!bin) return { found: tracks.length, saved: [] }

  const { normaliseLanguage } = require('./mediainfo')
  const wanted = String(settings.subLangs || 'tr,en')
    .split(',')
    .map((l) => normaliseLanguage(l) || l.trim().toLowerCase())
    .filter(Boolean)

  const subtitles = require('./subtitles')
  const proxy = proxyFor(download, settings)
  const saved = []

  for (const code of wanted) {
    if (job?.paused || job?.canceled) break
    const track = tracks.find((t) => normaliseLanguage(t.lang) === code && !t.forced)
    if (!track || !track.url) continue

    // Fetched into our own folder, never beside the video: it is muxed in below
    // and only kept if that fails.
    const out = subtitles.subtitlePathFor(filePath, code)
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-caption-'))
    const input = path.join(temporary, 'track.vtt')
    let ok = false
    try {
      const localPath = await require('./subtitle-fetch').fetchSubtitle(track.url, input, {
        resolved: { ...download.resolved, referer: track.referer || download.resolved?.referer },
        proxy, signal: job?.abort.signal,
      })
      if (job?.paused || job?.canceled) break
      ok = await new Promise((resolve) => {
        const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          '-protocol_whitelist', 'file', ...(localPath.endsWith('.m3u8') ? ['-allowed_extensions', 'ALL'] : []), '-i', localPath, out],
          { env: toolEnv(), windowsHide: true })
        if (job) job.child = child
        const abort = () => child.kill('SIGKILL')
        const timeout = setTimeout(abort, 30000)
        const finish = (value) => { clearTimeout(timeout); job?.abort.signal.removeEventListener('abort', abort); resolve(value) }
        if (job?.abort.signal.aborted) abort()
        else job?.abort.signal.addEventListener('abort', abort, { once: true })
        child.on('error', () => finish(false))
        child.on('close', (code2) => finish(code2 === 0))
      })
    } catch (err) {
      if (!job?.paused && !job?.canceled) store.toast(`Altyazı alınamadı: ${err.message}`, 'warn')
    } finally {
      await require('./subtitle-fetch').cleanupSubtitle(input)
      fs.rmSync(temporary, { recursive: true, force: true })
    }

    if (ok && fileSizeOf(out)) saved.push({ lang: code, path: out })
    else {
      try {
        fs.unlinkSync(out)
      } catch {
        /* nothing written */
      }
    }
  }

  let embedded = false
  if (saved.length && !job?.paused && !job?.canceled) {
    const result = await subtitles.embedMany(filePath, saved)
    embedded = result.ok
    // Inside the video now; the loose copies would only show up twice in our
    // player. If the mux failed they stay in our folder, where the player finds them.
    if (result.ok) for (const sub of saved) fs.rmSync(sub.path, { force: true })
  }
  return { found: tracks.length, saved, embedded }
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
    if (download.audioLanguage) spoken.add(normaliseLanguage(download.audioLanguage))
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
      languages: wanted.join(','),
      apiKey: settings.subtitleApiKey,
    })
  } catch (err) {
    if (err && err.code === 'NO_KEY') return
    store.toast(`Altyazı aranamadı: ${err.message}`, 'warn')
    return
  }

  // A hash match first: it was timed against this exact file. Failing that, the
  // best-ranked human translation — a series ripped from a stream almost never
  // hash-matches anything, and "no subtitles at all" was the outcome the user kept
  // reporting. A guess that is a second off is fixable in the player; nothing is not.
  let pick = null
  let guessed = false
  for (const lang of wanted) {
    pick = found.results.find((r) => r.hashMatch && r.language.toLowerCase() === lang)
    if (pick) break
  }
  if (!pick) {
    for (const lang of wanted) {
      pick = found.results.find((r) => r.language.toLowerCase() === lang && !r.machine)
      if (pick) {
        guessed = true
        break
      }
    }
  }
  if (!pick) return

  try {
    const outcome = await subtitles.apply({
      videoPath: filePath,
      fileId: pick.fileId,
      language: pick.language,
      hashMatch: !!pick.hashMatch,
      apiKey: settings.subtitleApiKey,
      sync: guessed && settings.syncSubtitles,
      embedTrack: settings.embedSubtitleFile !== false,
    })
    store.commit(() => {
      download.subtitlePath = outcome.path
      download.subtitleLanguage = pick.language
    })
    store.toast(
      guessed
        ? `Altyazı eklendi (${pick.language}): ${download.title} — kayarsa oynatıcıda G/H ile ayarla ya da başka sürüm seç.`
        : `Altyazı eklendi (${pick.language}, senkron): ${download.title}`,
      'ok'
    )
  } catch (err) {
    store.toast(`Altyazı eklenemedi: ${err.message}`, 'warn')
  }
}

/** Start queued transfers up to the concurrency limit. */
function pump_queue() {
  if (pumping) return
  const state = store.getState()
  const limit = Math.max(1, Number(state.settings.concurrency) || 1)
  let free = limit - activeCount()
  if (free <= 0) return
  pumping = true
  try {
    for (const d of queueOrder.queuedInOrder(state.downloads)) {
      if (free <= 0) break
      if (d.status === 'queued' && !jobs.has(d.id) && (!d.retryAt || d.retryAt <= Date.now())) {
        start(d.id)
        // Storage preflight can settle synchronously. Do not recurse through
        // the whole queue or count an already paused job as an occupied slot.
        free = limit - activeCount()
      }
    }
  } finally { pumping = false }
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
function enqueue({ item, url, title, site, sourceId, quality, audioOnly, categoryId, preferredAudioLanguage }) {
  const settings = store.getState().settings
  const chosenLanguage = preferredAudioLanguage ?? settings.preferredAudioLanguage ?? 'en'
  if (!['en', 'tr', 'auto'].includes(chosenLanguage)) throw new Error('Ses dili Türkçe, İngilizce veya kaynağın varsayılanı olmalı.')
  const chosenQuality = quality === undefined ? settings.defaultQuality : Number(quality) || 0
  const duplicate = queueOrder.activeDuplicate(store.getState().downloads, { item, url, sourceId, quality: chosenQuality, audioOnly, preferredAudioLanguage: chosenLanguage })
  if (duplicate) { store.toast('Bu video aynı kalite ve ses tercihiyle zaten kuyrukta.', 'info'); return duplicate }
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
    preferredAudioLanguage: chosenLanguage,
    audioSelectionExplicit: preferredAudioLanguage !== undefined && chosenLanguage !== 'auto',
    refreshPending: !!(item?.resolved?.pageUrl && chosenLanguage !== 'auto' &&
      (chosenLanguage !== (settings.preferredAudioLanguage || 'en') || (item?.audioTracks?.length && !item.audioTracks.some((track) => languageCode(track.lang) === chosenLanguage)))),
    series: item?.series || null,
    season: item?.season ?? null,
    episode: item?.episode ?? null,
    queueOrder: queueOrder.nextOrder(store.getState().downloads),
    recoveryCount: 0,
    retryAt: null,
    streamAudioTracks: item?.audioTracks || [],
    streamSubtitles: (item && item.subtitles) || [],
    // Inherited from the link the user added, and copied here because a download
    // outlives the source row it came from.
    useProxy: !!(store.findSource(sourceId || item?.sourceId)?.useProxy ?? item?.resolved?.useProxy ?? false),
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
  // A new item at the back of the queue changes when everything finishes, even
  // if nothing about the running transfers changed.
  startOutlook()
  return download
}

function pause(id) {
  clearRecovery(id)
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
  job.abort.abort()
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
    download.retryAt = null
    download.error = null
  })
  pump_queue()
}

/**
 * Stop now, and say so now.
 *
 * Two things were wrong here. yt-dlp traps SIGTERM and finishes what is already
 * in flight before exiting — with several fragments downloading at once that is
 * seconds, during which the row carried on as if nothing had happened and the
 * button looked broken. And if the engine had not yet handed over a process to
 * kill, `job.child.kill()` threw into a catch and the function returned, leaving
 * the transfer running with no way to stop it.
 *
 * So: mark it stopped, show it stopped, ask politely, and insist shortly after.
 */
function cancel(id) {
  clearRecovery(id)
  const download = store.findDownload(id)
  if (!download) return
  const job = jobs.get(id)

  if (!job) {
    settleRemoved(download)
    return
  }

  job.canceled = true
  job.abort.abort()
  // The interface should not wait on a process to notice. The engine's own
  // settle still runs when it exits and finds the record already gone.
  store.commit(() => {
    download.status = 'canceled'
    download.stage = null
    download.note = null
    download.speed = null
    download.eta = null
    download.parts = null
  })
  sendProgress(download, true)

  const stop = (signal) => {
    try {
      if (job.child) job.child.kill(process.platform === 'win32' ? undefined : signal)
    } catch {
      /* already gone */
    }
  }
  stop('SIGTERM')
  // Still there a moment later? It is not going to leave on its own.
  const insist = setTimeout(() => {
    if (jobs.get(id) === job) stop('SIGKILL')
  }, 1500)
  if (insist.unref) insist.unref()
}

/**
 * Cancelling means the row goes back to how it was before, so a different
 * quality can be picked and started fresh — not a dead record parked under
 * "cancelled" that has to be cleared by hand.
 */
function settleRemoved(download) {
  const settings = store.getState().settings
  const job = jobs.get(download.id)
  if (job) {
    job.settled = true
    clearInterval(job.diskWatch)
    jobs.delete(download.id)
    deletePartials(job, settings)
    cleanupTemp(job)
  }
  store.commit((s) => {
    s.downloads = s.downloads.filter((d) => d.id !== download.id)
    for (const i of s.items) if (i.downloadId === download.id) i.downloadId = null
  })
  progressLastSent.delete(download.id)
  pump_queue()
}

function retry(id) {
  clearRecovery(id)
  const download = store.findDownload(id)
  if (!download || jobs.has(id)) return
  store.commit(() => {
    download.status = 'queued'
    download.error = null
    download.percent = 0
    download.downloaded = 0
    download.total = null
    download.retryAt = null
    download.recoveryCount = 0
    download.refreshPending = !!download.resolved?.pageUrl
  })
  pump_queue()
}

function remove(id, { deleteFile = false } = {}) {
  clearRecovery(id)
  const download = store.findDownload(id)
  if (!download) return
  const job = jobs.get(id)
  if (job) {
    job.canceled = true
    job.abort.abort()
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
    // The poster frame, the kept subtitles and the watch history all describe a
    // file that no longer exists.
    require('./thumbs').forget(download.filePath)
    require('./subtitles').forgetStored(download.filePath)
    store.forgetFile(download.filePath)
  }
  store.commit((s) => {
    s.downloads = s.downloads.filter((d) => d.id !== id)
    for (const i of s.items) if (i.downloadId === id) i.downloadId = null
  })
  progressLastSent.delete(id)
  pump_queue()
}

/**
 * Check that every finished download still has its file.
 *
 * Files leave the folder in ways the app never hears about — deleted in Finder,
 * moved to another disk, renamed. Without this the library kept offering "play"
 * and "reveal" for nothing, and the buttons looked broken. A file that merely
 * moved is found again and the record corrected; one that is gone is marked, so
 * the row can say so and offer to download it again.
 */
function verifyFiles() {
  const state = store.getState()
  const dir = state.settings.downloadDir
  const changes = []
  for (const d of state.downloads) {
    if (d.status !== 'done') continue
    const found = locateDownload(d, dir)
    if (found && (found !== d.filePath || d.missing)) changes.push([d, found, false])
    else if (!found && !d.missing) changes.push([d, d.filePath, true])
  }
  if (!changes.length) return 0
  store.commit(() => {
    for (const [d, filePath, missing] of changes) {
      if (!missing && d.filePath && filePath !== d.filePath) store.moveFileKey(d.filePath, filePath)
      d.filePath = filePath
      d.missing = missing
    }
  })
  return changes.filter((c) => c[2]).length
}

/**
 * Fetch a finished-but-missing download again, into the same record.
 *
 * Retrying is the honest action for a file that disappeared: the link, the
 * quality and the category are all still known.
 */
function redownload(id) {
  const download = store.findDownload(id)
  if (!download || jobs.has(id)) return false
  store.commit(() => {
    download.status = 'queued'
    download.error = null
    download.missing = false
    download.filePath = null
    download.fileSize = null
    download.percent = 0
    download.downloaded = 0
    download.total = null
    download.finishedAt = null
    download.attempts = 0
  })
  pump_queue()
  startOutlook()
  return true
}

/** Drop the records of finished downloads whose files are gone. */
function clearMissing() {
  verifyFiles()
  let removed = 0
  store.commit((s) => {
    const before = s.downloads.length
    const gone = new Set(s.downloads.filter((d) => d.status === 'done' && d.missing).map((d) => d.id))
    s.downloads = s.downloads.filter((d) => !gone.has(d.id))
    for (const i of s.items) if (gone.has(i.downloadId)) i.downloadId = null
    removed = before - s.downloads.length
  })
  forgetMissing()
  return removed
}

/**
 * Drop throttling state for downloads that no longer exist. Called after a bulk
 * clear, which otherwise leaves an entry per removed transfer behind forever.
 */
function forgetMissing() {
  const alive = new Set(store.getState().downloads.map((d) => d.id))
  for (const id of retryTimers.keys()) if (!alive.has(id)) clearRecovery(id)
  for (const id of progressLastSent.keys()) {
    if (!alive.has(id)) progressLastSent.delete(id)
  }
}

function killAll() {
  for (const id of retryTimers.keys()) clearRecovery(id)
  for (const [, job] of jobs) {
    job.paused = true
    job.abort.abort()
    clearInterval(job.watchdog)
    clearInterval(job.diskWatch)
    try {
      job.child.kill()
    } catch {
      /* already exited */
    }
  }
  jobs.clear()
}

module.exports = {
  buildArgs, parseProgressLine, estimateEta, scheduleRecovery,
  enqueue,
  prioritize,
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
  outlook,
  verifyFiles,
  redownload,
  clearMissing,
}
