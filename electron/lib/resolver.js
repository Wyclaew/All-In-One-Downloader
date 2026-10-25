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
const { describeStream, applyPlayerMetadata, estimateVariantSizes, accessEvidence } = require('./mediainfo')
const { electronRules: proxyRules, fetchVia } = require('./proxy')
const userscripts = require('./userscripts')
const { discoverSources, documentBaseOf, htmlAttributes } = require('./source-discovery')
const { DISCOVERY_SCRIPT, FRAME_SCRIPT, alternativeScript } = require('./browser-discovery')
const { normaliseTrack, collectTextTracks, mergeTextTracks, PAGE_TEXT_TRACKS } = require('./text-tracks')
const { uid, hostOf } = require('./util')

// Each simultaneous resolve has its own rules; callbacks retain their context.
const { AsyncLocalStorage } = require('async_hooks')
const resolverContext = new AsyncLocalStorage()
const defaultBlocker = createBlocker({})
const activeBlocker = () => resolverContext.getStore() || defaultBlocker

function withRules(options, fn) {
  const rules = options?.blockRules || {}
  return resolverContext.run(createBlocker({
    extraBlocked: rules.extraBlockedHosts || '', allowTrackers: rules.blockTrackers === false,
  }), fn)
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'

/** Extensions that mean "this is the thing we want to hand to yt-dlp". */
/**
 * The same site often ships two different players. Desktop gets one that builds
 * its source in JavaScript; a phone gets a plain <video src> because the phone's
 * own player handles it. Asking as a phone is a second, cheaper document.
 */
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

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

/**
 * JSON endpoints worth opening. Narrow enough to skip the analytics chatter every
 * page makes, wide enough to catch the document a player reads its sources from.
 */
const JSON_PLAYER_HINT = /(config|playlist|manifest|sources?|player|media|stream|video|episode|watch)/i

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
function unpackPacked(input) {
  const source = String(input || '').slice(0, 3 * 1024 * 1024)
  const results = []
  let total = 0, attempts = 0
  const quoted = (start) => {
    const quote = source[start]
    if (quote !== "'" && quote !== '"') return null
    let value = ''
    for (let i = start + 1; i < source.length && i - start <= 1024 * 1024; i += 1) {
      let char = source[i]
      if (char === quote) return { value, end: i + 1 }
      if (char === '\\') {
        char = source[++i]
        if (char === undefined) return null
        const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' }
        if (char === 'x' || char === 'u') {
          const length = char === 'x' ? 2 : 4, hex = source.slice(i + 1, i + 1 + length)
          if (!new RegExp('^[0-9a-f]{' + length + '}$', 'i').test(hex)) return null
          value += String.fromCharCode(parseInt(hex, 16)); i += length; continue
        }
        if (char === '\n') continue
        if (char === '\r') { if (source[i + 1] === '\n') i += 1; continue }
        value += escapes[char] ?? char
      } else value += char
    }
    return null
  }
  const prefix = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[dr]\s*\)\s*\{/g
  let match
  while (attempts < 8 && (match = prefix.exec(source))) {
    attempts += 1
    const call = source.slice(prefix.lastIndex, prefix.lastIndex + 8192).match(/\}\s*\(\s*(['"])/)
    if (!call) continue
    const payload = quoted(prefix.lastIndex + call.index + call[0].length - 1)
    if (!payload) continue
    const numbers = source.slice(payload.end, payload.end + 96).match(/^\s*,\s*(\d{1,3})\s*,\s*(\d{1,6})\s*,\s*/)
    if (!numbers) continue
    const radix = Number(numbers[1]), count = Number(numbers[2])
    if (radix < 2 || radix > 62 || count > 20000) continue
    const dictionary = quoted(payload.end + numbers[0].length)
    if (!dictionary || !/^\s*\.\s*split\s*\(\s*(['"])\|\1\s*\)/.test(source.slice(dictionary.end, dictionary.end + 64))) continue
    const words = dictionary.value.split('|')
    if (count > words.length) continue
    const tokens = new Map()
    for (let i = 0; i < count; i += 1) if (words[i]) tokens.set(encodeBase(i, radix), words[i])
    let size = payload.value.length, oversized = false
    // One scan of the payload replaces the former dictionary-times-payload
    // regex work. Neither a huge count nor inserted token-like words recurse.
    const unpacked = payload.value.replace(/\b[0-9a-zA-Z]+\b/g, (token) => {
      const word = tokens.get(token)
      if (!word) return token
      const next = size + word.length - token.length
      if (next + total > 3 * 1024 * 1024) { oversized = true; return token }
      size = next; return word
    })
    if (!oversized && size + total <= 3 * 1024 * 1024) { results.push(unpacked); total += size + 1 }
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

async function fetchText(
  url,
  referer,
  { timeoutMs = 12000, userAgent = UA, json = false, proxy = '', cookieFile = null, signal = null, maxBytes = 3 * 1024 * 1024, retries = 1 } = {}
) {
  const headers = {
    'User-Agent': userAgent,
    Accept: json
      ? 'application/json, text/javascript, */*;q=0.8'
      : 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'tr,en-US;q=0.8,en;q=0.6',
    // Players call their own API from the page, and plenty of them check.
    ...(json ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
    ...(referer ? { Referer: referer } : {}),
  }

  // Everything on behalf of a proxied link goes through the tunnel. `fetch`
  // cannot be given an agent, so a proxied source has to leave that path
  // entirely — otherwise the page is read from the real address while only the
  // download is tunnelled.
  try {
    const res = await fetchVia(url, { headers, proxy, timeoutMs, signal, maxBytes, retries, allowBinaryText: true, headersFor: (target) => ({ Cookie: require('./mediainfo').cookieHeaderFor(cookieFile, target) }) })
    return { text: String(res.text || '').slice(0, 3 * 1024 * 1024), finalUrl: res.finalUrl || url, status: res.status, contentType: res.headers?.['content-type'] || '' }
  } catch (err) {
    return { text: '', finalUrl: url, error: err.message, errorCode: err.code }
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

/**
 * Players on these hosts are ones yt-dlp already knows how to extract. Finding
 * one on an unrecognised page is the best possible outcome: instead of scraping
 * the stream ourselves, we hand the embed URL back to yt-dlp and get its full
 * format list, subtitles and metadata.
 */
const EMBED_HOST =
  /^https?:\/\/(?:[\w-]+\.)*(?:youtube\.com\/embed|youtube-nocookie\.com\/embed|youtu\.be|player\.vimeo\.com|dailymotion\.com\/(?:embed|player)|ok\.ru\/videoembed|vk\.com\/video_ext|facebook\.com\/plugins\/video|player\.twitch\.tv|streamable\.com|sproutvideo\.com|wistia\.(?:com|net)|players\.brightcove\.net|cdn\.jwplayer\.com|content\.jwplatform\.com|kaltura\.com|rutube\.ru\/play|bitchute\.com\/embed|odysee\.com\/\$\/embed|archive\.org\/embed|w\.soundcloud\.com\/player|iframe\.mediadelivery\.net|embed\.redtube|players\.akamai|rumble\.com\/embed|geo\.dailymotion\.com\/player|tiktok\.com\/embed|embed\.ted\.com|[\w.-]+\/videos\/embed\/[0-9a-f-]{8,}|my\.mail\.ru\/video\/embed|coub\.com\/embed)/i

/**
 * Watch URL -> embed URL.
 *
 * A site's watch page and its embed page are different documents served by
 * different code, and when one breaks the other often still works. Vimeo is the
 * standing example: yt-dlp's extractor fails on `vimeo.com/ID` with an OAuth 401
 * but handles `player.vimeo.com/video/ID` perfectly, because that path never asks
 * for a token. Rewriting is cheap, so it is always worth a try.
 */
const EMBED_REWRITES = [
  [/^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)/i, (m) => `https://player.vimeo.com/video/${m[1]}`],
  [
    /^https?:\/\/(?:www\.)?dailymotion\.com\/video\/([a-z0-9]+)/i,
    (m) => `https://www.dailymotion.com/embed/video/${m[1]}`,
  ],
  [
    /^https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?(?:.*&)?v=([\w-]{6,})/i,
    (m) => `https://www.youtube.com/embed/${m[1]}`,
  ],
  [/^https?:\/\/youtu\.be\/([\w-]{6,})/i, (m) => `https://www.youtube.com/embed/${m[1]}`],
  [/^https?:\/\/(?:www\.)?ok\.ru\/video\/(\d+)/i, (m) => `https://ok.ru/videoembed/${m[1]}`],
  [
    /^https?:\/\/(?:www\.)?bitchute\.com\/video\/([\w-]+)/i,
    (m) => `https://www.bitchute.com/embed/${m[1]}/`,
  ],
  [/^https?:\/\/rutube\.ru\/video\/(\w+)/i, (m) => `https://rutube.ru/play/embed/${m[1]}`],
  [
    /^https?:\/\/(?:www\.)?twitch\.tv\/videos\/(\d+)/i,
    (m) => `https://player.twitch.tv/?video=${m[1]}&parent=twitch.tv`,
  ],
  [
    /^https?:\/\/(?:www\.)?archive\.org\/details\/([\w.-]+)/i,
    (m) => `https://archive.org/embed/${m[1]}`,
  ],
]

/** Embed URLs derivable from a watch URL's shape. */
function embedCandidatesFor(url) {
  const out = []
  for (const [pattern, build] of EMBED_REWRITES) {
    const match = String(url).match(pattern)
    if (!match) continue
    const embed = build(match)
    if (isHttp(embed) && embed !== url) out.push(embed)
  }
  return out
}

/** `'8u3m.tsefinam//:sptth'` — the URL stored backwards. */
function decodeReversed(text) {
  if (!/\/\/:s?ptth/.test(text)) return ''
  const out = []
  const re = /(?:^|[^\w\-./:%?=&#])([\w\-./:%?=&#]{1,16000}\/\/:s?ptth)(?=$|[^\w\-./:%?=&#])/g
  let match
  while ((match = re.exec(text)) !== null) {
    const forward = match[1].split('').reverse().join('')
    if (isHttp(forward)) out.push(forward)
  }
  return out.join('\n')
}

/** `String.fromCharCode(104,116,116,112,...)` spelling out a URL. */
function decodeCharCodes(text) {
  if (!/fromCharCode\s*\(/i.test(text)) return ''
  const out = []
  const re = /fromCharCode\s*\(([\d\s,]{12,})\)/gi
  let match
  while ((match = re.exec(text)) !== null) {
    const decoded = match[1]
      .split(',')
      .map((n) => Number(n.trim()))
      .filter((n) => Number.isFinite(n) && n > 0 && n < 0x10000)
      .map((n) => String.fromCharCode(n))
      .join('')
    if (/https?:\/\//i.test(decoded)) out.push(decoded)
  }
  return out.join('\n')
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
  /\b(?:file|src|source|videoUrl|video_url|playUrl|play_url|stream|streamUrl|hls|hlsUrl|manifest|contentUrl|mp4|m3u8)\b\s*[:=]\s*["'`]((?:https?:\/\/|\/\/|\/|\.\.?\/)[^"'`\s]+)["'`]/gi

const TAG_SRC_RE = /<(?:video|source|audio)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi

/** Custom players keep their source in a data attribute more often than not. */
const DATA_ATTR_RE =
  /\bdata-(?:src|url|file|video|video-src|videourl|source|hls|stream|media|mp4|m3u8|player)\s*=\s*["'](https?:\/\/[^"']{12,})["']/gi

/**
 * Standard metadata a page can declare about its own video. `og:video` and
 * JSON-LD `contentUrl` are frequently the file itself; `embedUrl` is a player we
 * can hand to yt-dlp. Both are site-agnostic and cost nothing to read.
 */
function declaredMediaOf(html, baseUrl) {
  const discovered = discoverSources(html, baseUrl)
  return [...new Set([...discovered.sources.map((s) => s.url), ...discovered.frames])]
}

function collectFromText(text, baseUrl) {
  const structured = discoverSources(text, baseUrl)
  // Structured data has already been walked with explicit media roles. Do not
  // re-scan its ads/navigation/license fields as unscoped JavaScript configs.
  let legacy = String(text)
  try { JSON.parse(legacy); legacy = '' } catch {}
  legacy = legacy.replace(/<script\b[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>[\s\S]*?<\/script>/gi, '')
  const raw = legacy.replace(/data:text\/html(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=]+)/gi, (_, value) => Buffer.from(value, 'base64').toString('utf8'))
  const decodedSources = []
  const expanded = [
    normaliseText(decodeEntities(raw)).replace(/\\"/g, '"'),
    normaliseText(unpackPacked(raw)),
    normaliseText(decodeBase64Blobs(raw)),
    normaliseText(decodeHexEscapes(raw)),
    normaliseText(decodePercentEscapes(raw)),
    normaliseText(decodeReversed(raw)),
    normaliseText(decodeCharCodes(raw)),
    ...structured.documents,
  ]
    .filter(Boolean)
    .map((part) => {
      try { decodedSources.push(...discoverSources(JSON.parse(part), structured.documentBase || baseUrl).sources); return '' } catch {}
      return part.replace(/<script\b[^>]*(?:type=["']application\/(?:ld\+)?json["']|id=["']__(?:NEXT_DATA|NUXT_DATA)__["'])[^>]*>[\s\S]*?<\/script>/gi, '')
    })
    .join('\n')

  const found = [...structured.sources, ...decodedSources].filter((c) => !activeBlocker().shouldBlock(c.url) && !activeBlocker().isAdMedia(c.url)).map((c) => ({ ...c, referer: baseUrl, origin: originOf(baseUrl), via: 'structured' }))
  const push = (url, confident) => {
    let clean = decodeEntities(String(url)).replace(/[",';)\]}]+$/, '').trim()
    try { const parsed = new URL(clean, structured.documentBase || baseUrl); if (parsed.username || parsed.password) return; clean = parsed.href } catch { return }
    if (!isHttp(clean) || activeBlocker().shouldBlock(clean)) return
    if (NON_MEDIA_EXT.test(clean)) return
    if (activeBlocker().isAdMedia(clean)) return
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
  // Attribute src on images/iframes/scripts is not a player config value.
  const configText = expanded.replace(/<[^>]+>/g, ' ')
  while ((match = CONFIG_VALUE_RE.exec(configText)) !== null) push(match[1], true)

  TAG_SRC_RE.lastIndex = 0
  while ((match = TAG_SRC_RE.exec(expanded)) !== null) {
    try {
      push(new URL(match[1], baseUrl).href, true)
    } catch {
      /* malformed */
    }
  }

  DATA_ATTR_RE.lastIndex = 0
  while ((match = DATA_ATTR_RE.exec(expanded)) !== null) push(match[1], true)

  return { candidates: dedupe(found), expanded }
}

/**
 * The player's own source API.
 *
 * On a large share of streaming hosts the address is not in the page at all: the
 * page ships an id, and the player asks its own backend for the stream — a small
 * JSON endpoint like `/api/source/abc123` or `/player/index.php?data=…`. Scraping
 * the HTML finds nothing because there is nothing to find. Asking the endpoint
 * the player would ask, with the page as Referer, gets the same answer the player
 * gets — in one request, without starting a browser.
 */
const SOURCE_API_RE =
  /["'`(=]\s*((?:https?:\/\/[^"'`\s<>]+|\/[^"'`\s<>]*)?(?:\/api\/(?:v\d+\/)?(?:source|sources|video|stream|player|embed)|\/getSources?\b|\/get_?video(?:_?info)?\b|\/player\/index\.php|\/(?:source|sources|embed-source|player)\.php|\/ajax\/(?:video|source|player|embed)[^"'`\s<>]*)[^"'`\s<>{}]*)/gi

/**
 * Endpoints worth asking, absolute and same-host only.
 *
 * Same-host on purpose: a source API belongs to the site serving the player.
 * Following one off-site would mean fetching whatever any script on the page
 * cares to name.
 */
function collectSourceApis(text, baseUrl) {
  let host = ''
  try {
    host = new URL(baseUrl).hostname
  } catch {
    return []
  }
  const out = new Set()
  SOURCE_API_RE.lastIndex = 0
  let match
  while ((match = SOURCE_API_RE.exec(text)) !== null) {
    let abs
    try {
      abs = new URL(normaliseText(match[1]), baseUrl)
    } catch {
      continue
    }
    if (!/^https?:$/.test(abs.protocol)) continue
    if (abs.hostname !== host && !abs.hostname.endsWith(`.${host}`)) continue
    if (activeBlocker().shouldBlock(abs.href)) continue
    out.add(abs.href)
  }
  return [...out]
}

/**
 * Script URLs named inside another script.
 *
 * A loader does not write a `<script src>` tag into the markup — it does
 * `el.src = "/static/player.js"`, or names the file in a config. The tag-based
 * extractor cannot see either, so the chain stops at the loader and the real
 * player, where the source actually lives, is never read.
 */
function collectScriptRefs(text, baseUrl) {
  let host = ''
  try {
    host = new URL(baseUrl).hostname
  } catch {
    return []
  }
  const out = new Set()
  const re = /["'`]([^"'`\s<>]+\.js(?:\?[^"'`\s<>]*)?)["'`]/gi
  let match
  while ((match = re.exec(text)) !== null) {
    let abs
    try {
      abs = new URL(normaliseText(match[1]), baseUrl)
    } catch {
      continue
    }
    if (!/^https?:$/.test(abs.protocol)) continue
    if (abs.hostname !== host && !abs.hostname.endsWith(`.${host}`)) continue
    if (activeBlocker().shouldBlock(abs.href)) continue
    if (/jquery|bootstrap|analytics|gtag|gtm|recaptcha|polyfill|react|vue\.|lodash/i.test(abs.pathname)) {
      continue
    }
    out.add(abs.href)
  }
  return [...out]
}

/** `<meta http-equiv="refresh" content="0; url=...">` — a redirect with no 3xx. */
function metaRefreshOf(html, baseUrl) {
  const match = String(html).match(
    /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["'][^"']*?url\s*=\s*([^"';]+)/i
  )
  if (!match) return null
  try {
    const abs = new URL(normaliseText(match[1].trim()), baseUrl)
    return /^https?:$/.test(abs.protocol) ? abs.href : null
  } catch {
    return null
  }
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
    if (!/^https?:$/.test(abs.protocol) || activeBlocker().shouldBlock(abs.href)) continue
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
  for (const match of String(html).matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = htmlAttributes(match[0])
    if (/^(?:og:video:duration|video:duration|duration)$/i.test(attrs.property || attrs.name || attrs.itemprop || '')) {
      const duration = parseDurationValue(attrs.content)
      if (duration) return duration
    }
  }
  let nodes = 0
  const find = (value, depth = 0) => {
    if (++nodes > 1500 || depth > 10 || !value || typeof value !== 'object') return null
    if (Array.isArray(value)) { for (const entry of value.slice(0, 100)) { const d = find(entry, depth + 1); if (d) return d } return null }
    if (/(?:^|[\s,/])(?:VideoObject|AudioObject|TVEpisode|Movie)(?:$|[\s,])/i.test(String(value['@type'] || ''))) {
      const duration = parseDurationValue(value.duration)
      if (duration) return duration
    }
    for (const [key, entry] of Object.entries(value).slice(0, 100)) {
      if (/^(?:advertisement|ads|related|recommendations)$/i.test(key)) continue
      const d = find(entry, depth + 1); if (d) return d
    }
    return null
  }
  for (const block of String(html).matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    if (block[1].length > 512 * 1024) continue
    try { const duration = find(JSON.parse(block[1])); if (duration) return duration } catch {}
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

function retryableNavigationError(error) {
  return /\bERR_(?:CONNECTION_(?:CLOSED|RESET|ABORTED)|EMPTY_RESPONSE|TIMED_OUT|NETWORK_CHANGED)\b/.test(String(error?.code || '') + ' ' + String(error?.message || ''))
}

function createNavigationGuard(now = Date.now) {
  const frames = new WeakMap(), legacyMain = {}
  return (event, fallbackUrl = '') => {
    const frame = event.frame || (event.isMainFrame !== false ? legacyMain : null)
    if (!frame) return false
    const at = now(), url = String(event.url || fallbackUrl).split('#')[0]
    const history = (frames.get(frame) || []).filter((entry) => at - entry.at <= 6000).slice(-31)
    history.push({ at, url }); frames.set(frame, history)
    return history.filter((entry) => entry.url === url).length > 4
  }
}

function usablePlayerFrame(url, blocker = activeBlocker()) {
  if (!isHttp(url) || blocker.shouldBlock(url) || blocker.isAdMedia(url)) return false
  try {
    const parsed = new URL(url)
    // These remain available to a player's ad lifecycle, but opening their
    // hidden sync documents as alternative video players wastes the deadline.
    return !/^(?:sync|usync|match|pixel)\./i.test(parsed.hostname) && !/^\/(?:cdn-cgi|(?:cookie|user)[-_]?sync|sync|usync|pixel)(?:\/|\.|$)/i.test(parsed.pathname)
  } catch { return false }
}

function authenticationGateOf(markup, evidence = {}) {
  if (evidence.accessRequired) return true
  const text = String(markup).slice(0, 65536).replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>|<[^>]+>/gi, ' ').replace(/\s+/g, ' ')
  return /(?:\b(?:login|sign.?in|registration|membership)\s+(?:is\s+)?required\b|(?:you\s+(?:must|need to)\s+(?:sign in|log in|register|create an account)).{0,60}(?:watch|view|continue|video|content)|(?:sign in|log in|register).{0,50}to\s+(?:watch|view|continue)|(?:izlemek|izleyebilmek|görüntülemek|erişmek|bu içerik|bu video).{0,100}(?:giriş yap|üye ol|kayıt ol))/i.test(text)
}

/**
 * Players a page offers, whether as an iframe or as a button that will load one.
 *
 * Besides real iframes (and lazy ones, and iframe markup written inside script
 * strings with escaped quotes), this reads the "alternative player" switches a
 * great many streaming sites use: a row of buttons whose data attribute holds the
 * embed address — often base64'd — and which only becomes an iframe when clicked.
 * Each of those is a player we can open directly, without clicking anything.
 */
const ALT_PLAYER_ATTR =
  /\bdata-(?:src|frame|iframe|embed|link|url|player|video|lazy-src|lazy|href|source|target|hash|id)\s*=\s*["']([^"']{8,600})["']/gi

function decodeMaybeBase64(value) {
  const v = String(value).trim()
  if (/^https?:\/\//i.test(v) || v.startsWith('//')) return v
  if (/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(v)) {
    try {
      const decoded = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
      if (/^https?:\/\/[^\s"'<>]+$/i.test(decoded.trim())) return decoded.trim()
      const inner = decoded.match(/<iframe[^>]+src=["']([^"']+)["']/i)
      if (inner) return inner[1]
    } catch {
      /* not base64 after all */
    }
  }
  return null
}

function collectIframes(html, baseUrl) {
  const structured = discoverSources(html, baseUrl)
  const urls = structured.frames.filter((url) => !activeBlocker().shouldBlock(url))
  // Iframe markup inside a JS or JSON string arrives with escaped quotes.
  const text = normaliseText(decodeEntities([html, ...structured.documents].join('\n'))).replace(/\\"/g, '"').replace(/\\'/g, "'")
  const push = (raw) => {
    try {
      const abs = new URL(decodeEntities(raw), structured.documentBase || baseUrl).href
      if (isHttp(abs) && !activeBlocker().shouldBlock(abs) && !urls.includes(abs)) urls.push(abs)
    } catch {
      /* malformed src */
    }
  }
  const re = /<iframe\b[^>]*?\b(?:src|data-src|data-litespeed-src|data-lazy-src)\s*=\s*["']([^"']+)["']/gi
  let match
  while ((match = re.exec(text)) !== null) push(match[1])

  const page = (() => {
    try {
      return new URL(baseUrl).hostname
    } catch {
      return ''
    }
  })()
  while ((match = ALT_PLAYER_ATTR.exec(text)) !== null) {
    const decoded = decodeMaybeBase64(match[1])
    if (!decoded) continue
    let abs
    try {
      abs = new URL(decodeEntities(decoded), baseUrl)
    } catch {
      continue
    }
    // An address on another host, or a path that reads like a player, is an
    // embed; an image or a stylesheet on the page's own host is not.
    if (/\.(?:jpe?g|png|gif|webp|svg|css|js|woff2?)(?:\?|$)/i.test(abs.pathname)) continue
    if (abs.hostname === page && !/(embed|player|iframe|video|watch|play|source|ajax)/i.test(abs.pathname + abs.search)) {
      continue
    }
    push(abs.href)
  }
  return urls.slice(0, 24)
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
async function staticScan(
  pageUrl,
  { maxDepth = 4, maxFetches = 24, onProgress = null, proxy = '', browserCookieJar = null, signal = null } = {}
) {
  const candidates = []
  const subtitles = []
  let title = ''
  let failure = null
  let accessRequired = false
  let challengeRequired = false
  let thumbnail = ''
  let expectedDuration = null
  const embeds = new Set()
  const frames = []
  let fetches = 0
  const visited = new Set()
  let queue = [{ url: pageUrl, referer: '', depth: 0, kind: 'page' }]

  while (queue.length && fetches < maxFetches && !signal?.aborted) {
    // Fetch a whole level at once. These are independent documents and the time
    // is all network latency, so doing them one after another was leaving most
    // of the wait on the table.
    const batch = []
    // A slow analytics/player helper must not hold a ready iframe document in
    // the same Promise.all batch. Follow the actual document chain first;
    // speculative scripts/APIs can use the remaining phase budget afterwards.
    const documents = queue.filter((job) => job.kind === 'page')
    const pending = documents.length ? documents : queue
    const deferred = documents.length ? queue.filter((job) => job.kind !== 'page') : []
    for (const job of pending) {
      if (fetches + batch.length >= maxFetches) break
      if (visited.has(job.url)) continue
      visited.add(job.url)
      batch.push(job)
    }
    fetches += batch.length

    const fetched = await Promise.all(
      batch.map(async (job) => ({
        job,
        ...(await fetchText(job.url, job.referer, { json: job.kind === 'api', proxy, cookieFile: browserCookieJar, signal })),
      }))
    )

    const next = deferred
    for (const { job, text, finalUrl, status, error, errorCode, contentType } of fetched) {
      if (job.url === pageUrl) {
        const evidence = accessEvidence(status, text)
        failure = error ? { message: error, code: errorCode } : status >= 400 || evidence.networkBlocked ? { status, errorKind: evidence.errorKind } : null
        accessRequired = evidence.accessRequired
        challengeRequired = evidence.challengeRequired
      }
      if (status < 400 && (/^\s*#EXTM3U/.test(text || '') || /<(?:[\w.-]+:)?MPD(?:\s|>)/i.test((text || '').slice(0, 1000)) || /^(?:video|audio)\//i.test(contentType || ''))) {
        candidates.push({ url: finalUrl, kind: /^\s*#EXTM3U/.test(text || '') ? 'hls' : /MPD/.test((text || '').slice(0, 1000)) ? 'dash' : 'file', referer: job.referer || pageUrl, cookieFile: browserCookieJar, via: 'content' })
        continue
      }
      if (!text || status >= 400) continue

      if (job.kind === 'page') {
        if (!title) title = pageTitleOf(text)
        if (!thumbnail) thumbnail = pageImageOf(text)
        if (!expectedDuration) expectedDuration = pageDurationOf(text)
      }

      // Anything pointing at a player yt-dlp knows is worth more than anything
      // we could scrape ourselves; collect those separately.
      for (const url of [
        ...collectIframes(text, finalUrl),
        ...declaredMediaOf(text, finalUrl),
      ]) {
        if (EMBED_HOST.test(url)) embeds.add(url)
      }

      subtitles.push(...collectTextTracks(text, finalUrl))
      const { candidates: found } = collectFromText(text, finalUrl)
      if (found.length && onProgress) {
        onProgress(`${found.length} olası akış bulundu, doğrulanıyor`)
      }
      candidates.push(...found.map((c) => ({ ...c, cookieFile: browserCookieJar })))

      /*
       * Order matters here, because the fetch budget is shared.
       *
       * Frames and the refresh redirect are the proven paths — a nested player
       * document is where most sites actually keep the stream. The source API and
       * the script chain are newer and speculative: they win outright when they
       * hit, but queueing them first would let a page with four API-looking URLs
       * spend the budget before a single iframe was opened. So: documents first,
       * guesses after.
       */
      if (job.kind === 'page') {
        const refresh = metaRefreshOf(text, finalUrl)
        if (refresh && job.depth < maxDepth) {
          next.push({ url: refresh, referer: finalUrl, depth: job.depth + 1, kind: 'page' })
        }

        if (job.depth < maxDepth) {
          for (const frame of collectIframes(text, finalUrl)) {
            // Worth revisiting on its own later: a nested player is served
            // without the wrapper page's ad wall or bot check.
            if (!/recaptcha|about:blank/i.test(frame)) {
              frames.push({ url: frame, referer: finalUrl, depth: job.depth + 1 })
            }
            next.push({ url: frame, referer: finalUrl, depth: job.depth + 1, kind: 'page' })
          }
        }

        for (const script of collectScripts(text, documentBaseOf(text, finalUrl)).slice(0, 5)) {
          next.push({ url: script, referer: finalUrl, depth: job.depth, kind: 'script' })
        }
      }

      // The page and its scripts both name the endpoint the player will call.
      if (job.kind !== 'api') {
        for (const api of collectSourceApis(text, finalUrl).slice(0, 3)) {
          next.push({ url: api, referer: finalUrl, depth: job.depth, kind: 'api' })
        }
      }

      // A loader script that fetches the real player is common enough to be
      // worth one hop, but only one: scripts fan out without limit otherwise.
      if (job.kind === 'script' && job.depth === 0) {
        for (const nested of collectScriptRefs(text, finalUrl).slice(0, 2)) {
          next.push({ url: nested, referer: finalUrl, depth: 1, kind: 'script' })
        }
      }
    }
    queue = next
  }

  /*
   * Nothing found as a desktop browser? Ask again as a phone.
   *
   * Sites routinely serve two different players: an MSE one to desktop, where the
   * source only exists inside JavaScript, and a plain <video src> to mobile
   * because the phone's own player handles it. When the desktop pass comes back
   * empty this one request often has the answer sitting in the markup — far
   * cheaper than the browser engine, and it costs nothing when it fails.
   */
  // Not on the metadata-only peeks (maxFetches: 1), which are called for a title
  // and a runtime and would pay for a second document they never read.
  if (!candidates.length && maxFetches > 1 && !signal?.aborted) {
    if (onProgress) onProgress('mobil sürüm deneniyor')
    const { text, finalUrl } = await fetchText(pageUrl, '', { userAgent: MOBILE_UA, proxy, cookieFile: browserCookieJar, signal })
    if (text) {
      const { candidates: mobile } = collectFromText(text, finalUrl)
      for (const candidate of mobile) candidates.push({ ...candidate, via: 'static-mobile', userAgent: MOBILE_UA, cookieFile: browserCookieJar })
      if (!expectedDuration) expectedDuration = pageDurationOf(text)
      for (const api of collectSourceApis(text, finalUrl).slice(0, 2)) {
        const answer = await fetchText(api, finalUrl, { json: true, proxy, cookieFile: browserCookieJar, signal })
        if (!answer.text) continue
        const { candidates: fromApi } = collectFromText(answer.text, answer.finalUrl)
        for (const candidate of fromApi) candidates.push({ ...candidate, via: 'static-mobile', userAgent: MOBILE_UA, cookieFile: browserCookieJar })
      }
    }
  }

  return {
    title,
    thumbnail,
    expectedDuration,
    failure,
    accessRequired,
    challengeRequired,
    embeds: [...embeds],
    frames,
    subtitles: mergeTextTracks(subtitles),
    candidates: dedupe(candidates).map((c) => ({ ...c, subtitles: mergeTextTracks(subtitles) })),
    engine: 'static',
  }
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
      if (!v.closest('.video-ads,.jw-flag-ads,.vjs-ad-playing,.ad-showing') && !document.querySelector('.jw-flag-ads,.vjs-ad-playing,.ad-showing')) continue;
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
 * Listen to the player's code, not just its traffic.
 *
 * Watching the network tells you what was requested but not what the player
 * *meant*: a manifest fetched by XHR with no telling extension and a generic
 * content type looks like any other request, and a URL assembled at runtime from
 * a decrypted blob never appears anywhere in the page source. Wrapping fetch,
 * XMLHttpRequest and the media `src` setter catches all three, because it reads
 * the argument the player passed.
 *
 * Installed with executeJavaScript in the page world rather than through a
 * preload, so context isolation stays on — the page can hand us wrong strings at
 * worst, and every candidate is verified before it is offered.
 */
const HOOK_SCRIPT = `(() => {
  try {
    if (window.__aioHooked) return 1;
    window.__aioHooked = true;
    window.__aioSeen = [];

    var interesting = /\\.(m3u8|mpd|mp4|webm|m4v|mkv|mov|flv|mp3|m4a)(\\?|#|$)|\\/(?:manifest|playlist|config|master|index|source|stream|video)(?:[./?]|$)/i;

    var remember = function (abs) {
      if (window.__aioSeen.length < 80 && window.__aioSeen.indexOf(abs) === -1) window.__aioSeen.push(abs);
    };
    // Relative addresses count too: a player that requests "/hls/master" is
    // asking for exactly what we are looking for.
    var absolute = function (value) {
      try { return new URL(String(value), location.href).href; } catch (e) { return ''; }
    };
    var note = function (value) {
      try {
        if (typeof value !== 'string' || !value || value.slice(0, 5) === 'blob:' || value.slice(0, 5) === 'data:') return;
        var abs = absolute(value);
        if (abs.slice(0, 4) !== 'http' || !interesting.test(abs)) return;
        remember(abs);
      } catch (e) {}
    };
    // Some sites serve the playlist from an address that looks like nothing —
    // "/api/v2/x?id=9", "seg.txt", "image.png" — so the body is the only
    // reliable tell. A playlist starts with #EXTM3U; a DASH manifest has <MPD.
    var sniff = function (url, text) {
      try {
        if (typeof text !== 'string') return;
        var head = text.slice(0, 600);
        if (head.indexOf('#EXTM3U') !== -1 || /<MPD[\s>]/.test(head)) {
          var abs = absolute(url);
          if (abs.slice(0, 4) === 'http') remember(abs);
        }
      } catch (e) {}
    };

    var originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = function (input) {
        var url = '';
        try { url = typeof input === 'string' ? input : input && input.url; note(url); } catch (e) {}
        var result = originalFetch.apply(this, arguments);
        // Response bodies are inspected by the bounded discovery hook.
        return result;
      };
    }

    var originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        note(url);
        var xhr = this;
        xhr.addEventListener('load', function () {
          try {
            if (xhr.responseType === '' || xhr.responseType === 'text') sniff(xhr.responseURL || url, xhr.responseText);
          } catch (e) {}
        });
      } catch (e) {}
      return originalOpen.apply(this, arguments);
    };

    var hookSrc = function (proto) {
      var descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'src');
      if (!descriptor || !descriptor.set) return;
      Object.defineProperty(proto, 'src', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set: function (value) {
          try { note(value); } catch (e) {}
          return descriptor.set.call(this, value);
        },
      });
    };
    hookSrc(HTMLMediaElement.prototype);
    hookSrc(window.HTMLSourceElement && HTMLSourceElement.prototype);

    var originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      try {
        if (String(name).toLowerCase() === 'src' && /^(VIDEO|AUDIO|SOURCE)$/.test(this.tagName)) note(value);
      } catch (e) {}
      return originalSetAttribute.apply(this, arguments);
    };
    return 0;
  } catch (e) { return -1; }
})()`

/** Take what the hooks have collected and clear it for the next pass. */
const HOOK_DRAIN = `(() => {
  try {
    var seen = window.__aioSeen || [];
    window.__aioSeen = [];
    return seen;
  } catch (e) { return []; }
})()`

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
    ses.webRequest.onBeforeRequest(null)
    ses.webRequest.onBeforeSendHeaders(null)
    ses.webRequest.onHeadersReceived(null)
    await ses.closeAllConnections()
    await ses.clearAuthCache()
    await ses.clearCache()
    await ses.clearStorageData()
  } catch {
    // A failed cleanup must not hand an authenticated session to another run.
    return
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
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
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
    referer = null,
    proxy = '',
    useUserScripts = true,
    signal = null,
    preferredAudioLanguage = 'en',
  } = {}
) {
  const browserBlocker = activeBlocker()
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

    // Each resolve gets its own session, which is exactly what makes a per-link
    // proxy possible: this page goes through the tunnel while the one resolving
    // beside it does not. Chromium understands SOCKS here, so no tunnelling of
    // our own is needed on this path.
    const configureProxy = ses.setProxy(proxy ? { mode: 'fixed_servers', proxyRules: proxyRules(proxy), proxyBypassRules: '<-loopback>' } : { mode: 'direct' })
    const captureController = new AbortController()
    const captureSignal = signal ? AbortSignal.any([signal, captureController.signal]) : captureController.signal
    const hits = new Map()
    const textTracks = []
    const discoveredFrames = new Map()
    const requestContexts = new Map()
    const runtimeByUrl = new Map()
    const runtimeByFrame = new Map()
    let alternateAt = Date.now()
    const skipped = new Set()
    const jsonScanned = new Set()
    const segments = new Set()
    const measuring = new Set()
    const measurementWaiters = []
    let measurementSlots = 0
    const timers = []
    let adSkipTimer = null
    let adSkips = 0
    let adCount = 0
    let encrypted = false
    let title = ''
    let loadError = null
    let documentResponse = { status: null, headers: {} }
    let documentEvidence = accessEvidence(null, '')
    let documentFailure = null
    let accountState = null
    const captureCookieFile = path.join(os.tmpdir(), `edl-cookies-${uid('c')}.txt`)
    // A runtime announced by a user script, used the same way the page's own
    // declared duration is: to tell a short pre-roll from the feature.
    let scriptDuration = null
    // One run per script per frame URL: frames re-emit dom-ready as they navigate.
    const ranScripts = new Set()
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

    /**
     * What came back from the page world: a bare URL from the network hooks, or a
     * structured offer from a user script.
     *
     * A script's answer is a suggestion, not a verdict — it goes through `record`
     * like every sniffed request, so verification, the ad filter and the duration
     * check all still apply. A script can also declare the runtime, which is the
     * strongest signal the ad filter has for telling a pre-roll from the feature.
     */
    const takeOffer = (item, referer) => {
      if (typeof item === 'string') return record(item, referer, 'content-type')
      if (!item || typeof item !== 'object') return
      if (item.from === 'media-element' && item.playerMetadata && typeof item.playerMetadata === 'object') {
        const metadata = item.playerMetadata
        if (isHttp(item.url) && (runtimeByUrl.size < 160 || runtimeByUrl.has(item.url.split('#')[0]))) runtimeByUrl.set(item.url.split('#')[0], metadata)
        else if (typeof metadata.src === 'string' && metadata.src.startsWith('blob:') && (runtimeByFrame.size < 40 || runtimeByFrame.has(referer))) runtimeByFrame.set(referer, metadata)
        // Metadata is tied to a loaded URL, or to the sole verified manifest in
        // this frame. Never apply one player's duration to all network traffic.
        for (const hit of hits.values()) applyRuntimeMetadata(hit)
      }
      if (typeof item.title === 'string' && item.title.trim() && !title) {
        title = item.title.trim().slice(0, 300)
      }
      if (typeof item.duration === 'number' && Number.isFinite(item.duration) && item.duration > 0 && !scriptDuration) {
        scriptDuration = item.duration
      }
      if (typeof item.note === 'string' && item.note) note(item.note)
      if (item.drm === true) encrypted = true
      if (typeof item.url === 'string') record(item.url, referer, 'content-type', item.kind)
    }

    function runtimeMetadataFor(hit) {
      const direct = runtimeByUrl.get(hit.url.split('#')[0])
      if (direct) return direct
      const metadata = runtimeByFrame.get(hit.referer)
      if (!metadata || !['hls', 'dash'].includes(hit.kind)) return null
      const all = [...hits.values()]
      const children = new Set(all.flatMap((h) => (h.info?.variants || []).map((v) => v.url).filter(Boolean)))
      const sameFrame = all.filter((h) => h.referer === hit.referer && !h.invalid && ['hls', 'dash'].includes(h.kind) && !children.has(h.url))
      return sameFrame.length === 1 && sameFrame[0] === hit ? metadata : null
    }
    function applyRuntimeMetadata(hit) {
      if (!hit.info) return
      applyPlayerMetadata(hit.info, runtimeMetadataFor(hit))
      estimateVariantSizes(hit.info)
    }

    const record = (url, referer, why, declaredKind = null) => {
      if (done || !isHttp(url) || browserBlocker.shouldBlock(url)) return
      const kind = ['hls', 'dash', 'file'].includes(declaredKind) ? declaredKind : kindOf(url)
      if (kind === 'unknown' && why !== 'content-type') return
      if (kind === 'segment') {
        // Not downloadable on their own, but they say where the playlist lives.
        if (segments.size < 4) segments.add(url)
        return
      }
      const key = url.split('#')[0]
      if (skipped.has(key)) return
      if (hits.has(key)) {
        const hit = hits.get(key)
        if (hit.kind === 'unknown' && ['hls', 'dash', 'file'].includes(kind)) { hit.kind = kind; hit.needsCheck = false }
        if (hit.invalid && why === 'content-type') { hit.invalid = false; measure(hit) }
        return
      }
      if (hits.size >= 80) return

      // A pre-roll loads before the feature does. Naming it here and refusing to
      // settle on it is the whole point: stopping at the first stream we saw was
      // how an advert ended up being downloaded instead of the video.
      if (browserBlocker.isAdMedia(url)) {
        skipped.add(key)
        adCount += 1
        note(`reklam akışı atlandı (${hostOf(url) || 'reklam ağı'}) — video bekleniyor`)
        return
      }

      const captured = requestContexts.get(key) || {}
      const hit = {
        url,
        kind,
        needsCheck: kind === 'unknown',
        referer: captured.referer || referer || pageUrl,
        origin: captured.origin || '',
        userAgent: captured.userAgent || UA,
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
        userAgent: hit.userAgent || UA,
        kind: hit.kind,
        signal: captureSignal,
        // The window's session is proxied by Chromium, but measuring a stream
        // happens outside it — so it needs telling.
        proxy,
      }
      const pending = (async () => {
        if (measurementSlots >= 4) await new Promise((resume) => measurementWaiters.push(resume))
        else measurementSlots += 1
        try {
          if (done || captureSignal.aborted) return { playable: false }
          const cookies = await ses.cookies.get({})
          if (cookies.length) { writeCookieJar(cookies, captureCookieFile); resolved.cookieFile = captureCookieFile }
          resolved.playerMetadata = runtimeMetadataFor(hit)
          return await describeStream(hit.url, resolved)
        } finally {
          const resume = measurementWaiters.shift()
          if (resume) resume()
          else measurementSlots -= 1
        }
      })()
      measuring.add(pending)
      pending.finally(() => measuring.delete(pending)).catch(() => {})
      pending
        .then((info) => {
          hit.info = info
          if (info.kind) hit.kind = info.kind
          applyRuntimeMetadata(hit)
          if (info.drm) encrypted = true
          if (!info.playable && !info.drm) { hit.invalid = true; return }
          if (done) return
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
          const floor = scriptDuration
            ? Math.max(featureFloor, scriptDuration * 0.5)
            : featureFloor
          if (info && info.duration && info.duration >= Math.max(floor, minStreamSeconds)) {
            clearTimeout(settleTimer)
            settleTimer = setTimeout(finish, 1500)
            return
          }
          if (floor > 0 && info && info.duration && info.duration < floor && expectedDuration) {
            hit.short = true
            adCount += 1
            note(
              expectedDuration
                ? `${Math.round(info.duration)} sn'lik akış — sayfa ${Math.round(expectedDuration)} sn diyor, bu reklam. Video bekleniyor`
                : `${Math.round(info.duration)} sn'lik kısa akış — reklam olabilir, video bekleniyor`
            )
            return
          }
          if (info?.duration && info.duration < minStreamSeconds && !expectedDuration) { hit.tentativeShort = true; return }
          settle()
        })
        .catch(() => settle())
    }

    /**
     * Some players never request a .m3u8 at all: they fetch a JSON document that
     * *contains* the stream URLs and feed the result to MSE. Vimeo is the obvious
     * case — its player asks for `/config`, so watching for media file extensions
     * finds nothing. When a JSON response looks like a player document, read it
     * and scan the body the same way we scan a page.
     */
    async function scanJsonBody(url) {
      if (done || jsonScanned.has(url) || jsonScanned.size >= 12) return
      jsonScanned.add(url)
      try {
        const cookies = await ses.cookies.get({})
        if (cookies.length) writeCookieJar(cookies, captureCookieFile)
        const { text, status } = await fetchText(url, pageUrl, { proxy, cookieFile: captureCookieFile, signal: captureSignal, maxBytes: 2 * 1024 * 1024, retries: 0 })
        if (done || status >= 400 || !text) return
        const { candidates } = collectFromText(text, url)
        if (candidates.length) note(`oynatıcı belgesinde ${candidates.length} akış bulundu`)
        for (const candidate of candidates) record(candidate.url, pageUrl, 'content-type', candidate.kind)
      } catch {
        /* the document was not readable from here */
      }
    }

    /**
     * Last resort for a player that fetches segments directly and never asks for
     * a playlist we can see. Segments almost always sit beside or below the
     * playlist, so walk up from one and try the conventional names.
     */
    async function deriveManifestFromSegments() {
      const deriveSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(2500)]) : AbortSignal.timeout(2500)
      const names = ['master.m3u8', 'index.m3u8', 'playlist.m3u8', 'manifest.mpd', 'index.mpd']
      const first = [...segments][0]
      if (!first) return null

      let parsed
      try {
        parsed = new URL(first)
      } catch {
        return null
      }
      const parts = parsed.pathname.split('/').filter(Boolean)

      for (let level = 0; level < 3 && parts.length; level += 1) {
        parts.pop()
        const dir = `${parsed.origin}/${parts.length ? `${parts.join('/')}/` : ''}`
        for (const name of names) {
          const candidate = dir + name
          try {
            if (signal?.aborted || deriveSignal.aborted) return null
            const { text, status } = await fetchText(candidate, pageUrl, { proxy, cookieFile: captureCookieFile, signal: deriveSignal, timeoutMs: 1200, maxBytes: 65536, retries: 0 })
            if (status >= 400) continue
            if (/#EXTM3U/i.test(text) || /<MPD/i.test(text)) {
              note('parçalardan manifest türetildi')
              return candidate
            }
          } catch {
            /* try the next name */
          }
        }
      }
      return null
    }

    /** Wait a beat for sibling streams, then wrap up. */
    function settle() {
      if (done) return
      clearTimeout(settleTimer)
      settleTimer = setTimeout(finish, SETTLE_MS)
    }

    async function finish(force = false) {
      if (done) return
      done = true
      if (force || signal?.aborted) captureController.abort()
      clearTimeout(settleTimer)
      clearTimeout(hardStop)
      signal?.removeEventListener('abort', finish)
      clearInterval(adSkipTimer)
      for (const t of timers) clearTimeout(t)

      try {
        const main = win && !win.isDestroyed() ? win.webContents.mainFrame : null
        const frames = main && !signal?.aborted ? [main, ...(main.framesInSubtree || [])] : []
        await Promise.race([Promise.allSettled(frames.map(async (frame) => {
          const tracks = await frame.executeJavaScript(PAGE_TEXT_TRACKS, true)
          for (const track of tracks || []) textTracks.push(normaliseTrack(track, frame.url || pageUrl))
        })), new Promise((r) => setTimeout(r, 2000))])
      } catch { /* detached player */ }
      let cookieFile = null
      try {
        const cookies = await ses.cookies.get({})
        if (cookies.length) {
          cookieFile = captureCookieFile
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

      // A stream is only judged once it has been measured. Ending the scan while
      // a measurement was still in flight let an unmeasured pre-roll through as
      // though it were the feature.
      if (measuring.size) {
        await Promise.race([
          Promise.allSettled([...measuring]),
          new Promise((r) => setTimeout(r, 5000)),
        ])
      }
      captureController.abort()

      const all = [...hits.values()]
      let keepers = all.filter((h) => !h.short && !h.invalid && (h.info?.playable || h.info?.drm))
      if (keepers.some((h) => !h.tentativeShort)) keepers = keepers.filter((h) => !h.tentativeShort)

      if (!keepers.length && segments.size && !signal?.aborted) {
        const derived = await deriveManifestFromSegments()
        if (derived) {
          keepers = [
            {
              url: derived,
              kind: /\.mpd(\?|#|$)/i.test(derived) ? 'dash' : 'hls',
              referer: pageUrl,
              origin: originOf(pageUrl),
              via: 'derived',
              info: null,
              short: false,
            },
          ]
        }
      }

      await releasePartition(partition, ses)

      resolve({
        title: /^(video player|player|loading|untitled)?$/i.test(title.trim()) ? '' : title,
        candidates: dedupe(keepers).map((c) => ({ ...c, cookieFile, subtitles: mergeTextTracks(textTracks) })),
        engine: 'browser',
        frames: [...discoveredFrames.values()],
        loadError: keepers.length ? null : loadError,
        failure: documentFailure,
        accountState,
        encrypted,
        accessRequired: documentEvidence.accessRequired || all.some((h) => h.info?.accessRequired),
        challengeRequired: documentEvidence.challengeRequired || all.some((h) => h.info?.challengeRequired),
        adsSkipped: adCount,
        // Reported so the caller can explain an empty result rather than just
        // saying nothing was found.
        shortOnly: keepers.length === 0 && all.some((h) => h.short),
        shortest: all.length
          ? Math.min(...all.filter((h) => h.info && h.info.duration).map((h) => h.info.duration), Infinity)
          : Infinity,
      })
    }

    // Close discovery at the deadline, but let an already captured manifest
    // use the bounded measurement grace in finish(). Aborting it immediately
    // discarded players that first appeared just before the deadline.
    const hardStop = setTimeout(() => finish(), timeoutMs)
    if (signal?.aborted) { finish(); return }
    signal?.addEventListener('abort', finish, { once: true })

    try {
      ses.setUserAgent(UA)

      ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        if (browserBlocker.shouldBlock(details.url)) return callback({ cancel: true })
        // Popunders arrive as top-level navigations in fresh windows; the window
        // open handler denies those, but block the obvious ones early too.
        if (kindOf(details.url) === 'segment' && segments.size < 8) segments.add(details.url)
        callback({ cancel: false })
      })

      ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
        const headers = details.requestHeaders || {}
        const get = (name) => String(headers[Object.keys(headers).find((key) => key.toLowerCase() === name)] || '')
        if (requestContexts.size < 1600) requestContexts.set(details.url.split('#')[0], {
          referer: get('referer'), origin: get('origin'), userAgent: get('user-agent'),
        })
        record(details.url, details.referrer, 'request')
        callback({ requestHeaders: headers })
      })

      ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
        if (details.resourceType === 'mainFrame') {
          documentResponse = { status: details.statusCode, headers: Object.fromEntries(Object.entries(details.responseHeaders || {}).map(([name, value]) => [name.toLowerCase(), String(value)])) }
        }
        if (details.statusCode >= 400) {
          const hit = hits.get(details.url.split('#')[0])
          if (hit) hit.invalid = true
          callback({ cancel: false }); return
        }
        const headers = details.responseHeaders || {}
        const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type')
        const type = key ? String(headers[key]) : ''
        if (/text\/vtt|application\/x-subrip/i.test(type)) textTracks.push(normaliseTrack({ url: details.url, kind: 'subtitles' }, details.referrer || pageUrl))
        if (CONTENT_TYPE_MEDIA.test(type)) {
          record(details.url, details.referrer, 'content-type', /dash/i.test(type) ? 'dash' : /mpegurl/i.test(type) ? 'hls' : 'file')
        } else if (details.method === 'GET' && /application\/json/i.test(type) && JSON_PLAYER_HINT.test(details.url)) {
          scanJsonBody(details.url)
        }
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

      // DRM evidence comes from protected manifests or a real media encrypted
      // event. Player libraries logging "DRM disabled" are not evidence.

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
                if (frame.url !== pageUrl && usablePlayerFrame(frame.url, browserBlocker)) discoveredFrames.set(frame.url, { url: frame.url, referer: frame.parent?.url || pageUrl, depth: 2 })
                frame.executeJavaScript(FRAME_SCRIPT, true).then((urls) => {
                  for (const url of urls || []) if (url !== pageUrl && usablePlayerFrame(url, browserBlocker)) discoveredFrames.set(url, { url, referer: frame.url || pageUrl, depth: 2 })
                }).catch(() => {})
                const healthy = [...hits.values()].some((h) => h.info?.playable && !h.short && !h.invalid)
                if (!assisted && !healthy && Date.now() - alternateAt > 6500 && !measuring.size) {
                  alternateAt = Date.now()
                  frame.executeJavaScript(alternativeScript(preferredAudioLanguage), true).then((label) => { if (label) note(`alternatif oynatıcı deneniyor: ${label}`) }).catch(() => {})
                }
              } catch {}
              // Hook the player's own calls, then read what they carried. Runs on
              // the same pass as ad-skipping: no extra timer, every frame covered.
              try {
                frame.executeJavaScript(HOOK_SCRIPT + ';' + DISCOVERY_SCRIPT, true).catch(() => {})
                const drained = frame.executeJavaScript(HOOK_DRAIN, true)
                if (drained && drained.then) {
                  drained
                    .then((items) => {
                      if (!Array.isArray(items)) return
                      for (const item of items) takeOffer(item, frame.url || pageUrl)
                    })
                    .catch(() => {})
                }
              } catch {
                /* frame detached */
              }
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

      /**
       * Site recipes, run in the page beside the hooks.
       *
       * Matched per frame rather than per window: on a wrapped site the player
       * lives two frames down on a different host, and a pattern written for that
       * host has to see it. A script that throws is contained by its own wrapper,
       * so a bad recipe costs its own output and nothing else.
       */
      const runUserScripts = (frame, when) => {
        if (!useUserScripts) return
        let scripts = []
        try {
          scripts = userscripts.forUrl(frame.url || pageUrl)
        } catch {
          return
        }
        for (const script of scripts) {
          const wants = script.runAt === 'document-idle' ? 'idle' : 'end'
          if (wants !== when) continue
          if (ranScripts.has(`${frame.url}::${script.file}`)) continue
          ranScripts.add(`${frame.url}::${script.file}`)
          frame.executeJavaScript(userscripts.wrap(script), true).catch(() => {})
          note(`script çalıştı: ${script.name}`)
        }
      }

      /**
       * Stop a page that reloads itself into the ground.
       *
       * Some players ship a script whose whole job is to notice a developer tool
       * and answer with `window.stop(); location.reload()`. Inside our scan that
       * becomes a loop: the frame never finishes, the media request never goes
       * out, and after enough attempts the site itself starts answering 500 — so
       * the visible symptom is an error page and "no video found" on a page that
       * plainly has one.
       *
       * The guard is about the behaviour, not about any particular script. Only
       * repeated visits to the same URL in the same frame count. Independent
       * advert frames and a real login redirect chain must not freeze the player.
       */
      const repeatedNavigation = createNavigationGuard()
      let navFrozen = false
      let sawFrameEvents = false
      const guardNavigation = (event, fallbackUrl) => {
        if (done) return
        if (!repeatedNavigation(event, fallbackUrl)) return
        if (!navFrozen) {
          navFrozen = true
          note('sayfa kendini yeniliyor — yenilemeler durduruldu')
        }
        try {
          event.preventDefault()
        } catch {
          /* not a cancellable navigation */
        }
      }

      // `will-frame-navigate` covers every frame, which is what matters here: the
      // document that reloads itself is usually the player's iframe. It also
      // fires for the main frame, and just before `will-navigate` does — so the
      // older event only counts on an Electron too old to have the newer one,
      // otherwise every main-frame navigation would be counted twice.
      win.webContents.on('will-frame-navigate', (event) => {
        sawFrameEvents = true
        guardNavigation(event)
      })
      win.webContents.on('will-navigate', (event, url) => {
        if (!sawFrameEvents) guardNavigation(event, url)
      })

      // Get the hooks in as early as possible: a player that builds its source
      // immediately would otherwise do it before the first pass comes round.
      win.webContents.on('dom-ready', () => {
        try {
          const main = win.webContents.mainFrame
          for (const frame of main ? [main, ...(main.framesInSubtree || [])] : []) {
            frame.executeJavaScript(HOOK_SCRIPT + ';' + DISCOVERY_SCRIPT, true).catch(() => {})
            runUserScripts(frame, 'end')
          }
        } catch {
          /* frame not ready */
        }
      })

      win.webContents.on('frame-created', (_event, { frame }) => {
        frame.on('dom-ready', () => {
          if (done) return
          frame.executeJavaScript(HOOK_SCRIPT + ';' + DISCOVERY_SCRIPT, true).catch(() => {})
          runUserScripts(frame, 'end')
        })
      })

      let scheduled = false
      win.webContents.on('did-finish-load', async () => {
        // Inspect the document we actually loaded, rather than assuming a
        // completed navigation is a successful page. HTTP-200 error templates
        // and browser-only sign-in/CAPTCHA pages otherwise become "no video".
        try {
          const markup = await win.webContents.mainFrame.executeJavaScript('document.documentElement.outerHTML.slice(0, 65536)', true)
          if (done || !win || win.isDestroyed()) return
          documentEvidence = accessEvidence(documentResponse.status, markup, documentResponse.headers)
          documentFailure = documentResponse.status >= 400 || documentEvidence.networkBlocked
            ? { status: documentResponse.status, errorKind: documentEvidence.errorKind } : null
          if (documentEvidence.networkBlocked && !hits.size) {
            note('site bu ağın IP adresini kabul etmiyor')
            finish()
            return
          }
          const hasPasswordForm = /<form\b[\s\S]*?<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(markup)
          const authGate = authenticationGateOf(markup, documentEvidence)
          const foundVideo = [...hits.values()].some((hit) => hit.info?.playable && !hit.short && !hit.invalid)
          if (!foundVideo && !documentEvidence.networkBlocked && !documentEvidence.challengeRequired && (hasPasswordForm || authGate)) {
            const authentication = await require('./site-account-forms').attemptAuthentication(win, {
              signal: captureSignal, onProgress: note, allowNavigation: !!authGate, onState: (value) => { accountState = value },
            })
            if (done || !win || win.isDestroyed()) return
            if (authentication.state === 'submitted' || authentication.state === 'navigating') {
              // The following document is the login result; driving the old
              // page now would race its form navigation and player discovery.
              return
            }
          }
        } catch { /* A navigation may replace this frame before inspection. */ }
        if (done || !win || win.isDestroyed()) return
        startAdSkipping()
        try {
          const main = win.webContents.mainFrame
          for (const frame of main ? [main, ...(main.framesInSubtree || [])] : []) {
            runUserScripts(frame, 'idle')
          }
        } catch {
          /* frame not ready */
        }
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
        await configureProxy
        if (browserCookieJar) {
          const count = await injectCookieJar(ses, browserCookieJar)
          if (count) note(`tarayıcı oturumun yüklendi (${count} çerez)`)
        }
        if (done || !win || win.isDestroyed()) return
        note('sayfa açılıyor')
        const navigate = (attempt = 0) => {
          if (done || !win || win.isDestroyed() || signal?.aborted) return
          win.loadURL(pageUrl, { userAgent: UA, httpReferrer: referer || originOf(pageUrl) })
            .then(() => { loadError = null })
            .catch((err) => {
              if (done || signal?.aborted) return
              if (!attempt && !hits.size && retryableNavigationError(err)) {
                note('sayfa bağlantısı kesildi; aynı ağ yolundan yeniden deneniyor')
                timers.push(setTimeout(() => navigate(1), 500))
                return
              }
              loadError = err.message
              if (!hits.size) finish()
            })
        }
        navigate()
      }
      boot().catch((err) => { loadError = err.message; finish() })
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
async function verifyCandidates(candidates, { limit = 16, concurrency = 3, proxy = '', signal = null, onRejected = null } = {}) {
  const shortlist = candidates.slice(0, limit)
  const keep = []
  let cursor = 0

  async function worker() {
    while (cursor < shortlist.length && !signal?.aborted) {
      const candidate = shortlist[cursor++]
      // Already measured during capture; don't pay for it twice.
      if (candidate.info && (candidate.info.playable || candidate.info.drm)) {
        keep.push(candidate)
        continue
      }
      const resolved = {
        referer: candidate.referer,
        origin: candidate.origin,
        userAgent: candidate.userAgent || UA,
        cookieFile: candidate.cookieFile || null,
        kind: candidate.kind,
        proxy,
        signal,
      }
      try {
        const info = await describeStream(candidate.url, resolved)
        // Duration is the honest test of "this is a video": a poster image
        // reports a resolution but never a running time.
        const real = !!info.playable
        if (real) {
          keep.push({
            ...candidate,
            kind: info.kind || candidate.kind,
            info,
          })
        } else if (info.drm) {
          keep.push({ ...candidate, info })
        } else onRejected?.(info)
      } catch { /* An extension alone is not proof of a playable source. */ }
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

  const kept = candidates.filter((c) => c.info?.drm || (c.info?.live && c.info?.playable) || (!c.info?.duration && c.info?.playable) || (c.info?.duration && c.info.duration >= floor))

  // Without a declared runtime, an empty result more likely means our guess was
  // wrong than that everything was an advert — so keep what we had.
  if (!kept.length && !expected) return { kept: candidates, dropped: 0 }

  if (expected) {
    kept.sort(
      (a, b) => (a.info?.duration ? Math.abs(a.info.duration - expected) : Infinity) - (b.info?.duration ? Math.abs(b.info.duration - expected) : Infinity)
    )
  }
  return { kept, dropped: candidates.length - kept.length }
}

/**
 * Resolve a page to playable media.
 * Returns { title, thumbnail, candidates: [{url, kind, referer, origin, cookieFile, info}], engine }
 */
async function resolvePageImpl(
  pageUrl,
  {
    onProgress = null,
    timeoutMs = 45000,
    staticOnly = false,
    browserCookieJar = null,
    minStreamSeconds = 120,
    blockRules = null,
    preferEngine = null,
    proxy = '',
    useUserScripts = true,
    signal = null,
    preferredAudioLanguage = 'en',
  } = {}
) {
  if (!isHttp(pageUrl) || signal?.aborted) return { title: '', candidates: [], engine: 'none' }
  const evidence = { accessRequired: false, challengeRequired: false, failure: null }
  const verification = { proxy, signal, onRejected: (info) => {
    evidence.accessRequired ||= !!info.accessRequired
    evidence.challengeRequired ||= !!info.challengeRequired
    if (!evidence.failure && info.status >= 400) evidence.failure = { status: info.status }
  } }
  if (['hls', 'dash', 'file'].includes(kindOf(pageUrl))) {
    const candidates = await verifyCandidates([{ url: pageUrl, kind: kindOf(pageUrl), referer: pageUrl, cookieFile: browserCookieJar }], verification)
    return { title: '', candidates, engine: 'static', userAgent: UA, ...evidence }
  }

  // A host we've resolved before tells us which engine actually works. Going
  // straight there skips a full crawl and its verification round — the single
  // biggest saving available, because the static pass is wasted effort on any
  // site whose player builds its source in JavaScript.
  const skipStatic = preferEngine === 'browser'

  if (onProgress) {
    onProgress(skipStatic ? 'bu site için oynatıcı taraması' : 'sayfa ve oynatıcı kodları taranıyor')
  }
  // Reserve time for the real browser. A page with several stalled third-party
  // scripts used to spend the entire shared deadline in the static crawl,
  // aborting before its working dynamic player could even be opened.
  const staticController = new AbortController()
  const staticSignal = signal ? AbortSignal.any([signal, staticController.signal]) : staticController.signal
  let staticTimedOut = false
  const staticTimer = setTimeout(() => { staticTimedOut = true; staticController.abort() }, Math.max(2000, Math.min(15000, timeoutMs * 0.35)))
  let fast
  try {
    fast = skipStatic
      ? await staticScan(pageUrl, { maxFetches: 8, maxDepth: 2, proxy, browserCookieJar, signal: staticSignal })
      : await staticScan(pageUrl, { onProgress, proxy, browserCookieJar, signal: staticSignal })
  } finally { clearTimeout(staticTimer) }
  if (staticTimedOut && /ABORT/i.test(fast.failure?.code || '')) fast.failure = null

  if (signal?.aborted) return { ...fast, candidates: [], userAgent: UA }
  if (fast.expectedDuration && onProgress) {
    onProgress(`sayfa videoyu ${Math.round(fast.expectedDuration / 60)} dk diye bildiriyor`)
  }

  // An embed on a host yt-dlp knows beats anything we could scrape: the caller
  // re-probes it and gets the full format list, subtitles and metadata.
  const embeds = fast.embeds || []

  if (fast.candidates.length) {
    const verified = dropVariantDuplicates(await verifyCandidates(fast.candidates, verification))
    const { kept, dropped } = dropShortStreams(verified, minStreamSeconds, fast.expectedDuration)
    if (kept.length) {
      if (dropped && onProgress) onProgress(`${dropped} kısa akış (reklam) atlandı`)
      return {
        ...fast,
        title: cleanTitle(fast.title, hostOf(pageUrl)),
        candidates: kept,
        adsSkipped: dropped,
        embeds,
        userAgent: UA,
      }
    }
  }
  if (staticOnly) {
    return {
      ...fast,
      accessRequired: fast.accessRequired || evidence.accessRequired,
      challengeRequired: fast.challengeRequired || evidence.challengeRequired,
      failure: fast.failure || evidence.failure,
      title: cleanTitle(fast.title, hostOf(pageUrl)),
      candidates: [],
      embeds,
      userAgent: UA,
    }
  }

  if (onProgress) onProgress('oynatıcı görünmez tarayıcıda çalıştırılıyor')
  // With a nested player to fall back on there is no reason to sit out the full
  // window waiting for a wrapper page that may never yield.
  const frameMap = new Map((fast.frames || []).map((f) => [f.url, f]))
  const frameOrder = (a, b) => {
    const score = (frame) => /embed|player|watch|video|stream/i.test(frame.url) ? 10 : 0
    return score(b) - score(a) || b.depth - a.depth
  }
  const nestedFrames = [...frameMap.values()].filter((frame) => usablePlayerFrame(frame.url)).sort(frameOrder).slice(0, 4)
  const first = nestedFrames.find((f) => !EMBED_HOST.test(f.url) && (f.depth >= 2 || /\/(?:embed|player)(?:\/|[?#])|\/(?:player|video)\.php(?:[?#]|$)/i.test(f.url)))
  const options = { onProgress, browserCookieJar, minStreamSeconds, expectedDuration: fast.expectedDuration, proxy, useUserScripts, signal, preferredAudioLanguage }
  let deep = await browserScan(first?.url || pageUrl, {
    ...options, referer: first?.referer, timeoutMs: nestedFrames.length ? Math.min(timeoutMs, 24000) : timeoutMs,
  })
  const attempted = new Set([first?.url || pageUrl])
  for (const frame of deep.frames || []) if (!frameMap.has(frame.url)) frameMap.set(frame.url, frame)
  const remaining = [...frameMap.values()].filter((frame) => usablePlayerFrame(frame.url)).sort(frameOrder)
  if (first) remaining.push({ url: pageUrl, referer: null, depth: 0 })
  let alternatives = 0
  for (let index = 0; !deep.candidates.length && deep.failure?.errorKind !== 'network-blocked' && index < remaining.length && alternatives < 5 && !signal?.aborted; index += 1) {
    const frame = remaining[index]
    if (attempted.has(frame.url)) continue
    attempted.add(frame.url)
    alternatives += 1
    onProgress?.(`alternatif oynatıcı açılıyor: ${hostOf(frame.url)}`)
    const inner = await browserScan(frame.url, { ...options, referer: frame.referer, timeoutMs: Math.min(timeoutMs, 24000) })
    if (inner.candidates.length) deep = { ...inner, title: deep.title || inner.title }
    else {
      deep.failure ||= inner.failure
      deep.accessRequired ||= inner.accessRequired
      deep.challengeRequired ||= inner.challengeRequired
      deep.loadError ||= inner.loadError
    }
    for (const next of inner.frames || []) if (!attempted.has(next.url) && !remaining.some((f) => f.url === next.url)) remaining.push(next)
  }

  const verified = deep.candidates.length ? await verifyCandidates(deep.candidates, verification) : []
  // Keep browser finds even if verification couldn't read them: the session that
  // captured them is gone, so a fresh fetch may legitimately fail.
  const pool = dropVariantDuplicates(verified.length ? verified : deep.candidates)
  const { kept, dropped } = dropShortStreams(pool, minStreamSeconds, fast.expectedDuration)
  if (dropped && onProgress) onProgress(`${dropped} kısa akış (reklam) atlandı`)

  return {
    ...deep,
    failure: deep.failure || fast.failure || evidence.failure,
    accessRequired: fast.accessRequired || evidence.accessRequired || deep.accessRequired,
    challengeRequired: fast.challengeRequired || evidence.challengeRequired || deep.challengeRequired,
    candidates: kept.map((c) => ({ ...c, subtitles: mergeTextTracks(c.subtitles || [], fast.subtitles || [], fast.candidates.flatMap((v) => v.subtitles || [])) })),
    adsSkipped: (deep.adsSkipped || 0) + dropped,
    title: cleanTitle(deep.title || fast.title, hostOf(pageUrl)),
    thumbnail: fast.thumbnail || '',
    embeds,
    userAgent: UA,
  }
}

/**
 * Open the page visibly and record whatever the user manages to play.
 * The escape hatch for ad walls, consent gates and bot checks: a person clears
 * them, the app only listens.
 */
async function assistedCaptureImpl(
  pageUrl,
  {
    onProgress = null,
    browserCookieJar = null,
    minStreamSeconds = 120,
    timeoutMs = 300000,
    blockRules = null,
    proxy = '',
    useUserScripts = true,
    signal = null,
    preferredAudioLanguage = 'en',
  } = {}
) {
  if (!isHttp(pageUrl)) return { title: '', candidates: [], engine: 'assisted' }

  // One cheap fetch for the page's own title, poster and declared runtime — the
  // runtime is what lets us tell the feature from a pre-roll here too.
  const meta = await staticScan(pageUrl, { maxFetches: 1, maxDepth: 0, proxy, browserCookieJar, signal })

  const result = await browserScan(pageUrl, {
    assisted: true,
    timeoutMs,
    onProgress,
    browserCookieJar,
    minStreamSeconds,
    expectedDuration: meta.expectedDuration,
    proxy,
    useUserScripts,
    preferredAudioLanguage,
    signal,
  })

  const verified = result.candidates.length ? await verifyCandidates(result.candidates, { proxy, signal }) : []
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

async function resolvePage(pageUrl, options = {}) {
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  const budget = Math.max(8000, Math.min(180000, (Number(options.timeoutMs) || 45000) * 2))
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, budget)
  try {
    const result = await withRules(options, () => resolvePageImpl(pageUrl, { ...options, signal: controller.signal }))
    return { ...result, timedOut }
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
}

function assistedCapture(pageUrl, options = {}) {
  return withRules(options, () => assistedCaptureImpl(pageUrl, options))
}

module.exports = {
  resolvePage,
  assistedCapture,
  embedCandidatesFor,
  unpackPacked,
  // Exported so the static techniques can be exercised without a browser.
  staticScan,
  collectFromText,
  collectIframes,
  dropShortStreams,
  collectSourceApis,
  verifyCandidates,
  injectedScripts: { PLAY_NUDGE, AD_SKIP, HOOK_SCRIPT, HOOK_DRAIN, ASSIST_BANNER, DISCOVERY_SCRIPT, FRAME_SCRIPT },
  metaRefreshOf,
  retryableNavigationError,
  createNavigationGuard,
  usablePlayerFrame,
  authenticationGateOf,
  UA,
  MOBILE_UA,
}
