'use strict'
// New records are shown newest-first but transfers run oldest-first. Explicit
// priority is an ordering value, independent of visible library ordering.
function queuedInOrder(downloads) {
  return downloads.map((download, index) => ({ download, index }))
    .filter(({ download }) => download.status === 'queued')
    .sort((a, b) => (a.download.queueOrder ?? a.download.createdAt ?? 0) - (b.download.queueOrder ?? b.download.createdAt ?? 0) || b.index - a.index)
    .map(({ download }) => download)
}
function nextOrder(downloads) { return downloads.reduce((latest, d) => Number.isFinite(d.queueOrder) ? Math.max(latest, d.queueOrder) : latest, Date.now()) + 1 }
function sameMedia(d, { item, url, sourceId }) {
  const source = sourceId || item?.sourceId
  if (source && d.sourceId && source !== d.sourceId) return false
  if (item && (d.itemId === item.id || item.downloadId === d.id)) return true
  const address = url || item?.url
  if (address && (d.url === address || d.originalUrl === address)) return true
  if (item && source && d.sourceId === source && d.resolved?.pageUrl && item.resolved?.pageUrl === d.resolved.pageUrl) {
    const title = (v) => String(v || '').replace(/ · akış \d+$/, '').trim()
    return title(d.title) === title(item.title) && d.resolved.kind === item.resolved.kind
  }
  return false
}
function activeDuplicate(downloads, { item, url, quality, audioOnly, sourceId, preferredAudioLanguage }) {
  const address = url || item?.url
  return downloads.find((d) => ['queued', 'running', 'paused'].includes(d.status) && sameMedia(d, { item, url: address, sourceId }) && (!(sourceId || item?.sourceId) || d.sourceId === (sourceId || item.sourceId)) && (!preferredAudioLanguage || d.preferredAudioLanguage === preferredAudioLanguage) && d.quality === quality && !!d.audioOnly === !!audioOnly) || null
}
function bringToFront(downloads, id) {
  const queued = queuedInOrder(downloads), item = queued.find((d) => d.id === id)
  if (!item) return false
  queued.splice(queued.indexOf(item), 1); queued.unshift(item)
  const start = Date.now()
  queued.forEach((d, index) => { d.queueOrder = start + index })
  return true
}
module.exports = { sameMedia, queuedInOrder, nextOrder, activeDuplicate, bringToFront }
