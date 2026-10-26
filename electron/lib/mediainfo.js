'use strict'

// Real metadata for a stream our resolver found.
//
// `yt-dlp -J` is good at pages and bad at bare manifests: hand it a master
// playlist and it usually comes back without a duration, which is exactly the
// field a list of videos needs most. ffprobe reads HLS, DASH and progressive
// files directly and reports duration, resolution and codecs for all three.
//
// The manifest itself is still worth parsing on top of that, for two things
// ffprobe won't tell us: which variant URL maps to which height, and whether the
// stream is encrypted with something we must not touch.

const fs = require('fs')
const http = require('http')
const https = require('https')
const { execFile } = require('child_process')
const { toolEnv, ffprobePath } = require('./binaries')
const { fetchVia, ffmpegEnv, agentsFor } = require('./proxy')
const { num } = require('./util')

const FFPROBE_TIMEOUT = 25000
const FETCH_TIMEOUT = 12000
const MAX_MANIFEST = 2 * 1024 * 1024

/* -------------------------------------------------------------------------- */
/* headers                                                                     */
/* -------------------------------------------------------------------------- */

/** Cookie header for `url`, read out of a Netscape jar. */
function cookieHeaderFor(jarFile, url) {
  if (!jarFile) return ''
  let host, target
  try {
    target = new URL(url)
    host = target.hostname
  } catch {
    return ''
  }

  let text = ''
  try {
    text = fs.readFileSync(jarFile, 'utf8')
  } catch {
    return ''
  }

  const pairs = []
  for (const raw of text.split('\n')) {
    let line = raw.trim()
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
    else if (!line || line.startsWith('#')) continue

    const parts = line.split('\t')
    if (parts.length < 7) continue
    const domain = parts[0]
    const bare = domain.replace(/^\./, '')
    const matches = host === bare || (parts[1] === 'TRUE' && host.endsWith(`.${bare}`))
    const cookiePath = parts[2] || '/'
    const pathname = target.pathname || '/'
    const pathMatches = pathname === cookiePath || (pathname.startsWith(cookiePath) && (cookiePath.endsWith('/') || pathname[cookiePath.length] === '/'))
    if (!matches || !pathMatches) continue
    if (parts[3] === 'TRUE' && target.protocol !== 'https:') continue
    if (Number(parts[4]) > 0 && Number(parts[4]) * 1000 <= Date.now()) continue
    pairs.push(`${parts[5]}=${parts.slice(6).join('\t')}`)
  }
  return pairs.join('; ')
}

/** ffmpeg wants one CRLF-terminated blob for extra headers. */
function ffprobeHeaderArgs(url, resolved) {
  const args = []
  if (!resolved) return args
  const lines = []
  if (resolved.referer) lines.push(`Referer: ${resolved.referer}`)
  if (resolved.origin) lines.push(`Origin: ${resolved.origin}`)
  const cookie = cookieHeaderFor(resolved.cookieFile, url)
  if (cookie) lines.push(`Cookie: ${cookie}`)
  if (resolved.userAgent) args.push('-user_agent', resolved.userAgent)
  if (lines.length) args.push('-headers', `${lines.join('\r\n')}\r\n`)
  return args
}

function fetchHeaders(url, resolved) {
  const headers = {
    'User-Agent': (resolved && resolved.userAgent) || 'Mozilla/5.0',
    Accept: '*/*',
  }
  if (resolved && resolved.referer) headers.Referer = resolved.referer
  if (resolved && resolved.origin) headers.Origin = resolved.origin
  const cookie = cookieHeaderFor(resolved && resolved.cookieFile, url)
  if (cookie) headers.Cookie = cookie
  return headers
}

const positive = (value) => { const n = num(value); return n > 0 ? n : null }

/* -------------------------------------------------------------------------- */
/* ffprobe                                                                     */
/* -------------------------------------------------------------------------- */

/** { duration, width, height, size, container, hasAudio } or null. */
function ffprobeMedia(url, resolved) {
  return new Promise((resolve) => {
    // Custom FFmpeg Cookie headers are reused for cross-host children and
    // redirects. Own manifest/header requests preserve jar scope; skip this
    // optional remote probe whenever a jar may be needed by this source or one
    // of its children instead of relying on version-specific cookie semantics.
    if (/^https?:/i.test(url) && resolved?.cookieFile) return resolve(null)
    const bin = ffprobePath()
    if (!bin) return resolve(null)

    const args = [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      // Don't let a stalled CDN hold the queue open.
      '-rw_timeout',
      '15000000',
      // A remote manifest may reference more protocols than its own URL. Keep
      // optional metadata probing from opening local files or device inputs.
      ...(/^https?:/i.test(url) ? ['-protocol_whitelist', 'http,https,tcp,tls,crypto,data'] : []),
      ...ffprobeHeaderArgs(url, resolved),
      '-i',
      url,
    ]

    // ffprobe understands http_proxy and nothing else. For a SOCKS proxy there is
    // no way to tunnel it, and probing anyway would send the user's real address
    // to a host they asked to reach through the tunnel — so it does not run.
    const proxy = (resolved && resolved.proxy) || ''
    let env = toolEnv()
    if (proxy) {
      const vars = ffmpegEnv(proxy)
      if (!vars) return resolve(null)
      env = { ...env, ...vars }
    }

    execFile(
      bin,
      args,
      { env, signal: resolved?.signal, timeout: FFPROBE_TIMEOUT, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (!stdout) return resolve(null)
        let data
        try {
          data = JSON.parse(stdout)
        } catch {
          return resolve(null)
        }
        if (!data || typeof data !== 'object') return resolve(null)

        const format = data.format || {}
        const streams = Array.isArray(data.streams) ? data.streams : []

        // ffprobe reads a still image as a one-frame video stream; refuse those
        // outright so posters can never be mistaken for the feature.
        if (/^(png_pipe|image2|mjpeg|jpeg_pipe|webp_pipe|gif|bmp_pipe|svg)/i.test(format.format_name || '')) {
          return resolve(null)
        }
        const video = streams.filter((s) => s.codec_type === 'video')
        const audio = streams.filter((s) => s.codec_type === 'audio')

        // A master playlist exposes every variant as its own stream; the tallest
        // is what "best" would actually download.
        let height = 0
        let width = 0
        for (const s of video) {
          const h = num(s.height) || 0
          if (h > height) {
            height = h
            width = num(s.width) || 0
          }
        }

        let duration = positive(format.duration)
        if (!duration) {
          for (const s of streams) {
            const d = positive(s.duration)
            if (d && (!duration || d > duration)) duration = d
          }
        }

        resolve({
          duration: duration || null,
          width: width || null,
          height: height || null,
          size: positive(format.size),
          bitrate: positive(format.bit_rate),
          container: format.format_name || null,
          hasVideo: video.length > 0,
          hasAudio: audio.length > 0,
          audioTracks: audio.map((a) => ({ lang: a.tags?.language || '', name: a.tags?.title || '', index: a.index })),
          failed: !!err && !duration && !height,
        })
      }
    )
  })
}

/* -------------------------------------------------------------------------- */
/* manifests                                                                   */
/* -------------------------------------------------------------------------- */

async function fetchManifest(url, resolved) {
  // A manifest read on behalf of a proxied link has to use that link's proxy.
  // `fetch` takes no agent, so a tunnelled source leaves this path entirely —
  // otherwise the playlist is read from the real address while only the download
  // is tunnelled, which both leaks and fails on a geo-blocked host.
  try {
    const res = await fetchVia(url, {
      headers: fetchHeaders(url, resolved),
      proxy: (resolved && resolved.proxy) || '',
      timeoutMs: FETCH_TIMEOUT,
      maxBytes: MAX_MANIFEST,
      signal: resolved?.signal,
      allowBinaryText: true,
      retries: 0,
      headersFor: (target) => ({ Cookie: cookieHeaderFor(resolved?.cookieFile, target) }),
    })
    return {
      text: String(res.text || ''),
      finalUrl: res.finalUrl || url,
      size: num(res.headers && res.headers['content-length']),
      status: res.status,
      contentType: res.headers?.['content-type'] || '',
      access: accessEvidence(res.status, res.text, res.headers),
    }
  } catch (error) {
    return { text: '', finalUrl: url, size: null, errorKind: resolved?.signal?.aborted ? 'cancelled' : error.code === 'RESPONSE_TOO_LARGE' ? 'response-too-large' : /TIMEDOUT/.test(error.code || '') ? 'timeout' : /ENOTFOUND|EAI_AGAIN|ECONN|ENET|EHOST/.test(error.code || '') ? 'network' : 'unknown' }
  }
}

/** Evidence of an actual access gate; an HTTP 403 alone does not prove login. */
function accessEvidence(status, input, headers = {}) {
  const text = String(input || '').slice(0, 65536)
  const visible = text.replace(/<!--[\s\S]*?-->|<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  // Some hosts return their IP-denial template with HTTP 200. This is neither
  // a login requirement nor proof that the user's internet is offline.
  const networkBlocked = (status >= 400 || /<(?:title|h[1-6])\b[^>]*>[^<]*(?:error|forbidden|access denied|erişim engeli)/i.test(text)) &&
    /(?:vpn\s+veya\s+server\s+ip\s+adresi\s+ile|(?:your\s+)?ip\s+(?:address\s+)?(?:has been\s+|is\s+)?blocked|(?:vpn|proxy)\s+(?:connections?\s+)?(?:are\s+|is\s+)?not\s+(?:allowed|permitted))/i.test(visible)
  const challengeMarker = /(?:_cf_chl_opt|cf-chl-(?:widget|challenge)|challenges\.cloudflare\.com|g-recaptcha|h-captcha|hcaptcha\.com)/i.test(text)
  const challengeRequired = !networkBlocked && (/challenge/i.test(String(headers['cf-mitigated'] || '')) || challengeMarker && ([403, 429, 503].includes(status) || /<title[^>]*>[^<]*(?:just a moment|verify|verification|attention required|doğrula)/i.test(text)))
  const passwordForm = /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(text)
  const accessRequired = !networkBlocked && !challengeRequired && (status === 401 || !!headers['www-authenticate'] || passwordForm && /<title[^>]*>[^<]*(?:giriş|üye|sign.?in|log.?in|authentication)/i.test(text))
  const errorKind = networkBlocked ? 'network-blocked' : challengeRequired ? 'verification' : accessRequired ? 'authentication' : status === 403 ? 'access-denied' : status === 404 ? 'not-found' : status === 410 ? 'expired' : status === 429 ? 'rate-limited' : status >= 500 ? 'server' : null
  return { accessRequired, challengeRequired, networkBlocked, errorKind }
}

/**
 * What a plain file is, without fetching it: how large, and whether the server
 * will serve pieces of it.
 *
 * HEAD is the polite way to ask and plenty of media CDNs refuse it, so fall back
 * to a one-byte ranged GET — which answers both questions at once, since a 206
 * *is* the proof that ranges work.
 */
async function probeFile(url, resolved) {
  const out = { size: null, ranges: false, url }
  const head = await requestFileHeaders(url, resolved, 'HEAD')
  if (head && head.status >= 200 && head.status < 300) {
    out.url = head.url
    out.status = head.status
    out.contentType = head.headers['content-type'] || ''
    out.size = !head.headers['content-encoding'] ? positive(head.headers['content-length']) : null
    out.ranges = /\bbytes\b/i.test(head.headers['accept-ranges'] || '')
    if (out.size && out.ranges) return out
  }
  if (resolved?.signal?.aborted) return out
  const ranged = await requestFileHeaders(url, resolved, 'GET')
  if (!ranged) return out
  if (ranged.status >= 400 && out.status >= 200 && out.status < 300) {
    out.ranges = false
    return out
  }
  out.status = ranged.status
  out.url = ranged.url
  out.contentType = ranged.headers['content-type'] || out.contentType || ''
  const range = String(ranged.headers['content-range'] || '').match(/^bytes\s+0-0\/(\d+)$/i)
  if (ranged.status === 206 && range && positive(range[1]) && !ranged.headers['content-encoding']) {
    out.size = positive(range[1]); out.ranges = true
  } else if (ranged.status === 200) {
    if (!out.size && !ranged.headers['content-encoding']) out.size = positive(ranged.headers['content-length'])
    // An ignored Range proves that this response cannot be split in parallel.
    out.ranges = false
  }
  return out
}

/** Headers only: no text reader, and the response is closed even for a 200 GET.
 * Native fetch forwards manually supplied cookies across redirects. Recompute
 * jar scope at each hop here, using the same proxy as the eventual transfer. */
function requestFileHeaders(url, resolved, method = 'HEAD', timeoutMs = FETCH_TIMEOUT) {
  if (resolved?.signal?.aborted) return Promise.resolve(null)
  let agents
  try { agents = resolved?.proxy ? agentsFor(resolved.proxy) : null } catch { return Promise.resolve(null) }
  if (resolved?.proxy && !agents) return Promise.resolve(null)
  const started = Date.now()
  const firstOrigin = (() => { try { return new URL(url).origin } catch { return '' } })()
  const visit = (targetUrl, redirects = 5) => new Promise((resolve) => {
    let target
    try { target = new URL(targetUrl) } catch { return resolve(null) }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || resolved?.signal?.aborted) return resolve(null)
    const remaining = timeoutMs - (Date.now() - started)
    if (remaining <= 0) return resolve(null)
    const headers = { ...fetchHeaders(target.href, resolved), 'Accept-Encoding': 'identity', ...(method === 'GET' ? { Range: 'bytes=0-0' } : {}) }
    if (target.origin !== firstOrigin) delete headers.Origin
    let settled = false, timer, req
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
    try {
      req = (target.protocol === 'https:' ? https : http).request(target, {
        method, headers, agent: agents?.[target.protocol], signal: resolved?.signal,
        autoSelectFamily: !resolved?.proxy,
      }, (res) => {
        res.on('error', () => {})
        const status = res.statusCode
        const responseHeaders = res.headers
        res.destroy()
        if (responseHeaders.location && status >= 300 && status < 400 && redirects > 0) {
          let next
          try { next = new URL(responseHeaders.location, target).href } catch { return finish(null) }
          settled = true; clearTimeout(timer)
          return resolve(visit(next, redirects - 1))
        }
        finish({ status, headers: responseHeaders, url: target.href })
      })
      req.on('error', () => finish(null))
      timer = setTimeout(() => { req.destroy(); finish(null) }, remaining)
      req.end()
    } catch { finish(null) }
  })
  return visit(url)
}

/** Byte length of a plain file, or null when the server won't say. */
async function headSize(url, resolved) {
  const info = await probeFile(url, resolved)
  return info.size
}

function hlsAttributes(text) {
  const attrs = {}
  for (const match of String(text).matchAll(/(?:^|[:,])([\w-]+)=(?:"([^"]*)"|([^,]*))/g)) attrs[match[1].toUpperCase()] = match[2] ?? match[3]
  return attrs
}

/**
 * Parse an HLS playlist.
 * Returns { variants, duration, encrypted, drm, isMaster }.
 *
 * Note on encryption: plain AES-128 with a fetchable key URI is ordinary HLS and
 * yt-dlp decrypts it natively — that is not DRM and must not be reported as such.
 * SAMPLE-AES with a vendor key system is.
 */
function parseHls(text, baseUrl) {
  const lines = text.split(/\r?\n/)
  const variants = []
  const subtitles = []
  const audioTracks = []
  const segments = []
  const maps = []
  let duration = 0
  let extinfCount = 0
  let encrypted = false
  let drm = false
  let pendingInf = null
  let pendingDuration = null
  let pendingRange = null
  let previousRange = null
  let gap = false
  let invalidMedia = false
  let partCount = 0

  const absolute = (ref) => {
    if (typeof ref !== 'string' || ref.length > 16000 || /[\u0000-\u001f\u007f]/.test(ref)) return null
    try {
      const url = new URL(ref, baseUrl)
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null
    } catch {
      return null
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line) continue

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = hlsAttributes(line)
      const res = String(attrs.RESOLUTION || '').match(/^(\d+)x(\d+)$/i)
      pendingInf = {
        width: res ? Number(res[1]) : null,
        height: res ? Number(res[2]) : null,
        bandwidth: positive(attrs['AVERAGE-BANDWIDTH']) || positive(attrs.BANDWIDTH),
        peakBandwidth: positive(attrs.BANDWIDTH),
        averageBandwidth: positive(attrs['AVERAGE-BANDWIDTH']),
        codecs: attrs.CODECS || '',
        audioGroup: attrs.AUDIO || null,
      }
      continue
    }

    /*
     * Subtitle renditions.
     *
     * This was the missing piece behind "the subtitles never showed up in VLC".
     * yt-dlp's --write-subs asks the *extractor* for subtitles, and a bare m3u8
     * scraped off a series site has no extractor to ask — but the master playlist
     * itself lists its subtitle tracks right here, which is where those sites keep
     * them. Nobody was reading them.
     */
    if (line.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO(?:,|$)/i.test(line)) {
      const attrs = hlsAttributes(line)
      const attr = (name) => attrs[name] || ''
      const uri = attr('URI')
      audioTracks.push({
        url: uri ? absolute(uri) : null, lang: attr('LANGUAGE').toLowerCase() || require('./media-preferences').trackLanguage({ name: attr('NAME') }),
        name: attr('NAME'), group: attr('GROUP-ID'), default: /DEFAULT=YES/i.test(line),
      })
      continue
    }

    if (line.startsWith('#EXT-X-MEDIA:') && /TYPE=SUBTITLES/i.test(line)) {
      const uri = (line.match(/URI="([^"]+)"/i) || [])[1]
      if (uri) {
        const abs = absolute(uri)
        if (abs) {
          subtitles.push({
            url: abs,
            lang: ((line.match(/LANGUAGE="([^"]*)"/i) || [])[1] || '').toLowerCase(),
            name: (line.match(/NAME="([^"]*)"/i) || [])[1] || '',
            forced: /FORCED=YES/i.test(line),
          })
        }
      }
      continue
    }

    if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
      const attrs = hlsAttributes(line), method = String(attrs.METHOD || '').toUpperCase()
      if (method && method !== 'NONE') {
        encrypted = true
        // The key system is a format/scheme, not a word in an ordinary CDN
        // filename such as /keys/clearkey.bin.
        if (/SAMPLE-AES/i.test(method) || attrs.KEYFORMAT && attrs.KEYFORMAT.toLowerCase() !== 'identity' || /^(?:skd|urn):/i.test(attrs.URI || '')) drm = true
      }
      continue
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const range = line.slice('#EXT-X-BYTERANGE:'.length).match(/^(\d+)(?:@(\d+))?$/)
      pendingRange = range && positive(range[1]) ? { length: Number(range[1]), offset: range[2] === undefined ? null : Number(range[2]) } : null
      if (!pendingRange) invalidMedia = true
      continue
    }
    if (line.startsWith('#EXT-X-PART:')) {
      const attrs = hlsAttributes(line)
      if (positive(attrs.DURATION) && attrs.URI && absolute(attrs.URI) && attrs.GAP !== 'YES') partCount += 1
      continue
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = hlsAttributes(line)
      const range = String(attrs.BYTERANGE || '').match(/^(\d+)@(\d+)$/)
      const url = attrs.URI && absolute(attrs.URI)
      if (url && maps.length < 1000) maps.push({ url, length: range ? positive(range[1]) : null, offset: range ? Number(range[2]) : null })
      continue
    }
    if (line === '#EXT-X-GAP') { gap = true; continue }
    if (line.startsWith('#EXTINF:')) {
      const secs = parseFloat(line.slice('#EXTINF:'.length))
      if (pendingDuration || !Number.isFinite(secs) || secs <= 0) invalidMedia = true
      pendingDuration = Number.isFinite(secs) && secs > 0 ? secs : null
      continue
    }

    if (line.startsWith('#')) continue

    // A bare line is a URI: either a variant (if preceded by STREAM-INF) or a segment.
    if (pendingInf) {
      const url = absolute(line)
      if (url) variants.push({ ...pendingInf, url })
      pendingInf = null
    } else if (pendingDuration) {
      const url = absolute(line)
      if (url) {
        let range = pendingRange
        if (range && range.offset === null) range = previousRange?.url === url ? { ...range, offset: previousRange.offset + previousRange.length } : null
        if (pendingRange && !range) invalidMedia = true
        if (range) previousRange = { ...range, url }
        else previousRange = null
        // Keep the duration calculation bounded in memory even for huge VODs.
        if (segments.length < 12000) segments.push({ url, duration: pendingDuration, range, gap })
        duration += pendingDuration
        extinfCount += 1
      } else invalidMedia = true
      pendingDuration = null; pendingRange = null; gap = false
    } else invalidMedia = true
  }

  variants.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0))

  return {
    variants,
    subtitles,
    audioTracks,
    duration: extinfCount && !invalidMedia && !pendingDuration ? duration : null,
    complete: !invalidMedia && !pendingDuration && !pendingInf,
    segments,
    segmentCount: extinfCount,
    hasParts: partCount > 0,
    maps,
    live: variants.length ? null : extinfCount || partCount ? !/^#EXT-X-ENDLIST\s*$/m.test(text) : null,
    encrypted,
    drm,
    isMaster: variants.length > 0,
  }
}

/** ISO-8601 elapsed time; calendar months/years cannot be converted to seconds. */
function parseIsoDuration(text) {
  const m = String(text || '').trim().match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i)
  if (!m || !m.slice(1).some((v) => v !== undefined)) return null
  const total = (Number(m[1]) || 0) * 86400 + (Number(m[2]) || 0) * 3600 + (Number(m[3]) || 0) * 60 + (Number(m[4]) || 0)
  return Number.isFinite(total) ? total : null
}

/** Decode XML's built-in/numeric entities; custom/remote entities are refused. */
function decodeXml(value) {
  let valid = true
  const text = String(value).replace(/&([^;\s<>&]+);/g, (_token, entity) => {
    const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }
    if (Object.hasOwn(named, entity)) return named[entity]
    const number = /^#x[0-9a-f]+$/i.test(entity) ? parseInt(entity.slice(2), 16) : /^#\d+$/.test(entity) ? Number(entity.slice(1)) : NaN
    if (!Number.isInteger(number) || number <= 0 || number > 0x10ffff || number >= 0xd800 && number <= 0xdfff) { valid = false; return '' }
    return String.fromCodePoint(number)
  })
  // A bare '&' is invalid XML, too; checking the original avoids rejecting the
  // literal ampersand produced by a legitimate &amp; in a signed BaseURL.
  if (/&(?!(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);)/i.test(String(value))) valid = false
  return valid ? text : null
}

// XML is data. This reader deliberately has no DTD/entity/network support.
// Retaining direct text allows the native DASH engine to resolve inherited
// BaseURL entries without introducing a second parser with different bounds.
function dashTree(input) {
  const text = String(input || '').replace(/^\uFEFF/, '')
  if (text.length > MAX_MANIFEST) return null
  const root = { name: '', attrs: {}, children: [], text: '' }, stack = [root]
  let count = 0, offset = 0
  const append = (raw, literal = false) => {
    const value = literal ? raw : decodeXml(raw)
    if (value === null || stack.length === 1 && value.trim()) return false
    stack[stack.length - 1].text += value
    return true
  }
  while (offset < text.length) {
    const start = text.indexOf('<', offset)
    if (start === -1) { if (!append(text.slice(offset))) return null; break }
    if (!append(text.slice(offset, start))) return null
    if (text.startsWith('<!--', start)) {
      const end = text.indexOf('-->', start + 4)
      if (end === -1) return null
      offset = end + 3; continue
    }
    if (text.startsWith('<![CDATA[', start)) {
      const end = text.indexOf(']]>', start + 9)
      if (end === -1 || stack.length === 1 || !append(text.slice(start + 9, end), true)) return null
      offset = end + 3; continue
    }
    if (text.startsWith('<?', start)) {
      const end = text.indexOf('?>', start + 2)
      if (end === -1) return null
      offset = end + 2; continue
    }
    if (text.startsWith('<!', start)) return null
    let end = start + 1, quote = ''
    for (; end < text.length; end += 1) {
      const char = text[end]
      if (quote) { if (char === quote) quote = '' }
      else if (char === '"' || char === "'") quote = char
      else if (char === '>') break
    }
    if (end >= text.length || quote) return null
    const tag = text.slice(start + 1, end)
    offset = end + 1
    const close = tag.match(/^\/([A-Za-z_][\w:.-]*)\s*$/)
    if (close) {
      if (stack.length <= 1 || stack[stack.length - 1].xmlName !== close[1]) return null
      stack.pop(); continue
    }
    const match = tag.match(/^([A-Za-z_][\w:.-]*)/)
    if (!match || ++count > 50000 || stack.length > 48) return null
    const node = { name: match[1].split(':').pop().toLowerCase(), xmlName: match[1], attrs: {}, children: [], text: '' }
    const selfClosing = /\/\s*$/.test(tag)
    const tail = tag.slice(match[0].length, selfClosing ? tag.lastIndexOf('/') : tag.length)
    let position = 0
    while (position < tail.length) {
      const attr = tail.slice(position).match(/^\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/)
      if (!attr) { if (tail.slice(position).trim()) return null; break }
      const key = attr[1].toLowerCase(), value = decodeXml(attr[2] ?? attr[3])
      if (value === null || Object.hasOwn(node.attrs, key)) return null
      node.attrs[key] = value
      position += attr[0].length
    }
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) stack.push(node)
  }
  return stack.length === 1 && root.children.length === 1 && root.children[0].name === 'mpd' ? root.children[0] : null
}
const dashChildren = (node, name) => (node?.children || []).filter((n) => n.name === name)
function dashTemplate(chain) {
  const attrs = {}; let timeline = null, list = null
  for (const node of chain) {
    const template = dashChildren(node, 'segmenttemplate')[0] || dashChildren(node, 'segmentlist')[0]
    if (!template) continue
    Object.assign(attrs, template.attrs)
    timeline = dashChildren(template, 'segmenttimeline')[0] || timeline
    if (template.name === 'segmentlist') list = template
  }
  return { attrs, timeline, list }
}
function dashTimelineDuration(chain, periodDuration) {
  const { attrs, timeline, list } = dashTemplate(chain)
  const scale = attrs.timescale === undefined ? 1 : positive(attrs.timescale)
  const offset = attrs.presentationtimeoffset === undefined ? 0 : num(attrs.presentationtimeoffset)
  if (!Number.isSafeInteger(scale) || scale <= 0 || !Number.isSafeInteger(offset) || offset < 0) return null
  if (!timeline) {
    const length = positive(attrs.duration), count = dashChildren(list, 'segmenturl').length
    return length && count ? length * count / scale : null
  }
  const entries = dashChildren(timeline, 's')
  let end = 0
  for (let i = 0; i < entries.length; i += 1) {
    const a = entries[i].attrs, d = positive(a.d), t = num(a.t), r = num(a.r) ?? 0
    if (!d || !Number.isSafeInteger(r) || r < -1) return null
    const start = t ?? end
    if (r === -1) {
      const bound = num(entries[i + 1]?.attrs.t) ?? (periodDuration ? offset + periodDuration * scale : null)
      if (bound === null || bound <= start) return null
      end = bound
    } else end = start + d * (r + 1)
    if (!Number.isFinite(end) || end > Number.MAX_SAFE_INTEGER) return null
  }
  return positive((end - offset) / scale)
}

function parseDash(text) {
  const mpd = dashTree(text)
  const protectedNode = (node) => node.name === 'contentprotection' || node.children.some(protectedNode)
  const encrypted = mpd ? protectedNode(mpd) : /<(?:[\w.-]+:)?ContentProtection\b/i.test(text)
  const empty = { valid: false, duration: null, height: null, width: null, variants: [], audioTracks: [], periods: [], audioBandwidth: null, drm: encrypted, encrypted, live: null }
  if (!mpd) return empty
  const live = String(mpd.attrs.type || 'static').toLowerCase() === 'dynamic'
  const declaredDuration = positive(parseIsoDuration(mpd.attrs.mediapresentationduration))
  const periods = dashChildren(mpd, 'period').map((node, index) => ({
    node, start: num(parseIsoDuration(node.attrs.start)) ?? (index === 0 ? 0 : null),
    duration: positive(parseIsoDuration(node.attrs.duration)), variants: [], audioTracks: [], audioBandwidth: null,
  }))
  const variants = [], audioTracks = []
  let height = 0, width = 0, audioBandwidth = 0
  // First establish explicit period bounds; an open-ended r=-1 timeline can
  // only be finite when a next Period or the MPD declares where it ends.
  for (let pass = 0; pass < 2; pass += 1) for (let i = 0; i < periods.length; i += 1) {
    const period = periods[i], next = periods[i + 1], prev = periods[i - 1]
    if (period.start === null && prev?.duration && prev.start !== null) period.start = prev.start + prev.duration
    if (!period.duration && period.start !== null) period.duration = positive(next?.start !== null && next?.start !== undefined ? next.start - period.start : i === periods.length - 1 && declaredDuration ? declaredDuration - period.start : null)
  }
  for (const period of periods) {
    let inferredDuration = null
    for (const set of dashChildren(period.node, 'adaptationset')) {
      const reps = dashChildren(set, 'representation')
      for (const rep of reps) {
        const attrs = { ...set.attrs, ...rep.attrs }
        const type = [attrs.contenttype, attrs.mimetype, attrs.codecs].filter(Boolean).join(' ')
        const audio = /audio|(?:^|\s)(?:mp4a|opus|vorbis|ac-3|ec-3)/i.test(type)
        const video = !audio && !/text|subtitle|vtt|ttml|stpp|wvtt/i.test(type)
        const bandwidth = positive(attrs.bandwidth)
        const h = positive(attrs.height), w = positive(attrs.width)
        if (audio) {
          const track = { lang: attrs.lang || '', name: attrs.label || '', id: attrs.id || '', bandwidth }
          period.audioTracks.push(track); audioTracks.push(track)
          period.audioBandwidth = Math.max(period.audioBandwidth || 0, bandwidth || 0) || null
          audioBandwidth = Math.max(audioBandwidth, bandwidth || 0)
        } else if (video) {
          const variant = { height: h, width: w, bandwidth, url: null, id: attrs.id || '', codecs: attrs.codecs || '' }
          period.variants.push(variant); variants.push(variant)
          if ((h || 0) > height) { height = h; width = w || 0 }
        }
        if (audio || video) {
          const d = dashTimelineDuration([mpd, period.node, set, rep], period.duration)
          if (d && (!inferredDuration || d > inferredDuration)) inferredDuration = d
        }
      }
    }
    if (!period.duration) period.duration = inferredDuration
    period.variants.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0))
  }
  // A finite timeline can establish an earlier Period's end. Propagate that
  // newly known start into later Periods so an MPD end can bound their r=-1.
  for (let i = 0; i < periods.length; i += 1) {
    const period = periods[i], previous = periods[i - 1], next = periods[i + 1]
    if (period.start === null && previous?.duration && previous.start !== null) period.start = previous.start + previous.duration
    if (!period.duration && period.start !== null) period.duration = positive(next?.start !== null && next?.start !== undefined ? next.start - period.start : i === periods.length - 1 && declaredDuration ? declaredDuration - period.start : null)
  }
  let end = 0, complete = periods.length > 0
  for (const period of periods) {
    if (period.start === null) period.start = end
    if (!period.duration) { complete = false; break }
    end = period.start + period.duration
  }
  variants.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0))
  // An unknown protection system still requires authorization/key handling that
  // this resolver does not provide. Keep it protected rather than guessing clear.
  const drm = encrypted
  return {
    valid: true,
    duration: live ? null : declaredDuration || (complete ? positive(end) : null),
    height: height || null, width: width || null, variants, audioTracks,
    periods: periods.map(({ node, ...period }) => period),
    audioBandwidth: audioBandwidth || null, drm, encrypted, live,
  }
}

/* -------------------------------------------------------------------------- */
/* public                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Bytes a stream of this bitrate and length will occupy. Manifests advertise
 * BANDWIDTH in bits per second, which is exactly what a size estimate needs — and
 * for a segmented stream it is the *only* thing that answers "how big is this"
 * without fetching every segment.
 */
function sizeFromBitrate(bitsPerSecond, seconds) {
  if (!positive(bitsPerSecond) || !positive(seconds)) return null
  const bytes = Math.round((bitsPerSecond / 8) * seconds)
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null
}

/**
 * Everything we can learn about a resolved stream without downloading it.
 * Returns { duration, height, width, filesize, sizes, variants, drm, encrypted, live }.
 */
function applyPlayerMetadata(info, metadata) {
  if (!metadata || !info.playable || info.drm || info.rejected) return info
  if (info.live !== true && !info.duration && positive(metadata.duration)) {
    info.duration = positive(metadata.duration); info.durationSource = 'player'
  }
  if (!info.width) info.width = positive(metadata.width)
  if (!info.height) info.height = positive(metadata.height)
  return info
}

function estimateVariantSizes(info) {
  if (info.live || !info.duration || info.filesize && !info.filesizeEstimated) return
  if (info.kind === 'dash' && !info.variants.length && info.audioBandwidth) {
    const periods = info.periods || []
    const bytes = periods.length && periods.every((p) => p.duration && p.audioBandwidth)
      ? periods.reduce((n, p) => n + (sizeFromBitrate(p.audioBandwidth, p.duration) || 0), 0)
      : sizeFromBitrate(info.audioBandwidth, info.duration)
    if (bytes) { info.filesize = bytes; info.filesizeEstimated = true; info.filesizeSource = 'manifest-bitrate' }
    return
  }
  for (const variant of info.variants) {
    let bytes = null
    // A multi-period MPD can change bitrate halfway through. Weight each
    // period independently rather than extending the largest bitrate over all.
    if (info.kind === 'dash' && info.periods?.length) {
      let complete = true, total = 0
      for (const period of info.periods) {
        const video = period.variants.find((v) => variant.height ? v.height === variant.height : v.id === variant.id)
        if (!period.duration || !video?.bandwidth) { complete = false; break }
        total += sizeFromBitrate(video.bandwidth + (period.audioBandwidth || 0), period.duration) || 0
      }
      if (complete) bytes = positive(Math.round(total))
    } else bytes = sizeFromBitrate(variant.bandwidth, info.duration)
    if (!bytes) continue
    variant.filesize = bytes; variant.filesizeEstimated = true
    variant.filesizeSource = 'manifest-bitrate'
    if (variant.height && bytes > (info.sizes[variant.height] || 0)) info.sizes[variant.height] = bytes
  }
  const top = info.variants.find((v) => v.url === info.selectedVariantUrl || v.mediaUrl === info.selectedVariantUrl) || info.variants[0]
  if (top?.filesize) {
    info.filesize = top.filesize; info.filesizeEstimated = true; info.filesizeSource = 'manifest-bitrate'
  }
}

async function estimateHlsSize(playlist, resolved) {
  if (!playlist || playlist.live !== false || !playlist.duration || playlist.segmentCount !== playlist.segments.length || playlist.segments.some((s) => s.gap)) return null
  const maps = [...new Map(playlist.maps.map((m) => [`${m.url}:${m.offset}:${m.length}`, m])).values()]
  if (playlist.segments.every((s) => s.range?.length) && maps.every((m) => m.length)) {
    const size = playlist.segments.reduce((n, s) => n + s.range.length, 0) + maps.reduce((n, m) => n + m.length, 0)
    return { size: positive(size), source: 'byte-ranges' }
  }
  if (resolved?.signal?.aborted) return null
  // Three headers-only requests, evenly spaced across the episode. Read no
  // fragment bodies; a server ignoring Range is closed as soon as it responds.
  const indexes = [...new Set([0, Math.floor((playlist.segments.length - 1) / 2), playlist.segments.length - 1])]
  if (maps.some((m) => !m.length)) indexes.splice(1, Math.max(0, indexes.length - 2))
  const samples = await Promise.all(indexes.map(async (i) => {
    const segment = playlist.segments[i]
    if (segment.range?.length) return { bytes: segment.range.length, seconds: segment.duration }
    const head = await requestFileHeaders(segment.url, resolved, 'GET', 3500)
    if (!head || head.headers['content-encoding'] || /html|json/i.test(head.headers['content-type'] || '')) return null
    const range = String(head.headers['content-range'] || '').match(/^bytes\s+0-0\/(\d+)$/i)
    const bytes = head.status === 206 && range ? positive(range[1]) : head.status === 200 ? positive(head.headers['content-length']) : null
    return bytes ? { bytes, seconds: segment.duration } : null
  }))
  // One missing or unrelated response is too weak a basis for a whole-file size.
  if (samples.some((s) => !s)) return null
  let mapBytes = 0
  for (const map of maps) {
    if (map.length) { mapBytes += map.length; continue }
    // Keep the total request count at three even for fMP4 with an init map.
    if (maps.length !== 1) return null
    const head = await requestFileHeaders(map.url, resolved, 'GET', 3500)
    const range = String(head?.headers['content-range'] || '').match(/^bytes\s+0-0\/(\d+)$/i)
    const size = head?.status === 206 && range ? positive(range[1]) : head?.status === 200 ? positive(head.headers['content-length']) : null
    if (!size || head.headers['content-encoding'] || /html|json/i.test(head.headers['content-type'] || '')) return null
    mapBytes += size
  }
  const bytes = samples.reduce((n, s) => n + s.bytes, 0), seconds = samples.reduce((n, s) => n + s.seconds, 0)
  return { size: positive(Math.round(bytes / seconds * playlist.duration + mapBytes)), source: 'segment-sample' }
}

async function describeStream(url, resolved) {
  let kind = resolved?.kind || '', mediaPlaylist = null, fileProbe = null
  const info = {
    duration: null, durationSource: null,
    kind: kind === 'unknown' ? null : kind,
    playable: false, rejected: false, width: null, height: null,
    filesize: null, filesizeSource: null, sizes: {}, subtitles: [], audioTracks: [],
    filesizeEstimated: false, variants: [], rejectedVariantUrls: [], encrypted: false, drm: false, live: null,
  }
  const inspectManifest = kind !== 'file' || /\.(m3u8|mpd)(?:[?#]|$)/i.test(url)
  if (inspectManifest && !resolved?.signal?.aborted) {
    const manifest = await fetchManifest(url, resolved)
    const { text, finalUrl } = manifest
    info.finalUrl = finalUrl
    if (manifest.errorKind) info.errorKind = manifest.errorKind
    if (manifest.status >= 400) { Object.assign(info, manifest.access); info.rejected = true; info.status = manifest.status; return info }
    if (/^\s*#EXTM3U/i.test(text)) {
      kind = info.kind = 'hls'
      const hls = parseHls(text, finalUrl)
      info.variants = hls.variants; info.subtitles = hls.subtitles; info.audioTracks = hls.audioTracks
      info.encrypted = hls.encrypted; info.drm = hls.drm
      if (!hls.isMaster) mediaPlaylist = hls
      else {
        let requests = 0
        let denied = null
        const visiting = new Set([url.split('#')[0], finalUrl.split('#')[0]])
        const inspect = async (parent, depth = 0) => {
          for (const variant of parent.variants.slice(0, 3)) {
            if (resolved?.signal?.aborted || info.drm || requests >= 6 || depth >= 3) break
            const key = variant.url.split('#')[0]
            if (visiting.has(key)) { info.manifestIssue = 'cycle'; continue }
            visiting.add(key); requests += 1
            const inner = await fetchManifest(variant.url, resolved)
            if (inner.status >= 400 || inner.access?.accessRequired || inner.access?.challengeRequired) {
              const evidence = { ...inner.access, status: inner.status }
              if (!denied || evidence.challengeRequired || evidence.accessRequired && !denied.challengeRequired) denied = evidence
            }
            const redirected = inner.finalUrl.split('#')[0]
            const redirectCycle = redirected !== key && visiting.has(redirected)
            if (!redirectCycle) visiting.add(redirected)
            let chosen = null
            if (redirectCycle) info.manifestIssue = 'cycle'
            else if (inner.status < 400 && /^\s*#EXTM3U/i.test(inner.text)) {
              const media = parseHls(inner.text, inner.finalUrl)
              info.drm ||= media.drm
              if (media.isMaster && !media.drm) chosen = await inspect(media, depth + 1)
              else if (!media.isMaster && (media.segmentCount || media.hasParts)) chosen = {
                playlist: media, url: variant.url, chain: [], variant,
                audioTracks: [], audioContext: false, audioGroup: null,
                subtitles: media.subtitles, encrypted: media.encrypted,
              }
            } else if (inner.status >= 400 || /^\s*(?:<!doctype\s+html|<html\b)/i.test(inner.text)) {
              if (info.rejectedVariantUrls.length < 12) info.rejectedVariantUrls.push(variant.url)
              if (depth === 0) info.variants = info.variants.filter((v) => v !== variant)
            }
            visiting.delete(key)
            if (!redirectCycle && redirected !== key) visiting.delete(redirected)
            if (chosen) {
              const ownAudio = variant.audioGroup ? parent.audioTracks.filter((track) => track.group === variant.audioGroup) : []
              const useChildAudio = chosen.audioContext
              return { ...chosen, chain: [variant.url, ...chosen.chain],
                audioTracks: useChildAudio ? chosen.audioTracks : ownAudio,
                audioGroup: useChildAudio ? chosen.audioGroup : variant.audioGroup || null,
                audioContext: useChildAudio || !!variant.audioGroup,
                subtitles: [...parent.subtitles, ...chosen.subtitles], encrypted: parent.encrypted || chosen.encrypted }
            }
          }
          return null
        }
        const chosen = await inspect(hls)
        if (chosen) {
          mediaPlaylist = chosen.playlist
          info.selectedVariantUrl = chosen.url
          info.selectedVariantChain = chosen.chain
          info.height = chosen.variant.height; info.width = chosen.variant.width
          info.audioTracks = [...new Map(chosen.audioTracks.map((t) => [`${t.group}:${t.url}:${t.lang}`, t])).values()]
          info.subtitles = [...new Map(chosen.subtitles.map((t) => [t.url, t])).values()]
          info.encrypted ||= chosen.encrypted
          const parent = info.variants.find((v) => v.url === chosen.chain[0])
          if (parent && chosen.chain.length > 1) {
            parent.mediaUrl = chosen.url
            parent.height = chosen.variant.height || parent.height
            parent.width = chosen.variant.width || parent.width
            parent.bandwidth = chosen.variant.bandwidth || parent.bandwidth
            parent.audioGroup = chosen.variant.audioGroup || parent.audioGroup
          }
          info.height ||= parent?.height; info.width ||= parent?.width
          info.preparedVariants = [{
            url: chosen.chain[0], mediaUrl: chosen.url,
            height: info.height, width: info.width, bandwidth: parent?.bandwidth || chosen.variant.bandwidth || null,
            audioGroup: chosen.audioGroup,
            audioTracks: info.audioTracks.slice(0, 40),
          }]
        } else if (denied) Object.assign(info, denied)
      }
      if (mediaPlaylist) {
        info.live = mediaPlaylist.live
        info.duration = info.live === false ? mediaPlaylist.duration : null
        info.playable = mediaPlaylist.segmentCount > 0 || mediaPlaylist.hasParts
      }
    } else if (/<(?:[\w.-]+:)?MPD(?:\s|>)/i.test(text.slice(0, 2000))) {
      kind = info.kind = 'dash'
      const dash = parseDash(text)
      if (!dash.valid) { info.rejected = true; info.drm = dash.drm; info.encrypted = dash.encrypted; return info }
      Object.assign(info, { duration: dash.duration, height: dash.height, width: dash.width,
        variants: dash.variants, periods: dash.periods, audioBandwidth: dash.audioBandwidth,
        audioTracks: dash.audioTracks, drm: dash.drm, encrypted: dash.encrypted, live: dash.live })
      info.playable = dash.variants.length > 0 || dash.audioTracks.length > 0
    } else if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(text) || manifest.access?.accessRequired || manifest.access?.challengeRequired) {
      Object.assign(info, manifest.access); info.rejected = true; return info
    } else if (/^(?:video|audio)\//i.test(manifest.contentType || '') && manifest.status >= 200 && manifest.status < 300) {
      kind = info.kind = 'file'
    }
    if (info.duration) info.durationSource = 'manifest'
  }
  if (kind === 'file' && !resolved?.signal?.aborted) {
    fileProbe = await probeFile(url, resolved)
    info.finalUrl = fileProbe.url
    if (!resolved?._contentRetried && /mpegurl|dash\+xml/i.test(fileProbe.contentType || '')) return describeStream(url, { ...resolved, kind: 'unknown', _contentRetried: true })
    if (fileProbe.status >= 400 || /(?:text\/html|application\/(?:json|xml))/i.test(fileProbe.contentType || '')) {
      Object.assign(info, accessEvidence(fileProbe.status, ''))
      if (/html/i.test(fileProbe.contentType || '') && !resolved?.signal?.aborted) {
        const gate = await fetchManifest(fileProbe.url, resolved)
        Object.assign(info, gate.access || {})
      }
      info.rejected = true; info.status = fileProbe.status; return info
    }
    if (resolved?.playerMetadata && /^(?:video|audio)\//i.test(fileProbe.contentType || '') && fileProbe.status >= 200 && fileProbe.status < 300) {
      info.playable = true; info.live = false
    }
  }
  // Runtime metadata can complete dimensions before an expensive remote probe,
  // but only after the manifest has independently established playable media.
  applyPlayerMetadata(info, resolved?.playerMetadata)
  let probed = null
  if (info.live !== true && (!info.duration || !info.height) && (kind !== 'hls' || mediaPlaylist) && !info.drm && !resolved?.signal?.aborted) {
    if (resolved?.cookieFile) info.metadataLimitReason = 'scoped-cookie'
    probed = await ffprobeMedia(url, resolved)
    if (probed) {
      if (kind === 'file' && !resolved?._contentRetried && /(?:^|,)(?:hls|dash)(?:,|$)/i.test(probed.container || '')) return describeStream(url, { ...resolved, kind: 'unknown', _contentRetried: true })
      if (!info.duration && info.live !== true && probed.duration) { info.duration = probed.duration; info.durationSource = 'probe' }
      info.height ||= probed.height; info.width ||= probed.width
      const stillImage = /_pipe|(?:^|,)image2(?:pipe)?(?:,|$)/i.test(probed.container || '')
      // An invalid master child cannot become playable because ffprobe exposed
      // its rendition's advertised dimensions before failing to read the media.
      if (kind !== 'hls' || mediaPlaylist) info.playable ||= !!(probed.hasAudio || probed.hasVideo && !stillImage) && !probed.failed
      if (info.playable && !info.kind) kind = info.kind = 'file'
      if (!info.audioTracks.length) info.audioTracks = probed.audioTracks || []
      if (info.kind === 'file') {
        info.live = false
        info.filesize = probed.size
        if (info.filesize) info.filesizeSource = 'probe'
      }
    }
  }
  applyPlayerMetadata(info, resolved?.playerMetadata)
  if (info.live) { info.duration = null; info.durationSource = null }
  if (!info.live && !info.drm) {
    estimateVariantSizes(info)
    if (!info.filesize && kind === 'hls' && mediaPlaylist) {
      // Sampling only the video child would omit separate audio. Master bitrate
      // already includes its audio group, so prefer that whenever available.
      const selected = info.variants.find((v) => v.url === info.selectedVariantUrl || v.mediaUrl === info.selectedVariantUrl)
      const separateAudio = selected?.audioGroup && info.audioTracks.some((t) => t.group === selected.audioGroup && t.url)
      const estimate = separateAudio ? null : await estimateHlsSize(mediaPlaylist, resolved)
      if (estimate?.size && !separateAudio) {
        info.filesize = estimate.size; info.filesizeSource = estimate.source; info.filesizeEstimated = true
      }
    } else if (kind === 'file') {
      const file = fileProbe || await probeFile(url, resolved)
      info.finalUrl = file.url
      if (file.status >= 400 || /(?:text\/html|application\/(?:json|xml))/i.test(file.contentType || '')) {
        info.rejected = true; info.playable = false; info.filesize = null; info.filesizeSource = null
      } else if (file.size) { info.filesize = file.size; info.filesizeSource = 'content-length'; info.filesizeEstimated = false }
      if (!info.filesize && probed?.bitrate && info.duration) {
        info.filesize = sizeFromBitrate(probed.bitrate, info.duration)
        info.filesizeEstimated = !!info.filesize; info.filesizeSource = info.filesize ? 'probe-bitrate' : null
      }
    }
  }
  if (info.filesize && info.height && !info.sizes[info.height]) info.sizes[info.height] = info.filesize
  info.rejected ||= !info.playable && !info.drm
  return info
}

/* -------------------------------------------------------------------------- */
/* audio language                                                              */
/* -------------------------------------------------------------------------- */

/** ffprobe reports ISO 639-2; subtitle providers speak ISO 639-1. */
const LANG_ALIASES = {
  tur: 'tr', tr: 'tr',
  eng: 'en', en: 'en',
  ger: 'de', deu: 'de', de: 'de',
  fre: 'fr', fra: 'fr', fr: 'fr',
  spa: 'es', es: 'es',
  ita: 'it', it: 'it',
  rus: 'ru', ru: 'ru',
  ara: 'ar', ar: 'ar',
  jpn: 'ja', ja: 'ja',
  kor: 'ko', ko: 'ko',
  chi: 'zh', zho: 'zh', zh: 'zh',
  por: 'pt', pt: 'pt',
  dut: 'nl', nld: 'nl', nl: 'nl',
  pol: 'pl', pl: 'pl',
  swe: 'sv', sv: 'sv',
  gre: 'el', ell: 'el', el: 'el',
  per: 'fa', fas: 'fa', fa: 'fa',
  hin: 'hi', hi: 'hi',
  ukr: 'uk', uk: 'uk',
  rum: 'ro', ron: 'ro', ro: 'ro',
  bul: 'bg', bg: 'bg',
  srp: 'sr', sr: 'sr',
  hrv: 'hr', hr: 'hr',
  cze: 'cs', ces: 'cs', cs: 'cs',
  hun: 'hu', hu: 'hu',
  heb: 'he', he: 'he',
  tha: 'th', th: 'th',
  vie: 'vi', vi: 'vi',
  ind: 'id', id: 'id',
}

/** Two-letter code, or '' when the tag is missing or 'und'. */
function normaliseLanguage(code) {
  const raw = String(code || '').trim().toLowerCase().split(/[-_]/)[0]
  if (!raw || raw === 'und' || raw === 'unknown' || raw === 'mul') return ''
  return LANG_ALIASES[raw] || (raw.length === 2 ? raw : '')
}

/**
 * Languages of a downloaded file's audio tracks. Many web downloads carry no
 * tag at all, so an empty result means "unknown", never "none".
 */
function audioLanguages(filePath) {
  return new Promise((resolve) => {
    const bin = ffprobePath()
    if (!bin) return resolve([])
    execFile(
      bin,
      [
        '-v', 'error',
        '-select_streams', 'a',
        '-show_entries', 'stream_tags=language',
        '-print_format', 'json',
        '-i', filePath,
      ],
      { env: toolEnv(), timeout: 20000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve([])
        try {
          const data = JSON.parse(stdout)
          const langs = (data.streams || [])
            .map((s) => normaliseLanguage(s.tags && s.tags.language))
            .filter(Boolean)
          resolve([...new Set(langs)])
        } catch {
          resolve([])
        }
      }
    )
  })
}

module.exports = {
  describeStream,
  parseHls,
  parseDash,
  cookieHeaderFor,
  ffprobeHeaderArgs,
  fetchHeaders,
  fetchManifest,
  headSize,
  probeFile,
  ffprobeMedia,
  audioLanguages,
  normaliseLanguage,
  parseIsoDuration,
  parseDashTree: dashTree,
  accessEvidence,
  applyPlayerMetadata,
  estimateVariantSizes,
}
