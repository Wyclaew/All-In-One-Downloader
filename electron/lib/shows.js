'use strict'

// Episode tracking for the series in the library.
//
// The library already knows which series, season and episode each download is.
// TVmaze (free, no key) supplies what the library cannot: the full episode list,
// so we can say what is missing and when the next one airs. Only the series name
// leaves the machine. Nothing here starts a download.

const REFRESH_MS = 12 * 60 * 60 * 1000
const RETRY_UNMATCHED_MS = 7 * 24 * 60 * 60 * 1000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const MAX_NAME = 160
const API = 'https://api.tvmaze.com/singlesearch/shows'

const showKey = (name) => String(name || '').normalize('NFKC').toLocaleLowerCase('tr').replace(/\s+/g, ' ').trim()
const episodeKey = (season, episode) => `${season}:${episode}`

function localDate(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function validName(name) {
  if (typeof name !== 'string') return null
  const clean = name.trim().replace(/\s+/g, ' ')
  return clean && clean.length <= MAX_NAME && !/[\x00-\x1f]/.test(clean) ? clean : null
}

/** Keep the fields we use; anything from the network is checked before it is stored. */
function parseShow(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.id)) return null
  const list = raw._embedded && Array.isArray(raw._embedded.episodes) ? raw._embedded.episodes : []
  return {
    id: raw.id,
    name: String(raw.name || ''),
    status: String(raw.status || ''),
    episodes: list
      .filter((e) => e && Number.isInteger(e.season) && Number.isInteger(e.number))
      .map((e) => ({
        season: e.season,
        episode: e.number,
        name: String(e.name || ''),
        airdate: /^\d{4}-\d{2}-\d{2}$/.test(e.airdate || '') ? e.airdate : null,
      })),
  }
}

function createShows({ getDownloads, getCache, updateCache, fetchImpl, now = Date.now, notify = () => {} }) {
  /** Series in the library, by key, with the episodes actually on disk. */
  function librarySeries() {
    const series = new Map()
    for (const d of getDownloads()) {
      const name = validName(d.series)
      if (!name || d.status !== 'done' || d.missing) continue
      const key = showKey(name)
      if (!series.has(key)) series.set(key, { name, owned: new Set(), unnumbered: 0 })
      const entry = series.get(key)
      if (Number.isInteger(d.season) && Number.isInteger(d.episode)) entry.owned.add(episodeKey(d.season, d.episode))
      else entry.unnumbered += 1
    }
    return series
  }

  function summarize({ name, owned, unnumbered }, cached, today) {
    const base = { key: showKey(name), name, unnumbered, owned: owned.size, query: cached?.query || name }
    if (!cached || !cached.show) return { ...base, matched: false, checked: !!cached, seasons: [], next: null }
    const seasons = new Map()
    let next = null
    for (const e of cached.show.episodes) {
      const have = owned.has(episodeKey(e.season, e.episode))
      const aired = !!e.airdate && e.airdate <= today
      if (!seasons.has(e.season)) seasons.set(e.season, { season: e.season, total: 0, have: 0, missing: [] })
      const season = seasons.get(e.season)
      if (aired || have) season.total += 1
      if (have) season.have += 1
      else if (aired) season.missing.push({ episode: e.episode, name: e.name, airdate: e.airdate })
      if (!aired && e.airdate && (!next || e.airdate < next.airdate)) next = e
    }
    return {
      ...base,
      matched: true,
      checked: true,
      show: { id: cached.show.id, name: cached.show.name, status: cached.show.status },
      seasons: [...seasons.values()].sort((a, b) => a.season - b.season),
      next,
    }
  }

  function overview() {
    const cache = getCache()
    const today = localDate(now())
    return [...librarySeries().entries()]
      .map(([key, entry]) => summarize(entry, cache[key], today))
      .sort((a, b) => a.name.localeCompare(b.name, 'tr', { numeric: true }))
  }

  async function lookup(query) {
    const url = `${API}?q=${encodeURIComponent(query)}&embed=episodes`
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(20000) })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`TVmaze yanıt vermedi (${response.status}).`)
    return parseShow(await response.json())
  }

  /** Newly aired episodes we do not own; the first look at a show only sets the baseline. */
  function announce(entry, show, seenThrough, today) {
    if (!seenThrough) return
    const fresh = show.episodes.filter((e) => e.airdate && e.airdate > seenThrough && e.airdate <= today &&
      !entry.owned.has(episodeKey(e.season, e.episode)))
    if (!fresh.length) return
    const first = fresh[0]
    const label = `S${String(first.season).padStart(2, '0')}B${String(first.episode).padStart(2, '0')}`
    notify(show.name, fresh.length === 1 ? `Yeni bölüm: ${label}` : `${fresh.length} yeni bölüm, ilki ${label}`)
  }

  async function refreshOne(key, entry, query) {
    const previous = getCache()[key]
    const today = localDate(now())
    const show = await lookup(query)
    if (show) announce(entry, show, previous?.seenThrough, today)
    updateCache(key, { query, show, fetchedAt: now(), seenThrough: show ? today : previous?.seenThrough || null })
  }

  async function refresh({ force = false } = {}) {
    const failures = []
    for (const [key, entry] of librarySeries()) {
      const cached = getCache()[key]
      const age = cached ? now() - cached.fetchedAt : Infinity
      if (!force && age < (cached?.show ? REFRESH_MS : RETRY_UNMATCHED_MS)) continue
      try {
        await refreshOne(key, entry, cached?.query || entry.name)
      } catch (err) {
        failures.push(`${entry.name}: ${err.message}`)
      }
    }
    return { shows: overview(), failures }
  }

  /** The automatic match was wrong: search again under a name the user typed. */
  async function rematch({ name, query } = {}) {
    const cleanName = validName(name), cleanQuery = validName(query)
    if (!cleanName || !cleanQuery) throw new Error('Aranacak dizi adını yaz.')
    const key = showKey(cleanName)
    const entry = librarySeries().get(key)
    if (!entry) throw new Error('Bu dizi artık kitaplıkta değil.')
    const show = await lookup(cleanQuery)
    if (!show) throw new Error(`"${cleanQuery}" TVmaze'de bulunamadı.`)
    updateCache(key, { query: cleanQuery, show, fetchedAt: now(), seenThrough: localDate(now()) })
    return overview()
  }

  return { overview, refresh, rematch, CHECK_INTERVAL_MS }
}

module.exports = { createShows, showKey, parseShow, CHECK_INTERVAL_MS }
