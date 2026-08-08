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
const fsp = require('fs/promises')
const http = require('http')
const https = require('https')
const path = require('path')
const { spawn } = require('child_process')
const { Readable, Transform } = require('stream')
const { pipeline } = require('stream/promises')
const { toolEnv, ffmpegPath } = require('./binaries')
const {
  fetchHeaders,
  fetchManifest,
  ffprobeHeaderArgs,
  parseHls,
  probeFile,
} = require('./mediainfo')
const { safeName, settingNumber } = require('./util')

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
/* plain file over HTTP, in several pieces at once                             */
/* -------------------------------------------------------------------------- */

/**
 * Below this there is nothing to gain: the connections cost more in handshakes
 * than they save, and the file is over before they ramp up.
 */
const MIN_MULTIPART = 4 * 1024 * 1024

/**
 * Parallel parts go through node's own http client rather than fetch.
 *
 * This is not a style preference. Node's fetch keeps one connection per origin by
 * default, so four "parallel" range requests to the same host queue behind each
 * other — no parallelism at all, and a part that hangs up early can leave the
 * next one waiting on a connection that never frees. An explicit agent with real
 * sockets is the only way to get what this feature is for.
 */
const AGENTS = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 32 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 32 }),
}

/** Open one request, following redirects, and hand back the live response. */
function openStream(rawUrl, headers, redirects = 5) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(rawUrl)
    } catch (err) {
      return reject(err)
    }
    const mod = target.protocol === 'http:' ? http : https
    const req = mod.request(
      target,
      { headers, agent: AGENTS[target.protocol] },
      (res) => {
        const location = res.headers.location
        if (location && res.statusCode >= 300 && res.statusCode < 400 && redirects > 0) {
          res.resume() // drain, or the socket is never reusable
          const next = new URL(location, target).href
          return resolve(openStream(next, headers, redirects - 1))
        }
        resolve({ status: res.statusCode, headers: res.headers, stream: res, request: req })
      }
    )
    req.on('error', reject)
    req.setTimeout(30000, () => req.destroy(new Error('Sunucu yanıt vermedi.')))
    req.end()
  })
}

/**
 * Why several connections are faster than one, given the same line.
 *
 * A single TCP stream is rarely limited by your bandwidth. It is limited by the
 * server's per-connection shaping, by the round-trip time against the congestion
 * window, and by whatever middlebox decided that this one flow has had enough.
 * None of those apply *per file* — they apply per connection. Opening four means
 * four independent windows, four shaping buckets, and four flows for the network
 * to schedule, which is why 300 KB/s on one can become several MB/s on four.
 *
 * The file is preallocated and each part is written straight to its own offset,
 * so nothing is concatenated at the end. Progress for each part is journalled
 * next to it, which is what makes a multi-part transfer resumable at all.
 */
function planPathFor(partPath) {
  return `${partPath}.parts`
}

function makePlan(size, connections) {
  const count = Math.max(1, Math.min(connections, 16))
  const chunk = Math.ceil(size / count)
  const parts = []
  for (let start = 0; start < size; start += chunk) {
    parts.push({ start, end: Math.min(start + chunk, size) - 1, done: 0 })
  }
  return { size, parts }
}

function readPlan(planPath, size) {
  try {
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
    if (!plan || plan.size !== size || !Array.isArray(plan.parts) || !plan.parts.length) return null
    // A journal that disagrees with itself is worse than no journal.
    for (const p of plan.parts) {
      if (!Number.isFinite(p.start) || !Number.isFinite(p.end) || !Number.isFinite(p.done)) return null
      if (p.done < 0 || p.start + p.done > p.end + 1) return null
    }
    return plan
  } catch {
    return null
  }
}

function savePlan(planPath, plan) {
  try {
    fs.writeFileSync(planPath, JSON.stringify(plan))
  } catch {
    /* the journal is an optimisation; losing it only costs a restart */
  }
}

async function fetchFileParallel({
  url,
  resolved,
  destPath,
  size,
  connections,
  onProgress,
  onHandle,
  onNote,
}) {
  const partPath = `${destPath}.part`
  const planPath = planPathFor(partPath)

  let plan = readPlan(planPath, size)
  let resumed = false
  if (plan && fs.existsSync(partPath) && fs.statSync(partPath).size === size) {
    resumed = plan.parts.some((p) => p.done > 0)
  } else {
    plan = makePlan(size, connections)
    // Preallocate so every connection can write at its own offset from the start.
    const fd = fs.openSync(partPath, 'w')
    try {
      fs.ftruncateSync(fd, size)
    } finally {
      fs.closeSync(fd)
    }
  }
  savePlan(planPath, plan)
  onNote?.(
    resumed ? `${plan.parts.length} parça, kaldığı yerden` : `${plan.parts.length} bağlantı`
  )

  let stopped = false
  const live = new Set()
  onHandle({
    kill() {
      stopped = true
      for (const req of live) {
        try {
          req.destroy()
        } catch {
          /* already gone */
        }
      }
      live.clear()
    },
  })

  const doneBytes = () => plan.parts.reduce((sum, p) => sum + p.done, 0)
  let lastAt = Date.now()
  let lastBytes = doneBytes()
  let lastSaved = Date.now()

  const tick = () => {
    const now = Date.now()
    if (now - lastAt < 400) return
    const downloaded = doneBytes()
    const speed = ((downloaded - lastBytes) * 1000) / (now - lastAt)
    lastAt = now
    lastBytes = downloaded
    if (now - lastSaved > 1000) {
      savePlan(planPath, plan)
      lastSaved = now
    }
    onProgress({
      downloaded,
      total: size,
      totalExact: true,
      speed,
      eta: speed > 0 ? Math.round((size - downloaded) / speed) : null,
      percent: downloaded / size,
    })
  }

  const MAX_STALLS = 4

  const runPart = async (part) => {
    let stalls = 0
    const capacity = part.end - part.start + 1

    while (part.done < capacity) {
      if (stopped) throw abortError()
      const from = part.start + part.done
      const res = await openStream(url, {
        ...fetchHeaders(url, resolved),
        Range: `bytes=${from}-${part.end}`,
      })
      live.add(res.request)

      if (res.status !== 206) {
        res.request.destroy()
        live.delete(res.request)
        const err = new Error('Sunucu parçalı indirmeyi reddetti.')
        err.code = 'NO_RANGE'
        throw err
      }

      const before = part.done

      // Written by hand rather than through a pipeline. A part has to stop at its
      // own boundary — asking for bytes 0-999 does not guarantee getting only
      // those, and some servers answer 206 and then send the rest of the file,
      // which would scribble over the next part's territory. Awaiting each
      // positioned write makes "stop here" and "everything is on disk" the same
      // moment, which a pipeline torn down mid-flight cannot promise.
      const handle = await fsp.open(partPath, 'r+')
      try {
        let offset = from
        for await (const chunk of res.stream) {
          if (stopped) throw abortError()
          const room = capacity - part.done
          if (room <= 0) break
          const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
          await handle.write(slice, 0, slice.length, offset)
          offset += slice.length
          part.done += slice.length
          tick()
          if (part.done >= capacity) break
        }
      } finally {
        await handle.close()
        // Hang up rather than pull down bytes that would only be discarded.
        res.request.destroy()
        live.delete(res.request)
      }

      // A connection dropped early leaves this part short; the loop reopens it
      // from exactly where it stopped rather than starting the file again. But a
      // server that answers 206 and then sends nothing would spin that loop
      // forever, so a run of empty answers has to end the attempt.
      if (part.done === before) {
        stalls += 1
        if (stalls >= MAX_STALLS) {
          throw new Error(`Sunucu ${from}. bayttan sonrasını vermedi.`)
        }
        await new Promise((r) => setTimeout(r, 300 * stalls))
      } else {
        stalls = 0
      }

      if (part.start + part.done > part.end) return
      if (stopped) throw abortError()
    }
  }

  try {
    await Promise.all(plan.parts.map(runPart))
  } catch (err) {
    savePlan(planPath, plan)
    if (stopped) throw abortError()
    throw err
  }

  const total = doneBytes()
  if (total !== size) {
    throw new Error(`Parçalar eksik indi (${total}/${size}).`)
  }

  fs.rmSync(planPath, { force: true })
  fs.renameSync(partPath, destPath)
  onProgress({ downloaded: size, total: size, totalExact: true, speed: null, eta: 0, percent: 1 })
  return { path: destPath, resumed, parts: plan.parts.length }
}

/* -------------------------------------------------------------------------- */
/* plain file over HTTP, one connection                                        */
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
    // Ask what this file is before fetching it: the length gives the meter a
    // target from the first byte, and whether the server serves ranges decides
    // between four connections and one.
    const probed = await probeFile(url, resolved).catch(() => ({ size: null, ranges: false }))
    halt()
    if (probed.url) url = probed.url
    if (probed.size) {
      onProgress({
        downloaded: 0,
        total: probed.size,
        totalExact: true,
        speed: null,
        eta: null,
        percent: 0,
      })
    }

    const connections = Math.max(1, Math.min(16, settingNumber(settings.connections, 4)))
    if (probed.size && probed.ranges && connections > 1 && probed.size >= MIN_MULTIPART) {
      try {
        const out = await fetchFileParallel({
          url,
          resolved,
          destPath,
          size: probed.size,
          connections,
          onProgress,
          onHandle,
          onNote,
        })
        return { filePath: out.path }
      } catch (err) {
        // Advertising ranges and honouring them are different things. One retry
        // on a single connection beats failing a download over an optimisation.
        if (!err || err.code !== 'NO_RANGE') throw err
        onNote?.('sunucu parçalı vermedi, tek bağlantıya düşüldü')
        fs.rmSync(planPathFor(`${destPath}.part`), { force: true })
        fs.rmSync(`${destPath}.part`, { force: true })
      }
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
