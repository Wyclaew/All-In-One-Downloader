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
const { Transform } = require('stream')
const { pipeline } = require('stream/promises')
const { toolEnv, ffmpegPath } = require('./binaries')
const { fetchHeaders, ffprobeHeaderArgs, parseHls } = require('./mediainfo')
const { agentsFor, ffmpegEnv, parseProxy } = require('./proxy')
const { safeName, settingNumber, atomicWrite } = require('./util')
const { failureKind, retryDelay, httpError, sleep } = require('./recovery')
const { TransferStats } = require('./transfer-stats')
const { languageCode } = require('./media-preferences')

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
/* asking about a file, through the same door we will fetch it from            */
/* -------------------------------------------------------------------------- */

/**
 * How long the file is and whether the server serves pieces of it.
 *
 * Use the same scoped HTTP client, route and cancellation as the transfer. A
 * one-byte range answers both questions; a 206 is proof that ranges work.
 */
async function probeVia(url, resolved, proxy, signal = null) {
  const res = await openStream(
    url,
    { ...fetchHeaders(url, resolved), Range: 'bytes=0-0' },
    { proxy, signal, resolved }
  )
  const headers = res.headers || {}
  res.request.destroy()

  const total = Number(String(headers['content-range'] || '').split('/')[1]) || null
  const validator = headers.etag && !headers.etag.startsWith('W/') ? headers.etag : headers['last-modified'] || null
  if (res.status === 206 && total) return { size: total, ranges: true, url: res.finalUrl || url, validator }
  if (res.status === 200) {
    return {
      size: Number(headers['content-length']) || null,
      ranges: false,
      url: res.finalUrl || url,
      validator,
    }
  }
  return { size: null, ranges: false, url }
}

/** A manifest's text, through the tunnel when there is one. */
async function fetchTextVia(url, resolved, proxy, limit = 2 * 1024 * 1024, signal = null) {
  const res = await openStream(url, fetchHeaders(url, resolved), { proxy, signal, resolved })
  if (res.status !== 200) {
    res.request.destroy()
    return { text: '', finalUrl: url }
  }
  const chunks = []
  let size = 0
  for await (const chunk of res.stream) {
    chunks.push(chunk)
    size += chunk.length
    if (size >= limit) break
  }
  res.request.destroy()
  return { text: Buffer.concat(chunks).toString('utf8'), finalUrl: res.finalUrl || url }
}

/* -------------------------------------------------------------------------- */
/* stream selection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Turn a download into a concrete stream: its URL, the headers it needs, and what
 * shape it is. A download made from a resolved item already carries all of this;
 * a bare page URL is resolved here, because without yt-dlp nothing else will.
 */
async function locateStream(download, settings, onNote, signal = null) {
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
    preferredAudioLanguage: download.preferredAudioLanguage || settings.preferredAudioLanguage || 'en',
    signal,
    useUserScripts: settings.useUserScripts !== false,
    // A proxied download that has to resolve its own page must resolve it through
    // the same tunnel it will fetch through.
    proxy: download.useProxy ? String(settings.proxyUrl || '').trim() : '',
    blockRules: {
      extraBlockedHosts: settings.extraBlockedHosts,
      blockTrackers: settings.blockTrackers,
    },
    minStreamSeconds: settingNumber(settings.minStreamSeconds, 120),
    timeoutMs: Math.max(8000, settingNumber(settings.resolverTimeout, 45000)),
    onProgress: (message) => onNote?.(message),
  })

  const candidate = require('./media-preferences').rankCandidates(result?.candidates || [], download.preferredAudioLanguage || settings.preferredAudioLanguage || 'en').find((c) => !c.info?.drm) || null
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
      userAgent: candidate.userAgent || result.userAgent,
      cookieFile: candidate.cookieFile || null,
      kind: candidate.kind,
      selectedVariantUrl: candidate.info?.selectedVariantUrl || null,
      rejectedVariantUrls: candidate.info?.rejectedVariantUrls || [],
    },
  }
}

/**
 * Swap a master playlist for the rendition the user asked for. Falls back to the
 * playlist itself when there is nothing to choose between.
 */
async function pickVariant(url, resolved, quality, onNote, proxy = '', preferred = 'en', signal = null) {
  const { text, finalUrl } = await fetchTextVia(url, resolved, proxy, 2 * 1024 * 1024, signal)
  if (!text || !/#EXTM3U/i.test(text)) return { url, height: null }
  const hls = parseHls(text, finalUrl)
  if (!hls.variants.length) return { url, height: null }

  // Sorted tallest first. A master playlist can also list a rendition with no
  // RESOLUTION at all — an audio-only one — and that must never be what "best"
  // or a failed cap lands on.
  const rejected = new Set(resolved.rejectedVariantUrls || [])
  const viable = hls.variants.filter((v) => !rejected.has(v.url))
  if (!viable.length) throw new Error('Bu oynatıcının kalite bağlantıları artık geçerli değil. Kaynak yeniden çözümlenmeli.')
  const video = viable.filter((v) => v.height)
  const ranked = video.length ? video : viable
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
  const tracks = (hls.audioTracks || []).filter((t) => !chosen.audioGroup || t.group === chosen.audioGroup)
  const lang = languageCode(preferred)
  const audio = tracks.find((t) => languageCode(t.lang) === lang) || tracks.find((t) => t.default) || tracks[0]
  if (lang !== 'auto' && audio?.lang && languageCode(audio.lang) !== lang) onNote?.(`İstenen ses dili yok; ${audio.lang} ses mevcut`)
  return { url: chosen.url || url, height: chosen.height || null, audioUrl: audio?.url || null, audioLanguage: audio?.lang || null }
}

function rateLimiter(value, signal = null) {
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*([kmg])?(?:i?b)?$/i)
  const rate = match ? Number(match[1]) * 1024 ** ({ k: 1, m: 2, g: 3 }[(match[2] || '').toLowerCase()] || 0) : 0
  if (!(rate > 0)) return null
  let next = Date.now()
  return async (bytes) => {
    const now = Date.now()
    const delay = Math.max(0, next - now)
    next = Math.max(now, next) + bytes / rate * 1000
    if (delay > 0) await sleep(delay, signal)
  }
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
function openStream(rawUrl, headers, { redirects = 5, proxy = '', signal = null, resolved = null } = {}) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(rawUrl)
    } catch (err) {
      return reject(err)
    }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return reject(new Error('Geçersiz akış protokolü veya adresi.'))
    if (resolved) {
      headers = { ...headers }
      for (const key of Object.keys(headers)) if (/^cookie$/i.test(key)) delete headers[key]
      const cookie = fetchHeaders(target.href, resolved).Cookie
      if (cookie) headers.Cookie = cookie
    }
    const mod = target.protocol === 'http:' ? http : https
    const tunnel = proxy ? agentsFor(proxy) : null
    if (proxy && !tunnel) return reject(new Error(`Vekil adresi anlaşılamadı: ${proxy}`))
    const agent = tunnel ? tunnel[target.protocol] : AGENTS[target.protocol]

    const req = mod.request(target, { headers, agent, signal, autoSelectFamily: !proxy }, (res) => {
      // An abort may arrive between response delivery and the caller attaching
      // its iterator. Keep that interval from emitting an unhandled error.
      res.on('error', () => {})
      const location = res.headers.location
      if (location && res.statusCode >= 300 && res.statusCode < 400 && redirects > 0) {
        res.resume() // drain, or the socket is never reusable
        let next
        try { next = new URL(location, target).href } catch (err) { req.destroy(); reject(err); return }
        const nextHeaders = { ...headers }
        if (new URL(next).origin !== target.origin) {
          for (const key of Object.keys(nextHeaders)) if (/^(cookie|authorization|origin)$/i.test(key)) delete nextHeaders[key]
        }
        return resolve(openStream(next, nextHeaders, { redirects: redirects - 1, proxy, signal, resolved }))
      }
      resolve({ status: res.statusCode, headers: res.headers, stream: res, request: req, finalUrl: target.href })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(Object.assign(new Error('Sunucu yanıt vermedi.'), { code: 'ETIMEDOUT' })))
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

function makePlan(size, connections, validator = null) {
  // Small tasks shared by all workers: a fast connection immediately takes the
  // next task, instead of waiting for a slow lane's quarter of a whole film.
  const chunk = Math.max(1024 * 1024, Math.min(4 * 1024 * 1024, Math.ceil(size / (connections * 8))))
  const parts = []
  for (let start = 0; start < size; start += chunk) {
    parts.push({ start, end: Math.min(start + chunk, size) - 1, done: 0 })
  }
  return { version: 2, size, validator, parts }
}

function readPlan(planPath, size, validator = null) {
  try {
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
    if (!plan || plan.size !== size || plan.validator !== validator || !Array.isArray(plan.parts) || !plan.parts.length) return null
    let next = 0
    for (const p of plan.parts) {
      if (![p.start, p.end, p.done].every(Number.isSafeInteger)) return null
      if (p.start !== next || p.end < p.start || p.end >= size || p.done < 0 || p.done > p.end - p.start + 1) return null
      next = p.end + 1
    }
    return next === size ? plan : null
  } catch { return null }
}

function savePlan(planPath, plan) {
  // Runtime state is deliberately excluded from the resume journal.
  atomicWrite(planPath, JSON.stringify({ ...plan, parts: plan.parts.map(({ start, end, done }) => ({ start, end, done })) }))
}

async function fetchFileParallel({
  url,
  resolved,
  destPath,
  size,
  connections,
  validator = null,
  limit = null,
  proxy = '',
  onProgress,
  onHandle,
  onNote,
}) {
  const partPath = `${destPath}.part`
  const planPath = planPathFor(partPath)

  let plan = readPlan(planPath, size, validator)
  let resumed = false
  if (plan && fs.existsSync(partPath) && fs.statSync(partPath).size === size) {
    resumed = plan.parts.some((p) => p.done > 0)
  } else {
    plan = makePlan(size, connections, validator)
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
  const controller = new AbortController()
  onHandle({ kill() { stopped = true; controller.abort() } })
  const doneBytes = () => plan.parts.reduce((sum, p) => sum + p.done, 0)
  const stats = new TransferStats(doneBytes())
  let lastAt = 0
  let lastSaved = Date.now()
  const lanes = Array.from({ length: Math.min(connections, plan.parts.length) }, () => ({ done: 0, size: 0 }))
  const tick = () => {
    const now = Date.now()
    if (now - lastAt < 400) return
    lastAt = now
    const downloaded = doneBytes()
    if (now - lastSaved > 1000) { savePlan(planPath, plan); lastSaved = now }
    onProgress({ downloaded, total: size, totalExact: true, ...stats.update(downloaded, size),
      percent: downloaded / size, parts: lanes.map((p) => ({ ...p })) })
  }
  const ticker = setInterval(tick, 500)

  const runPart = async (part, lane) => {
    const capacity = part.end - part.start + 1
    lanes[lane] = { done: part.done, size: capacity }
    let attempts = 0
    while (part.done < capacity) {
      if (controller.signal.aborted) throw abortError()
      const from = part.start + part.done
      let res = null
      try {
        res = await openStream(url, {
          ...fetchHeaders(url, resolved), 'Accept-Encoding': 'identity',
          Range: `bytes=${from}-${part.end}`, ...(validator ? { 'If-Range': validator } : {}),
        }, { proxy, signal: controller.signal, resolved })
        if (res.status !== 206) {
          if (res.status === 200 || res.status === 416) {
            throw Object.assign(new Error('Sunucu parçalı indirmeyi reddetti.'), { code: 'NO_RANGE' })
          }
          throw httpError(res.status, res.headers)
        }
        const range = String(res.headers['content-range'] || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/i)
        if (!range || Number(range[1]) !== from || Number(range[2]) !== part.end || Number(range[3]) !== size) {
          throw Object.assign(new Error('Sunucu yanlış bayt aralığı döndürdü.'), { code: 'NO_RANGE' })
        }
        const handle = await fsp.open(partPath, 'r+')
        try {
          for await (const chunk of res.stream) {
            if (controller.signal.aborted) throw abortError()
            const room = capacity - part.done
            if (room <= 0) break
            const slice = chunk.subarray(0, room)
            if (limit) await limit(slice.length)
            let written = 0
            while (written < slice.length) {
              const out = await handle.write(slice, written, slice.length - written, part.start + part.done)
              if (!out.bytesWritten) throw new Error('Dosyaya yazılamadı.')
              written += out.bytesWritten
              part.done += out.bytesWritten
              lanes[lane].done = part.done
            }
            tick()
          }
        } finally { await handle.close() }
        if (part.done < capacity) throw Object.assign(new Error('Parça eksik indi.'), { code: 'ECONNRESET' })
      } catch (err) {
        if (controller.signal.aborted) throw abortError()
        res?.request.destroy()
        const kind = failureKind(err)
        if (!['network', 'busy'].includes(kind) || attempts >= 4) throw err
        onNote?.(`bağlantı yenileniyor; alınan parçalar korunuyor (${attempts + 1}/4)`)
        await sleep(retryDelay(attempts++, kind, err.retryAfter), controller.signal)
      } finally { res?.request.destroy() }
    }
  }

  let cursor = 0
  const worker = async (lane) => {
    while (cursor < plan.parts.length && !controller.signal.aborted) {
      const part = plan.parts[cursor++]
      if (part.done < part.end - part.start + 1) await runPart(part, lane)
    }
  }
  let firstError = null
  try {
    await Promise.allSettled(lanes.map((_, lane) => worker(lane).catch((err) => {
      if (!firstError) firstError = err
      controller.abort()
    })))
  } finally {
    clearInterval(ticker)
    savePlan(planPath, plan)
  }
  // Wait for every writer to close BEFORE falling back, deleting or renaming.
  if (stopped) throw abortError()
  if (firstError) throw firstError
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

async function fetchFile({ url, resolved, destPath, validator = null, limit = null, proxy = '', onProgress, onHandle }) {
  const partPath = `${destPath}.part`
  let already = 0
  try {
    already = fs.statSync(partPath).size
  } catch {
    /* nothing to resume */
  }

  const journal = `${partPath}.single`
  let previous = null
  try { previous = JSON.parse(fs.readFileSync(journal, 'utf8')) } catch {}
  if (already && (!previous || previous.validator !== validator || (!validator && previous.url !== url))) already = 0
  atomicWrite(journal, JSON.stringify({ url, validator }))

  let stopped = false
  let request = null
  const controller = new AbortController()
  onHandle({
    kill() {
      stopped = true
      controller.abort()
      if (request) {
        try {
          request.destroy()
        } catch {
          /* already gone */
        }
      }
    },
  })

  const headers = { ...fetchHeaders(url, resolved) }
  if (already > 0) { headers.Range = `bytes=${already}-`; if (validator) headers['If-Range'] = validator }

  // Same client as the parallel path: one place that knows about redirects,
  // timeouts and proxies, rather than fetch here and http over there.
  const res = await openStream(url, headers, { proxy, signal: controller.signal, resolved }).catch((err) => {
    if (stopped) throw abortError()
    throw err
  })
  request = res.request
  if (res.status !== 200 && res.status !== 206) {
    request.destroy()
    throw httpError(res.status, res.headers)
  }

  // A redirect to a login wall or an error page answers 200 with HTML. Copying
  // those bytes would produce a .mp4 that is really a web page — saved, listed as
  // finished, and unplayable.
  const type = String(res.headers['content-type'] || '').toLowerCase()
  if (/^(text\/|application\/(x?html|json|xml))/.test(type)) {
    request.destroy()
    throw new Error(`Bağlantı video değil, ${type.split(';')[0]} döndürdü — akış adresi geçmiş olabilir.`)
  }

  // A server that ignores Range restarts the file; keeping the old bytes would
  // corrupt it, so start over rather than append.
  let resuming = already > 0 && res.status === 206
  if (res.status === 206 && Number((String(res.headers['content-range'] || '').match(/^bytes (\d+)-/i) || [])[1]) !== already) {
    request.destroy()
    fs.rmSync(partPath, { force: true })
    throw Object.assign(new Error('Sürdürme aralığı geçersiz.'), { code: 'ECONNRESET' })
  }
  if (already > 0 && !resuming) already = 0

  // No Content-Length means no total. Adding what we already have to a zero would
  // report the part we resumed from as the whole file — a meter stuck at 100%.
  const declared = Number(res.headers['content-length']) || 0
  const total = declared ? (resuming ? already + declared : declared) : null

  const out = fs.createWriteStream(partPath, { flags: resuming ? 'a' : 'w' })
  let downloaded = already
  let lastAt = Date.now()
  const stats = new TransferStats(downloaded)

  // Count inside the pipeline rather than on a 'data' listener: subscribing to
  // 'data' starts the stream flowing before pipeline has hooked up the sink, and
  // the first chunks go on the floor.
  const report = () => {
    const now = Date.now()
    lastAt = now
    onProgress({
      downloaded,
      total,
      // Content-Length is a real length, not a guess — say so, so the caller
      // doesn't second-guess it with an estimate.
      totalExact: !!total,
      ...stats.update(downloaded, total),
      percent: total ? downloaded / total : null,
    })
  }

  const meter = new Transform({
    transform(chunk, _enc, done) {
      Promise.resolve(limit?.(chunk.length)).then(() => {
        downloaded += chunk.length
        if (Date.now() - lastAt >= 400) report()
        done(null, chunk)
      }, done)
    },
    // A small file can finish inside one reporting window, which would leave the
    // meter showing nothing at all. Report once more on the way out.
    flush(done) {
      report()
      done()
    },
  })

  try {
    await pipeline(res.stream, meter, out)
  } catch (err) {
    if (stopped) throw abortError()
    throw err
  }

  if (stopped) throw abortError()
  if (total && downloaded !== total) throw Object.assign(new Error('Dosya eksik indi.'), { code: 'ECONNRESET' })
  fs.renameSync(partPath, destPath)
  fs.rmSync(journal, { force: true })
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

function ffmpegArgs({ url, resolved, audioUrl = null, selectedAudioIndex = null, destPath, workPath, download, settings }) {
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
    '-reconnect', '1', '-reconnect_streamed', '1',
    '-reconnect_on_network_error', '1', '-reconnect_on_http_error', '429,500,502,503,504',
    '-reconnect_delay_max', '8',
    ...ffprobeHeaderArgs(url, resolved),
    '-i',
    url,
  ]

  if (audioUrl) args.push(...ffprobeHeaderArgs(audioUrl, resolved), '-i', audioUrl)
  if (audioUrl) args.push('-map', '0:v:0?', '-map', '1:a:0')
  else if (selectedAudioIndex !== null) args.push('-map', '0:v:0?', '-map', `0:${selectedAudioIndex}`)

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

function runFfmpeg({
  url,
  resolved,
  audioUrl = null,
  selectedAudioIndex = null,
  destPath,
  workPath,
  download,
  settings,
  proxy = '',
  onProgress,
  onHandle,
}) {
  return new Promise((resolve, reject) => {
    const bin = ffmpegPath()
    if (!bin) return reject(new Error('ffmpeg bulunamadı. yt-dlp kapalıyken indirme ona dayanır.'))

    // ffmpeg has no SOCKS support of any kind. Downloading unproxied while the
    // interface shows a proxy badge would be a lie, so this combination stops
    // and says what to change.
    let env = toolEnv()
    if (proxy) {
      const vars = ffmpegEnv(proxy)
      if (!vars) {
        return reject(
          new Error(
            `Bu akış ffmpeg ile iniyor ve ffmpeg ${parseProxy(proxy)?.protocol || 'bu'} vekilini desteklemiyor. ` +
              'Vekilli indirmek için Ayarlar → Erişim\'den yt-dlp\'yi aç, ya da bir HTTP vekili gir.'
          )
        )
      }
      env = { ...env, ...vars }
    }

    const child = spawn(
      bin,
      ffmpegArgs({ url, resolved, audioUrl, selectedAudioIndex, destPath, workPath, download, settings }),
      { env, windowsHide: true }
    )
    onHandle(child)

    const duration = Number(download.duration) || 0
    let buffer = ''
    let stderr = ''
    let fields = {}
    const stats = new TransferStats()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const [rawKey, rawValue] = line.split('=')
        if (rawKey && rawValue !== undefined) fields[rawKey.trim()] = rawValue.trim()
      }
      if (!fields.progress) return

      const outSeconds = Number(fields.out_time_us || fields.out_time_ms || 0) / 1e6
      const bytes = Number(fields.total_size) || 0

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
        ...stats.update(bytes, null),
        eta,
        percent,
      })
      fields = {}
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
  signal = null,
}) {
  // Resolving a gated page can take most of a minute, and during that stretch
  // there is no process to kill — so pause and cancel are checked at each phase
  // boundary instead of being silently ignored until the first byte moves.
  const halt = () => {
    if (isStopped && isStopped()) throw abortError()
  }

  const proxy = download.useProxy ? String(settings.proxyUrl || '').trim() : ''

  const located = await locateStream(download, settings, onNote, signal)
  halt()
  let { url } = located
  const { resolved, kind } = located
  download.resolved = resolved
  download.url = located.url
  let audioUrl = null
  let audioLanguage = null

  if (kind === 'hls') {
    const picked = await pickVariant(url, resolved, download.quality, onNote, proxy, download.preferredAudioLanguage || settings.preferredAudioLanguage || 'en', signal)
    audioUrl = picked.audioUrl || null
    audioLanguage = picked.audioLanguage || null
    url = download.audioOnly && audioUrl ? audioUrl : picked.url
    if (download.audioOnly) audioUrl = null
    halt()
  }

  const dir = settings.downloadDir
  fs.mkdirSync(dir, { recursive: true })
  const base = safeName(download.title || 'video')
  const destPath = download.ownDestPath && path.dirname(download.ownDestPath) === dir && !fs.existsSync(download.ownDestPath)
    ? download.ownDestPath : freePath(dir, base, extensionFor(download, settings, url, kind))
  download.ownDestPath = destPath
  // Tell the caller where we are writing, so a cancelled transfer can clean up
  // after itself the same way the yt-dlp path does.
  onDest?.(destPath)

  onStage?.('downloading')

  // A plain file is a byte copy, and a byte copy can be resumed. Anything
  // segmented has to be assembled, and only ffmpeg does that properly.
  const plain = kind === 'file' && !download.audioOnly
  const limit = rateLimiter(settings.rateLimit, signal)
  if (plain) {
    // Ask what this file is before fetching it: the length gives the meter a
    // target from the first byte, and whether the server serves ranges decides
    // between four connections and one.
    const probed = await probeVia(url, resolved, proxy, signal).catch(() => ({ size: null, ranges: false }))
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

    const connections = Math.max(1, Math.floor(Math.min(16, settingNumber(settings.connections, 8))))
    if (probed.size && probed.ranges && connections > 1 && probed.size >= MIN_MULTIPART) {
      try {
        const out = await fetchFileParallel({
          url,
          resolved,
          destPath,
          size: probed.size,
          connections,
          validator: probed.validator || null,
          limit,
          proxy,
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

    if (fs.existsSync(planPathFor(`${destPath}.part`))) {
      fs.rmSync(planPathFor(`${destPath}.part`), { force: true })
      fs.rmSync(`${destPath}.part`, { force: true })
    }
    return { filePath: await fetchFile({ url, resolved, destPath, validator: probed.validator || null, limit, proxy, onProgress, onHandle }) }
  }

  if (kind === 'hls' && settings.nativeHls !== false) {
    try {
      return await require('./hls-native').transferHls({ url, audioUrl, audioLanguage, resolved, destPath, download,
        settings: { ...settings, connections: download.recoveryConnections || settings.connections },
        proxy, signal, onProgress, onHandle, onNote, onStage, limit })
    } catch (err) {
      halt()
      if (err.code !== 'HLS_UNSUPPORTED') throw err
      onNote?.('Bu HLS türü için alternatif aktarım motoru deneniyor')
    }
  }
  // FFmpeg cannot enforce Netscape host-only/Secure cookie scope across all
  // supported versions and redirects. Cookie-bearing HLS uses scoped native
  // requests above; unsupported remote formats must fail safely.
  if (resolved.cookieFile) throw new Error('Bu akış oturum çerezleri gerektiriyor ve güvenli yerel aktarım biçimi henüz desteklenmiyor. yt-dlp motorunu etkinleştirerek yeniden deneyebilirsin.')
  let selectedAudioIndex = null
  const preferred = languageCode(download.preferredAudioLanguage || settings.preferredAudioLanguage || 'en')
  if (!audioUrl && preferred !== 'auto') {
    const info = await require('./mediainfo').ffprobeMedia(url, { ...resolved, proxy })
    halt()
    selectedAudioIndex = info?.audioTracks?.find((t) => languageCode(t.lang) === preferred)?.index ?? null
  }
  const filePath = await runFfmpeg({
    url,
    resolved,
    audioUrl,
    selectedAudioIndex,
    destPath,
    workPath: `${destPath}.part`,
    download,
    settings,
    proxy,
    onProgress,
    onHandle,
  })
  if (kind === 'hls') require('./hls-native').cleanCache(destPath)
  return { filePath }
}

module.exports = { transfer, pickVariant, makePlan, readPlan, fetchFileParallel, fetchFile, probeVia, ffmpegArgs, openStream }
