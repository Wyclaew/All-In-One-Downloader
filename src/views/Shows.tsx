import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Btn, Empty } from '../components/ui'
import type { ShowSummary } from '../types'

const code = (season: number, episode: number) =>
  `S${String(season).padStart(2, '0')}B${String(episode).padStart(2, '0')}`

/**
 * What the library has of each series against what has actually aired. It only
 * reads: finding a missing episode stays in the user's hands, on Sources.
 */
export default function Shows({ onToast }: { onToast: (text: string, tone?: 'info' | 'ok' | 'warn' | 'error') => void }) {
  const [shows, setShows] = useState<ShowSummary[] | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    const result = await api.showsRefresh()
    setBusy(false)
    if (!result) return
    setShows(result.shows)
    if (result.failures.length) onToast(result.failures[0], 'warn')
  }, [onToast])

  useEffect(() => {
    api.showsList().then((list) => {
      if (!list) return
      setShows(list)
      if (list.some((s) => !s.checked)) void refresh()
    })
  }, [refresh])

  if (shows && !shows.length) {
    return (
      <Empty
        icon="film"
        title="Takip edilecek dizi yok"
        body="Kitaplıkta videolara dizi adı, sezon ve bölüm verdiğinde burada listelenir."
      />
    )
  }

  return (
    <div className="shows">
      <div className="shows-bar">
        <Btn size="sm" icon="refresh" spinning={busy} disabled={busy} onClick={refresh}>
          Bölümleri güncelle
        </Btn>
      </div>
      {(shows || []).map((show) => (
        <ShowCard key={show.key} show={show} onChange={setShows} />
      ))}
    </div>
  )
}

function ShowCard({ show, onChange }: { show: ShowSummary; onChange: (list: ShowSummary[]) => void }) {
  const [editing, setEditing] = useState(false)
  const [query, setQuery] = useState(show.query)
  const [busy, setBusy] = useState(false)
  const missing = show.seasons.reduce((sum, s) => sum + s.missing.length, 0)

  async function rematch() {
    setBusy(true)
    const list = await api.showsRematch({ name: show.name, query })
    setBusy(false)
    if (!list) return
    onChange(list)
    setEditing(false)
  }

  return (
    <section className="show-card">
      <header>
        <div>
          <h3>{show.name}</h3>
          <p className="show-meta">
            {show.matched
              ? `${show.show?.name} · ${show.owned} bölüm var · ${missing ? `${missing} eksik` : 'eksik yok'}`
              : show.checked ? "TVmaze'de bulunamadı" : 'Henüz kontrol edilmedi'}
            {show.unnumbered ? ` · ${show.unnumbered} numarasız video` : ''}
          </p>
          {show.next ? (
            <p className="show-meta">
              Sıradaki: {code(show.next.season, show.next.episode)} · {show.next.airdate}
            </p>
          ) : null}
        </div>
        <Btn size="sm" variant="ghost" onClick={() => setEditing(!editing)}>
          {show.matched ? 'Yanlış dizi mi?' : 'Elle ara'}
        </Btn>
      </header>
      {editing ? (
        <div className="show-rematch">
          <input className="input" aria-label="TVmaze'de aranacak ad" value={query} onChange={(e) => setQuery(e.target.value)} />
          <Btn size="sm" disabled={busy || !query.trim()} onClick={rematch}>Ara</Btn>
        </div>
      ) : null}
      {show.seasons.map((season) => (
        <details key={season.season} className="show-season">
          <summary>
            {season.season}. sezon · {season.have}/{season.total}
          </summary>
          {season.missing.length ? (
            <ul>
              {season.missing.map((e) => (
                <li key={e.episode}>
                  {code(season.season, e.episode)} · {e.name || 'Adsız bölüm'} · {e.airdate}
                </li>
              ))}
            </ul>
          ) : (
            <p className="show-meta">Bu sezonda eksik bölüm yok.</p>
          )}
        </details>
      ))}
    </section>
  )
}
