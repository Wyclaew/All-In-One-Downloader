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
const { resolvePage, assistedCapture, embedCandidatesFor } = require('./resolver')
const { describeStream } = require('./mediainfo')
const { uid, siteLabel, hostOf, num, resolvedArgs, settingNumber } = require('./util')

const { failureKind, retryDelay, sleep } = require('./recovery')
const { rankCandidates } = require('./media-preferences')
const { parseTitle } = require('./subtitles')
const network = require('./network-context')
const diagnostics = require('./diagnostics')

const MAX_JSON = 64 * 1024 * 1024 // channels can dump a lot of JSON

const running = new Map() // sourceId -> child process
const controllers = new Map()
const metadataJobs = new Map()

function baseArgs(settings) {
  const args = ['--no-warnings', '--ignore-config', '--socket-timeout', '20', '--retries', '3']
  const cookies = resolveCookieArg(settings.cookiesBrowser)
  if (cookies) args.push('--cookies-from-browser', cookies)
  // Set per source, not globally: two links can be resolving at the same moment,
  // one through the proxy and one straight out.
  args.push('--proxy', settings.proxy || '')
  return args
}

function runJsonOnce(url, extraArgs, settings, trackKey = null) {
  return new Promise((resolve, reject) => {
    let bin
    try {
      bin = ytdlpPathOrThrow()
    } catch (err) {
      return reject(err)
    }
    // `--` so the address can only ever be read as an address, never as an option.
    const args = [...baseArgs(settings), ...extraArgs, '--', url]
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
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL') }, 65000)
    const abort = () => { killed = true; child.kill() }
    if (settings.signal?.aborted) abort()
    else settings.signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (error) => { clearTimeout(timer); settings.signal?.removeEventListener('abort', abort); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      settings.signal?.removeEventListener('abort', abort)
      if (killed) return reject(Object.assign(new Error(settings.signal?.aborted ? 'Çözümleme durduruldu.' : 'Çözümleme zaman aşımına uğradı.'), { code: settings.signal?.aborted ? 'ABORTED' : 'ETIMEDOUT' }))
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

async function runJson(url, extraArgs, settings, trackKey = null) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await runJsonOnce(url, extraArgs, settings, trackKey) }
    catch (err) {
      if (settings.signal?.aborted || settings.autoRecover === false || attempt >= 2 || !['network', 'busy'].includes(failureKind(err))) throw err
      const source = trackKey && store.findSource(trackKey)
      if (source) note(source, `Geçici sunucu hatası; yeniden deneniyor (${attempt + 1}/2)`)
      await sleep(retryDelay(attempt, failureKind(err)), settings.signal)
    }
  }
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
  [
    /http error 403/i,
    () =>
      'Site erişimi reddetti (403). Oturum, site doğrulaması veya süresi dolmuş bir akış adresi olabilir; Tarayıcıda yakala ile kontrol edebilirsin.',
  ],
  [/http error 429|too many requests/i, () => 'Site çok fazla istek gördü (429). Biraz bekle.'],
  [/not available (?:from )?your (?:location|country)|geo.?restricted/i, () => 'Bu içerik bölgesel olarak kısıtlı.'],
  [/is not a valid url/i, () => 'Geçersiz bağlantı.'],
  [/getaddrinfo|name or service not known|ENOTFOUND/i, () => 'Sitenin alan adı çözülemedi. Site adresi, DNS veya vekil sunucu kaynaklı olabilir.'],
  [/timed? ?out|timeout/i, () => 'Site veya video sunucusu zamanında yanıt vermedi.'],
  [/network is unreachable|ENETUNREACH/i, () => 'Bu sunucuya ağ yolu bulunamadı. Vekil ve ağ ayarlarını kontrol et.'],
  [/certificate verify failed|SSL.*certificate/i, () => 'Sitenin güvenlik sertifikası doğrulanamadı.'],
  [/connection reset|remote.*closed|ECONNRESET/i, () => 'Site bağlantıyı yarıda kapattı.'],
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

/**
 * Failures a cookie-free retry can fix.
 *
 * Beyond an unreadable cookie store, sending cookies can itself be the problem:
 * given a signed-in session YouTube hands out format URLs from a different
 * client which then answer 403 when actually fetched, where an anonymous request
 * downloads fine. So a 403/401 or a bot-check prompt is worth one more attempt
 * without them before giving up.
 */
function isRetryableWithoutCookies(text) {
  const blob = String(text || '')
  if (isCookieFailure(blob)) return true
  return /http error 40[13]\b|\b403 forbidden|\b401 unauthorized|sign in to confirm/i.test(blob)
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

/**
 * How big each quality would be, worked out from yt-dlp's own format list.
 *
 * A page's answer to "how many GB is this" depends entirely on which rendition is
 * taken, so one number per item would be a guess. This mirrors what the download
 * selector picks — the tallest video within the cap, plus the best audio when the
 * video track carries none — and records a size per height.
 */
function sizesFromFormats(node) {
  const formats = Array.isArray(node.formats) ? node.formats : []
  if (!formats.length) return {}
  const duration = num(node.duration)

  const sizeOf = (f) => {
    const known = num(f.filesize) || num(f.filesize_approx)
    if (known) return known
    const tbr = num(f.tbr) // kbit/s
    return tbr && duration ? Math.round((tbr * 1000 * duration) / 8) : null
  }

  const hasVideo = (f) => f.vcodec && f.vcodec !== 'none'
  const hasAudio = (f) => f.acodec && f.acodec !== 'none'

  let bestAudio = 0
  for (const f of formats) {
    if (hasVideo(f) || !hasAudio(f)) continue
    const size = sizeOf(f)
    if (size && size > bestAudio) bestAudio = size
  }

  const sizes = {}
  for (const f of formats) {
    if (!hasVideo(f)) continue
    const height = num(f.height)
    if (!height) continue
    const size = sizeOf(f)
    if (!size) continue
    const total = hasAudio(f) ? size : size + bestAudio
    if (total > (sizes[height] || 0)) sizes[height] = total
  }
  if (bestAudio) sizes.audio = bestAudio
  return sizes
}

function itemFromNode(node, source, index) {
  const url = node.webpage_url || node.url || node.original_url || ''
  const sizes = sizesFromFormats(node)
  const heights = Object.keys(sizes)
    .map(Number)
    .filter((h) => Number.isFinite(h) && h > 0)
  const best = heights.length ? sizes[Math.max(...heights)] : null
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
    filesize: num(node.filesize) || num(node.filesize_approx) || best,
    // Sizes worked out from bitrate are estimates and are labelled as such.
    filesizeEstimated: !num(node.filesize) && !!(num(node.filesize_approx) || best),
    sizes,
    isLive: !!node.is_live,
    // Used later to avoid subtitling a video in the language it already speaks.
    language: node.language || null,
    audioTracks: (node.formats || []).filter((f) => f.acodec && f.acodec !== 'none').map((f) => ({ lang: f.language || '', name: f.format_note || '' })),
    series: node.series || (parseTitle(node.title || '').episode ? parseTitle(node.title || '').title : null),
    season: num(node.season_number) ?? parseTitle(node.title || '').season,
    episode: num(node.episode_number) ?? parseTitle(node.title || '').episode,
    site: siteLabel(url || source.url, node.extractor_key || node.ie_key),
    addedAt: Date.now(),
    // A flat-playlist entry with no duration needs a second look.
    enriched: node.duration !== undefined && node.duration !== null,
  }
}

/**
 * Settings as this particular source sees them.
 *
 * The proxy is a property of the link, not of the app: the whole point of the
 * per-link switch is that a proxied resolve and a direct one can be in flight at
 * the same moment. So it travels attached to the settings object handed to each
 * call rather than being read from global state deeper down.
 */
function note(source, message, stage = source.stage) {
  if (!store.findSource(source.id)) return
  store.commit(() => {
    source.note = diagnostics.redact(message)
    diagnostics.addEvent(source, stage, message)
  })
}

async function sourceSettings(settings, source, signal) {
  let proxy = ''
  if (source.useProxy) {
    proxy = await network.ensureForSource(source.id, { settings, signal,
      onProgress: (status) => note(source, status.message || `Tor hazırlanıyor (%${status.percent || 0})`, 'network') })
  }
  if (signal?.aborted) throw Object.assign(new Error('Çözümleme durduruldu.'), { code: 'ABORTED' })
  store.commit(() => { source.network = source.useProxy ? network.getContext(source.id) || { kind: 'proxy', isolated: false, label: 'Vekil bağlantı' } : { kind: 'direct', isolated: false, label: 'Doğrudan' } })
  return { ...settings, proxy, signal }
}

/**
 * Add the source row up front, before any network work. Lets the caller answer
 * the renderer immediately and probe in the background.
 */
function createSource(url, { useProxy = false } = {}) {
  const source = {
    id: uid('src'),
    url,
    useProxy: !!useProxy,
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
  cancelProbe(source.id)
  const controller = new AbortController()
  controllers.set(source.id, controller)
  const started = Date.now()
  try {
    return await runProbe(source, playlistEnd, controller.signal)
  } catch (err) {
    // A source must never be left spinning. Anything unexpected becomes visible.
    if (!controller.signal.aborted && (source.status === 'probing' || source.status === 'queued')) {
      store.commit(() => {
        source.status = 'error'
        source.error = diagnostics.redact((err && err.message) || 'Beklenmeyen bir hata oldu.')
        source.stage = null
        source.note = null
        diagnostics.addEvent(source, 'error', source.error, 'error')
      })
    }
    return source
  } finally {
    if (controllers.get(source.id) === controller) {
      store.commit(() => { source.elapsedMs = Date.now() - started; diagnostics.addEvent(source, source.status, source.error || `${source.count || 0} medya bulundu`, source.status === 'error' ? 'error' : 'info') })
      controllers.delete(source.id); running.delete(source.id)
    }
  }
}

async function runProbe(source, playlistEnd, signal) {
  const previousJar = store.itemsOfSource(source.id).find((item) => item.resolved?.cookieFile)?.resolved.cookieFile || null
  const globalSettings = store.getState().settings
  const ytdlpOff = globalSettings.useYtdlp === false

  store.commit((s) => {
    source.status = 'probing'
    source.stage = source.useProxy ? 'network' : (ytdlpOff ? 'resolver' : 'ytdlp')
    source.attempts = (source.attempts || 0) + 1
    diagnostics.addEvent(source, 'start', 'Çözümleme başladı')
    source.note = source.useProxy ? 'Güvenli bağlantı hazırlanıyor' : null
    source.error = null
    // A rescan replaces the found media but leaves downloads alone.
    s.items = s.items.filter((i) => i.sourceId !== source.id)
    source.count = 0
  })
  const settings = { ...await sourceSettings(globalSettings, source, signal), browserCookieJar: previousJar }
  store.commit(() => { source.stage = ytdlpOff ? 'resolver' : 'ytdlp'; source.note = null })

  // yt-dlp switched off in settings: no probing, no embed hand-off, no
  // enrichment through it. Every page goes to our own resolver.
  if (ytdlpOff) {
    await tryResolve(source, settings, null)
    return source
  }

  // Dedicated platform extractors preserve playlists and account metadata.
  // General movie/player pages start with the application's own discovery.
  const dedicated = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|soundcloud\.com|tiktok\.com|instagram\.com|twitch\.tv|dailymotion\.com|facebook\.com|twitter\.com|x\.com|bilibili\.com)$/.test(hostOf(source.url))
  let ownError = null
  const triedOwn = settings.resolverFirst !== false && settings.useResolver !== false && !dedicated
  if (triedOwn) {
    await tryResolve(source, settings, null)
    if (signal.aborted || source.status === 'ready') return source
    ownError = source.error
    store.commit(() => { source.status = 'probing'; source.stage = 'ytdlp'; source.note = 'Alternatif çözümleme motoru deneniyor'; source.error = null })
  }
  const fallbackToOwn = async (error) => {
    if (!triedOwn) await tryResolve(source, effective, error)
    else store.commit(() => { source.status = 'error'; source.stage = null; source.note = null; source.error = ownError || error || 'Oynatılabilir akış bulunamadı.' })
  }

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
    const message = err.message || 'yt-dlp çalıştırılamadı.'
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
  if (signal.aborted) return source
  running.delete(source.id)

  /*
   * A watch page and its embed page are different documents served by different
   * code, so when yt-dlp fails on one the other is often fine — Vimeo answers a
   * watch URL with an OAuth 401 but hands over sixteen formats for
   * player.vimeo.com/video/ID. Cheap enough to always try before the resolver.
   */
  if (failure && !missingTool) {
    const derived = embedCandidatesFor(source.url)
    if (derived.length && (await probeEmbeds(source, derived, effective))) return source
  }

  if (missingTool && settings.useResolver !== false) { await fallbackToOwn('yt-dlp kurulu değil.'); return source }
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
    await fallbackToOwn(failure)
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
    await fallbackToOwn(null)
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
    filesizeEstimated: !!(info && info.filesizeEstimated),
    sizes: (info && info.sizes) || {},
    // Subtitle tracks the master playlist itself advertises. yt-dlp cannot find
    // these — it asks the extractor, and a scraped m3u8 has no extractor.
    subtitles: require('./text-tracks').mergeTextTracks(info?.subtitles || [], candidate.subtitles || []),
    audioTracks: info?.audioTracks || [],
    language: candidate.language || null,
    series: parseTitle(title || '').episode ? parseTitle(title || '').title : null,
    season: parseTitle(title || '').season,
    episode: parseTitle(title || '').episode,
    isLive: info?.live ?? null,
    durationSource: info?.durationSource || null,
    filesizeSource: info?.filesizeSource || null,
    metadataStatus: info?.filesize && (info.duration || info.live === true) ? 'complete' : 'partial',
    metadataCheckedAt: Date.now(),
    site: hostOf(source.url) || source.site,
    addedAt: Date.now(),
    // Verified during resolution — no second metadata pass needed.
    enriched: !!(info?.filesize && (info.duration || info.live === true)),
    variants: info && info.variants ? info.variants.map((v) => v.height).filter(Boolean) : [],
    drm: !!(info && info.drm),
    resolved: {
      pageUrl: source.url,
      referer: candidate.referer || source.url,
      origin: candidate.origin || '',
      userAgent: candidate.userAgent || userAgent,
      cookieFile: candidate.cookieFile || null,
      kind: candidate.kind,
      engine: candidate.via,
      selectedVariantUrl: info?.selectedVariantUrl || null,
      rejectedVariantUrls: info?.rejectedVariantUrls || [],
      selectedVariantChain: info?.selectedVariantChain?.slice(0, 4) || [],
      preparedVariants: info?.preparedVariants?.slice(0, 8) || [],
      // A flag, not the address. A proxy URL can carry a password, and this
      // object is written to library.json in plain text — the address is looked
      // up from settings at the moment it is needed instead.
      useProxy: !!source.useProxy,
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
      source.error =
        settings.useYtdlp === false
          ? 'Hem yt-dlp hem kendi çözümleyicim kapalı — çözümleyecek bir şey kalmadı. Ayarlar → Erişim.'
          : fallbackError || 'Bu sayfada indirilebilir bir şey bulunamadı.'
    })
    return
  }

  store.commit(() => {
    source.status = 'probing'
    source.stage = 'resolver'
    source.note = 'sayfa taranıyor'
    source.error = null
    source.resolvedBy = null
  })

  // Hand the resolver the user's browser session so pages that want them signed
  // in behave the same as in their own browser.
  let browserCookieJar = settings.browserCookieJar || null
  if (settings.cookiesBrowser) {
    store.commit(() => { source.note = 'tarayıcı oturumu alınıyor' })
    browserCookieJar = await exportCookieJar(settings.cookiesBrowser, { signal: settings.signal }).catch(() => null)
  }

  const host = hostOf(source.url)
  const profile = store.getHostProfile(host)
  const startedAt = Date.now()

  let result = null
  try {
    result = await resolvePage(source.url, {
      browserCookieJar,
      preferredAudioLanguage: settings.preferredAudioLanguage || 'en',
      signal: settings.signal,
      proxy: settings.proxy || '',
      useUserScripts: settings.useUserScripts !== false,
      preferEngine: profile ? profile.engine : null,
      blockRules: {
        extraBlockedHosts: settings.extraBlockedHosts,
        blockTrackers: settings.blockTrackers,
      },
      minStreamSeconds: settingNumber(settings.minStreamSeconds, 120),
      timeoutMs: Math.max(8000, settingNumber(settings.resolverTimeout, 45000)),
      onProgress: (message) => {
        const live = store.findSource(source.id)
        if (live && !settings.signal?.aborted) note(live, message)
      },
    })
  } catch (err) {
    console.error('[resolver]', err)
  }

  // Remember which engine did the work so the next page on this site skips
  // straight to it.
  if (result && result.candidates && result.candidates.length) {
    store.rememberHostProfile(host, {
      engine: result.engine,
      ads: (result.adsSkipped || 0) > 0,
      ms: Date.now() - startedAt,
    })
  }

  // Best possible outcome on an unrecognised page: it embeds a player yt-dlp
  // already knows. Re-probing the embed gets the real format list, subtitles and
  // metadata instead of a bare stream URL we scraped ourselves.
  if (
    settings.useYtdlp !== false &&
    result &&
    !(result.candidates || []).length &&
    (result.embeds || []).length
  ) {
    const viaEmbed = await probeEmbeds(source, result.embeds, settings)
    if (viaEmbed) return
  }

  if (!settings.signal?.aborted && store.findSource(source.id)) applyResolution(source, result, fallbackError)
}

/**
 * Hand embed URLs to yt-dlp and build the source from whatever it recognises.
 * Returns true when the source ended up populated.
 */
async function probeEmbeds(source, embeds, settings) {
  store.commit(() => {
    source.note = `gömülü oynatıcı bulundu, yt-dlp'ye veriliyor`
  })

  const items = []
  for (const embed of embeds.slice(0, 4)) {
    if (settings.signal?.aborted) return false
    try {
      const { json } = await runJson(embed, ['-J', '--flat-playlist'], settings)
      if (!json || typeof json !== 'object') continue
      const nodes = json._type === 'playlist' ? json.entries || [] : [json]
      for (const node of nodes) {
        if (!node) continue
        const item = itemFromNode(node, source, items.length)
        // The embed page rarely has a useful title; the host page's is better.
        if (!node.title && source.title) item.title = source.title
        items.push(item)
      }
    } catch {
      /* try the next embed */
    }
    if (items.length) break
  }

  if (!items.length || settings.signal?.aborted) return false

  store.commit((s) => {
    source.count = items.length
    source.status = 'ready'
    source.error = null
    source.stage = null
    source.note = null
    source.kind = items.length > 1 ? 'playlist' : 'video'
    source.resolvedBy = 'gömülü oynatıcı'
    source.probedAt = Date.now()
    s.items.push(...items)
  })

  enrich(source.id, settings).catch(() => {})
  return true
}

/**
 * Turn a resolver result into media items, or into an error the user can act on.
 * Shared by the automatic path and by assisted capture.
 */
function applyResolution(source, result, fallbackError) {
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
        result?.failure?.errorKind === 'network-blocked' || result?.networkBlocked
          ? `Site bu ağın IP adresini engelliyor. Bu, internet bağlantısının kesik olduğu anlamına gelmez. ${source.useProxy ? 'Bu kaynak için VPN / vekili kapatıp yeniden taramayı deneyebilirsin.' : 'Siteyi tarayıcıda kontrol edebilir veya bu kaynak için başka bir ağ yolunu seçebilirsin.'}`
          : result && result.encrypted
          ? 'Bu akış DRM korumalı — indirilemez.'
          : result?.challengeRequired
            ? 'Site tarayıcı doğrulaması istiyor. Tarayıcıda yakala ile doğrulamayı tamamlayabilir veya mevcut tarayıcı oturumunu seçebilirsin.'
          : result?.accessRequired
            ? 'Site oturum açılmasını istiyor. Ayarlar → Site hesapları bölümünden bu site için giriş izni ver veya Tarayıcıda yakala ile giriş yap.'
          : result?.failure?.status >= 400
            ? `Site HTTP ${result.failure.status} döndürdü. Bu, internet bağlantısının kesik olduğu anlamına gelmez. Tarayıcıda yakala ile siteyi kontrol edebilirsin.`
          : result?.loadError || result?.failure?.message
            ? `Site açılamadı: ${result.loadError || result.failure.message}`
          : result?.timedOut
            ? 'Çözümleme süresi doldu. Site yanıtı veya oynatıcının başlaması gecikmiş olabilir; bekleme süresini artırabilir ya da Tarayıcıda yakala ile deneyebilirsin.'
          : result && result.shortOnly
            ? `Yalnızca ${shortest ? `${shortest} sn'lik ` : 'kısa '}bir akış geldi — bu reklam. Video akışı süre içinde başlamadı: Ayarlar → Erişim'den beklemeyi artır, ya da gerçekten kısa bir video ise "En kısa video süresi"ni Yok yap.`
            : adsOnly
              ? `${result.adsSkipped} reklam akışı atlandı, video akışı gelmedi. Ayarlar → Erişim'den beklemeyi artırıp yeniden dene.`
              : fallbackError || 'Sayfada oynatılabilir bir akış bulunamadı.'
    })
    return
  }

  const title = (result.title || source.title || hostOf(source.url) || '').trim()
  const picked = rankCandidates(candidates, store.getState().settings.preferredAudioLanguage || 'en').slice(0, 8)
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
    source.resolvedBy =
      result.engine === 'assisted'
        ? 'tarayıcıda yakalandı'
        : result.engine === 'browser'
          ? 'tarayıcı motoru'
          : 'sayfa taraması'
    source.probedAt = Date.now()
    s.items.push(...items)
  })

  enrichResolved(source.id).catch(() => {})
}

/**
 * Second chance at metadata for resolved streams the verification pass couldn't
 * read: ffprobe and the manifest parser first, yt-dlp as a last resort.
 */
async function enrichResolved(sourceId) { return enrich(sourceId) }

function needsMetadata(item) {
  return !item.enriched || (!item.duration && item.isLive !== true) || !item.filesize
}

/** Metadata is a cancellable job of its own; it can outlive the initial scan. */
function enrich(sourceId, settingsOverride = null, { force = false } = {}) {
  const existing = metadataJobs.get(sourceId)
  if (existing && !existing.controller.signal.aborted) return existing.promise
  if (existing) metadataJobs.delete(sourceId)
  const source = store.findSource(sourceId)
  if (!source || (source.status !== 'ready' && force)) return Promise.resolve(false)
  const base = settingsOverride || store.getState().settings
  const limit = Math.min(200, Math.max(0, Number(base.enrichLimit) || 0))
  const pending = store.itemsOfSource(sourceId).filter((i) => i.url && (force || needsMetadata(i)))
    .filter((i) => force || !i.enriched || Date.now() - (i.metadataCheckedAt || 0) > 15 * 60000).slice(0, force ? Math.max(1, limit) : limit)
  if (!pending.length) return Promise.resolve(false)
  const controller = new AbortController()
  const job = { controller, promise: null }
  metadataJobs.set(sourceId, job)
  job.promise = (async () => {
    const timeout = setTimeout(() => controller.abort(), 180000)
    let cursor = 0, finished = 0
    store.commit(() => { source.enriching = pending.length; diagnostics.addEvent(source, 'metadata', `${pending.length} medya bilgisi inceleniyor`) })
    try {
      const settings = await sourceSettings(base, source, controller.signal)
      const active = (item) => !controller.signal.aborted && metadataJobs.get(sourceId) === job && store.findItem(item.id)
      const patch = (item, fn) => { if (active(item)) store.commit(() => { const live = active(item); if (live) fn(live) }) }
      async function worker() {
        while (cursor < pending.length && !controller.signal.aborted) {
          const item = pending[cursor++]
          if (!active(item)) continue
          patch(item, (live) => { live.metadataStatus = 'loading' })
          let learned = false
          try {
            if (item.resolved) {
              const info = await describeStream(item.url, { ...item.resolved, proxy: settings.proxy, signal: controller.signal })
              if (info && !info.rejected) patch(item, (live) => {
                learned = !!(info.duration || info.height || info.filesize || info.live === true)
                live.duration = info.duration ?? live.duration
                live.durationSource = info.durationSource || live.durationSource
                live.height = info.height || live.height
                if (info.filesize) { live.filesize = info.filesize; live.filesizeEstimated = !!info.filesizeEstimated; live.filesizeSource = info.filesizeSource || null }
                if (info.sizes && Object.keys(info.sizes).length) live.sizes = info.sizes
                if (info.subtitles?.length) live.subtitles = require('./text-tracks').mergeTextTracks(live.subtitles || [], info.subtitles)
                if (info.audioTracks?.length) live.audioTracks = info.audioTracks
                live.isLive = info.live ?? live.isLive ?? null
                if (info.variants?.length) live.variants = info.variants.map((v) => v.height).filter(Boolean)
                live.drm = !!info.drm
                live.resolved.selectedVariantUrl = info.selectedVariantUrl || live.resolved.selectedVariantUrl
                live.resolved.rejectedVariantUrls = info.rejectedVariantUrls || live.resolved.rejectedVariantUrls || []
                if (info.selectedVariantChain) live.resolved.selectedVariantChain = info.selectedVariantChain.slice(0, 4)
                if (info.preparedVariants) live.resolved.preparedVariants = info.preparedVariants.slice(0, 8)
              })
            }
            if (active(item) && needsMetadata(item) && settings.useYtdlp !== false) {
              const { json } = await runJson(item.url, ['-J', '--no-playlist', ...(item.resolved ? resolvedArgs(item.resolved) : [])],
                { ...settings, cookiesBrowser: item.resolved ? '' : settings.cookiesBrowser })
              patch(item, (live) => {
                const sizes = sizesFromFormats(json)
                const best = Object.values(sizes).filter(Number.isFinite).sort((a, b) => b - a)[0]
                learned = learned || !!(json.duration || json.filesize || json.filesize_approx)
                if (!live.resolved) live.title = json.title || live.title
                if (num(json.duration) !== null) { live.duration = num(json.duration); live.durationSource = 'extractor' }
                live.thumbnail = bestThumb(json) || live.thumbnail
                live.uploader = json.uploader || json.channel || live.uploader
                live.ext = json.ext || live.ext
                live.height = heightOf(json) || live.height
                const size = num(json.filesize) || num(json.filesize_approx) || best
                if (size) { live.filesize = size; live.filesizeEstimated = !num(json.filesize); live.filesizeSource = 'extractor' }
                if (Object.keys(sizes).length) live.sizes = sizes
                if (typeof json.is_live === 'boolean') live.isLive = json.is_live
                live.language = json.language || live.language
                if (json.formats?.length) live.audioTracks = json.formats.filter((f) => f.acodec && f.acodec !== 'none').map((f) => ({ lang: f.language || '', name: f.format_note || '' }))
                live.series = json.series || live.series
                live.season = num(json.season_number) ?? live.season
                live.episode = num(json.episode_number) ?? live.episode
              })
            }
          } catch (err) {
            if (!controller.signal.aborted) store.commit(() => diagnostics.addEvent(source, 'metadata', err.message, 'warn'))
          } finally {
            patch(item, (live) => {
              live.enriched = true
              live.metadataCheckedAt = Date.now()
              live.metadataStatus = live.filesize && (live.duration || live.isLive === true) ? 'complete' : (learned || live.duration || live.filesize || live.height) ? 'partial' : 'unavailable'
            })
            finished += 1
            if (metadataJobs.get(sourceId) === job && store.findSource(sourceId)) store.commit(() => { source.enriching = pending.length - finished })
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker))
      return true
    } finally {
      clearTimeout(timeout)
      if (metadataJobs.get(sourceId) === job) {
        metadataJobs.delete(sourceId)
        if (store.findSource(sourceId)) store.commit(() => {
          source.enriching = 0
          if (source.status === 'ready') source.note = null
          for (const item of pending) { const live = store.findItem(item.id); if (live?.metadataStatus === 'loading') live.metadataStatus = 'partial' }
          diagnostics.addEvent(source, 'metadata', controller.signal.aborted ? 'Bilgi taraması durduruldu' : 'Bilgi taraması tamamlandı')
        })
      }
    }
  })()
  return job.promise
}

function refreshMetadata(sourceId) { return enrich(sourceId, null, { force: true }) }

function cancelProbe(sourceId) {
  metadataJobs.get(sourceId)?.controller.abort()
  controllers.get(sourceId)?.abort()
  controllers.delete(sourceId)
  const child = running.get(sourceId)
  if (child) {
    child.kill()
    running.delete(sourceId)
  }
}

function killAll() {
  for (const job of metadataJobs.values()) job.controller.abort()
  for (const controller of controllers.values()) controller.abort()
  controllers.clear()
  for (const child of running.values()) {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
  running.clear()
}

/**
 * Open the page in a visible window so the user can clear whatever gate it puts
 * up, and take whatever plays. Replaces the found media for that source.
 */
async function captureSource(sourceId) {
  const source = store.findSource(sourceId)
  if (!source) return null
  cancelProbe(sourceId)
  const controller = new AbortController()
  controllers.set(sourceId, controller)
  const started = Date.now()
  const previousJar = store.itemsOfSource(source.id).find((item) => item.resolved?.cookieFile)?.resolved.cookieFile || null
  store.commit((s) => {
    source.status = 'probing'
    source.stage = source.useProxy ? 'network' : 'resolver'
    source.note = 'Tarayıcı penceresi hazırlanıyor'
    source.error = null
    source.attempts = (source.attempts || 0) + 1
    diagnostics.addEvent(source, 'start', 'Tarayıcıda yakalama başladı')
    s.items = s.items.filter((i) => i.sourceId !== source.id)
    source.count = 0
  })
  try {
    const settings = { ...await sourceSettings(store.getState().settings, source, controller.signal), browserCookieJar: previousJar }
    store.commit(() => { source.stage = 'resolver'; source.note = 'Tarayıcı penceresi açılıyor' })

    let browserCookieJar = settings.browserCookieJar || null
    if (settings.cookiesBrowser) {
      browserCookieJar = await exportCookieJar(settings.cookiesBrowser, { signal: settings.signal }).catch(() => null)
    }

    let result = null
    try {
      result = await assistedCapture(source.url, {
        browserCookieJar,
        preferredAudioLanguage: settings.preferredAudioLanguage || 'en',
        signal: controller.signal,
        proxy: settings.proxy || '',
        useUserScripts: settings.useUserScripts !== false,
        blockRules: {
          extraBlockedHosts: settings.extraBlockedHosts,
          blockTrackers: settings.blockTrackers,
        },
        minStreamSeconds: settingNumber(settings.minStreamSeconds, 120),
        timeoutMs: 300000,
        onProgress: (message) => {
          const live = store.findSource(sourceId)
          if (live && !settings.signal?.aborted) note(live, message)
        },
      })
    } catch (err) {
      console.error('[assisted]', err)
    }

    if (!controller.signal.aborted && store.findSource(sourceId)) applyResolution(source, result, 'Pencere kapatıldı, akış yakalanmadı.')
  } catch (err) {
    if (!controller.signal.aborted) store.commit(() => { source.status = 'error'; source.error = diagnostics.redact(err.message); source.stage = null; source.note = null; diagnostics.addEvent(source, 'error', err.message, 'error') })
  } finally {
    if (controllers.get(sourceId) === controller) {
      store.commit(() => { source.elapsedMs = Date.now() - started })
      controllers.delete(sourceId)
    }
  }
  return source
}

module.exports = {
  createSource,
  probeUrl,
  captureSource,
  cancelProbe,
  refreshMetadata,
  needsMetadata,
  killAll,
  readableError,
  itemFromNode, itemFromCandidate,
  isCookieFailure,
  isRetryableWithoutCookies,
}
