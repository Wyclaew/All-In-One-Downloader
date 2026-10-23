'use strict'

// Remote subtitle documents are data. Fetch them through the selected tunnel
// with per-hop cookie scoping, then let FFmpeg see only local files. No page,
// subtitle playlist, key URI or conversion step can initiate FFmpeg network I/O.
const fs = require('fs/promises')
const path = require('path')
const { fetchVia } = require('./proxy')
const { fetchHeaders, cookieHeaderFor, parseHls } = require('./mediainfo')

const MAX_TOTAL = 16 * 1024 * 1024
const MAX_DOCUMENT = 2 * 1024 * 1024
const MAX_SEGMENTS = 2000
const TOTAL_TIMEOUT = 30000
const prepared = new Map()

async function cleanupSubtitle(outTemp) {
  const files = prepared.get(path.resolve(outTemp))
  if (!files) return
  prepared.delete(path.resolve(outTemp))
  await Promise.all(files.map((file) => fs.rm(file.path, { recursive: file.directory, force: true })))
}

async function fetchSubtitle(url, outTemp, { resolved = {}, proxy = resolved.proxy || '', signal = null } = {}) {
  const target = path.resolve(outTemp)
  if (prepared.has(target)) throw new Error('Altyazı geçici yolu zaten kullanımda.')
  const controller = new AbortController()
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const timeout = setTimeout(() => controller.abort(), TOTAL_TIMEOUT)
  const owned = []
  prepared.set(target, owned)
  let total = 0, reserved = 0
  const scope = { ...resolved, proxy, signal: combined }
  const read = async (source, maxBytes = MAX_DOCUMENT) => {
    if (combined.aborted) throw Object.assign(new Error('Altyazı hazırlığı durduruldu.'), { code: 'ABORTED' })
    const parsed = new URL(source)
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error('Altyazı adresi desteklenmiyor.')
    // Reserve each reader's maximum before it starts. Concurrent fragments may
    // not each consume the same remaining budget near the total limit.
    const limit = Math.min(maxBytes, MAX_TOTAL - total - reserved)
    if (limit <= 0) throw new Error('Altyazı toplam boyut sınırını aştı.')
    reserved += limit
    const headers = fetchHeaders(parsed.href, scope)
    delete headers.Cookie
    let response
    try {
      response = await fetchVia(parsed.href, {
        headers,
        headersFor: (next) => { const cookie = cookieHeaderFor(scope.cookieFile, next); return cookie ? { Cookie: cookie } : {} },
        proxy, signal: combined, allowBinaryText: true, timeoutMs: 8000, maxBytes: limit, retries: 0, allowBinaryText: true,
      })
    } finally { reserved -= limit }
    if (response.status < 200 || response.status >= 300) throw new Error(`Altyazı kaynağı HTTP ${response.status || '?'} döndürdü.`)
    const text = String(response.text || '').replace(/^\uFEFF/, '')
    total += Buffer.byteLength(text)
    if (!text || total > MAX_TOTAL || /\u0000|^\s*(?:<!doctype\s+html|<html\b)/i.test(text) || /(?:text\/html|application\/json)/i.test(response.headers?.['content-type'] || '')) throw new Error('Kaynak geçerli bir metin altyazısı sunmadı.')
    return { text, url: response.finalUrl || parsed.href }
  }
  const write = async (file, content) => {
    await fs.writeFile(file, content, { flag: 'wx', mode: 0o600 })
    owned.push({ path: file, directory: false })
  }
  try {
    let document = await read(url)
    // An occasional subtitle entry points to a one-rendition master. Follow at
    // most two levels; multi-quality video masters are never subtitle sources.
    for (let depth = 0; /^\s*#EXTM3U/.test(document.text); depth += 1) {
      const hls = parseHls(document.text, document.url)
      if (!hls.isMaster) break
      if (depth >= 1 || hls.variants.length !== 1 || hls.variants[0].height) throw new Error('Altyazı oynatma listesi desteklenmiyor.')
      document = await read(hls.variants[0].url)
    }
    if (!/^\s*#EXTM3U/.test(document.text)) {
      if (!/^\s*WEBVTT(?:\s|$)/i.test(document.text) && !/\d{1,2}:\d{2}:\d{2}[.,]\d{2,3}\s*-->/.test(document.text) && !/^\s*\[Script Info\]/i.test(document.text)) throw new Error('Altyazı biçimi tanınmadı.')
      await write(target, document.text)
      return target
    }
    const hls = parseHls(document.text, document.url)
    if (hls.live !== false || !hls.complete || hls.encrypted || hls.drm || hls.maps.length || !hls.segments.length || hls.segmentCount > MAX_SEGMENTS || hls.segmentCount !== hls.segments.length || hls.segments.some((s) => s.gap || s.range)) throw new Error('Bu altyazı oynatma listesi güvenli yerel dönüşümü desteklemiyor.')
    const directory = `${target}.parts`
    await fs.mkdir(directory, { mode: 0o700 })
    owned.push({ path: directory, directory: true })
    let cursor = 0
    const workers = await Promise.allSettled(Array.from({ length: Math.min(4, hls.segments.length) }, async () => {
      try {
        while (cursor < hls.segments.length) {
          const index = cursor++, segment = hls.segments[index]
          const part = await read(segment.url, 1024 * 1024)
          if (!/^\s*WEBVTT(?:\s|$)/i.test(part.text)) throw new Error('Altyazı parçası WebVTT değil.')
          // Files inside the exclusively-created directory have no user contents.
          await fs.writeFile(path.join(directory, `${index}.vtt`), part.text, { flag: 'wx', mode: 0o600 })
        }
      } catch (error) { controller.abort(); throw error }
    }))
    const failure = workers.find((result) => result.status === 'rejected')
    if (failure) throw failure.reason
    let index = 0
    const lines = ['#EXTM3U']
    for (const raw of document.text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line === '#EXTM3U') continue
      if (/^#EXTINF:\d+(?:\.\d+)?(?:,.*)?$/.test(line)) lines.push(line.replace(/,.*/, ','))
      else if (/^#EXT-X-(?:VERSION|TARGETDURATION|MEDIA-SEQUENCE|DISCONTINUITY-SEQUENCE):\d+$/.test(line) || /^#EXT-X-(?:DISCONTINUITY|ENDLIST)$/.test(line)) lines.push(line)
      else if (!line.startsWith('#')) {
        if (index >= hls.segments.length) throw new Error('Altyazı oynatma listesi tutarsız.')
        lines.push(`${path.basename(directory)}/${index++}.vtt`)
      }
    }
    if (index !== hls.segments.length) throw new Error('Altyazı oynatma listesi eksik.')
    const localPlaylist = `${target}.m3u8`
    await write(localPlaylist, lines.join('\n') + '\n')
    return localPlaylist
  } catch (error) {
    controller.abort()
    await cleanupSubtitle(target)
    throw error
  } finally { clearTimeout(timeout) }
}

module.exports = { fetchSubtitle, cleanupSubtitle }
