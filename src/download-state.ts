import type { Download, MediaItem, ProgressEvent } from './types'

const titleKey = (title: string) => title.replace(/ · akış \d+$/, '').trim()
export function mediaPreferenceKey(item: MediaItem): string {
  return item.resolved?.pageUrl ? item.sourceId + '|' + item.resolved.pageUrl + '|' + titleKey(item.title) : item.sourceId + '|' + item.url
}
export function downloadForItem(item: MediaItem, downloads: Download[]): Download | null {
  const matches = downloads.filter((d) => {
    if (d.sourceId && d.sourceId !== item.sourceId) return false
    if (d.itemId === item.id || item.downloadId === d.id) return true
    if (d.url === item.url || d.originalUrl === item.url) return true
    return !!d.resolved?.pageUrl && d.resolved.pageUrl === item.resolved?.pageUrl &&
      d.resolved.kind === item.resolved.kind && titleKey(d.title) === titleKey(item.title)
  })
  const active = (d: Download) => ['running', 'queued', 'paused'].includes(d.status) ? 1 : 0
  matches.sort((a, b) => active(b) - active(a) || b.createdAt - a.createdAt)
  return matches[0] || null
}

/** Build once per update instead of scanning the entire library per row. */
export function indexDownloads(downloads: Download[]) {
  const byId = new Map(downloads.map((download) => [download.id, download]))
  const byItem = new Map<string, Download[]>(), byUrl = new Map<string, Download[]>(), byPage = new Map<string, Download[]>()
  const add = (map: Map<string, Download[]>, key: string, download: Download) => {
    const list = map.get(key); if (list) list.push(download); else map.set(key, [download])
  }
  for (const d of downloads) {
    if (d.itemId) add(byItem, d.itemId, d)
    for (const url of new Set([d.url, d.originalUrl].filter(Boolean))) add(byUrl, (d.sourceId || '') + '|' + url, d)
    if (d.resolved?.pageUrl) add(byPage, (d.sourceId || '') + '|' + d.resolved.pageUrl + '|' + d.resolved.kind + '|' + titleKey(d.title), d)
  }
  return (item: MediaItem) => downloadForItem(item, [...new Set([
    ...(item.downloadId && byId.has(item.downloadId) ? [byId.get(item.downloadId)!] : []),
    ...(byItem.get(item.id) || []), ...(byUrl.get(item.sourceId + '|' + item.url) || []), ...(byUrl.get('|' + item.url) || []),
    ...(item.resolved?.pageUrl ? byPage.get(item.sourceId + '|' + item.resolved.pageUrl + '|' + item.resolved.kind + '|' + titleKey(item.title)) || [] : []),
  ])])
}

export function mergeProgress(download: Download, live?: ProgressEvent): Download {
  if (!live || live.status !== download.status || live.attempt !== (download.attempts || 0) ||
      (live.sequence || 0) < (download.progressSequence || 0)) return download
  if (['processing', 'merging'].includes(download.stage || '') && live.stage === 'downloading') return download
  return { ...download, ...live, id: download.id, parts: live.parts ?? null }
}
