'use strict'

function languageCode(value) {
  const code = String(value || '').trim().toLowerCase().replace(/\u0307/g, '').split(/[-_]/)[0]
  if (!code || ['und', 'unknown', 'mul', 'zxx'].includes(code)) return ''
  return ({ eng: 'en', english: 'en', ingilizce: 'en', tur: 'tr', türkçe: 'tr', turkish: 'tr' })[code] || code
}

function originalTrack(track) {
  return /\b(?:original(?: audio)?|orijinal(?: ses)?)\b/i.test(String(track?.name || track?.tags?.title || ''))
}
function trackLanguage(track) {
  const explicit = languageCode(track?.lang || track?.language || track?.tags?.language)
  if (explicit) return explicit
  const name = String(track?.name || track?.tags?.title || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  if (/\b(?:english|eng|ingilizce)\b/.test(name)) return 'en'
  if (/\b(?:turkish|tur|turkce)\b/.test(name)) return 'tr'
  return ''
}
function audioError(preferred, tracks = []) {
  const label = ({ en: 'İngilizce', tr: 'Türkçe', original: 'Orijinal' })[preferred] || preferred
  const names = [...new Set(tracks.map((t) => t.name || trackLanguage(t) || 'etiketsiz ses'))].slice(0, 8).join(', ')
  return Object.assign(new Error(`İstenen ${label} ses kaynakta doğrulanamadı.${names ? ` Mevcut sesler: ${names}.` : ''} Ses seçimini değiştir veya başka bir kaynak dene. Başka dil otomatik indirilmedi.`), { code: 'AUDIO_LANGUAGE_UNAVAILABLE' })
}
function pickAudioTrack(tracks, preferred = 'auto') {
  const lang = languageCode(preferred)
  if (!tracks.length) return null
  if (!lang || lang === 'auto') return tracks.find((t) => t.default) || tracks[0]
  const selected = tracks.find((t) => lang === 'original' ? originalTrack(t) : trackLanguage(t) === lang)
  if (!selected) throw audioError(lang, tracks)
  return selected
}

// An explicit preferred audio track wins over an unlabelled/default dub.
// Non-auto requests are strict; unlabelled original audio is a distinct choice.
function formatSelector(download, settings = {}) {
  const lang = languageCode(download.preferredAudioLanguage ?? settings.preferredAudioLanguage ?? 'en')
  const h = Number(download.quality) || 0
  // Bare HLS media playlists may omit height entirely. Accept those without
  // reopening an uncapped fallback that could select a known over-limit video.
  const cap = h ? `[height<=?${h}]` : ''
  if (lang === 'original') {
    const filters = ['[language$=-orig]', '[format_note*=original]', '[format_note*=Original]']
    return filters.flatMap((filter) => download.audioOnly ? ['ba' + filter, 'b' + filter] : ['bv' + cap + '+ba' + filter, 'b' + cap + filter]).join('/')
  }
  const preferred = lang && lang !== 'auto'
    ? download.audioOnly ? [`ba[language^=${lang}]`, `b[language^=${lang}]`]
      : [`bv${cap}+ba[language^=${lang}]`, `b${cap}[language^=${lang}]`]
    : []
  return preferred.length ? preferred.join('/') : (download.audioOnly ? ['ba', 'b'] : [`bv*${cap}+ba`, `b${cap}`]).join('/')
}

function rankCandidates(candidates, preferred = 'en') {
  const lang = languageCode(preferred)
  const score = (c) => {
    if (lang === 'original' && (c.info?.audioTracks || []).some(originalTrack)) return 2
    const languages = (c.info?.audioTracks || []).map(trackLanguage).filter(Boolean)
    const single = languageCode(c.language || c.info?.language)
    if (single && single !== 'auto') languages.push(single)
    return !lang || lang === 'auto' ? 0 : languages.includes(lang) ? 2 : languages.some(Boolean) ? -1 : 0
  }
  return [...candidates].sort((a, b) => score(b) - score(a))
}

module.exports = { languageCode, formatSelector, rankCandidates, trackLanguage, originalTrack, pickAudioTrack, audioError }
