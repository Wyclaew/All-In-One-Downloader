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

export function mergeProgress(download: Download, live?: ProgressEvent): Download {
  if (!live || live.status !== download.status || live.attempt !== (download.attempts || 0) ||
      (live.sequence || 0) < (download.progressSequence || 0)) return download
  if (['processing', 'merging'].includes(download.stage || '') && live.stage === 'downloading') return download
  return { ...download, ...live, id: download.id, parts: live.parts ?? null }
}
