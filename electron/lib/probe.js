'use strict'

// Turning a pasted link into a source group + a list of media items.
//
// Two passes, so the list shows up fast:
//   1. `yt-dlp -J --flat-playlist` — one call, gives titles/durations/thumbs for
//      playlists, channels and any page the generic extractor can read.
//   2. enrichment — for entries that came back without a duration or thumbnail,
//      fetch per-item metadata with a small concurrency pool and patch them in.

const { spawn } = require('child_process')
const store = require('./store')
const { toolEnv, ytdlpPathOrThrow } = require('./binaries')
const { resolveCookieArg, exportCookieJar } = require('./browsers')
const { resolvePage } = require('./resolver')
const { describeStream } = require('./mediainfo')
const { uid, siteLabel, hostOf, num, resolvedArgs } = require('./util')

const MAX_JSON = 64 * 1024 * 1024 // channels can dump a lot of JSON

const running = new Map() // sourceId -> child process

function baseArgs(settings) {
  const args = ['--no-warnings', '--ignore-config', '--socket-timeout', '20', '--retries', '3']
  const cookies = resolveCookieArg(settings.cookiesBrowser)
  if (cookies) args.push('--cookies-from-browser', cookies)
  return args
}

function runJson(url, extraArgs, settings, trackKey = null) {
  return new Promise((resolve, reject) => {
    let bin
    try {
      bin = ytdlpPathOrThrow()
    } catch (err) {
      return reject(err)
    }
    const args = [...baseArgs(settings), ...extraArgs, url]
    const child = spawn(bin, args, { env: toolEnv(), windowsHide: true })
    if (trackKey) running.set(trackKey, child)
    let out = ''
    let err = ''
    let killed = false
    child.stdout.on('data', (chunk) => {
      out += chunk
      if (out.length > MAX_JSON && !killed) {
        killed = true
        child.kill()
      }
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
      if (err.length > 200000) err = err.slice(-100000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      const trimmed = out.trim()
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed)
          // `yt-dlp -J` prints the literal `null` when extraction fails, so a
          // clean parse is not the same thing as a usable result.
          if (parsed && typeof parsed === 'object') {
            return resolve({ json: parsed, stderr: err })
          }
        } catch {
          /* fall through to the error path */
        }
      }
      // Carry the raw stderr along: callers decide what to retry based on the
      // original English, not the translated message.
      const error = new Error(readableError(err, code))
      error.raw = err
      reject(error)
    })
  })
}

/** yt-dlp speaks in stack-trace English; say the same thing usefully. */
const FRIENDLY = [
  [
    /could not find ([a-z]+) cookies database/i,
    (m) =>
      `${m[1]} çerez veritabanı bulunamadı. Ayarlar → Erişim'den başka bir tarayıcı seç veya "Yok" yap.`,
  ],
  [/cookies? (?:file|database).*(?:not found|unreadable)/i, () => 'Tarayıcı çerezleri okunamadı. Ayarlar → Erişim bölümünü kontrol et.'],
  [/sign in to confirm you.?re not a bot/i, () => 'Site bot doğrulaması istiyor. Ayarlar → Erişim\'den tarayıcı çerezlerini seç.'],
  [/sign in to confirm your age|age.?restricted/i, () => 'Yaş doğrulaması gerekiyor. Ayarlar → Erişim\'den tarayıcı çerezlerini seç.'],
  [/private video|this video is private/i, () => 'Bu video özel.'],
  [/members.?only|available to this channel.s members/i, () => 'Bu içerik yalnızca kanal üyelerine açık.'],
  [/video unavailable/i, () => 'Video kullanılamıyor.'],
  [/unsupported url/i, () => 'Bu bağlantıda tanınan bir video bulunamadı.'],
  [/no video formats found|requested format is not available/i, () => 'İndirilebilir bir video akışı bulunamadı.'],
  [/http error 404/i, () => 'Sayfa bulunamadı (404).'],
  [/http error 403/i, () => 'Erişim reddedildi (403). Giriş gerekiyor olabilir.'],
  [/http error 429|too many requests/i, () => 'Site çok fazla istek gördü (429). Biraz bekle.'],
  [/not available (?:from )?your (?:location|country)|geo.?restricted/i, () => 'Bu içerik bölgesel olarak kısıtlı.'],
  [/is not a valid url/i, () => 'Geçersiz bağlantı.'],
  [/unable to (?:download|resolve)|getaddrinfo|name or service not known|network is unreachable/i, () => 'Ağa ulaşılamadı. Bağlantını kontrol et.'],
]

/** Pull the useful line out of a wall of yt-dlp stderr. */
function readableError(stderr, code) {
  const blob = String(stderr || '')
  for (const [pattern, render] of FRIENDLY) {
    const match = blob.match(pattern)
    if (match) return render(match)
  }
  const lines = blob
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const errLine = lines.filter((l) => /^ERROR:/i.test(l)).pop()
  if (errLine) {
    return errLine
      .replace(/^ERROR:\s*/i, '')
      .replace(/^\[[^\]]+\]\s*/, '')
      .replace(/;\s*Confirm you are on the latest version.*$/i, '')
      .trim()
  }
  const last = lines.pop()
  return last || `yt-dlp ${code} koduyla çıktı`
}

/** True when the failure is the browser-cookie setting, not the link itself. */
function isCookieFailure(text) {
  return /cookies? (?:database|file)|cookiesfrombrowser|could not find .* cookies|çerez veritaban/i.test(
    String(text || '')
  )
}

function bestThumb(node) {
  if (node.thumbnail) return node.thumbnail
  const list = node.thumbnails
  if (Array.isArray(list) && list.length) {
    // Prefer a mid-size thumbnail: the largest one can be several MB.
    const withW = list.filter((t) => t && t.url)
    if (!withW.length) return null
    const sorted = [...withW].sort((a, b) => (a.width || 0) - (b.width || 0))
    const mid = sorted.find((t) => (t.width || 0) >= 320) || sorted[sorted.length - 1]
    return mid.url || null
  }
  return null
}

function heightOf(node) {
  const h = num(node.height)
  if (h) return h
  const res = node.resolution
  if (typeof res === 'string') {
    const m = res.match(/(\d+)\s*x\s*(\d+)/)
    if (m) return Number(m[2])
  }
  const formats = node.formats
  if (Array.isArray(formats)) {
    let best = 0
    for (const f of formats) {
      const fh = num(f && f.height)
      if (fh && fh > best) best = fh
    }
    if (best) return best
  }
  return null
}

function itemFromNode(node, source, index) {
  const url = node.webpage_url || node.url || node.original_url || ''
  return {
    id: uid('it'),
    sourceId: source.id,
    index,
    url,
    title: node.title || node.id || 'Adsız',
    duration: num(node.duration),
    thumbnail: bestThumb(node),
    uploader: node.uploader || node.channel || node.playlist_uploader || null,
    ext: node.ext || null,
    height: heightOf(node),
    filesize: num(node.filesize) || num(node.filesize_approx) || null,
    isLive: !!node.is_live,
    // Used later to avoid subtitling a video in the language it already speaks.
    language: node.language || null,
    site: siteLabel(url || source.url, node.extractor_key || node.ie_key),
    addedAt: Date.now(),
    // A flat-playlist entry with no duration needs a second look.
    enriched: node.duration !== undefined && node.duration !== null,
  }
}

/**
 * Add the source row up front, before any network work. Lets the caller answer
 * the renderer immediately and probe in the background.
 */
function createSource(url) {
  const source = {
    id: uid('src'),
    url,
    host: hostOf(url),
    site: siteLabel(url),
    title: null,
    uploader: null,
    kind: 'unknown',
    status: 'queued',
    error: null,
    collapsed: false,
    addedAt: Date.now(),
    count: 0,
    enriching: 0,
    stage: null,
    note: null,
    resolvedBy: null,
  }
  store.commit((s) => {
    s.sources.unshift(source)
  })
  return source
}

/**
 * Probe a URL and fill the source with whatever media the page holds.
 * Without a sourceId the row is created here; with one it is a rescan.
 */
async function probeUrl(url, { sourceId = null, playlistEnd = 0 } = {}) {
  const source = sourceId ? store.findSource(sourceId) : createSource(url)
  if (!source) return null
  try {
    return await runProbe(source, playlistEnd)
  } catch (err) {
    // A source must never be left spinning. Anything unexpected becomes visible.
    if (source.status === 'probing' || source.status === 'queued') {
      store.commit(() => {
        source.status = 'error'
        source.error = (err && err.message) || 'Beklenmeyen bir hata oldu.'
      })
    }
    running.delete(source.id)
    return source
  }
}

async function runProbe(source, playlistEnd) {
  const settings = store.getState().settings

  store.commit((s) => {
    source.status = 'probing'
    source.stage = 'ytdlp'
    source.note = null
    source.error = null
    // A rescan replaces the found media but leaves downloads alone.
    s.items = s.items.filter((i) => i.sourceId !== source.id)
  })

  const extra = ['-J', '--flat-playlist']
  if (playlistEnd > 0) extra.push('--playlist-end', String(playlistEnd))

  let json = null
  let effective = settings
  let failure = null
  let missingTool = false

  try {
    const res = await runJson(source.url, extra, effective, source.id)
    json = res.json
  } catch (err) {
    const message = err && err.code === 'NO_YTDLP' ? 'yt-dlp kurulu değil.' : err.message
    missingTool = !!(err && err.code === 'NO_YTDLP')
    // A broken cookie setting shouldn't cost the user their list: drop cookies
    // for this run, say so, and carry on.
    if (!missingTool && settings.cookiesBrowser && isCookieFailure(err.raw || message)) {
      effective = { ...settings, cookiesBrowser: '' }
      store.toast(`${message} Çerezsiz denendi.`, 'warn')
      try {
        const res = await runJson(source.url, extra, effective, source.id)
        json = res.json
      } catch (retryErr) {
        failure = retryErr.message
      }
    } else {
      failure = message
    }
  }
  running.delete(source.id)

  if (missingTool) {
    store.commit(() => {
      source.status = 'error'
      source.stage = null
      source.error = 'yt-dlp kurulu değil.'
    })
    return source
  }

  // yt-dlp couldn't read the page. Hand it to our own resolver.
  if (failure || !json || typeof json !== 'object') {
    await tryResolve(source, effective, failure)
    return source
  }

  const nodes = []
  if (json._type === 'playlist') {
    const entries = Array.isArray(json.entries) ? json.entries : []
    for (const entry of entries) {
      if (!entry) continue
      // Nested playlists (a channel's tabs) — flatten one level.
      if (entry._type === 'playlist' && Array.isArray(entry.entries)) {
        for (const sub of entry.entries) if (sub) nodes.push(sub)
      } else {
        nodes.push(entry)
      }
    }
  } else if (json) {
    nodes.push(json)
  }

  const playable = nodes.filter((n) => n && (n.url || n.webpage_url || n.id))
  const items = playable.map((n, i) => itemFromNode(n, source, i))

  // yt-dlp answered but found nothing playable — our resolver may still see it.
  if (!items.length) {
    await tryResolve(source, effective, null)
    return source
  }

  store.commit((s) => {
    source.title = json.title || json.playlist_title || (items[0] && items[0].title) || null
    source.uploader = json.uploader || json.channel || json.playlist_uploader || null
    source.site = siteLabel(json.webpage_url || source.url, json.extractor_key || json.ie_key)
    source.kind = json._type === 'playlist' ? 'playlist' : 'video'
    source.count = items.length
    source.status = 'ready'
    source.error = null
    source.stage = null
    source.note = null
    source.resolvedBy = 'yt-dlp'
    source.probedAt = Date.now()
    s.items.push(...items)
  })

  enrich(source.id, effective).catch(() => {})
  return source
}

/* ========================================================================== *
 * fallback: our own page resolver
 * ========================================================================== */

function itemFromCandidate(candidate, source, index, title, userAgent, total, thumbnail) {
  const info = candidate.info || null
  const suffix = total > 1 ? ` · akış ${index + 1}` : ''
  return {
    id: uid('it'),
    sourceId: source.id,
    index,
    url: candidate.url,
    title: `${title || hostOf(source.url) || 'Adsız'}${suffix}`,
    duration: info ? info.duration : null,
    thumbnail: thumbnail || null,
    uploader: null,
    ext: candidate.kind === 'hls' ? 'm3u8' : candidate.kind === 'dash' ? 'mpd' : null,
    height: info ? info.height : null,
    filesize: info ? info.filesize : null,
    isLive: info ? !!info.live : false,
    site: hostOf(source.url) || source.site,
    addedAt: Date.now(),
    // Verified during resolution — no second metadata pass needed.
    enriched: !!(info && (info.duration || info.height)),
    variants: info && info.variants ? info.variants.map((v) => v.height).filter(Boolean) : [],
    drm: !!(info && info.drm),
    resolved: {
      pageUrl: source.url,
      referer: candidate.referer || source.url,
      origin: candidate.origin || '',
      userAgent,
      cookieFile: candidate.cookieFile || null,
      kind: candidate.kind,
      engine: candidate.via,
    },
  }
}

/**
 * Run the in-house resolver and turn whatever it finds into media items.
 * Always leaves the source in a terminal state, never spinning.
 */
async function tryResolve(source, settings, fallbackError) {
  if (settings.useResolver === false) {
    store.commit(() => {
      source.status = 'error'
      source.stage = null
      source.note = null
      source.error = fallbackError || 'Bu sayfada indirilebilir bir şey bulunamadı.'
    })
    return
  }

  store.commit(() => {
    source.status = 'probing'
    source.stage = 'resolver'
    source.note = 'sayfa taranıyor'
    source.error = null
  })

  // Hand the resolver the user's browser session so pages that want them signed
  // in behave the same as in their own browser.
  let browserCookieJar = null
  if (settings.cookiesBrowser) {
    store.commit(() => { source.note = 'tarayıcı oturumu alınıyor' })
    browserCookieJar = await exportCookieJar(settings.cookiesBrowser).catch(() => null)
  }

  let result = null
  try {
    result = await resolvePage(source.url, {
      browserCookieJar,
      minStreamSeconds: Math.max(0, Number(settings.minStreamSeconds) ?? 120),
      timeoutMs: Math.max(8000, Number(settings.resolverTimeout) || 45000),
      onProgress: (message) => {
        const live = store.findSource(source.id)
        if (live) store.commit(() => { live.note = message })
      },
    })
  } catch (err) {
    console.error('[resolver]', err)
  }

  const candidates = (result && result.candidates) || []

  if (!candidates.length) {
    const adsOnly = result && result.adsSkipped > 0
    store.commit(() => {
      source.status = 'error'
      source.stage = null
      source.note = null
      const shortest =
        result && Number.isFinite(result.shortest) ? Math.round(result.shortest) : null
      source.error =
        result && result.encrypted
          ? 'Bu akış DRM korumalı — indirilemez.'
          : result && result.shortOnly
            ? `Yalnızca ${shortest ? `${shortest} sn'lik ` : 'kısa '}bir akış geldi — bu reklam. Video akışı süre içinde başlamadı: Ayarlar → Erişim'den beklemeyi artır, ya da gerçekten kısa bir video ise "En kısa video süresi"ni Yok yap.`
            : adsOnly
              ? `${result.adsSkipped} reklam akışı atlandı, video akışı gelmedi. Ayarlar → Erişim'den beklemeyi artırıp yeniden dene.`
              : fallbackError || 'Sayfada oynatılabilir bir akış bulunamadı.'
    })
    return
  }

  const title = (result.title || source.title || hostOf(source.url) || '').trim()
  const picked = candidates.slice(0, 8)
  const items = picked.map((c, i) =>
    itemFromCandidate(c, source, i, title, result.userAgent, picked.length, result.thumbnail)
  )
  const drmOnly = items.length > 0 && items.every((i) => i.drm)

  store.commit((s) => {
    source.title = title || source.url
    source.site = hostOf(source.url) || source.site
    source.kind = 'video'
    source.count = items.length
    source.status = 'ready'
    source.error = drmOnly ? 'Bulunan akışlar DRM korumalı — indirilemez.' : null
    source.stage = null
    source.note = null
    source.resolvedBy = result.engine === 'browser' ? 'tarayıcı motoru' : 'sayfa taraması'
    source.probedAt = Date.now()
    s.items.push(...items)
  })

  enrichResolved(source.id).catch(() => {})
}

/**
 * Second chance at metadata for resolved streams the verification pass couldn't
 * read: ffprobe and the manifest parser first, yt-dlp as a last resort.
 */
async function enrichResolved(sourceId) {
  const pending = store.itemsOfSource(sourceId).filter((i) => i.resolved && !i.enriched)
  const source = store.findSource(sourceId)
  if (!pending.length) return
  if (source) store.commit(() => { source.enriching = pending.length })

  for (const item of pending) {
    let filled = false
    try {
      const info = await describeStream(item.url, item.resolved)
      if (info && (info.duration || info.height)) {
        filled = true
        store.commit(() => {
          const live = store.findItem(item.id)
          if (!live) return
          live.duration = info.duration ?? live.duration
          live.height = info.height || live.height
          live.filesize = info.filesize || live.filesize
          live.isLive = !!info.live
          live.variants = (info.variants || []).map((v) => v.height).filter(Boolean)
          live.drm = !!info.drm
          live.enriched = true
        })
      }
    } catch {
      /* fall through to yt-dlp */
    }

    if (!filled) {
      const bare = { ...store.getState().settings, cookiesBrowser: '' }
      try {
        const { json } = await runJson(
          item.url,
          ['-J', '--no-playlist', ...resolvedArgs(item.resolved)],
          bare
        )
        store.commit(() => {
          const live = store.findItem(item.id)
          if (!live || !json) return
          live.duration = num(json.duration) ?? live.duration
          live.height = heightOf(json) || live.height
          live.filesize = num(json.filesize) || num(json.filesize_approx) || live.filesize
          live.isLive = !!json.is_live
          live.enriched = true
        })
      } catch {
        store.commit(() => {
          const live = store.findItem(item.id)
          if (live) live.enriched = true
        })
      }
    }

    if (source) store.commit(() => { source.enriching = Math.max(0, source.enriching - 1) })
  }

  if (source) store.commit(() => { source.enriching = 0 })
}

/** Fill in duration/thumbnail for entries the flat pass left blank. */
async function enrich(sourceId, settingsOverride = null) {
  const settings = settingsOverride || store.getState().settings
  const limit = Math.max(0, Number(settings.enrichLimit) || 0)
  if (!limit) return
  const source = store.findSource(sourceId)
  if (!source) return
  const pending = store
    .itemsOfSource(sourceId)
    .filter((i) => !i.enriched && i.url)
    .slice(0, limit)
  if (!pending.length) return

  store.commit(() => {
    source.enriching = pending.length
  })

  const CONCURRENCY = 3
  let cursor = 0

  async function worker() {
    while (cursor < pending.length) {
      const item = pending[cursor++]
      if (!store.findItem(item.id)) continue
      try {
        const { json } = await runJson(
          item.url,
          ['-J', '--no-playlist', '--flat-playlist'],
          settings
        )
        store.commit(() => {
          const live = store.findItem(item.id)
          if (!live) return
          live.title = json.title || live.title
          live.duration = num(json.duration) ?? live.duration
          live.thumbnail = bestThumb(json) || live.thumbnail
          live.uploader = json.uploader || json.channel || live.uploader
          live.ext = json.ext || live.ext
          live.height = heightOf(json) || live.height
          live.filesize = num(json.filesize) || num(json.filesize_approx) || live.filesize
          live.isLive = !!json.is_live
          live.site = siteLabel(json.webpage_url || live.url, json.extractor_key)
          live.enriched = true
        })
      } catch {
        store.commit(() => {
          const live = store.findItem(item.id)
          if (live) live.enriched = true // don't retry forever
        })
      }
      const s = store.findSource(sourceId)
      if (s) store.commit(() => { s.enriching = Math.max(0, pending.length - cursor) })
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker))
  const s = store.findSource(sourceId)
  if (s) store.commit(() => { s.enriching = 0 })
}

function cancelProbe(sourceId) {
  const child = running.get(sourceId)
  if (child) {
    child.kill()
    running.delete(sourceId)
  }
}

function killAll() {
  for (const child of running.values()) {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
  running.clear()
}

module.exports = { createSource, probeUrl, cancelProbe, killAll, readableError, isCookieFailure }
