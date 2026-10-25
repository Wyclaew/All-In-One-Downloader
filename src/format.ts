/** Every number the user sees goes through here, so units stay consistent. */

export const DASH = '–'

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return DASH
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function bytes(n: number | null | undefined, digits?: number): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return DASH
  if (n < 1024) return `${Math.round(n)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const d = digits ?? (value < 10 ? 1 : 0)
  return `${value.toFixed(d)} ${units[unit]}`
}

export function speed(bytesPerSecond: number | null | undefined): string {
  if (!bytesPerSecond || !Number.isFinite(bytesPerSecond)) return DASH
  return `${bytes(bytesPerSecond)}/s`
}

/** Remaining time, phrased the way a person would say it. */
export function eta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return DASH
  const total = Math.round(seconds)
  if (total < 60) return `${total} sn`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return s ? `${m} dk ${String(s).padStart(2, '0')} sn` : `${m} dk`
  const h = Math.floor(m / 60)
  const rm = m % 60
  if (h < 24) return rm ? `${h} sa ${String(rm).padStart(2, '0')} dk` : `${h} sa`
  const d = Math.floor(h / 24)
  return `${d} gün ${h % 24} sa`
}

export function percent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return DASH
  const v = Math.max(0, Math.min(1, fraction)) * 100
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`
}

export function relativeTime(ts: number | null | undefined): string {
  if (!ts) return DASH
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'az önce'
  if (min < 60) return `${min} dk önce`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} sa önce`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} gün önce`
  return new Date(ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function qualityLabel(height: number | null | undefined): string {
  if (!height) return DASH
  if (height >= 2160) return '4K'
  if (height >= 1440) return '1440p'
  return `${height}p`
}

/** Trim a long path to something that fits on one line. */
export function shortPath(p: string | null | undefined, max = 52): string {
  if (!p) return DASH
  if (p.length <= max) return p
  const parts = p.split(/[/\\]/)
  const file = parts.pop() || ''
  return `…/${file.length > max ? `${file.slice(0, max - 1)}…` : file}`
}
/** Human labels for requested and detected audio; unknown is never English. */
export function audioLanguage(value?: string | null): string {
  const code = String(value || '').trim().toLowerCase().split(/[-_]/)[0]
  const names: Record<string, string> = { tr: 'Türkçe', tur: 'Türkçe', en: 'İngilizce', eng: 'İngilizce', auto: 'Kaynağın sesi', und: 'dil doğrulanmadı', '': 'dil doğrulanmadı' }
  return names[code] || value || 'dil doğrulanmadı'
}
