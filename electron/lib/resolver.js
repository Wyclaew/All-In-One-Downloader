'use strict'

// Finding playable media on pages yt-dlp has no extractor for.
//
// Two engines, cheapest first:
//
//   1. static   — fetch the HTML, pull manifest/file URLs out of it, unpack the
//                 p.a.c.k.e.r-obfuscated player scripts these sites love, and
//                 follow nested iframes with the Referer chain intact.
//   2. browser  — load the page in a hidden BrowserWindow and watch what it
//                 actually requests. The player's JS runs for real, so it works
//                 on obfuscated and dynamically-built sources that no amount of
//                 scraping would reach.
//
// The output is always the same: a direct media URL plus the headers and cookies
// needed to fetch it. Downloading is still yt-dlp's job — it handles HLS, DASH
// and progressive files well once it's pointed at the right URL.
//
// Two deliberate limits:
//   * Page content is data, never instruction. We collect URLs and a title; we
//     never act on anything the page says.
//   * No DRM. An encrypted stream (Widevine/PlayReady) is left alone and
//     reported as such.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { BrowserWindow, session } = require('electron')
const { createBlocker } = require('./blocklist')
const { describeStream } = require('./mediainfo')
const { uid, hostOf } = require('./util')

/**
 * The active request blocker. Swapped at the start of each resolve so the user's
 * own extra rules apply; resolves are serialised by the caller, so a single
 * module-level matcher is enough and keeps the per-request path cheap.
 */
let blocker = createBlocker({})

function configureBlocker(settings = {}) {
  blocker = createBlocker({
    extraBlocked: settings.extraBlockedHosts || '',
    allowTrackers: settings.blockTrackers === false,
  })
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'

/** Extensions that mean "this is the thing we want to hand to yt-dlp". */
const MANIFEST_EXT = /\.(m3u8|mpd)(\?|#|$)/i
const FILE_EXT = /\.(mp4|webm|m4v|mkv|mov|flv|mp3|m4a|ogg|opus|wav)(\?|#|$)/i
const SEGMENT_EXT = /\.(ts|m4s|aac|init)(\?|#|$)/i

/**
 * Never a stream, however promising the surrounding code looks. Posters in
 * particular slip through source-position matching, and ffprobe happily reports
 * a width and height for a PNG — so they have to be excluded by name.
 */
const NON_MEDIA_EXT =
  /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|css|js|mjs|json|xml|txt|html?|php|woff2?|ttf|eot|pdf|zip|vtt|srt)(\?|#|$)/i

const MEDIA_URL_RE =
  /https?:\/\/[^\s"'`<>()\\]{8,}?\.(?:m3u8|mpd|mp4|webm|m4v|mkv|mov|flv|mp3|m4a)(?:\?[^\s"'`<>()\\]*)?/gi

// What gets blocked lives in blocklist.js. Tag managers and analytics are
// deliberately allowed through: some players initialise via them, and blocking
// those was enough to stop a player from ever building its source.

const CONTENT_TYPE_MEDIA =
  /(application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)|video\/(?:mp4|webm|x-matroska)|audio\/(?:mp4|mpeg|webm))/i

/** How long to keep listening after the last useful stream shows up. */
const SETTLE_MS = 5000

/* ========================================================================== *
 * shared helpers
 * ========================================================================== */

function isHttp(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url)
}

/** JSON and JS escape slashes; normalise so one regex catches every form. */
function normaliseText(text) {
  return String(text)
    .replace(/\\\//g, '/')
    .replace(/\\u002F/gi, '/')
    .replace(/\\x2F/gi, '/')
}

function kindOf(url) {
  if (MANIFEST_EXT.test(url)) return /\.mpd(\?|#|$)/i.test(url) ? 'dash' : 'hls'
  if (FILE_EXT.test(url)) return 'file'
  if (SEGMENT_EXT.test(url)) return 'segment'
  return 'unknown'
}

/** Manifests beat progressive files beat anything else. */
function rank(candidate) {
  const url = candidate.url.toLowerCase()
  if (candidate.kind === 'hls') return /master|playlist|index/.test(url) ? 100 : 90
  if (candidate.kind === 'dash') return 88
  if (candidate.kind === 'file') return /\.mp4(\?|#|$)/.test(url) ? 70 : 60
  if (candidate.kind === 'unknown') return 30
  return 5
}

function dedupe(candidates) {
  const seen = new Set()
  const out = []
  for (const c of [...candidates].sort((a, b) => rank(b) - rank(a))) {
    const key = c.url.split('#')[0]
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

/* ========================================================================== *
 * p.a.c.k.e.r unpacking
 * ========================================================================== */

/** The encoder the packer uses: 0-9a-z, then A-Z for radices above 36. */
function encodeBase(value, radix) {
  const digit = (n) => (n > 35 ? String.fromCharCode(n + 29) : n.toString(36))
  let out = ''
  let n = value
  do {
    out = digit(n % radix) + out
    n = Math.floor(n / radix)
  } while (n > 0)
  return out
}

/**
 * Reverse `eval(function(p,a,c,k,e,d){...}('payload',radix,count,'a|b|c'.split('|'),0,{}))`
 * — near-universal on self-hosted players. Returns unpacked source, or ''.
 */
function unpackPacked(source) {
  const results = []
  const re =
    /eval\(function\(p,a,c,k,e,[dr]\)\{.*?\}\(\s*(['"])((?:\\.|(?!\1)[\s\S])*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])((?:\\.|(?!\5)[\s\S])*?)\5\s*\.split\('\|'\)/g

  let match
  while ((match = re.exec(source)) !== null) {
    const payload = match[2].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    const radix = Number(match[3])
    const count = Number(match[4])
    const words = match[6].split('|')
    if (!payload || !radix || !Number.isFinite(count)) continue

    let out = payload
    for (let i = count - 1; i >= 0; i -= 1) {
      const word = words[i]
      if (!word) continue
      const token = encodeBase(i, radix)
      out = out.replace(new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), word)
    }
    results.push(out)
  }
  return results.join('\n')
}

/** Long base64 blobs sometimes hide the real source URL. */
function decodeBase64Blobs(text) {
  const out = []
  const re = /["'`]([A-Za-z0-9+/=]{40,})["'`]/g
  let match
  while ((match = re.exec(text)) !== null) {
    try {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8')
      if (/https?:\/\//i.test(decoded)) out.push(decoded)
    } catch {
      /* not base64 */
    }
  }
  return out.join('\n')
}

/* ========================================================================== *
 * engine 1 — static scan
 * ========================================================================== */

async function fetchText(url, referer, timeoutMs = 12000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'tr,en-US;q=0.8,en;q=0.6',
        ...(referer ? { Referer: referer } : {}),
      },
    })
    const type = res.headers.get('content-type') || ''
    if (!/text|html|json|javascript|xml|mpegurl/i.test(type)) return { text: '', finalUrl: res.url }
    const text = await res.text()
    return { text: text.slice(0, 3 * 1024 * 1024), finalUrl: res.url || url }
  } catch {
    return { text: '', finalUrl: url }
  } finally {
    clearTimeout(timer)
  }
}

/** `\x68\x74\x74\x70...` — a favourite way to hide a URL from a grep. */
function decodeHexEscapes(text) {
  if (!/\\x[0-9a-f]{2}/i.test(text)) return ''
  return text.replace(/(?:\\x[0-9a-fA-F]{2})+/g, (run) =>
    run
      .split('\\x')
      .filter(Boolean)
      .map((h) => String.fromCharCode(parseInt(h, 16)))
      .join('')
  )
}

/** `%68%74%74%70...`, same idea. */
function decodePercentEscapes(text) {
  if (!/%[0-9a-f]{2}%[0-9a-f]{2}/i.test(text)) return ''
  return text.replace(/(?:%[0-9a-fA-F]{2}){4,}/g, (run) => {
    try {
      return decodeURIComponent(run)
    } catch {
      return run
    }
  })
}

/**
 * URLs sitting in the positions players read their source from, even when the
 * URL carries no file extension: `file:"…"`, `sources:[{src:"…"}]`,
 * `<source src="…">`, JSON-LD `contentUrl`. These are strong hints but unproven,
 * so they come back as `unknown` and get validated before use.
 */
const CONFIG_VALUE_RE =
  /\b(?:file|src|source|url|videoUrl|video_url|playUrl|play_url|stream|streamUrl|hls|hlsUrl|manifest|contentUrl|mp4|m3u8)\b\s*[:=]\s*["'`](https?:\/\/[^"'`\s]{12,})["'`]/gi

const TAG_SRC_RE = /<(?:video|source|audio)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi

function collectFromText(text, baseUrl) {
  const raw = String(text)
  const expanded = [
    normaliseText(raw),
    normaliseText(unpackPacked(raw)),
    normaliseText(decodeBase64Blobs(raw)),
    normaliseText(decodeHexEscapes(raw)),
    normaliseText(decodePercentEscapes(raw)),
  ]
    .filter(Boolean)
    .join('\n')

  const found = []
  const push = (url, confident) => {
    const clean = String(url).replace(/[",';)\]}]+$/, '').trim()
    if (!isHttp(clean) || blocker.shouldBlock(clean)) return
    if (NON_MEDIA_EXT.test(clean)) return
    if (blocker.isAdMedia(clean)) return
    const kind = kindOf(clean)
    if (kind === 'segment') return
    if (kind === 'unknown' && !confident) return
    found.push({
      url: clean,
      kind,
      referer: baseUrl,
      origin: originOf(baseUrl),
      via: 'static',
      // `unknown` means "found in a source position but unverified".
      needsCheck: kind === 'unknown',
    })
  }

  let match

  MEDIA_URL_RE.lastIndex = 0
  while ((match = MEDIA_URL_RE.exec(expanded)) !== null) push(match[0], false)

  CONFIG_VALUE_RE.lastIndex = 0
  while ((match = CONFIG_VALUE_RE.exec(expanded)) !== null) push(match[1], true)

  TAG_SRC_RE.lastIndex = 0
  while ((match = TAG_SRC_RE.exec(expanded)) !== null) {
    try {
      push(new URL(match[1], baseUrl).href, true)
    } catch {
      /* malformed */
    }
  }

  return { candidates: found, expanded }
}

/**
 * Player scripts are usually a separate file, so scanning only the HTML misses
 * the very place the source lives. Take same-site and player-looking scripts.
 */
function collectScripts(html, baseUrl) {
  const urls = []
  const re = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi
  let match
  let host = ''
  try {
    host = new URL(baseUrl).hostname
  } catch {
    /* ignore */
  }

  while ((match = re.exec(html)) !== null) {
    let abs
    try {
      abs = new URL(normaliseText(match[1]), baseUrl)
    } catch {
      continue
    }
    if (!/^https?:$/.test(abs.protocol) || blocker.shouldBlock(abs.href)) continue
    const sameSite = host && (abs.hostname === host || abs.hostname.endsWith(`.${host}`))
    const looksLikePlayer = /player|embed|stream|video|hls|jwplayer|clappr|plyr|source/i.test(abs.pathname)
    // Skip the usual framework bulk; it never holds a stream URL.
    if (/jquery|bootstrap|analytics|gtag|gtm|recaptcha|polyfill|react|vue\.|lodash/i.test(abs.pathname)) continue
    if (sameSite || looksLikePlayer) urls.push(abs.href)
  }
  return urls
}

/** Seconds, or ISO-8601 like PT45M12S. */
function parseDurationValue(raw) {
  const text = String(raw || '').trim()
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text)
    return n > 0 ? Math.round(n) : null
  }
  const m = text.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/i)
  if (!m) return null
  const total =
    (Number(m[1]) || 0) * 86400 +
    (Number(m[2]) || 0) * 3600 +
    (Number(m[3]) || 0) * 60 +
    (Number(m[4]) || 0)
  return total > 0 ? Math.round(total) : null
}

/**
 * How long the page says its video is.
 *
 * This is the one signal that works the same on every site, because it comes
 * from the page rather than from guessing about hosts or ad vendors. If a page
 * declares a 45-minute episode, a 15-second stream is an advert — no host list,
 * no comparison against other candidates, no per-site rule needed.
 */
function pageDurationOf(html) {
  const meta = html.match(
    /<meta[^>]+(?:property|itemprop|name)=["'](?:og:video:duration|video:duration|duration)["'][^>]+content=["']([^"']+)["']/i
  )
  if (meta) {
    const value = parseDurationValue(meta[1])
    if (value) return value
  }

  for (const block of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    const found = block[1].match(/"duration"\s*:\s*"([^"]+)"/i)
    if (found) {
      const value = parseDurationValue(found[1])
      if (value) return value
    }
  }
  return null
}

function pageImageOf(html) {
  const og =
    html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
  return og ? decodeEntities(og[1]).trim() : ''
}

/** Strip the site's boilerplate off a page title. */
function cleanTitle(title, host) {
  let out = decodeEntities(String(title || '')).replace(/\s+/g, ' ').trim()
  if (!out) return ''
  const site = String(host || '').replace(/^www\./, '').split('.')[0]
  if (site) {
    const escaped = site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`\\s*[-–—|·:]\\s*${escaped}.*$`, 'i'), '')
  }
  out = out
    .replace(/\s*[-–—|]\s*(?:izle|full hd izle|hd izle|watch online|online|free|full movie)\s*$/i, '')
    .replace(/^\s*(?:watch|izle)\s+/i, '')
    .replace(/\s+(?:full hd online|full hd|online izle|izle)\s*$/i, '')
    .trim()
  return out || decodeEntities(String(title || '')).trim()
}

function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function collectIframes(html, baseUrl) {
  const urls = []
  const re = /<iframe\b[^>]*?\b(?:src|data-src|data-litespeed-src)\s*=\s*["']([^"']+)["']/gi
  let match
  while ((match = re.exec(html)) !== null) {
    try {
      const abs = new URL(normaliseText(match[1]), baseUrl).href
      if (isHttp(abs) && !blocker.shouldBlock(abs)) urls.push(abs)
    } catch {
      /* malformed src */
    }
  }
  return urls
}

function pageTitleOf(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
  if (og) return decodeEntities(og[1]).trim()
  const t = html.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i)
  return t ? decodeEntities(t[1]).trim() : ''
}

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

/**
 * Walk the page, its player scripts, and up to `maxDepth` levels of nested
 * iframes — carrying the Referer chain, because embed hosts check it.
 */
async function staticScan(pageUrl, { maxDepth = 3, maxFetches = 16, onProgress = null } = {}) {
  const candidates = []
  let title = ''
  let thumbnail = ''
  let expectedDuration = null
  let fetches = 0
  const visited = new Set()
  let queue = [{ url: pageUrl, referer: '', depth: 0, kind: 'page' }]

  while (queue.length && fetches < maxFetches) {
    const next = []
    for (const job of queue) {
      if (fetches >= maxFetches) break
      if (visited.has(job.url)) continue
      visited.add(job.url)
      fetches += 1

      const { text, finalUrl } = await fetchText(job.url, job.referer)
      if (!text) continue

      if (job.kind === 'page') {
        if (!title) title = pageTitleOf(text)
        if (!thumbnail) thumbnail = pageImageOf(text)
        if (!expectedDuration) expectedDuration = pageDurationOf(text)
      }

      const { candidates: found } = collectFromText(text, finalUrl)
      if (found.length && onProgress) {
        onProgress(`${found.length} olası akış bulundu, doğrulanıyor`)
      }
      candidates.push(...found)

      // Scripts hold sources but never frames, so they are a leaf.
      if (job.kind === 'page') {
        for (const script of collectScripts(text, finalUrl).slice(0, 5)) {
          next.push({ url: script, referer: finalUrl, depth: job.depth, kind: 'script' })
        }
        if (job.depth < maxDepth) {
          for (const frame of collectIframes(text, finalUrl)) {
            next.push({ url: frame, referer: finalUrl, depth: job.depth + 1, kind: 'page' })
          }
        }
      }
    }
    queue = next
  }

  return { title, thumbnail, expectedDuration, candidates: dedupe(candidates), engine: 'static' }
}

/* ========================================================================== *
 * engine 2 — hidden browser, watching the network
 * ========================================================================== */

/**
 * Start playback without breaking it. Two rules learned the hard way:
 *   - once a <video> exists, only ever call play() on it; clicking again toggles
 *     a playing player back to paused
 *   - never match play buttons with a wildcard: `[class*=play]` also matches the
 *     `jw-state-playing` class on the player root
 */
const PLAY_NUDGE = `(() => {
  try {
    const v = document.querySelector('video');
    if (v) {
      v.muted = true;
      if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(function(){}); }
      return v.paused ? 'video:paused' : 'video:playing';
    }
    var hints = ['.vjs-big-play-button','.jw-icon-display','.jw-icon-playback',
      '.plyr__control--overlaid','#play','#playbtn','.play-button','.playbutton',
      '.btn-play','.play_button','[aria-label="Play"]','[title="Play"]'];
    for (var i = 0; i < hints.length; i++) {
      var el = document.querySelector(hints[i]);
      if (el) { el.click(); return 'clicked'; }
    }
    return 'none';
  } catch (e) { return 'err'; }
})()`

/**
 * Get past a pre-roll.
 *
 * Two mechanisms, in order of preference. First the player's own skip control,
 * operated exactly as a viewer would. Failing that, run the advert out by seeking
 * a short video element to its end — which is what makes the ad SDK report
 * completion, and completion is the thing that makes the player load the feature.
 *
 * The 180-second guard matters: it is what keeps this from ever fast-forwarding
 * the actual video.
 */
const AD_SKIP = `(() => {
  try {
    var done = [];
    var wanted = /^(skip|skip ad|skip advert|atla|reklamı atla|reklamı geç|geç|kapat)/i;
    var controls = ['.ytp-ad-skip-button', '.ytp-ad-skip-button-modern', '.videoAdUiSkipButton',
      '.ima-skip-button', '.jw-skip', '.jw-icon-inline.jw-skip', '[class*="skip-button"]',
      '[class*="skipButton"]', '[id*="skipBtn"]', '[class*="ad-skip"]'];

    for (var i = 0; i < controls.length; i++) {
      var el = document.querySelector(controls[i]);
      if (el && el.offsetParent !== null && !el.disabled) { el.click(); done.push('skip'); break; }
    }

    if (!done.length) {
      var clickable = document.querySelectorAll('button,a,[role="button"]');
      for (var j = 0; j < clickable.length && j < 400; j++) {
        var c = clickable[j];
        if (c.offsetParent === null) continue;
        var label = (c.textContent || c.getAttribute('aria-label') || '').trim();
        if (label && label.length < 32 && wanted.test(label)) { c.click(); done.push('skiptext'); break; }
      }
    }

    var videos = document.querySelectorAll('video');
    for (var k = 0; k < videos.length; k++) {
      var v = videos[k];
      var d = v.duration;
      // Only ever a short clip — never the feature.
      if (!isFinite(d) || d <= 0 || d > 180) continue;
      try { v.muted = true; if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function(){}); } } catch (e) {}
      if (v.currentTime < d - 0.4) {
        try { v.currentTime = Math.max(0, d - 0.15); done.push('runout'); } catch (e) {}
      }
    }
    return done.join(',') || 'none';
  } catch (e) { return 'err'; }
})()`

/** How often to look for an advert to get past. */
const AD_SKIP_INTERVAL = 1200

/**
 * Electron has no way to destroy a session, so minting a fresh partition per
 * resolve leaves one behind every time — a slow leak that a long session of
 * pasted links would keep growing. Reuse a small pool instead, wiping storage on
 * release so runs never inherit each other's cookies.
 */
const partitionPool = []
let partitionsMade = 0

function acquirePartition() {
  const name = partitionPool.pop()
  if (name) return name
  partitionsMade += 1
  return `resolver-${partitionsMade}`
}

async function releasePartition(name, ses) {
  try {
    await ses.clearStorageData()
  } catch {
    /* best effort — the slot is still reusable */
  }
  if (partitionPool.length < 8) partitionPool.push(name)
}

/** Players build their source at their own pace; poke on a schedule, not on events. */
const NUDGE_SCHEDULE = [700, 2500, 5000, 8500, 13000, 18000, 24000, 30000, 36000, 42000]

/**
 * Load a Netscape cookie jar into a session, so the offscreen browser carries
 * the user's real sign-in state instead of arriving as an anonymous visitor.
 */
async function injectCookieJar(ses, jarFile) {
  let text = ''
  try {
    text = fs.readFileSync(jarFile, 'utf8')
  } catch {
    return 0
  }

  const jobs = []
  for (const raw of text.split('\n')) {
    let line = raw.trim()
    if (!line) continue
    let httpOnly = false
    if (line.startsWith('#HttpOnly_')) {
      httpOnly = true
      line = line.slice('#HttpOnly_'.length)
    } else if (line.startsWith('#')) {
      continue
    }

    const parts = line.split('\t')
    if (parts.length < 7) continue
    const [domain, , cookiePath, secureFlag, expiry, name] = parts
    const value = parts.slice(6).join('\t')
    if (!domain || !name) continue

    const secure = String(secureFlag).toUpperCase() === 'TRUE'
    const host = domain.replace(/^\./, '')
    const expires = Number(expiry)

    jobs.push(
      ses.cookies
        .set({
          url: `${secure ? 'https' : 'http'}://${host}${cookiePath || '/'}`,
          name,
          value,
          domain: domain.startsWith('.') ? domain : undefined,
          path: cookiePath || '/',
          secure,
          httpOnly,
          expirationDate: Number.isFinite(expires) && expires > 0 ? expires : undefined,
        })
        .then(
          () => true,
          () => false
        )
    )
  }

  const results = await Promise.all(jobs)
  return results.filter(Boolean).length
}

function writeCookieJar(cookies, file) {
  const lines = ['# Netscape HTTP Cookie File', '# All in One Downloader', '']
  const fallbackExpiry = Math.floor(Date.now() / 1000) + 7 * 86400
  for (const c of cookies) {
    if (!c.name) continue
    const domain = c.domain || ''
    const expiry = Math.floor(c.expirationDate || fallbackExpiry)
    lines.push(
      [
        domain,
        domain.startsWith('.') ? 'TRUE' : 'FALSE',
        c.path || '/',
        c.secure ? 'TRUE' : 'FALSE',
        expiry,
        c.name,
        c.value == null ? '' : c.value,
      ].join('\t')
    )
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
  return file
}

/**
 * Load the page offscreen and record every media request it makes.
 * Resolves as soon as a manifest or progressive file shows up, or on timeout.
 */
/** Shown in the assisted window so the user knows what is expected of them. */
const ASSIST_BANNER = `(() => {
  try {
    if (document.getElementById('__aio_banner')) return;
    var d = document.createElement('div');
    d.id = '__aio_banner';
    d.textContent = 'All in One Downloader — reklamı geç ve videoyu başlat. Akış yakalandığında bu pencere kendiliğinden kapanır.';
    d.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;' +
      'background:#17202a;color:#f2eee8;font:600 13px -apple-system,system-ui,sans-serif;' +
      'padding:11px 16px;text-align:center;letter-spacing:.01em;box-shadow:0 2px 12px rgba(0,0,0,.45)';
    document.documentElement.appendChild(d);
  } catch (e) {}
})()`

/**
 * Watch a page's network for media.
 *
 * `assisted` shows the window and stops driving the player: the person clears
 * whatever gate the site puts up — an ad wall, a consent screen, a bot check —
 * and presses play themselves, while this only listens. That is the honest way
 * to handle a page that demands a human, and it generalises to every site
 * without the app pretending to be one.
 */
function browserScan(
  pageUrl,
  {
    timeoutMs = 45000,
    onProgress = null,
    browserCookieJar = null,
    minStreamSeconds = 120,
    assisted = false,
    expectedDuration = null,
  } = {}
) {
  // A page-declared runtime raises the bar for "long enough to be the feature".
  const featureFloor =
    expectedDuration && expectedDuration > 0
      ? Math.max(minStreamSeconds, expectedDuration * 0.5)
      : minStreamSeconds
  return new Promise((resolve) => {
    // No persist: prefix, so the partition is in-memory; taken from a pool
    // because Electron cannot destroy a session once created.
    const partition = acquirePartition()
    const ses = session.fromPartition(partition)
    const hits = new Map()
    const skipped = new Set()
    const timers = []
    let adSkipTimer = null
    let adSkips = 0
    let adCount = 0
    let encrypted = false
    let title = ''
    let win = null
    let settleTimer = null
    let done = false

    const note = (message) => {
      if (onProgress) {
        try {
          onProgress(message)
        } catch {
          /* listener's problem */
        }
      }
    }

    const record = (url, referer, why) => {
      if (!isHttp(url) || blocker.shouldBlock(url)) return
      const kind = kindOf(url)
      if (kind === 'unknown' && why !== 'content-type') return
      if (kind === 'segment') return
      const key = url.split('#')[0]
      if (hits.has(key) || skipped.has(key)) return

      // A pre-roll loads before the feature does. Naming it here and refusing to
      // settle on it is the whole point: stopping at the first stream we saw was
      // how an advert ended up being downloaded instead of the video.
      if (blocker.isAdMedia(url)) {
        skipped.add(key)
        adCount += 1
        note(`reklam akışı atlandı (${hostOf(url) || 'reklam ağı'}) — video bekleniyor`)
        return
      }

      const hit = {
        url,
        kind: kind === 'unknown' ? 'hls' : kind,
        referer: referer || pageUrl,
        origin: originOf(referer || pageUrl),
        via: 'browser',
        info: null,
        short: false,
      }
      hits.set(key, hit)
      note(`akış yakalandı: ${hostOf(url) || 'kaynak'}`)
      measure(hit)
    }

    /**
     * Never settle on a stream without knowing how long it is.
     *
     * A pre-roll can be self-hosted on the site's own CDN under an innocent path
     * — no host list will catch it. Its length gives it away, so we read that
     * first and keep listening if the stream is too short to be the feature.
     */
    function measure(hit) {
      const resolved = {
        referer: hit.referer,
        origin: hit.origin,
        userAgent: UA,
        kind: hit.kind,
      }
      describeStream(hit.url, resolved)
        .then((info) => {
          hit.info = info
          // Declared runtime matched: this is the feature, stop listening now
          // instead of waiting out the settle window.
          if (
            expectedDuration &&
            info &&
            info.duration &&
            Math.abs(info.duration - expectedDuration) <= Math.max(30, expectedDuration * 0.15)
          ) {
            note('sayfanın bildirdiği süreyle eşleşti')
            clearTimeout(settleTimer)
            settleTimer = setTimeout(finish, 400)
            return
          }
          // Long enough to be the feature: no reason to hold the window open for
          // the full settle window waiting for something better.
          if (info && info.duration && info.duration >= Math.max(featureFloor, minStreamSeconds)) {
            clearTimeout(settleTimer)
            settleTimer = setTimeout(finish, 1500)
            return
          }
          if (featureFloor > 0 && info && info.duration && info.duration < featureFloor) {
            hit.short = true
            adCount += 1
            note(
              expectedDuration
                ? `${Math.round(info.duration)} sn'lik akış — sayfa ${Math.round(expectedDuration)} sn diyor, bu reklam. Video bekleniyor`
                : `${Math.round(info.duration)} sn'lik kısa akış — reklam olabilir, video bekleniyor`
            )
            return
          }
          settle()
        })
        .catch(() => settle())
    }

    /** Wait a beat for sibling streams, then wrap up. */
    function settle() {
      if (done) return
      clearTimeout(settleTimer)
      settleTimer = setTimeout(finish, SETTLE_MS)
    }

    async function finish() {
      if (done) return
      done = true
      clearTimeout(settleTimer)
      clearTimeout(hardStop)
      clearInterval(adSkipTimer)
      for (const t of timers) clearTimeout(t)

      let cookieFile = null
      try {
        const cookies = await ses.cookies.get({})
        if (cookies.length) {
          cookieFile = path.join(os.tmpdir(), `edl-cookies-${uid('c')}.txt`)
          writeCookieJar(cookies, cookieFile)
        }
      } catch {
        /* cookies are a bonus, not a requirement */
      }

      try {
        if (win && !win.isDestroyed()) {
          if (!title) {
            title = win.webContents.getTitle() || ''
          }
          win.destroy()
        }
      } catch {
        /* already gone */
      }
      await releasePartition(partition, ses)

      const all = [...hits.values()]
      const keepers = all.filter((h) => !h.short)

      resolve({
        title: /^(video player|player|loading|untitled)?$/i.test(title.trim()) ? '' : title,
        candidates: dedupe(keepers).map((c) => ({ ...c, cookieFile })),
        engine: 'browser',
        encrypted,
        adsSkipped: adCount,
        // Reported so the caller can explain an empty result rather than just
        // saying nothing was found.
        shortOnly: keepers.length === 0 && all.length > 0,
        shortest: all.length
          ? Math.min(...all.filter((h) => h.info && h.info.duration).map((h) => h.info.duration), Infinity)
          : Infinity,
      })
    }

    const hardStop = setTimeout(finish, timeoutMs)

    try {
      ses.setUserAgent(UA)

      ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        if (blocker.shouldBlock(details.url)) return callback({ cancel: true })
        // Popunders arrive as top-level navigations in fresh windows; the window
        // open handler denies those, but block the obvious ones early too.
        record(details.url, details.referrer, 'request')
        callback({ cancel: false })
      })

      ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
        const headers = details.responseHeaders || {}
        const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type')
        const type = key ? String(headers[key]) : ''
        if (CONTENT_TYPE_MEDIA.test(type)) record(details.url, details.referrer, 'content-type')
        callback({ cancel: false })
      })

      win = new BrowserWindow({
        show: assisted,
        width: 1280,
        height: assisted ? 820 : 720,
        title: assisted ? 'Tarayıcıda yakala' : undefined,
        webPreferences: {
          partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          // The person has to see the page they are being asked to click through.
          images: assisted,
          webSecurity: true,
          backgroundThrottling: false,
          autoplayPolicy: 'no-user-gesture-required',
        },
      })

      // Closing the window is a legitimate way to give up.
      win.on('closed', () => {
        win = null
        finish()
      })

      win.webContents.setAudioMuted(!assisted)
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      // Never let the page ask for anything.
      ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))

      // The signature of this event differs across Electron majors; read loosely.
      win.webContents.on('console-message', (...parts) => {
        const text = parts.map((p) => (p && p.message ? p.message : p)).join(' ')
        if (/encrypted|widevine|playready|\bdrm\b/i.test(String(text))) encrypted = true
      })

      /**
       * Keep looking for an advert to get past, in every frame, in both modes.
       * The assisted window gets it too — the point of asking a person to clear
       * the gate isn't to make them sit through the pre-roll as well.
       */
      function startAdSkipping() {
        if (adSkipTimer) return
        adSkipTimer = setInterval(() => {
          if (done || !win || win.isDestroyed()) return
          try {
            const main = win.webContents.mainFrame
            const frames = main ? [main, ...(main.framesInSubtree || [])] : []
            for (const frame of frames) {
              try {
                const result = frame.executeJavaScript(AD_SKIP, true)
                if (result && result.then) {
                  result
                    .then((r) => {
                      if (typeof r === 'string' && r !== 'none' && r !== 'err' && adSkips < 3) {
                        adSkips += 1
                        note('reklam geçiliyor')
                      }
                    })
                    .catch(() => {})
                }
              } catch {
                /* frame detached */
              }
            }
          } catch {
            /* window gone */
          }
        }, AD_SKIP_INTERVAL)
      }

      let scheduled = false
      win.webContents.on('did-finish-load', () => {
        startAdSkipping()
        if (assisted) {
          note('pencere açık — reklamı geç ve videoyu başlat')
          try {
            win.webContents.mainFrame.executeJavaScript(ASSIST_BANNER, true).catch(() => {})
          } catch {
            /* frame gone */
          }
          return
        }
        if (scheduled) return
        scheduled = true
        note('sayfa yüklendi, oynatıcı tetikleniyor')
        // Fixed schedule rather than per-frame events: ad iframes finish loading
        // dozens of times and would burn every attempt in the first second.
        NUDGE_SCHEDULE.forEach((delay, index) => {
          timers.push(setTimeout(() => nudge(index === 0), delay))
        })
      })

      function nudge(allowClick) {
        // Runs from timers: anything thrown here would take down the main
        // process, so the whole body is guarded.
        try {
          if (done || !win || win.isDestroyed()) return

          const main = win.webContents.mainFrame
          const frames = main ? [main, ...(main.framesInSubtree || [])] : []
          let sawVideo = false
          for (const frame of frames) {
            try {
              const result = frame.executeJavaScript(PLAY_NUDGE, true)
              if (result && result.then) {
                result.then((r) => {
                  if (typeof r === 'string' && r.startsWith('video')) sawVideo = true
                }).catch(() => {})
              }
            } catch {
              /* frame detached mid-walk */
            }
          }

          // A gesture on the first pass, and again while the only thing we have
          // seen is an advert — some players wait for a click to move on to the
          // feature once the pre-roll finishes.
          const stuckOnAds = adCount > 0 && ![...hits.values()].some((h) => !h.short)
          if ((allowClick && !sawVideo) || stuckOnAds) {
            win.webContents.sendInputEvent({ type: 'mouseDown', x: 640, y: 360, button: 'left', clickCount: 1 })
            win.webContents.sendInputEvent({ type: 'mouseUp', x: 640, y: 360, button: 'left', clickCount: 1 })
          }
        } catch (err) {
          note(`oynatıcı tetiklenemedi: ${err.message}`)
        }
      }

      // Carry the user's own session in before the first request goes out.
      const boot = async () => {
        if (browserCookieJar) {
          const count = await injectCookieJar(ses, browserCookieJar)
          if (count) note(`tarayıcı oturumun yüklendi (${count} çerez)`)
        }
        if (done || !win || win.isDestroyed()) return
        note('sayfa açılıyor')
        win.loadURL(pageUrl, { userAgent: UA, httpReferrer: originOf(pageUrl) }).catch(() => {})
      }
      boot().catch(() => finish())
    } catch (err) {
      note(`tarayıcı motoru başlatılamadı: ${err.message}`)
      finish()
    }
  })
}

/* ========================================================================== *
 * public entry
 * ========================================================================== */

/**
 * Resolve a page to playable media.
 * Returns { title, candidates: [{url, kind, referer, origin, cookieFile}], engine }
 */
/**
 * Confirm a candidate really is media, and learn its duration and height while
 * we're there. Unverified guesses from player configs live or die here, which is
 * what lets the scan be aggressive without inventing entries.
 */
async function verifyCandidates(candidates, { limit = 12, concurrency = 3 } = {}) {
  const shortlist = candidates.slice(0, limit)
  const keep = []
  let cursor = 0

  async function worker() {
    while (cursor < shortlist.length) {
      const candidate = shortlist[cursor++]
      // Already measured during capture; don't pay for it twice.
      if (candidate.info && (candidate.info.duration || candidate.info.variants.length)) {
        keep.push(candidate)
        continue
      }
      const resolved = {
        referer: candidate.referer,
        origin: candidate.origin,
        userAgent: UA,
        cookieFile: candidate.cookieFile || null,
        kind: candidate.kind === 'unknown' ? 'hls' : candidate.kind,
      }
      try {
        const info = await describeStream(candidate.url, resolved)
        // Duration is the honest test of "this is a video": a poster image
        // reports a resolution but never a running time.
        const real = !!(info.duration || info.variants.length)
        if (real) {
          keep.push({
            ...candidate,
            kind: info.variants.length ? 'hls' : candidate.kind === 'unknown' ? 'file' : candidate.kind,
            info,
          })
        } else if (!candidate.needsCheck) {
          // Extension said media but nothing could read it; keep it and let
          // yt-dlp have the final say rather than dropping a real find.
          keep.push({ ...candidate, info: null })
        }
      } catch {
        if (!candidate.needsCheck) keep.push({ ...candidate, info: null })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, shortlist.length) }, worker))
  return dedupe(keep)
}

/**
 * A master playlist already contains its variants, so offering those separately
 * just clutters the list with duplicates of the same video at fixed qualities —
 * yt-dlp picks the variant from the master anyway.
 */
function dropVariantDuplicates(candidates) {
  const children = new Set()
  for (const c of candidates) {
    for (const variant of (c.info && c.info.variants) || []) {
      if (variant.url) children.add(variant.url.split('#')[0])
    }
  }
  if (!children.size) return candidates
  const kept = candidates.filter((c) => !children.has(c.url.split('#')[0]))
  return kept.length ? kept : candidates
}

/**
 * Second line of defence against adverts, for the ones served from a host we
 * don't recognise: a pre-roll runs for seconds, a feature for many minutes. Once
 * we know the durations, anything dwarfed by the longest stream is dropped.
 *
 * Only applies when something long was actually found — otherwise the page may
 * genuinely hold a short clip, and dropping it would be wrong.
 */
function dropShortStreams(candidates, minSeconds, expected = null) {
  const timed = candidates.filter((c) => c.info && c.info.duration)
  if (!timed.length) return { kept: candidates, dropped: 0 }

  let floor
  if (expected && expected > 0) {
    // The page told us the runtime; trust it over any relative comparison.
    floor = expected * 0.5
  } else {
    const longest = Math.max(...timed.map((c) => c.info.duration))
    if (longest < minSeconds) return { kept: candidates, dropped: 0 }
    floor = Math.max(minSeconds / 2, longest * 0.25)
  }

  const kept = candidates.filter((c) => c.info && c.info.duration && c.info.duration >= floor)

  // Without a declared runtime, an empty result more likely means our guess was
  // wrong than that everything was an advert — so keep what we had.
  if (!kept.length && !expected) return { kept: candidates, dropped: 0 }

  if (expected) {
    kept.sort(
      (a, b) => Math.abs(a.info.duration - expected) - Math.abs(b.info.duration - expected)
    )
  }
  return { kept, dropped: candidates.length - kept.length }
}

/**
 * Resolve a page to playable media.
 * Returns { title, thumbnail, candidates: [{url, kind, referer, origin, cookieFile, info}], engine }
 */
async function resolvePage(
  pageUrl,
  {
    onProgress = null,
    timeoutMs = 45000,
    staticOnly = false,
    browserCookieJar = null,
    minStreamSeconds = 120,
    blockRules = null,
    preferEngine = null,
  } = {}
) {
  if (!isHttp(pageUrl)) return { title: '', candidates: [], engine: 'none' }
  if (blockRules) configureBlocker(blockRules)

  // A host we've resolved before tells us which engine actually works. Going
  // straight there skips a full crawl and its verification round — the single
  // biggest saving available, because the static pass is wasted effort on any
  // site whose player builds its source in JavaScript.
  const skipStatic = preferEngine === 'browser'

  if (onProgress) {
    onProgress(skipStatic ? 'bu site için oynatıcı taraması' : 'sayfa ve oynatıcı kodları taranıyor')
  }
  const fast = skipStatic
    ? await staticScan(pageUrl, { maxFetches: 1, maxDepth: 0 })
    : await staticScan(pageUrl, { onProgress })

  if (fast.expectedDuration && onProgress) {
    onProgress(`sayfa videoyu ${Math.round(fast.expectedDuration / 60)} dk diye bildiriyor`)
  }

  if (fast.candidates.length && !skipStatic) {
    const verified = dropVariantDuplicates(await verifyCandidates(fast.candidates))
    const { kept, dropped } = dropShortStreams(verified, minStreamSeconds, fast.expectedDuration)
    if (kept.length) {
      if (dropped && onProgress) onProgress(`${dropped} kısa akış (reklam) atlandı`)
      return {
        ...fast,
        title: cleanTitle(fast.title, hostOf(pageUrl)),
        candidates: kept,
        adsSkipped: dropped,
        userAgent: UA,
      }
    }
  }
  if (staticOnly) {
    return { ...fast, title: cleanTitle(fast.title, hostOf(pageUrl)), candidates: [], userAgent: UA }
  }

  if (onProgress) onProgress('oynatıcı görünmez tarayıcıda çalıştırılıyor')
  const deep = await browserScan(pageUrl, {
    timeoutMs,
    onProgress,
    browserCookieJar,
    minStreamSeconds,
    expectedDuration: fast.expectedDuration,
  })
  const verified = deep.candidates.length ? await verifyCandidates(deep.candidates) : []
  // Keep browser finds even if verification couldn't read them: the session that
  // captured them is gone, so a fresh fetch may legitimately fail.
  const pool = dropVariantDuplicates(verified.length ? verified : deep.candidates)
  const { kept, dropped } = dropShortStreams(pool, minStreamSeconds, fast.expectedDuration)
  if (dropped && onProgress) onProgress(`${dropped} kısa akış (reklam) atlandı`)

  return {
    ...deep,
    candidates: kept,
    adsSkipped: (deep.adsSkipped || 0) + dropped,
    title: cleanTitle(deep.title || fast.title, hostOf(pageUrl)),
    thumbnail: fast.thumbnail || '',
    userAgent: UA,
  }
}

/**
 * Open the page visibly and record whatever the user manages to play.
 * The escape hatch for ad walls, consent gates and bot checks: a person clears
 * them, the app only listens.
 */
async function assistedCapture(
  pageUrl,
  {
    onProgress = null,
    browserCookieJar = null,
    minStreamSeconds = 120,
    timeoutMs = 300000,
    blockRules = null,
  } = {}
) {
  if (!isHttp(pageUrl)) return { title: '', candidates: [], engine: 'assisted' }
  if (blockRules) configureBlocker(blockRules)

  // One cheap fetch for the page's own title, poster and declared runtime — the
  // runtime is what lets us tell the feature from a pre-roll here too.
  const meta = await staticScan(pageUrl, { maxFetches: 1, maxDepth: 0 })

  const result = await browserScan(pageUrl, {
    assisted: true,
    timeoutMs,
    onProgress,
    browserCookieJar,
    minStreamSeconds,
    expectedDuration: meta.expectedDuration,
  })

  const verified = result.candidates.length ? await verifyCandidates(result.candidates) : []
  const pool = dropVariantDuplicates(verified.length ? verified : result.candidates)
  const { kept, dropped } = dropShortStreams(pool, minStreamSeconds, meta.expectedDuration)

  return {
    ...result,
    engine: 'assisted',
    candidates: kept,
    adsSkipped: (result.adsSkipped || 0) + dropped,
    title: cleanTitle(result.title || meta.title, hostOf(pageUrl)),
    thumbnail: meta.thumbnail || '',
    userAgent: UA,
  }
}

module.exports = { resolvePage, assistedCapture, unpackPacked, UA }
