'use strict'

// Data-only extraction. No eval, Function, vm or execution of downloaded code.
const MAX_TEXT = 3 * 1024 * 1024
const MEDIA = /\.(?:m3u8|mpd|mp4|webm|m4v|mkv|mov|flv|mp3|m4a)(?:[?#]|$)/i
const REJECT = /\.(?:jpe?g|png|gif|webp|svg|vtt|srt|ass|css|js|woff2?)(?:[?#]|$)/i
const SOURCE_KEYS = /^(?:file|src|source|sources|url|urls|contentUrl|playbackUrl|playUrl|video_url|videoUrl|streamUrl|hls|dash|manifest|playlist|hlsManifestUrl|dashManifestUrl)$/i
const MEDIA_CONTEXT = /source|video|stream|playback|manifest|playlist|content|media|rendition|variant/i

function unescapeText(value) {
  return String(value).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/\\u([0-9a-f]{4})/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\\\//g, '/')
}

function sourceKind(value, type = '') {
  if (/mpegurl|hls/i.test(type) || /\.m3u8(?:[?#]|$)/i.test(value)) return 'hls'
  if (/dash\+xml|\bdash\b/i.test(type) || /\.mpd(?:[?#]|$)/i.test(value)) return 'dash'
  return MEDIA.test(value) || /^video\//i.test(type) ? 'file' : 'unknown'
}

function discoverSources(input, baseUrl) {
  const sources = [], frames = [], documents = []
  const seen = new Set(), visited = new Set()
  let nodes = 0, decodedBytes = 0
  const absolute = (raw) => {
    try {
      const url = new URL(unescapeText(raw), baseUrl)
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
    } catch { return null }
  }
  function offer(value, meta = {}) {
    const url = absolute(value)
    if (!url || seen.has('s:' + url) || (REJECT.test(url) && !/mpegurl|dash|video/i.test(meta.type || ''))) return
    seen.add('s:' + url)
    sources.push({ url, kind: sourceKind(url, meta.type), language: meta.language || null, label: meta.label || '', needsCheck: true })
  }
  function frame(value) {
    const url = absolute(value)
    if (url && !seen.has('f:' + url)) { seen.add('f:' + url); frames.push(url) }
  }
  function walk(value, context = '', depth = 0) {
    if (++nodes > 6000 || depth > 12 || value == null) return
    if (typeof value === 'string') {
      const raw = value.trim()
      if ((MEDIA.test(raw) || MEDIA_CONTEXT.test(context)) && (/^(?:https?:\/\/|\/|\.\.?\/)/i.test(raw) || MEDIA.test(raw) && !/\s/.test(raw))) offer(raw)
      if (/embed|iframe/i.test(context) && /^https?:\/\//i.test(raw)) frame(raw)
      if (depth < 6 && raw.length <= MAX_TEXT && /^[{["<]/.test(raw)) decode(raw, depth + 1)
      return
    }
    if (Array.isArray(value)) { for (const entry of value.slice(0, 300)) walk(entry, context, depth + 1); return }
    if (typeof value !== 'object') return
    const type = String(value.type || value.mimeType || value.mime || '')
    const mediaContext = MEDIA_CONTEXT.test(context) || /mpegurl|dash|^video\//i.test(type)
    for (const [key, entry] of Object.entries(value).slice(0, 300)) {
      if (typeof entry === 'string' && SOURCE_KEYS.test(key) && (key !== 'url' || mediaContext || MEDIA.test(entry))) {
        offer(entry, { type, language: value.language || value.lang, label: value.label || value.name })
      }
      if (/^(?:embedUrl|iframe|iframe_url|embed)$/i.test(key) && typeof entry === 'string') frame(entry)
      // Tracking, advertising, thumbnails and unrelated navigation aren't sources.
      if (/^(?:ads?|advertising|thumbnails?|images?|poster|related|recommendations)$/i.test(key)) continue
      walk(entry, `${context}.${key}`, depth + 1)
    }
  }
  function decode(raw, depth = 0) {
    if (depth > 6 || typeof raw !== 'string' || raw.length > MAX_TEXT || visited.has(raw) || decodedBytes > MAX_TEXT * 3) return
    visited.add(raw); decodedBytes += raw.length
    let text = unescapeText(raw)
    try { walk(JSON.parse(raw), 'config', depth + 1); return } catch {}
    if (/<(?:iframe|video|source)\b/i.test(text)) documents.push(text)
    // Includes application/json, JSON-LD and Next/Nuxt state, regardless of id.
    text = text.replace(/<script\b[^>]*(?:type=["']application\/(?:ld\+)?json["']|id=["']__(?:NEXT_DATA|NUXT_DATA)__["'])[^>]*>([\s\S]*?)<\/script>/gi, (_tag, body) => {
      try { walk(JSON.parse(body), 'player', depth + 1) } catch {}
      return ''
    })
    // Only explicit string decoders, with bounded expansion; never evaluate JS.
    for (const token of text.matchAll(/(?:atob\s*\(\s*|["'])([A-Za-z0-9+/_-]{24,}={0,2})["']/g)) {
      if (token[1].length > MAX_TEXT) continue
      const decoded = Buffer.from(token[1], 'base64url').toString('utf8')
      if (/https?:|<iframe|["'](?:file|sources?|hls|manifest)["']\s*:/i.test(decoded)) decode(decoded, depth + 1)
    }
    // Common inline configs use single quotes or unquoted property names.
    const configs = text.replace(/<[^>]+>/g, ' ')
    for (const match of configs.matchAll(/(?:["']?)(file|src|source|hls|dash|manifest|playbackUrl|videoUrl|hlsManifestUrl|dashManifestUrl)["']?\s*[:=]\s*(["'])((?:\\.|(?!\2)[\s\S]){1,8192}?)\2/gi)) {
      if (/^(?:https?:|\/|\.\.?\/)/i.test(match[3]) || MEDIA.test(match[3]) && !/\s/.test(match[3])) offer(match[3], { type: match[1] })
    }
    for (const match of text.matchAll(/(?:iframe(?:\.src)?|embedUrl)["']?\s*[:=]\s*["']([^"']{1,8192})["']/gi)) frame(match[1])
    for (const match of text.matchAll(/<iframe\b[^>]*\bsrcdoc\s*=\s*(["'])([\s\S]*?)\1/gi)) decode(match[2], depth + 1)
    for (const match of text.matchAll(/data:text\/html(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=]+)/gi)) decode(Buffer.from(match[1], 'base64').toString('utf8'), depth + 1)
  }
  if (typeof input === 'object') walk(input, 'player')
  else decode(String(input || '').slice(0, MAX_TEXT))
  return { sources: sources.slice(0, 120), frames: frames.slice(0, 24), documents: documents.slice(0, 24) }
}

module.exports = { discoverSources, unescapeText, sourceKind }
