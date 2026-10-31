import { useMemo, useState } from 'react'
import { api } from '../api'
import * as fmt from '../format'
import { T } from '../strings'
import { useFileThumb } from '../thumbs'
import type { AppState, Download } from '../types'
import { thumbnailForRoute, Btn, Empty, Icon, Menu, MenuItem, Modal } from '../components/ui'
import SubtitlePicker from '../components/SubtitlePicker'

/**
 * The home page: what you have, as something to watch rather than a list of
 * transfers.
 *
 * The library answers "what is downloading and where did it go". This answers
 * "what shall I watch" — posters taken from the files themselves, the red bar of
 * how far in you are, and one click to play. Only files that are actually on disk
 * appear here; a missing one belongs in the library, where it can be fetched again.
 */

type Sort = 'new' | 'old' | 'name' | 'size' | 'recent'
type Filter = 'all' | 'unwatched' | 'progress' | 'watched'

interface Props {
  state: AppState
  downloads: Download[]
  category: string | null
  query: string
  onToast: (message: string, kind?: 'info' | 'warn' | 'error' | 'ok') => void
  onOpenSettings: () => void
  onGoToSources: () => void
}

export default function Home({ state, downloads, category, query, onToast, onOpenSettings, onGoToSources }: Props) {
  const [sort, setSort] = useState<Sort>('new')
  const [filter, setFilter] = useState<Filter>('all')
  const [collectionFor, setCollectionFor] = useState<Download | null>(null)
  const [collectionName, setCollectionName] = useState('')
  const [savingCollection, setSavingCollection] = useState(false)
  const [subtitleFor, setSubtitleFor] = useState<Download | null>(null)

  const positions = state.positions || {}
  const watched = state.watched || {}

  const playable = useMemo(
    () => downloads.filter((d) => d.status === 'done' && d.filePath && !d.missing),
    [downloads]
  )

  const progressOf = (d: Download) => {
    const p = d.filePath ? positions[`file:${d.filePath}`] : undefined
    return p && p.duration ? Math.min(1, p.at / p.duration) : 0
  }
  const isWatched = (d: Download) => !!(d.filePath && watched[`file:${d.filePath}`])

  const continueRow = useMemo(() => {
    return playable
      .map((d) => ({ d, p: d.filePath ? positions[`file:${d.filePath}`] : undefined }))
      .filter((x) => x.p && x.p.at > 0)
      .sort((a, b) => (b.p?.seen || 0) - (a.p?.seen || 0))
      .slice(0, 12)
      .map((x) => x.d)
  }, [playable, positions])

  const grid = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('tr')
    let list = playable.filter((d) => {
      if (category === '__none__' && d.categoryId) return false
      if (category && category !== '__none__' && d.categoryId !== category) return false
      if (needle && !`${d.title} ${d.site} ${d.series || ''}`.toLocaleLowerCase('tr').includes(needle)) return false
      if (filter === 'watched') return isWatched(d)
      if (filter === 'unwatched') return !isWatched(d) && progressOf(d) === 0
      if (filter === 'progress') return progressOf(d) > 0
      return true
    })
    const seenAt = (d: Download) =>
      (d.filePath && (positions[`file:${d.filePath}`]?.seen || watched[`file:${d.filePath}`])) || 0
    list = [...list].sort((a, b) => {
      if (sort === 'old') return (a.finishedAt || 0) - (b.finishedAt || 0)
      if (sort === 'name') return a.title.localeCompare(b.title, 'tr', { numeric: true })
      if (sort === 'size') return (b.fileSize || 0) - (a.fileSize || 0)
      if (sort === 'recent') return seenAt(b) - seenAt(a)
      return (b.finishedAt || 0) - (a.finishedAt || 0)
    })
    return list
    // isWatched/progressOf read the same maps listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playable, query, category, filter, sort, positions, watched])

  const collections = useMemo(() => {
    const grouped = new Map<string, { name: string; episodes: Download[] }>()
    const entries: { key: string; name?: string; episodes: Download[] }[] = []
    for (const d of grid) {
      if (!state.settings.groupEpisodes || !d.series) { entries.push({ key: d.id, episodes: [d] }); continue }
      const key = d.series.normalize('NFKC').toLocaleLowerCase('tr').trim()
      let group = grouped.get(key)
      if (!group) {
        group = { name: d.series, episodes: [] }; grouped.set(key, group)
        entries.push({ key: `series:${key}`, name: group.name, episodes: group.episodes })
      }
      group.episodes.push(d)
    }
    for (const group of grouped.values()) group.episodes.sort((a, b) =>
      (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || a.title.localeCompare(b.title, 'tr', { numeric: true }))
    return entries
  }, [grid, state.settings.groupEpisodes])

  if (!playable.length) {
    return (
      <Empty
        icon="film"
        title={T.home.emptyTitle}
        body={T.home.emptyBody}
        action={
          <Btn icon="layers" onClick={onGoToSources} style={{ marginTop: 6 }}>
            {T.nav.sources}
          </Btn>
        }
      />
    )
  }

  const cardProps = {
    positions,
    watched,
    vaultEnabled: state.settings.vaultEnabled !== false,
    onSubtitle: (d: Download) => setSubtitleFor(d),
    onToast,
    onCollection: (d: Download) => { setCollectionFor(d); setCollectionName(d.series || '') },
  }

  return (
    <div className="home">
      {continueRow.length && !query.trim() && !category ? (
        <section className="home-section">
          <div className="home-head">
            <h2>{T.home.continue}</h2>
          </div>
          <div className="home-strip">
            {continueRow.map((d) => (
              <Card key={d.id} download={d} wide {...cardProps} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="home-section">
        <div className="home-head">
          <h2>{T.home.all}</h2>
          <span className="count">{grid.length}</span>
          <span className="spacer" />
          <div className="seg" role="tablist">
            {(
              [
                ['all', T.home.filterAll],
                ['unwatched', T.home.filterNew],
                ['progress', T.home.filterProgress],
                ['watched', T.home.filterWatched],
              ] as [Filter, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={filter === value ? 'on' : ''}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <Btn size="sm" variant="ghost" icon="layers" onClick={() => api.updateSettings({ groupEpisodes: !state.settings.groupEpisodes })}>
            {state.settings.groupEpisodes ? 'Bölümler birlikte' : 'Bölümleri grupla'}
          </Btn>
          <select className="select compact" aria-label="Sıralama" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="new">{T.home.sortNew}</option>
            <option value="recent">{T.home.sortRecent}</option>
            <option value="old">{T.home.sortOld}</option>
            <option value="name">{T.home.sortName}</option>
            <option value="size">{T.home.sortSize}</option>
          </select>
        </div>

        {grid.length ? (
          <div className="home-grid">
            {collections.map((group) => group.name ? (
              <details className="series-collection" key={group.key} open={query.trim() ? true : undefined}>
                <summary>
                  <Icon name="layers" size={18} />
                  <span className="grow">{group.name}</span>
                  <span className="count">{group.episodes.length} bölüm</span>
                </summary>
                <div className="home-grid">
                  {group.episodes.map((d) => <Card key={d.id} download={d} {...cardProps} />)}
                </div>
              </details>
            ) : <Card key={group.key} download={group.episodes[0]} {...cardProps} />)}
          </div>
        ) : (
          <p className="home-none">{T.home.none}</p>
        )}
      </section>

      {collectionFor ? (
        <Modal title="Dizi veya koleksiyon" footer={null} onClose={() => setCollectionFor(null)}>
          <p className="hint">Aynı adı verdiğin videolar ana sayfada birlikte görünür. Boş bırakırsan bu video gruptan çıkar.</p>
          <label className="vault-field"><span>Koleksiyon adı</span>
            <input className="input" value={collectionName} autoFocus maxLength={160} onChange={(e) => setCollectionName(e.target.value)} />
          </label>
          <Btn variant="primary" spinning={savingCollection} disabled={savingCollection} onClick={async () => {
            setSavingCollection(true)
            const res = await api.setDownloadSeries(collectionFor.id, collectionName.trim() || null)
            setSavingCollection(false)
            if (res) setCollectionFor(null)
          }}>Kaydet</Btn>
        </Modal>
      ) : null}
      {subtitleFor ? (
        <SubtitlePicker
          download={subtitleFor}
          onClose={() => setSubtitleFor(null)}
          onToast={onToast}
          onOpenSettings={onOpenSettings}
        />
      ) : null}
    </div>
  )
}

function Card({
  download: d,
  wide,
  positions,
  watched,
  vaultEnabled,
  onSubtitle,
  onCollection,
  onToast,
}: {
  download: Download
  wide?: boolean
  positions: Record<string, { at: number; duration: number; seen: number }>
  watched: Record<string, number>
  vaultEnabled: boolean
  onSubtitle: (d: Download) => void
  onCollection: (d: Download) => void
  onToast: (message: string, kind?: 'info' | 'warn' | 'error' | 'ok') => void
}) {
  const local = useFileThumb(d.audioOnly ? null : d.filePath, d.duration)
  const [remoteFailed, setRemoteFailed] = useState(false)
  const key = d.filePath ? `file:${d.filePath}` : ''
  const pos = key ? positions[key] : undefined
  const done = !!(key && watched[key])
  const ratio = pos && pos.duration ? Math.min(1, pos.at / pos.duration) : done ? 1 : 0
  const poster = local || (!remoteFailed ? thumbnailForRoute(d.thumbnail, d.useProxy) : null)

  const play = () => api.playFile(d.filePath as string)

  return (
    <article className={`card-v${wide ? ' wide' : ''}${done ? ' watched' : ''}`}>
      <button type="button" className="card-v-poster" onClick={play} title={T.home.play}>
        {poster ? (
          <img src={poster} alt="" loading="lazy" onError={() => setRemoteFailed(true)} />
        ) : (
          <span className="card-v-fallback">
            <Icon name={d.audioOnly ? 'audio' : 'film'} size={26} />
          </span>
        )}
        <span className="card-v-play" aria-hidden="true">
          <Icon name="play" size={22} />
        </span>
        {d.duration ? <span className="card-v-time">{fmt.duration(d.duration)}</span> : null}
        {done ? <span className="card-v-badge">{T.home.watched}</span> : null}
        {ratio > 0 ? (
          <span className="card-v-bar">
            <span style={{ width: `${ratio * 100}%` }} />
          </span>
        ) : null}
      </button>

      <div className="card-v-body">
        <button type="button" className="card-v-title clamp2" title={d.title} onClick={play}>
          {d.title}
        </button>
        <div className="card-v-meta">
          <span className="truncate">{d.season != null && d.episode != null ? `S${String(d.season).padStart(2, '0')} · B${String(d.episode).padStart(2, '0')}` : d.site || T.library.from}</span>
          {d.audioLanguage ? <span title="Ses dili">{d.audioLanguage.toUpperCase()}</span> : null}
          <span className="sep" />
          <span>{pos ? `kaldığın yer ${fmt.duration(pos.at)}` : fmt.relativeTime(d.finishedAt)}</span>
          {d.subtitleLanguage ? (
            <span className="card-v-cc" title={`${d.subtitleLanguage} altyazı`}>
              <Icon name="captions" size={12} />
            </span>
          ) : null}
        </div>
      </div>

      <div className="card-v-menu">
        <Menu title={T.common.more}>
          {(close) => (
            <>
              <MenuItem
                icon="play"
                onClick={() => {
                  play()
                  close()
                }}
              >
                {pos ? T.home.resume : T.home.play}
              </MenuItem>
              <MenuItem
                icon="folder"
                onClick={() => {
                  api.revealFile(d.filePath as string)
                  close()
                }}
              >
                {T.library.reveal}
              </MenuItem>
              <MenuItem icon="layers" onClick={() => { onCollection(d); close() }}>Dizi / koleksiyon…</MenuItem>
              <MenuItem
                icon="captions"
                onClick={() => {
                  onSubtitle(d)
                  close()
                }}
              >
                {T.subs.find}
              </MenuItem>
              {vaultEnabled ? (
                <MenuItem
                  icon="lock"
                  onClick={async () => {
                    close()
                    onToast(T.library.movingToVault, 'info')
                    const entry = await api.vaultTakeDownload(d.id)
                    if (entry) onToast(T.library.movedToVault, 'ok')
                  }}
                >
                  {T.library.toVault}
                </MenuItem>
              ) : null}
              <MenuItem
                icon="external"
                onClick={() => {
                  api.openFile(d.filePath as string)
                  close()
                }}
              >
                {T.library.openExternal}
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
    </article>
  )
}
