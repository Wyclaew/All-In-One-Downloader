'use strict'

// Pure playback rules shared by the renderer and regression tests.
;(function (root) {
  function finiteDuration(value) {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? number : null
  }
  function seekTime(value, duration) {
    const end = finiteDuration(duration), at = Number(value)
    return end && Number.isFinite(at) ? Math.max(0, Math.min(end, at)) : null
  }
  function cueIndex(input) {
    const cues = (Array.isArray(input) ? input : [])
      .filter((cue) => cue && Number.isFinite(cue.start) && cue.start >= 0 && Number.isFinite(cue.end) && cue.end > cue.start && typeof cue.text === 'string')
      .map((cue) => ({ start: cue.start, end: cue.end, text: cue.text }))
      .sort((a, b) => a.start - b.start || a.end - b.end)
    const ends = []
    for (const cue of cues) ends.push(Math.max(cue.end, ends.at(-1) || 0))
    return { cues, ends }
  }
  function activeCues(index, time) {
    if (!index || !Number.isFinite(time)) return []
    const { cues, ends } = index
    let low = 0, high = cues.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (cues[mid].start <= time) low = mid + 1
      else high = mid
    }
    const result = []
    for (let i = low - 1; i >= 0 && ends[i] > time; i -= 1) {
      if (cues[i].end > time) result.push({ ...cues[i], index: i })
    }
    return result.reverse()
  }
  function errorInfo(code) {
    if (code === 1) return { message: 'Oynatma kesildi. Aynı konumdan yeniden deneyebilirsin.', retry: true, remux: false }
    if (code === 2) return { message: 'Dosya okunurken bağlantı kesildi. Dosyanın erişilebilir olduğunu kontrol edip yeniden dene.', retry: true, remux: false }
    if (code === 3) return { message: 'Görüntü veya ses çözümlenemedi. Dosya bozuk olabilir ya da kullanılan kodek desteklenmiyor.', retry: true, remux: true }
    if (code === 4) return { message: 'Bu dosyanın kapsayıcısı veya kodeği desteklenmiyor. Hızlı dönüştürme kapsayıcıyı değiştirir; desteklenmeyen kodeği değiştirmez.', retry: true, remux: true }
    return { message: 'Dosya açılamadı. Taşınmış, silinmiş veya bozulmuş olabilir.', retry: true, remux: false }
  }
  function autoAdvance(next, enabled, canceled) {
    // A neighbouring movie in natural filename order is an offer, never an
    // automatically selected next episode.
    return !!(next && next.sure && enabled && !canceled)
  }
  function playbackIssue(sample) {
    if (!sample.playing || !sample.visible || sample.seeking || !sample.ready || sample.error) return null
    if (sample.positionIdleMs >= 6000) return sample.readyState < 3 ? 'buffering' : 'stalled'
    // Low-frame-rate/VFR artwork is not a decoder stall. Frame callbacks are
    // supplementary evidence only; the packet scan can explain source gaps.
    if (!sample.audioOnly && sample.fps >= 5 && sample.frameIdleMs >= 6000) return 'video-stalled'
    return null
  }
  const api = { finiteDuration, seekTime, cueIndex, activeCues, errorInfo, autoAdvance, playbackIssue }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.PlayerCore = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
