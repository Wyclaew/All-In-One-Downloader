import { T } from './strings'

/** One string encodes both the height cap and the audio-only switch. */
export const QUALITY_OPTIONS = [
  { value: 'best', label: T.quality.best },
  { value: '2160', label: '2160p' },
  { value: '1440', label: '1440p' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p' },
  { value: '480', label: '480p' },
  { value: 'audio', label: T.quality.audio },
] as const

export type QualityValue = (typeof QUALITY_OPTIONS)[number]['value']

export function toRequest(value: string): { quality: number; audioOnly: boolean } {
  if (value === 'audio') return { quality: 0, audioOnly: true }
  if (value === 'best') return { quality: 0, audioOnly: false }
  return { quality: Number(value) || 0, audioOnly: false }
}

export function fromDefault(defaultQuality: number): string {
  return defaultQuality ? String(defaultQuality) : 'best'
}

export function describe(quality: number, audioOnly: boolean): string {
  if (audioOnly) return 'ses'
  return quality ? `${quality}p` : 'en iyi'
}

/**
 * Bytes this item would cost at the quality currently chosen for it.
 *
 * The size of a video is not one number: it depends on which rendition is taken,
 * which is exactly what the row's dropdown decides. So the size map is consulted
 * with the same rule the download selector uses — the tallest rendition at or
 * below the cap — and `filesize` is only the fallback for items that never
 * reported a per-quality breakdown.
 */
export function sizeFor(
  item: { sizes?: Record<string, number>; filesize: number | null },
  value: string
): number | null {
  const sizes = item.sizes
  if (sizes) {
    if (value === 'audio') return sizes.audio || null
    const heights = Object.keys(sizes)
      .map(Number)
      .filter((h) => Number.isFinite(h) && h > 0)
      .sort((a, b) => b - a)
    const cap = value === 'best' ? 0 : Number(value) || 0
    const pick = cap ? heights.find((h) => h <= cap) : heights[0]
    if (pick && sizes[pick]) return sizes[pick]
  }
  return value === 'audio' ? null : item.filesize
}
