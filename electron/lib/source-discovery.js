'use strict'

// Data-only extraction. No eval, Function, vm or execution of downloaded code.
const MAX_TEXT = 3 * 1024 * 1024
const MEDIA = /\.(?:m3u8|mpd|mp4|webm|m4v|mkv|mov|flv|mp3|m4a|ogg|opus|wav)(?:[?#]|$)/i
const REJECT = /\.(?:jpe?g|png|gif|webp|svg|avif|vtt|srt|ass|css|js|mjs|woff2?|pdf|zip|html?)(?:[?#]|$)/i
const SOURCE_KEYS = /^(?:file|src|source|sources|url|urls|uri|contentUrl|playbackUrl|playUrl|video_url|videoUrl|streamUrl|stream_url|hls|dash|mpd|manifest|manifestUri|manifestUrl|playlist|hlsManifestUrl|dashManifestUrl|hlsUrl|dashUrl|mp4)$/i
const SOURCE_CONTAINERS = /^(?:source|sources|urls|playback|video|videos|stream|streams|media|renditions|variants|progressive|playlist|encoding|hls|dash|mpd)$/i
const EXCLUDED_KEYS = /^(?:ads?|advertising|thumbnails?|images?|poster|related|recommendations|author|publisher|navigation|menu|license(?:Url|Server)?|drm|keySystems?|protectionData|authentication|login)$/i
const TAG = /<(?:video|audio|source|iframe|embed|object|base|meta)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi

function unescapeText(value) {
  return String(value).replace(/&(?:amp|quot|apos|lt|gt);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' }
    if (named[entity.toLowerCase()] !== undefined) return named[entity.toLowerCase()]
    const n = /^&#x/i.test(entity) ? parseInt(entity.slice(3), 16) : Number(entity.slice(2, -1))
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ''
  }).replace(/\\u([0-9a-f]{4})/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\\\//g, '/')
}

function htmlAttributes(tag) {
  const out = {}
  for (const attr of String(tag).matchAll(/\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[attr[1].toLowerCase()] = unescapeText(attr[2] ?? attr[3] ?? attr[4])
  return out
}
function httpUrl(value, baseUrl) {
  if (typeof value !== 'string' || !value.trim() || value.length > 16000 || /[\u0000-\u001f\u007f]/.test(value)) return null
  try {
    const decoded = unescapeText(value.trim())
    if (/[\u0000-\u001f\u007f]/.test(decoded)) return null
    const url = new URL(decoded, baseUrl)
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}
function documentBaseOf(html, baseUrl) {
  const clean = String(html).slice(0, 128 * 1024).replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  const head = clean.match(/<head\b[^>]*>([\s\S]*?)(?:<\/head>|<body\b|$)/i)?.[1] || clean
  const tag = head.match(/<base\b(?:[^>"']|"[^"]*"|'[^']*')*>/i)?.[0]
  return tag ? httpUrl(htmlAttributes(tag).href, baseUrl) || baseUrl : baseUrl
}
function sourceKind(value, type = '') {
  if (/mpegurl|\bhls\b/i.test(type) || /\.m3u8(?:[?#]|$)/i.test(value)) return 'hls'
  if (/dash\+xml|\bdash\b|\bmpd\b/i.test(type) || /\.mpd(?:[?#]|$)/i.test(value)) return 'dash'
  return MEDIA.test(value) || /^(?:video|audio)\//i.test(type) ? 'file' : 'unknown'
}

function discoverSources(input, baseUrl) {
  const sources = [], frames = [], documents = []
  const seen = new Map(), visited = new Set()
  let nodes = 0, decodedBytes = 0
  const documentBase = typeof input === 'string' ? documentBaseOf(input, baseUrl) : baseUrl
  function offer(value, meta = {}, base = documentBase) {
    const url = httpUrl(value, base)
    if (!url || (REJECT.test(url) && !/mpegurl|dash|^(?:video|audio)\//i.test(meta.type || ''))) return
    const kind = sourceKind(url, meta.type)
    const previous = seen.get('s:' + url)
    if (previous) {
      if (previous.kind === 'unknown' && kind !== 'unknown') previous.kind = kind
      previous.language ||= meta.language || null; previous.label ||= meta.label || ''
      return
    }
    if (sources.length >= 120) return
    const source = { url, kind, language: meta.language || null, label: meta.label || '', needsCheck: true }
    seen.set('s:' + url, source); sources.push(source)
  }
  function frame(value, base = documentBase) {
    const url = httpUrl(value, base)
    if (url && !seen.has('f:' + url) && frames.length < 24) { seen.set('f:' + url, true); frames.push(url) }
  }
  function walk(value, context = '', depth = 0, inheritedType = '', sourceContext = false, base = documentBase) {
    if (++nodes > 6000 || depth > 12 || value == null) return
    if (typeof value === 'string') {
      const raw = value.trim()
      if ((MEDIA.test(raw) || sourceContext) && !/[<>\s]/.test(raw)) offer(raw, { type: inheritedType }, base)
      if (depth < 6 && raw.length <= MAX_TEXT && /^[{["<]/.test(raw)) decode(raw, depth + 1, base)
      return
    }
    if (Array.isArray(value)) { for (const entry of value.slice(0, 300)) walk(entry, context, depth + 1, inheritedType, sourceContext, base); return }
    if (typeof value !== 'object') return
    const type = String(value.type || value.mimeType || value.mime || value.encodingFormat || value.format || inheritedType || '')
    const videoObject = /(?:^|[\s,/])(?:VideoObject|AudioObject|MediaObject)(?:$|[\s,])/i.test(String(value['@type'] || ''))
    const mediaContext = sourceContext || videoObject || /mpegurl|dash|^(?:video|audio)\//i.test(type)
    for (const [key, entry] of Object.entries(value).slice(0, 300)) {
      if (EXCLUDED_KEYS.test(key)) continue
      if (/^(?:embedUrl|iframe|iframe_url|embed)$/i.test(key)) { if (typeof entry === 'string') frame(entry, base); continue }
      const container = SOURCE_CONTAINERS.test(key)
      if (typeof entry === 'string' && SOURCE_KEYS.test(key) && (!/^(?:url|uri)$/i.test(key) || mediaContext || MEDIA.test(entry))) {
        offer(entry, { type: /^(?:hls|dash|mpd|mp4)$/i.test(key) ? key : type, language: value.language || value.lang || value.inLanguage, label: value.label || value.name }, base)
      }
      // A media object's author/menu/license URL does not inherit its source role.
      walk(entry, key, depth + 1, container ? type : '', container, base)
    }
  }
  function decode(raw, depth = 0, base = documentBase) {
    if (depth > 6 || typeof raw !== 'string' || raw.length > MAX_TEXT || visited.has(raw) || decodedBytes + raw.length > MAX_TEXT * 3) return
    visited.add(raw); decodedBytes += raw.length
    try { walk(JSON.parse(raw), 'config', depth + 1, '', false, base); return } catch {}
    let text = raw
    if (/<(?:iframe|video|audio|source)\b/i.test(text) && documents.length < 24) documents.push(text)
    for (const match of text.matchAll(TAG)) {
      const name = match[0].match(/^<(\w+)/)[1].toLowerCase(), attrs = htmlAttributes(match[0])
      if (name === 'base') continue
      if (name === 'meta') {
        const property = attrs.property || attrs.name || attrs.itemprop || ''
        if (/^(?:og:video(?::(?:secure_url|url))?|twitter:player:stream|contentUrl)$/i.test(property) && attrs.content) offer(attrs.content, {}, base)
        else if (/^twitter:player$/i.test(property)) frame(attrs.content, base)
        continue
      }
      if (['iframe', 'embed', 'object'].includes(name)) {
        for (const ref of [attrs.src, attrs['data-src'], attrs['data-lazy-src'], attrs.data]) if (httpUrl(ref, base)) { frame(ref, base); break }
        if (attrs.srcdoc) decode(attrs.srcdoc, depth + 1, base)
      } else if (!/^image\//i.test(attrs.type || '')) {
        for (const ref of [attrs.src, attrs['data-src']]) if (ref) offer(ref, { type: attrs.type }, base)
      }
      for (const key of ['data-setup', 'data-player', 'data-config']) if (attrs[key] && /^[{[]/.test(attrs[key])) { try { walk(JSON.parse(attrs[key]), 'player', depth + 1, '', true, base) } catch {} }
    }
    text = text.replace(/<script\b[^>]*(?:type=["']application\/(?:ld\+)?json["']|id=["']__(?:NEXT_DATA|NUXT_DATA)__["'])[^>]*>([\s\S]*?)<\/script>/gi, (_tag, body) => {
      try { walk(JSON.parse(body), 'player', depth + 1, '', false, base) } catch {}
      return ''
    })
    text = unescapeText(text)
    for (const token of text.matchAll(/(?:atob\s*\(\s*|["'])([A-Za-z0-9+/_-]{24,}={0,2})["']/g)) {
      const decoded = Buffer.from(token[1], 'base64url').toString('utf8')
      if (/https?:|<iframe|["'](?:file|sources?|hls|manifest)["']\s*:/i.test(decoded)) decode(decoded, depth + 1, base)
    }
    const configs = text.replace(/<[^>]+>/g, ' ')
    for (const match of configs.matchAll(/(?:["']?)(file|src|source|hls|dash|mpd|manifest|manifestUri|manifestUrl|playbackUrl|videoUrl|hlsManifestUrl|dashManifestUrl)["']?\s*[:=]\s*(["'])((?:\\.|(?!\2)[\s\S]){1,8192}?)\2/gi)) {
      if (/^(?:https?:|\/|\.\.?\/)/i.test(match[3]) || MEDIA.test(match[3]) && !/\s/.test(match[3])) offer(match[3], { type: match[1] }, base)
    }
    for (const match of text.matchAll(/(?:iframe(?:\.src)?|embedUrl)["']?\s*[:=]\s*["']([^"']{1,8192})["']/gi)) frame(match[1], base)
    for (const match of text.matchAll(/data:text\/html(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=]+)/gi)) decode(Buffer.from(match[1], 'base64').toString('utf8'), depth + 1, base)
  }
  if (typeof input === 'object') walk(input, 'player')
  else decode(String(input || '').slice(0, MAX_TEXT))
  return { sources, frames, documents, documentBase }
}

module.exports = { discoverSources, unescapeText, sourceKind, htmlAttributes, documentBaseOf }
