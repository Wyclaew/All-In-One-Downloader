'use strict'

// Library metadata only. Never opens, moves or rewrites a media/vault file.
const crypto = require('node:crypto')
const MAX_ITEMS = 1000
const MAX_EPISODE = 9999
const natural = new Intl.Collator('tr', { numeric: true, sensitivity: 'base' })
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
function metadata(download) {
  return { series: typeof download.series === 'string' && download.series.trim() ? download.series : null,
    season: Number.isInteger(download.season) ? download.season : null,
    episode: Number.isInteger(download.episode) ? download.episode : null }
}
function validateNumber(value, min, max, label) {
  if (value !== null && (!Number.isInteger(value) || value < min || value > max)) throw new Error(`${label} ${min}–${max} arasında bir tam sayı olmalı.`)
}
function createCollectionEditor({ getDownloads, commit, token = () => crypto.randomBytes(16).toString('hex') }) {
  let previous = null
  function preview(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.ids) || !raw.ids.length || raw.ids.length > MAX_ITEMS) throw new Error(`Bir düzenlemede 1–${MAX_ITEMS} video seç.`)
    if (raw.ids.some((id) => typeof id !== 'string' || !id || id.length > 200 || /[\x00-\x1f]/.test(id))) throw new Error('Geçersiz video seçimi. Listeyi yenileyip tekrar dene.')
    const seriesSet = own(raw, 'series') && raw.series !== undefined
    if (seriesSet && raw.series !== null && typeof raw.series !== 'string') throw new Error('Dizi / koleksiyon adını yaz veya boş bırak.')
    const series = !seriesSet || raw.series === null ? null : raw.series.trim().replace(/\s+/g, ' ') || null
    if (series && (series.length > 160 || /[\x00-\x1f]/.test(series))) throw new Error('Koleksiyon adı en çok 160 karakter olabilir.')
    const seasonSet = own(raw, 'season') && raw.season !== undefined
    const episodeSet = own(raw, 'episodeStart') && raw.episodeStart !== undefined
    if (seasonSet) validateNumber(raw.season, 0, 999, 'Sezon')
    if (episodeSet) validateNumber(raw.episodeStart, 1, MAX_EPISODE, 'İlk bölüm')
    const order = raw.order || 'existing'
    if (!['existing', 'title', 'created'].includes(order)) throw new Error('Geçersiz bölüm sıralaması.')
    const records = getDownloads(), byId = new Map(records.map((download) => [download.id, download]))
    const ids = [...new Set(raw.ids)]
    if (ids.some((id) => !byId.has(id))) throw new Error('Seçili videolardan biri artık kitaplıkta değil. Listeyi yenileyip tekrar seç.')
    const stable = (a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0) || natural.compare(String(a.id), String(b.id))
    const list = ids.map((id) => byId.get(id)).sort((a, b) => order === 'title'
      ? natural.compare(String(a.title || ''), String(b.title || '')) || stable(a, b)
      : order === 'created' ? stable(a, b)
        : (Number.isInteger(a.season) ? a.season : Infinity) - (Number.isInteger(b.season) ? b.season : Infinity) ||
          (Number.isInteger(a.episode) ? a.episode : Infinity) - (Number.isInteger(b.episode) ? b.episode : Infinity) || natural.compare(String(a.title || ''), String(b.title || '')) || stable(a, b))
    if (episodeSet && raw.episodeStart !== null && raw.episodeStart + list.length - 1 > MAX_EPISODE) throw new Error(`Son bölüm numarası ${MAX_EPISODE} sınırını aşıyor. Daha küçük bir başlangıç seç.`)
    const rows = list.map((download, index) => {
      const before = metadata(download)
      return { id: download.id, title: String(download.title || ''), before,
        after: { series: seriesSet ? series : before.series, season: seasonSet ? raw.season : before.season,
          episode: episodeSet ? raw.episodeStart === null ? null : raw.episodeStart + index : before.episode } }
    })
    const revision = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')
    return { count: rows.length, rows, revision }
  }
  function apply(raw) {
    const proposed = preview(raw)
    if (typeof raw.revision !== 'string' || raw.revision !== proposed.revision) throw new Error('Önizlemeden sonra koleksiyon bilgileri değişti. Yeniden önizleyip kaydet.')
    const changes = proposed.rows.filter((row) => JSON.stringify(row.before) !== JSON.stringify(row.after))
    if (!changes.length) return { ...proposed, count: 0, undoToken: null }
    const undoToken = token()
    commit(() => {
      const byId = new Map(getDownloads().map((download) => [download.id, download]))
      for (const row of changes) Object.assign(byId.get(row.id), row.after)
    })
    previous = { token: undoToken, rows: changes }
    return { ...proposed, count: changes.length, undoToken }
  }
  function undo(value) {
    if (!previous || typeof value !== 'string' || value !== previous.token) throw new Error('Bu koleksiyon düzenlemesi artık geri alınamıyor.')
    const byId = new Map(getDownloads().map((download) => [download.id, download]))
    if (previous.rows.some((row) => !byId.has(row.id) || JSON.stringify(metadata(byId.get(row.id))) !== JSON.stringify(row.after))) throw new Error('Videoların koleksiyon bilgileri yeniden değişmiş. Eski değerlerin üzerine yazılmadı.')
    const count = previous.rows.length
    commit(() => { for (const row of previous.rows) Object.assign(byId.get(row.id), row.before) })
    previous = null
    return { count }
  }
  return { preview, apply, undo }
}
module.exports = { createCollectionEditor, MAX_ITEMS }
