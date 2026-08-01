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
const { uid, hostOf } = require('./util')

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'

/** Extensions that mean "this is the thing we want to hand to yt-dlp". */
const MANIFEST_EXT = /\.(m3u8|mpd)(\?|#|$)/i
const FILE_EXT = /\.(mp4|webm|m4v|mkv|mov|flv|mp3|m4a|ogg|opus|wav)(\?|#|$)/i
const SEGMENT_EXT = /\.(ts|m4s|aac|init)(\?|#|$)/i

const MEDIA_URL_RE =
  /https?:\/\/[^\s"'`<>()\\]{8,}?\.(?:m3u8|mpd|mp4|webm|m4v|mkv|mov|flv|mp3|m4a)(?:\?[^\s"'`<>()\\]*)?/gi

/** Ad and tracker hosts: blocking them kills pop-unders and speeds the load. */
const JUNK_HOST =
  /(doubleclick|googlesyndication|googletagmanager|google-analytics|googleadservices|adservice|popads|popcash|propellerads|propeller|onclickads|adsterra|exoclick|juicyads|hilltopads|clickadu|clicksgear|mgid\.com|taboola|outbrain|zedo|adnxs|criteo|histats|statcounter|yandex\.[a-z]+\/(?:watch|metrika)|scorecardresearch|quantserve|adform|bidswitch|smartadserver|revcontent|trafficjunky|adsco\.re|luckyorange|hotjar)/i

const CONTENT_TYPE_MEDIA =
  /(application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)|video\/(?:mp4|webm|x-matroska)|audio\/(?:mp4|mpeg|webm))/i

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

function collectFromText(text, baseUrl) {
  const expanded = [
    normaliseText(text),
    normaliseText(unpackPacked(text)),
    normaliseText(decodeBase64Blobs(text)),
  ].join('\n')

  const found = []
  let match
  MEDIA_URL_RE.lastIndex = 0
  while ((match = MEDIA_URL_RE.exec(expanded)) !== null) {
    const url = match[0].replace(/[",';)\]]+$/, '')
    const kind = kindOf(url)
    if (kind === 'segment' || kind === 'unknown') continue
    found.push({ url, kind, referer: baseUrl, origin: originOf(baseUrl), via: 'static' })
  }
  return { candidates: found, expanded }
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
      if (isHttp(abs) && !JUNK_HOST.test(abs)) urls.push(abs)
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

/** Walk the page and up to `maxDepth` levels of nested iframes. */
async function staticScan(pageUrl, { maxDepth = 2, maxFetches = 7 } = {}) {
  const candidates = []
  let title = ''
  let fetches = 0
  const visited = new Set()
  let queue = [{ url: pageUrl, referer: '', depth: 0 }]

  while (queue.length && fetches < maxFetches) {
    const next = []
    for (const job of queue) {
      if (fetches >= maxFetches) break
      if (visited.has(job.url)) continue
      visited.add(job.url)
      fetches += 1

      const { text, finalUrl } = await fetchText(job.url, job.referer)
      if (!text) continue
      if (!title) title = pageTitleOf(text)

      const { candidates: found } = collectFromText(text, finalUrl)
      candidates.push(...found)

      if (job.depth < maxDepth) {
        for (const frame of collectIframes(text, finalUrl)) {
          next.push({ url: frame, referer: finalUrl, depth: job.depth + 1 })
        }
      }
    }
    queue = next
  }

  return { title, candidates: dedupe(candidates), engine: 'static' }
}

/* ========================================================================== *
 * engine 2 — hidden browser, watching the network
 * ========================================================================== */

const PLAY_NUDGE = `(() => {
  try {
    const v = document.querySelector('video');
    if (v) { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}); }
    const hints = ['.vjs-big-play-button','.jw-icon-display','.plyr__control--overlaid',
      '#play','.play-button','.playbutton','.btn-play','[class*="bigplay"]','[id*="playbtn"]'];
    for (const sel of hints) {
      const el = document.querySelector(sel);
      if (el) { el.click(); return 'clicked:' + sel; }
    }
    return v ? 'video' : 'none';
  } catch (e) { return 'err'; }
})()`

function writeCookieJar(cookies, file) {
  const lines = ['# Netscape HTTP Cookie File', '# Everything Downloader', '']
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
function browserScan(pageUrl, { timeoutMs = 30000, onProgress = null } = {}) {
  return new Promise((resolve) => {
    const partition = `resolver-${uid('s')}` // no persist: prefix -> in-memory
    const ses = session.fromPartition(partition)
    const hits = new Map()
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
      if (!isHttp(url) || JUNK_HOST.test(url)) return
      const kind = kindOf(url)
      if (kind === 'unknown' && why !== 'content-type') return
      if (kind === 'segment') return
      const key = url.split('#')[0]
      if (hits.has(key)) return
      hits.set(key, {
        url,
        kind: kind === 'unknown' ? 'hls' : kind,
        referer: referer || pageUrl,
        origin: originOf(referer || pageUrl),
        via: 'browser',
      })
      note(`akış yakalandı: ${hostOf(url) || 'kaynak'}`)
      // Give sibling requests a moment to arrive, then wrap up.
      if (kind === 'hls' || kind === 'dash' || kind === 'file') {
        clearTimeout(settleTimer)
        settleTimer = setTimeout(finish, 1200)
      }
    }

    async function finish() {
      if (done) return
      done = true
      clearTimeout(settleTimer)
      clearTimeout(hardStop)

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
      try {
        await ses.clearStorageData()
      } catch {
        /* best effort */
      }

      resolve({
        title: /^(video player|player|loading|untitled)?$/i.test(title.trim()) ? '' : title,
        candidates: dedupe([...hits.values()]).map((c) => ({ ...c, cookieFile })),
        engine: 'browser',
        encrypted,
      })
    }

    const hardStop = setTimeout(finish, timeoutMs)

    try {
      ses.setUserAgent(UA)

      ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        if (JUNK_HOST.test(details.url)) return callback({ cancel: true })
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
        show: false,
        width: 1280,
        height: 720,
        webPreferences: {
          partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          images: false,
          webSecurity: true,
          backgroundThrottling: false,
          autoplayPolicy: 'no-user-gesture-required',
        },
      })

      win.webContents.setAudioMuted(true)
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      // Never let the page ask for anything.
      ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))

      // The signature of this event differs across Electron majors; read loosely.
      win.webContents.on('console-message', (...parts) => {
        const text = parts.map((p) => (p && p.message ? p.message : p)).join(' ')
        if (/encrypted|widevine|playready|\bdrm\b/i.test(String(text))) encrypted = true
      })

      win.webContents.on('did-finish-load', () => {
        note('sayfa yüklendi, oynatıcı tetikleniyor')
        nudge()
        // Players often build their source a beat after load.
        setTimeout(nudge, 2500)
        setTimeout(nudge, 6000)
      })

      win.webContents.on('did-frame-finish-load', () => nudge())

      let nudges = 0
      function nudge() {
        // Runs from webContents events: anything thrown here would take down the
        // main process, so the whole body is guarded.
        try {
          if (done || nudges > 6 || !win || win.isDestroyed()) return
          nudges += 1

          const main = win.webContents.mainFrame
          const frames = main ? [main, ...(main.framesInSubtree || [])] : []
          for (const frame of frames) {
            try {
              const result = frame.executeJavaScript(PLAY_NUDGE, true)
              if (result && result.catch) result.catch(() => {})
            } catch {
              /* frame detached mid-walk */
            }
          }

          // A real click starts players that ignore programmatic play().
          win.webContents.sendInputEvent({ type: 'mouseDown', x: 640, y: 360, button: 'left', clickCount: 1 })
          win.webContents.sendInputEvent({ type: 'mouseUp', x: 640, y: 360, button: 'left', clickCount: 1 })
        } catch (err) {
          note(`oynatıcı tetiklenemedi: ${err.message}`)
        }
      }

      win.loadURL(pageUrl, { userAgent: UA, httpReferrer: originOf(pageUrl) }).catch(() => {})
      note('sayfa açılıyor')
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
async function resolvePage(pageUrl, { onProgress = null, timeoutMs = 30000, staticOnly = false } = {}) {
  if (!isHttp(pageUrl)) return { title: '', candidates: [], engine: 'none' }

  if (onProgress) onProgress('sayfa taranıyor')
  const fast = await staticScan(pageUrl)
  const usable = fast.candidates.filter((c) => c.kind !== 'unknown')
  if (usable.length || staticOnly) {
    return { ...fast, candidates: usable, userAgent: UA }
  }

  if (onProgress) onProgress('oynatıcı çalıştırılıyor')
  const deep = await browserScan(pageUrl, { timeoutMs, onProgress })
  return {
    ...deep,
    title: deep.title || fast.title,
    userAgent: UA,
  }
}

module.exports = { resolvePage, unpackPacked, UA }
