'use strict'

// Reports are shareable: no query strings, credentials, cookies or full media
// addresses. The last 60 human-readable events are sufficient to follow a scan.
function safeUrl(raw) {
  try { const u = new URL(raw); return `${u.protocol}//${u.host}/…` } catch { return '[adres]' }
}
function redact(value) {
  return String(value || '').replace(/(?:https?|socks5h?|socks4a?):\/\/[^\s<>"']+/gi, safeUrl)
    .replace(/(?:authorization|cookie)\s*[:=][^\r\n]*/gi, '[gizlendi]')
    .replace(/(?:authorization|cookie|password|parola|token|signature|secret)\s*[:=]\s*[^\s,;]+/gi, '[gizlendi]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/g, '[gizlendi]')
    .slice(0, 1500)
}
function addEvent(source, stage, message, level = 'info') {
  const text = redact(message)
  const events = Array.isArray(source.events) ? source.events : []
  const previous = events.at(-1)
  if (previous?.message === text && previous.stage === stage) return
  source.events = [...events, { at: Date.now(), stage, message: text, level }].slice(-60)
}
function report(source, items, downloads, version) {
  return JSON.stringify({
    app: 'All in One Downloader', version, platform: process.platform,
    source: { site: source.site, status: source.status, stage: source.stage,
      error: redact(source.error), attempts: source.attempts || 0, resolvedBy: source.resolvedBy,
      elapsedMs: source.elapsedMs || null, network: source.network || { kind: source.useProxy ? 'proxy' : 'direct' } },
    events: (source.events || []).map((e) => ({ ...e, message: redact(e.message) })),
    media: items.map((i) => ({ host: (() => { try { return new URL(i.url).hostname } catch { return '' } })(),
      kind: i.resolved?.kind || i.ext, duration: i.duration, durationSource: i.durationSource || null,
      height: i.height, bytes: i.filesize, estimated: !!i.filesizeEstimated,
      filesizeSource: i.filesizeSource || null, live: i.isLive ?? null, drm: !!i.drm,
      metadataStatus: i.metadataStatus || null })),
    downloads: downloads.map((d) => ({ status: d.status, stage: d.stage,
      attempts: d.attempts, recoveryCount: d.recoveryCount || 0, error: redact(d.error) })),
  }, null, 2)
}
module.exports = { redact, addEvent, report }
