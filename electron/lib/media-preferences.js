'use strict'

function languageCode(value) {
  const code = String(value || '').trim().toLowerCase().replace(/\u0307/g, '').split(/[-_]/)[0]
  if (!code || ['und', 'unknown', 'mul', 'zxx'].includes(code)) return ''
  return ({ eng: 'en', english: 'en', ingilizce: 'en', tur: 'tr', türkçe: 'tr', turkish: 'tr' })[code] || code
}

// An explicit preferred audio track wins over an unlabelled/default dub.
// Unknown tracks remain a fallback; never claim to know an untagged language.
function formatSelector(download, settings = {}) {
  const lang = languageCode(download.preferredAudioLanguage ?? settings.preferredAudioLanguage ?? 'en')
  const h = Number(download.quality) || 0
  // Bare HLS media playlists may omit height entirely. Accept those without
  // reopening an uncapped fallback that could select a known over-limit video.
  const cap = h ? `[height<=?${h}]` : ''
  const preferred = lang && lang !== 'auto'
    ? download.audioOnly ? [`ba[language^=${lang}]`, `b[language^=${lang}]`]
      : [`bv${cap}+ba[language^=${lang}]`, `b${cap}[language^=${lang}]`]
    : []
  return [...preferred, ...(download.audioOnly ? ['ba', 'b'] : [`bv*${cap}+ba`, `b${cap}`])].join('/')
}

function rankCandidates(candidates, preferred = 'en') {
  const lang = languageCode(preferred)
  const score = (c) => {
    const languages = (c.info?.audioTracks || []).map((t) => languageCode(t.lang)).filter((l) => l && l !== 'und')
    const single = languageCode(c.language || c.info?.language)
    if (single && single !== 'auto') languages.push(single)
    return !lang || lang === 'auto' ? 0 : languages.includes(lang) ? 2 : languages.some(Boolean) ? -1 : 0
  }
  return [...candidates].sort((a, b) => score(b) - score(a))
}

module.exports = { languageCode, formatSelector, rankCandidates }
