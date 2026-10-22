'use strict'

const { languageCode } = require('./media-preferences')

function normaliseTrack(track, baseUrl) {
  if (!track || !track.url || /thumb|chapter|metadata/i.test(track.kind || '')) return null
  let url
  try { url = new URL(track.url, baseUrl).href } catch { return null }
  if (!/^https?:\/\//i.test(url)) return null
  const label = String(track.name || '')
  let lang = languageCode(track.lang)
  if (!lang || lang === 'und') {
    if (/türkçe|turkce|turkish|\btr\b/i.test(label)) lang = 'tr'
    else if (/english|ingilizce|\ben\b/i.test(label)) lang = 'en'
    else lang = (new URL(url).pathname.match(/(?:^|[./_-])(tr|en|tur|eng)(?=[./_-]|$)/i) || [])[1] || ''
  }
  return { url, lang: languageCode(lang), name: label, forced: track.forced === true || /(?:^|\W)(?:forced|zorunlu)(?:\W|$)/i.test(label), referer: baseUrl }
}

function collectTextTracks(text, baseUrl) {
  const found = []
  const input = String(text).replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  for (const tag of input.matchAll(/<track\b[^>]+>/gi)) {
    const attr = (name) => (tag[0].match(new RegExp(`\\b(?:${name})\\s*=\\s*["']([^"']*)["']`, 'i')) || [])[1] || ''
    found.push(normaliseTrack({ url: attr('src'), lang: attr('srclang'), name: attr('label'), kind: attr('kind') }, baseUrl))
  }
  for (const block of input.matchAll(/\{[^{}]{0,3000}\}/g)) {
    const attr = (name) => (block[0].match(new RegExp(`\\b(?:${name})["']?\\s*:\\s*["']([^"']*)["']`, 'i')) || [])[1] || ''
    const url = attr('file|src|url')
    const kind = attr('kind|type')
    if (!/\.(vtt|srt|ass|ssa)(?:[?#]|$)/i.test(url) && !/^(captions|subtitles)$/i.test(kind)) continue
    found.push(normaliseTrack({ url, name: attr('label|name'), lang: attr('srclang|language|lang'), kind }, baseUrl))
  }
  return mergeTextTracks(found)
}

function mergeTextTracks(...lists) {
  const seen = new Set()
  return lists.flat().filter((t) => {
    if (!t?.url || seen.has(t.url)) return false
    seen.add(t.url); return true
  })
}

// Read the player's declared captions, even if the subtitle is never requested
// by its default playback language. This runs in the page's isolated browser.
const PAGE_TEXT_TRACKS = `(() => {
  const tracks = [];
  const take = (t) => { if (t) tracks.push({ url: t.file || t.src || t.url, lang: t.srclang || t.language || t.lang, name: t.label || t.name, kind: t.kind || t.type, forced: t.forced === true }); };
  try { document.querySelectorAll('track').forEach(take); } catch {}
  try { (window.jwplayer?.()?.getPlaylist?.() || []).forEach(p => (p.tracks || []).forEach(take)); } catch {}
  try {
    const players = window.videojs?.getPlayers?.() || {};
    Object.values(players).forEach(p => { const ts = p.remoteTextTrackEls?.() || []; for (let i=0;i<ts.length;i++) take(ts[i]); });
  } catch {}
  try { (window.plyr?.source?.tracks || []).forEach(take); } catch {}
  return tracks.slice(0, 40);
})()`

module.exports = { normaliseTrack, collectTextTracks, mergeTextTracks, PAGE_TEXT_TRACKS }
