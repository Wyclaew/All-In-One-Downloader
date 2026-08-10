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
const { execFile } = require('child_process')
const { toolEnv, ffprobePath } = require('./binaries')
const { fetchVia, ffmpegEnv } = require('./proxy')
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
  let host
  try {
    host = new URL(url).hostname
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
    const matches = host === bare || host.endsWith(`.${bare}`)
    if (!matches) continue
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

/* -------------------------------------------------------------------------- */
/* ffprobe                                                                     */
/* -------------------------------------------------------------------------- */

/** { duration, width, height, size, container, hasAudio } or null. */
function ffprobeMedia(url, resolved) {
  return new Promise((resolve) => {
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
      { env, timeout: FFPROBE_TIMEOUT, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
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

        let duration = num(format.duration)
        if (!duration) {
          for (const s of streams) {
            const d = num(s.duration)
            if (d && (!duration || d > duration)) duration = d
          }
        }

        resolve({
          duration: duration || null,
          width: width || null,
          height: height || null,
          size: num(format.size) || null,
          container: format.format_name || null,
          hasVideo: video.length > 0,
          hasAudio: audio.length > 0,
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
    })
    if (res.status && res.status >= 400) return { text: '', finalUrl: url, size: null }
    return {
      text: String(res.text || ''),
      finalUrl: res.finalUrl || url,
      size: num(res.headers && res.headers['content-length']),
    }
  } catch {
    return { text: '', finalUrl: url, size: null }
  }
}

/**
 * What a plain file is, without fetching it: how long, and whether the server
 * will serve pieces of it.
 *
 * HEAD is the polite way to ask and plenty of media CDNs refuse it, so fall back
 * to a one-byte ranged GET — which answers both questions at once, since a 206
 * *is* the proof that ranges work.
 */
async function probeFile(url, resolved) {
  const headers = fetchHeaders(url, resolved)
  const out = { size: null, ranges: false, url }
  // Same door as everything else when the link is proxied.
  if (resolved && resolved.proxy) {
    try {
      const res = await fetchVia(url, {
        headers: { ...headers, Range: 'bytes=0-0' },
        proxy: resolved.proxy,
        timeoutMs: FETCH_TIMEOUT,
        maxBytes: 1,
      })
      const total = num(String((res.headers || {})['content-range'] || '').split('/')[1])
      if (res.status === 206 && total) return { size: total, ranges: true, url }
      if (res.status === 200) {
        return {
          size: num((res.headers || {})['content-length']),
          ranges: /bytes/i.test(String((res.headers || {})['accept-ranges'] || '')),
          url,
        }
      }
    } catch {
      /* fall through: nothing known, and nothing leaked */
    }
    return out
  }

  const attempt = async (init) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
    try {
      return await fetch(url, { redirect: 'follow', signal: controller.signal, ...init })
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  const head = await attempt({ method: 'HEAD', headers })
  if (head && head.ok) {
    out.size = num(head.headers.get('content-length'))
    out.ranges = /bytes/i.test(head.headers.get('accept-ranges') || '')
    // Follow the redirect once here: parallel parts must all ask the same host,
    // and re-resolving the redirect on every connection wastes a round trip each.
    if (head.url) out.url = head.url
    if (out.size && out.ranges) return out
  }

  const ranged = await attempt({ method: 'GET', headers: { ...headers, Range: 'bytes=0-0' } })
  if (ranged) {
    // Read nothing: cancelling the body keeps this to one byte on the wire.
    try {
      await ranged.body?.cancel()
    } catch {
      /* already closed */
    }
    if (ranged.url) out.url = ranged.url
    const total = num((ranged.headers.get('content-range') || '').split('/')[1])
    if (ranged.status === 206 && total) {
      out.size = total
      out.ranges = true
      return out
    }
    if (ranged.ok && !out.size) out.size = num(ranged.headers.get('content-length'))
  }
  return out
}

/** Byte length of a plain file, or null when the server won't say. */
async function headSize(url, resolved) {
  const info = await probeFile(url, resolved)
  return info.size
}

/** Key systems we will not try to work around. */
const DRM_HINT = /widevine|playready|fairplay|streamingkeydelivery|clearkey|urn:uuid:edef8ba9|urn:uuid:9a04f079/i

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
  let duration = 0
  let extinfCount = 0
  let encrypted = false
  let drm = false
  let pendingInf = null

  const absolute = (ref) => {
    try {
      return new URL(ref, baseUrl).href
    } catch {
      return null
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line) continue

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = line.slice('#EXT-X-STREAM-INF:'.length)
      const res = attrs.match(/RESOLUTION=(\d+)x(\d+)/i)
      const bw = attrs.match(/(?:AVERAGE-)?BANDWIDTH=(\d+)/i)
      pendingInf = {
        width: res ? Number(res[1]) : null,
        height: res ? Number(res[2]) : null,
        bandwidth: bw ? Number(bw[1]) : null,
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
      const method = (line.match(/METHOD=([A-Z0-9-]+)/i) || [])[1] || ''
      if (method && method.toUpperCase() !== 'NONE') encrypted = true
      if (DRM_HINT.test(line) || /SAMPLE-AES/i.test(method)) drm = true
      continue
    }

    if (line.startsWith('#EXTINF:')) {
      const secs = parseFloat(line.slice('#EXTINF:'.length))
      if (Number.isFinite(secs)) {
        duration += secs
        extinfCount += 1
      }
      continue
    }

    if (line.startsWith('#')) continue

    // A bare line is a URI: either a variant (if preceded by STREAM-INF) or a segment.
    if (pendingInf) {
      const url = absolute(line)
      if (url) variants.push({ ...pendingInf, url })
      pendingInf = null
    }
  }

  variants.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0))

  return {
    variants,
    subtitles,
    duration: extinfCount ? Math.round(duration) : null,
    encrypted,
    drm,
    isMaster: variants.length > 0,
  }
}

/** ISO-8601 duration from a DASH manifest: PT1H23M4.5S */
function parseIsoDuration(text) {
  const m = String(text || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/i)
  if (!m) return null
  const [, d, h, min, s] = m
  const total =
    (Number(d) || 0) * 86400 + (Number(h) || 0) * 3600 + (Number(min) || 0) * 60 + (Number(s) || 0)
  return total > 0 ? Math.round(total) : null
}

function parseDash(text) {
  const duration = parseIsoDuration((text.match(/mediaPresentationDuration="([^"]+)"/i) || [])[1])

  // Accumulate rather than spreading into Math.max: a manifest with a
  // representation per segment can carry thousands of matches, and spreading an
  // array that large overflows the call stack.
  let height = 0
  for (const match of text.matchAll(/height="(\d+)"/gi)) {
    const value = Number(match[1])
    if (Number.isFinite(value) && value > height) height = value
  }

  // Bitrates, split by adaptation set, so a size estimate can pair the right
  // video rendition with the audio track that ships alongside it.
  const variants = []
  let audioBandwidth = 0
  for (const chunk of text.split(/<AdaptationSet/i).slice(1)) {
    const isAudio = /(?:mimeType|contentType)="?audio/i.test(chunk)
    for (const rep of chunk.split(/<Representation/i).slice(1)) {
      const bandwidth = Number((rep.match(/bandwidth="(\d+)"/i) || [])[1]) || 0
      if (!bandwidth) continue
      if (isAudio) {
        if (bandwidth > audioBandwidth) audioBandwidth = bandwidth
        continue
      }
      const repHeight = Number((rep.match(/height="(\d+)"/i) || [])[1]) || null
      variants.push({ height: repHeight, width: null, bandwidth, url: null })
    }
  }
  variants.sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth)

  const drm = /<ContentProtection[^>]*>/i.test(text) && DRM_HINT.test(text)
  return {
    duration,
    height: height || null,
    variants,
    audioBandwidth: audioBandwidth || null,
    drm,
    encrypted: /<ContentProtection/i.test(text),
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
  if (!bitsPerSecond || !seconds) return null
  const bytes = Math.round((bitsPerSecond / 8) * seconds)
  return bytes > 0 ? bytes : null
}

/**
 * Everything we can learn about a resolved stream without downloading it.
 * Returns { duration, height, width, filesize, sizes, variants, drm, encrypted, live }.
 */
async function describeStream(url, resolved) {
  const kind = resolved && resolved.kind ? resolved.kind : ''
  const info = {
    duration: null,
    width: null,
    height: null,
    filesize: null,
    /** height -> bytes, so the row can answer for whichever quality is picked. */
    sizes: {},
    /** Subtitle tracks the manifest itself advertises. */
    subtitles: [],
    /** True when the figure came from bitrate × duration, not from a real length. */
    filesizeEstimated: false,
    variants: [],
    encrypted: false,
    drm: false,
    live: false,
  }

  // Manifest first: cheap, and the only source for variant URLs and key systems.
  if (kind === 'hls' || /\.m3u8(\?|#|$)/i.test(url)) {
    const { text, finalUrl } = await fetchManifest(url, resolved)
    if (text && /#EXTM3U/i.test(text)) {
      const hls = parseHls(text, finalUrl)
      info.variants = hls.variants
      info.subtitles = hls.subtitles || []
      info.duration = hls.duration
      info.encrypted = hls.encrypted
      info.drm = hls.drm
      info.live = /#EXT-X-PLAYLIST-TYPE:EVENT/i.test(text) || !/#EXT-X-ENDLIST/i.test(text)
      if (hls.variants.length) {
        info.height = hls.variants[0].height
        info.width = hls.variants[0].width
      }
      // A master playlist carries no EXTINF; read the top variant for duration.
      if (!info.duration && hls.variants.length) {
        const inner = await fetchManifest(hls.variants[0].url, resolved)
        if (inner.text) {
          const media = parseHls(inner.text, inner.finalUrl)
          info.duration = media.duration
          info.live = !/#EXT-X-ENDLIST/i.test(inner.text)
          if (media.drm) info.drm = true
          if (media.encrypted) info.encrypted = true
        }
      }
    }
  } else if (kind === 'dash' || /\.mpd(\?|#|$)/i.test(url)) {
    const { text } = await fetchManifest(url, resolved)
    if (text) {
      const dash = parseDash(text)
      info.duration = dash.duration
      info.height = dash.height
      info.variants = dash.variants
      info.audioBandwidth = dash.audioBandwidth
      info.drm = dash.drm
      info.encrypted = dash.encrypted
    }
  }

  // ffprobe fills whatever is still missing, and handles progressive files.
  if (!info.duration || !info.height) {
    const probed = await ffprobeMedia(url, resolved)
    if (probed) {
      info.duration = info.duration || probed.duration
      info.height = info.height || probed.height
      info.width = info.width || probed.width
      info.filesize = info.filesize || probed.size
    }
  }

  if (info.live) info.duration = null

  // How big is it? A segmented stream has no Content-Length to ask for, so the
  // manifest's own bitrate is the answer; a plain file has a real length, so ask
  // the server for it rather than guessing.
  if (!info.filesize && !info.live) {
    if (info.variants.length && info.duration) {
      const audio = info.audioBandwidth || 0
      for (const variant of info.variants) {
        const bytes = sizeFromBitrate((variant.bandwidth || 0) + audio, info.duration)
        // A master playlist can list the same height at several bitrates; the one
        // a player would pick is the highest, and that is what we would download.
        if (bytes && variant.height && bytes > (info.sizes[variant.height] || 0)) {
          info.sizes[variant.height] = bytes
        }
      }
      const top = info.variants[0]
      info.filesize = sizeFromBitrate((top.bandwidth || 0) + audio, info.duration)
      info.filesizeEstimated = !!info.filesize
    } else if (kind === 'file' || /\.(mp4|webm|m4v|mkv|mov|flv|mp3|m4a)(\?|#|$)/i.test(url)) {
      info.filesize = await headSize(url, resolved)
    }
  }

  if (info.filesize && info.height && !info.sizes[info.height]) {
    info.sizes[info.height] = info.filesize
  }
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
}
