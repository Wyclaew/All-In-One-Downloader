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
