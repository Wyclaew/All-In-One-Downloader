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

    execFile(
      bin,
      args,
      { env: toolEnv(), timeout: FFPROBE_TIMEOUT, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
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
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: fetchHeaders(url, resolved),
    })
    if (!res.ok) return { text: '', finalUrl: url, size: null }
    const size = num(res.headers.get('content-length'))
    const text = (await res.text()).slice(0, MAX_MANIFEST)
    return { text, finalUrl: res.url || url, size }
  } catch {
    return { text: '', finalUrl: url, size: null }
  } finally {
    clearTimeout(timer)
  }
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
  const heights = [...text.matchAll(/height="(\d+)"/gi)].map((m) => Number(m[1]))
  const drm = /<ContentProtection[^>]*>/i.test(text) && DRM_HINT.test(text)
  return {
    duration,
    height: heights.length ? Math.max(...heights) : null,
    drm,
    encrypted: /<ContentProtection/i.test(text),
  }
}

/* -------------------------------------------------------------------------- */
/* public                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Everything we can learn about a resolved stream without downloading it.
 * Returns { duration, height, width, filesize, variants, drm, encrypted, live }.
 */
async function describeStream(url, resolved) {
  const kind = resolved && resolved.kind ? resolved.kind : ''
  const info = {
    duration: null,
    width: null,
    height: null,
    filesize: null,
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
  return info
}

module.exports = { describeStream, parseHls, parseDash, cookieHeaderFor, ffprobeMedia }
