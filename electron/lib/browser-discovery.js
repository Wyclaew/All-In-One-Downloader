'use strict'

// Serialized into the untrusted page. It has no Node or IPC access and only
// offers bounded data to the normal candidate verifier.
function installDiscovery() {
  if (window.__aioDiscoveryV2) return
  window.__aioDiscoveryV2 = true
  const seen = new Set()
  let budget = 12000, reads = 0, walking = false
  const media = /\.(m3u8|mpd|mp4|webm|m4v|mkv|mov|flv|mp3|m4a)([?#]|$)/i
  const offer = (url, kind) => {
    try {
      const abs = new URL(url, location.href).href
      if (!/^https?:/.test(abs) || seen.has(abs) || seen.size >= 160) return
      seen.add(abs)
      const output = window.__aioSeen || (window.__aioSeen = [])
      if (output.length < 200) output.push({ url: abs, kind, from: 'browser-discovery' })
    } catch {}
  }
  const walk = (value, context = '', depth = 0) => {
    if (--budget <= 0 || depth > 10 || !value) return
    if (typeof value === 'string') {
      if (value.length < 16000 && (media.test(value) || /sources?|file|manifest|playback|hls|dash/i.test(context)) && (/^(https?:|\/|\.\.?\/)/i.test(value) || media.test(value) && !/\s/.test(value))) offer(value)
      return
    }
    if (Array.isArray(value)) { value.slice(0, 100).forEach((v) => walk(v, context, depth + 1)); return }
    if (typeof value !== 'object') return
    const type = String(value.type || value.mimeType || '')
    for (const [key, entry] of Object.entries(value).slice(0, 100)) {
      if (/^(ads?|advertising|related|recommendations|images?|thumbnails?|poster)$/i.test(key)) continue
      if (typeof entry === 'string' && /^(file|src|url|hls|dash|manifest)$/i.test(key) && /mpegurl|dash|^video\//i.test(type)) offer(entry, /dash/i.test(type) ? 'dash' : /mpegurl/i.test(type) ? 'hls' : 'file')
      walk(entry, context + '.' + key, depth + 1)
    }
  }
  const scan = (text, url = '') => {
    if (typeof text !== 'string' || text.length > 2 * 1024 * 1024 || budget <= 0) return
    const clean = text.replace(/\\\//g, '/').replace(/\\u0026/gi, '&')
    if (/^\s*#EXTM3U/.test(clean)) offer(url, 'hls')
    if (/<(?:[\w.-]+:)?MPD(?:\s|>)/.test(clean.slice(0, 1000))) offer(url, 'dash')
    for (const m of clean.matchAll(/https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mpd|mp4|webm)(?:\?[^\s"'<>\\]*)?/gi)) offer(m[0])
    for (const m of clean.matchAll(/(?:file|src|hls|dash|manifest)["']?\s*:\s*["']((?:https?:|\/)[^"']+)["']/gi)) offer(m[1])
  }
  const originalParse = JSON.parse
  JSON.parse = function () {
    const value = originalParse.apply(this, arguments)
    if (!walking && budget > 0) { walking = true; try { walk(value) } catch {} finally { walking = false } }
    return value
  }
  const originalAtob = window.atob
  if (originalAtob) window.atob = function () { const value = originalAtob.apply(this, arguments); try { scan(value) } catch {} return value }
  const originalFetch = window.fetch
  if (originalFetch) window.fetch = function () {
    const pending = originalFetch.apply(this, arguments)
    pending.then(async (response) => {
      if (reads >= 16 || budget <= 0 || Number(response.headers.get('content-length')) > 512 * 1024) return
      reads += 1
      let reader
      try {
        reader = response.clone().body.getReader()
        const decoder = new TextDecoder()
        let text = '', bytes = 0
        while (bytes <= 512 * 1024) {
          const part = await reader.read()
          if (part.done) break
          bytes += part.value.byteLength
          text += decoder.decode(part.value, { stream: true })
        }
        if (bytes <= 512 * 1024) {
          scan(text, response.url)
          try { walk(originalParse(text), 'response') } catch {}
        }
      } catch {} finally { try { reader?.cancel().catch(() => {}) } catch {} }
    }).catch(() => {})
    return pending
  }
  const originalOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function () {
    this.addEventListener('load', () => {
      try {
        if (this.responseType === 'json') walk(this.response, 'response')
        else if (!this.responseType || this.responseType === 'text') {
          scan(this.responseText, this.responseURL)
          try { walk(originalParse(this.responseText), 'response') } catch {}
        }
      } catch {}
    }, { once: true })
    return originalOpen.apply(this, arguments)
  }
  try { performance.getEntriesByType('resource').filter((e) => media.test(e.name)).slice(-80).forEach((e) => offer(e.name)) } catch {}
  const sweep = () => {
    try {
      Array.from(document.querySelectorAll('video,video source,audio')).slice(0, 80).forEach((v) => {
        if (v.currentSrc && !v.currentSrc.startsWith('blob:')) offer(v.currentSrc)
        if (v.src && !v.src.startsWith('blob:')) offer(v.src)
        // Values from a loaded media element supplement an independently
        // verified source. A blob URL itself is never offered as a download.
        if (v.readyState >= 1 && !v.closest('.video-ads,.jw-flag-ads,.vjs-ad-playing,.ad-showing')) {
          const src = v.currentSrc || v.src || ''
          if (!/^(?:https?:|blob:)/i.test(src)) return
          const output = window.__aioSeen || (window.__aioSeen = [])
          if (output.length < 200) output.push({
            url: /^https?:/i.test(src) ? src : null,
            playerMetadata: { duration: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null,
              width: v.videoWidth || null, height: v.videoHeight || null, src },
            from: 'media-element',
          })
        }
      })
      document.querySelectorAll('script[type="application/json"],script#__NEXT_DATA__,script#__NUXT_DATA__').forEach((s) => {
        if (s.textContent.length < 512 * 1024) { try { walk(originalParse(s.textContent), 'state') } catch {} }
      })
    } catch {}
  }
  sweep()
  const timer = setInterval(sweep, 1800)
  setTimeout(() => clearInterval(timer), 60000)
}

function discoverFrames() {
  const urls = []
  try {
    document.querySelectorAll('iframe[src],iframe[data-src],embed[src],object[data]').forEach((el) => {
      for (const raw of [el.getAttribute('src'), el.dataset.src, el.data]) {
        if (!raw) continue
        try { const url = new URL(raw, location.href); if (/^https?:$/.test(url.protocol)) { urls.push(url.href); break } } catch {}
      }
    })
  } catch {}
  return [...new Set(urls)].slice(0, 20)
}

function selectAlternative(preferred) {
  try {
    const tried = window.__aioTriedPlayers || (window.__aioTriedPlayers = new Set())
    if (tried.size >= 6) return null
    const selector = '#playeroptions li, .player-options [data-post], .player-options [data-player], .player-options button, .video-sources a, .video-sources button, [data-player][data-source], .sources-list [data-id], [role="tab"][aria-controls*="player"]'
    const options = [...document.querySelectorAll(selector)].filter((el) => {
      const text = (el.textContent || '').trim()
      if (el.offsetParent === null || el.disabled || /giriş|üye|sign.?in|log.?in|subscribe|satın|register|download|indir/i.test(text)) return false
      const href = el.getAttribute('href')
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) return false
      return !tried.has(el.outerHTML.slice(0, 500))
    })
    const score = (el) => preferred === 'tr' ? /dublaj|türkçe|turkish/i.test(el.textContent) ? 2 : 0 : /altyaz|orijinal|original|english|\ben\b/i.test(el.textContent) ? 2 : 0
    options.sort((a, b) => score(b) - score(a))
    const el = options[0]
    if (!el) return null
    tried.add(el.outerHTML.slice(0, 500)); el.click()
    return (el.textContent || 'alternatif oynatıcı').trim().slice(0, 60)
  } catch { return null }
}

module.exports = {
  DISCOVERY_SCRIPT: `(${installDiscovery.toString()})()`,
  FRAME_SCRIPT: `(${discoverFrames.toString()})()`,
  alternativeScript: (preferred) => `(${selectAlternative.toString()})(${JSON.stringify(preferred || 'en')})`,
}
