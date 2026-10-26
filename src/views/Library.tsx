import AudioSelect, { type AudioChoice } from '../components/AudioSelect'
import { type ReactNode, useMemo, useState } from 'react'
import { api } from '../api'
import * as fmt from '../format'
import { describe } from '../quality'
import { T } from '../strings'
import type { AppState, Category, Download, Outlook } from '../types'
import { thumbnailForRoute, Btn, Chip, Empty, Icon, IconBtn, Menu, MenuItem, Meter, Modal, Thumb } from '../components/ui'
import SubtitlePicker from '../components/SubtitlePicker'
import CollectionEditor from '../components/CollectionEditor'
import MediaHealth from '../components/MediaHealth'
import { useFileThumb } from '../thumbs'

const ACTIVE = new Set(['running', 'queued', 'paused'])
const PROBLEM = new Set(['error', 'canceled'])

interface Props {
  state: AppState
  downloads: Download[]
  /** Finish times worked out against the whole queue, not one connection. */
  outlook: Outlook
  category: string | null
  query: string
  onClearFilters: () => void
  onGoToSources: () => void
  onToast: (message: string, kind?: 'info' | 'warn' | 'error' | 'ok') => void
  onOpenSettings: () => void
}

const STAGE_LABEL: Record<string, string> = {
  starting: T.library.stageStarting,
  merging: T.library.stageMerging,
  processing: T.library.stageProcessing,
}

export default function Library({
  state,
  downloads,
  outlook,
  category,
  query,
  onClearFilters,
  onGoToSources,
  onToast,
  onOpenSettings,
}: Props) {
  const [pendingRemove, setPendingRemove] = useState<Download[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [alsoDeleteFile, setAlsoDeleteFile] = useState(false)
  const [subtitleFor, setSubtitleFor] = useState<Download | null>(null)
  const [vaulting, setVaulting] = useState<string | null>(null)
  const [collectionFor, setCollectionFor] = useState<Download[] | null>(null)
  const [collectionUndo, setCollectionUndo] = useState<{ token: string; count: number } | null>(null)
  const [undoingCollection, setUndoingCollection] = useState(false)
  const [checkingMedia, setCheckingMedia] = useState<Download | null>(null)

  // The choice of whether a delete takes the file with it is a setting, not a
  // question to be re-answered every time.
  const deletePolicy = state.settings.deleteFileWithRecord || 'ask'

  const categoryById = useMemo(() => {
    const map = new Map<string, Category>()
    for (const c of state.categories) map.set(c.id, c)
    return map
  }, [state.categories])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return downloads.filter((d) => {
      if (category === '__none__' && d.categoryId) return false
      if (category && category !== '__none__' && d.categoryId !== category) return false
      if (!needle) return true
      const cat = d.categoryId ? categoryById.get(d.categoryId)?.name || '' : ''
      return `${d.title} ${d.site} ${d.series || ''} ${cat}`.toLowerCase().includes(needle)
    })
  }, [downloads, query, category, categoryById])

  const active = filtered.filter((d) => ACTIVE.has(d.status)).sort((a, b) => { const order = { running: 0, queued: 1, paused: 2 } as Record<string, number>; return order[a.status] - order[b.status] || (a.queueOrder ?? a.createdAt) - (b.queueOrder ?? b.createdAt) })
  const missingCount = filtered.filter((d) => d.status === 'done' && d.missing).length
  const done = filtered.filter((d) => d.status === 'done')
  const problems = filtered.filter((d) => PROBLEM.has(d.status))

  if (!downloads.length) {
    return (
      <Empty
        icon="archive"
        title={T.empty.libraryTitle}
        body={T.empty.libraryBody}
        action={
          <Btn icon="layers" onClick={onGoToSources} style={{ marginTop: 6 }}>
            {T.nav.sources}
          </Btn>
        }
      />
    )
  }

  if (!filtered.length && !collectionUndo && !collectionFor && !checkingMedia) {
    return (
      <Empty
        icon="search"
        title={T.empty.filterTitle}
        body={T.empty.filterBody}
        action={
          <Btn icon="x" onClick={onClearFilters} style={{ marginTop: 6 }}>
            {T.common.all}
          </Btn>
        }
      />
    )
  }

  const liveSelected = new Set(filtered.filter((d) => selected.has(d.id)).map((d) => d.id))
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const setMany = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  const askRemove = (list: Download[]) => {
    setAlsoDeleteFile(deletePolicy === 'always' && list.some((d) => !!d.filePath && !d.missing))
    setPendingRemove(list)
  }
  const sectionSelect = (list: Download[]) => {
    const ids = list.map((d) => d.id)
    const all = ids.length > 0 && ids.every((id) => liveSelected.has(id))
    return (
      <label className="dl-check" title={all ? T.library.selectNone : T.library.selectAll}>
        <input type="checkbox" checked={all} onChange={() => setMany(ids, !all)} />
      </label>
    )
  }

  const rowProps = {
    categories: state.categories,
    selected: liveSelected,
    selecting: liveSelected.size > 0,
    onToggle: toggle,
    categoryById,
    vaultingId: vaulting,
    outlook,
    onRemove: (d: Download) => askRemove([d]),
    onFindSubtitle: (d: Download) => setSubtitleFor(d),
    onCollection: (d: Download) => setCollectionFor([d]),
    onCheckMedia: (d: Download) => setCheckingMedia(d),
    onToVault: async (d: Download) => {
      setVaulting(d.id)
      // Encrypting a few gigabytes takes seconds with nothing to show for it, and
      // the row disappears when it lands — so say what is happening up front.
      onToast(T.library.movingToVault, 'info')
      const entry = await api.vaultTakeDownload(d.id)
      setVaulting(null)
      if (entry) onToast(T.library.movedToVault, 'ok')
    },
  }

  const selectedList = filtered.filter((d) => liveSelected.has(d.id))

  return (
    <>
      {collectionUndo ? <div className="bulk-bar collection-undo" role="status">
        <span className="grow">{collectionUndo.count} videonun koleksiyon bilgileri güncellendi.</span>
        <Btn size="sm" disabled={undoingCollection} spinning={undoingCollection} onClick={async () => {
          setUndoingCollection(true)
          const result = await api.undoCollectionEdit(collectionUndo.token)
          setUndoingCollection(false); setCollectionUndo(null)
          if (result) onToast(`${result.count} videonun önceki koleksiyon bilgileri geri getirildi.`, 'ok')
        }}>Geri al</Btn>
        <IconBtn icon="x" title="Koleksiyon düzenleme bildirimini kapat" disabled={undoingCollection} onClick={() => setCollectionUndo(null)} />
      </div> : null}
      {selectedList.length ? (
        <div className="bulk-bar">
          <span className="grow">
            <b>{selectedList.length}</b> {T.library.selectedCount}
          </span>
          <select
            className="select compact"
            value=""
            onChange={(e) => {
              const value = e.target.value
              if (!value) return
              api.setDownloadCategory(
                selectedList.map((d) => d.id),
                value === '__none__' ? null : value
              )
              onToast(T.library.categorySet, 'ok')
            }}
          >
            <option value="">{T.library.setCategory}…</option>
            <option value="__none__">{T.nav.uncategorized}</option>
            {state.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <Btn size="sm" icon="layers" onClick={() => setCollectionFor(selectedList)}>Dizi / bölüm düzenle</Btn>
          <Btn size="sm" icon="trash" variant="danger" onClick={() => askRemove(selectedList)}>
            {T.library.removeSelected}
          </Btn>
          <Btn size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            {T.library.selectNone}
          </Btn>
        </div>
      ) : null}

      {!filtered.length ? <Empty icon="search" title={T.empty.filterTitle} body={T.empty.filterBody} action={<Btn icon="x" onClick={onClearFilters} style={{ marginTop: 6 }}>{T.common.all}</Btn>} /> : null}
      {active.length ? (
        <Section
          title={T.library.active}
          count={active.length}
          select={sectionSelect(active)}
          action={
            outlook.total ? (
              <span className="dim" style={{ fontSize: 12 }}>
                {T.library.allRemaining} {fmt.eta(outlook.total)}
              </span>
            ) : null
          }
        >
          {active.map((d) => (
            <Row key={d.id} download={d} {...rowProps} />
          ))}
        </Section>
      ) : null}

      {done.length ? (
        <Section
          title={T.library.finished}
          count={done.length}
          select={sectionSelect(done)}
          action={
            <>
              {missingCount ? (
                <Btn
                  size="sm"
                  variant="ghost"
                  icon="alert"
                  onClick={async () => {
                    const removed = await api.clearMissing()
                    if (removed) onToast(`${removed} ${T.library.missingCleared}`, 'ok')
                  }}
                >
                  {T.library.clearMissing} ({missingCount})
                </Btn>
              ) : null}
              <Btn size="sm" variant="ghost" icon="trash" onClick={() => api.clearDownloads('done')}>
                {T.library.clearDone}
              </Btn>
            </>
          }
        >
          {done.map((d) => (
            <Row key={d.id} download={d} {...rowProps} />
          ))}
        </Section>
      ) : null}

      {problems.length ? (
        <Section
          title={T.library.problems}
          count={problems.length}
          select={sectionSelect(problems)}
          action={
            <Btn size="sm" variant="ghost" icon="trash" onClick={() => api.clearDownloads('failed')}>
              {T.library.clearFailed}
            </Btn>
          }
        >
          {problems.map((d) => (
            <Row key={d.id} download={d} {...rowProps} />
          ))}
        </Section>
      ) : null}

      {subtitleFor ? (
        <SubtitlePicker
          download={subtitleFor}
          onClose={() => setSubtitleFor(null)}
          onToast={onToast}
          onOpenSettings={onOpenSettings}
        />
      ) : null}
      {collectionFor ? <CollectionEditor downloads={collectionFor} onClose={() => setCollectionFor(null)} onApplied={(result) => {
        setCollectionFor(null); setSelected(new Set())
        setCollectionUndo(result.undoToken ? { token: result.undoToken, count: result.count } : null)
        onToast(result.count ? `${result.count} videonun koleksiyon bilgileri güncellendi.` : 'Koleksiyon bilgileri zaten bu şekildeydi.', result.count ? 'ok' : 'info')
      }} /> : null}
      {checkingMedia ? <MediaHealth download={checkingMedia} onClose={() => setCheckingMedia(null)} /> : null}

      {pendingRemove ? (
        <Modal
          title={
            pendingRemove.length > 1
              ? `${pendingRemove.length} ${T.confirm.removeMany}`
              : T.confirm.removeDownload
          }
          onClose={() => setPendingRemove(null)}
          footer={
            <>
              <Btn onClick={() => setPendingRemove(null)}>{T.confirm.cancel}</Btn>
              <Btn
                variant="primary"
                onClick={async () => {
                  const ids = pendingRemove.map((d) => d.id)
                  setPendingRemove(null)
                  await api.removeDownloads(ids, alsoDeleteFile && deletePolicy !== 'never')
                  setMany(ids, false)
                }}
              >
                {T.confirm.confirm}
              </Btn>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>
            {deletePolicy === 'never' ? T.confirm.removeRecordOnly : T.confirm.removeDownloadBody}
          </p>
          {/* "Never" means the question is settled; showing the box would reopen it. */}
          {deletePolicy === 'never' ? null : (
            <label className="toggle" style={{ marginTop: 10 }}>
              <input
                type="checkbox"
                checked={alsoDeleteFile}
                disabled={!pendingRemove.some((d) => d.filePath && !d.missing)}
                onChange={(e) => setAlsoDeleteFile(e.target.checked)}
              />
              <span className="toggle-track" />
              <span style={{ fontSize: 12.5, color: 'var(--text)' }}>{T.confirm.deleteFile}</span>
            </label>
          )}
        </Modal>
      ) : null}
    </>
  )
}

/* -------------------------------------------------------------------------- */

function Section({
  title,
  count,
  action,
  select,
  children,
}: {
  title: string
  count: number
  action?: ReactNode
  select?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="section">
      <div className="section-head">
        {select}
        <span className="label">{title}</span>
        <span className="count">{count}</span>
        <span className="spacer" />
        {action}
      </div>
      <div className="card">{children}</div>
    </section>
  )
}

function Row({
  download: d,
  categories,
  selected,
  selecting,
  onToggle,
  categoryById,
  vaultingId,
  outlook,
  onRemove,
  onFindSubtitle,
  onCollection,
  onCheckMedia,
  onToVault,
}: {
  download: Download
  categories: Category[]
  selected: Set<string>
  selecting: boolean
  onToggle: (id: string) => void
  categoryById: Map<string, Category>
  vaultingId: string | null
  outlook: Outlook
  onRemove: (d: Download) => void
  onFindSubtitle: (d: Download) => void
  onCollection: (d: Download) => void
  onCheckMedia: (d: Download) => void
  onToVault: (d: Download) => void
}) {
  const [retryAudio, setRetryAudio] = useState<AudioChoice>((d.preferredAudioLanguage || 'auto') as AudioChoice)
  const category = d.categoryId ? categoryById.get(d.categoryId) : null
  const running = d.status === 'running'
  const paused = d.status === 'paused'
  const queued = d.status === 'queued'
  const failed = d.status === 'error' || d.status === 'canceled'
  const stage = d.stage && d.stage !== 'downloading' ? STAGE_LABEL[d.stage] : null

  const tone = d.status === 'done' ? 'done' : failed ? 'bad' : paused ? 'paused' : 'running'
  const playable = d.status === 'done' && !!d.filePath && !d.missing
  // A frame from the file itself once it exists; the site's picture until then.
  const localThumb = useFileThumb(playable && !d.audioOnly ? d.filePath : null, d.duration)
  const isSelected = selected.has(d.id)
  // While picking several, a click on the row picks it; otherwise a finished
  // video plays, which is what clicking a video should do.
  const onRowClick = () => {
    if (selecting) onToggle(d.id)
    else if (playable) api.playFile(d.filePath as string)
  }

  // The queue-aware figure when there is one: it knows this transfer is sharing
  // the line, and that the ones behind it are waiting for a slot. The engine's
  // own number is the fallback for the first seconds, before anything is measured.
  const queueEta = outlook.etas[d.id]
  const eta = d.eta ?? (d.status === 'queued' && !d.retryAt ? queueEta : null)

  // A segmented stream reports no total of its own, but the item measured one
  // before the transfer started — so the meter still has a figure to show.
  const target = d.total ?? d.expectedSize ?? null
  const shownSize = d.fileSize ?? target
  // Only mark a number as an estimate when there *is* a number: a leading ~ on an
  // em dash reads as a glitch.
  const sizeIsEstimate = shownSize !== null && d.fileSize == null && d.total == null

  return (
    <div className={`dl${running ? ' running' : ''}${isSelected ? ' selected' : ''}`}>
      <label className="dl-check" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={isSelected} onChange={() => onToggle(d.id)} />
      </label>
      <div
        className={playable || selecting ? 'dl-play-hit' : undefined}
        onClick={onRowClick}
        title={playable && !selecting ? T.library.play : undefined}
      >
        <Thumb src={localThumb || thumbnailForRoute(d.thumbnail, d.useProxy)} duration={fmt.duration(d.duration)} audio={d.audioOnly} />
      </div>

      <div className="dl-ident">
        <span
          className={`dl-title clamp2${playable || selecting ? ' dl-play-hit' : ''}`}
          title={d.title}
          onClick={onRowClick}
        >
          {d.title}
        </span>

        <div className="dl-meta">
          <Chip tone="site" lang="en">
            {d.site || T.library.from}
          </Chip>
          {category ? (
            <Chip tone="cat">
              <span className="swatch" style={{ background: category.color }} />
              {category.name}
            </Chip>
          ) : null}
          <span>{describe(d.quality, d.audioOnly)}</span>
          {d.series ? <><span className="sep" /><span className="truncate" title={d.series}>{d.series}{d.season !== null && d.season !== undefined ? ` · S${d.season}` : ''}{d.episode !== null && d.episode !== undefined ? ` · B${d.episode}` : ''}</span></> : null}
          <span className="sep" />
          <span title={`İstenen ses: ${fmt.audioLanguage(d.preferredAudioLanguage || 'auto')}`}>
            {d.status === 'done' ? `Ses: ${fmt.audioLanguage(d.audioLanguage || (d.preferredAudioLanguage === 'original' ? 'original' : null))}` : `İstenen ses: ${fmt.audioLanguage(d.preferredAudioLanguage || 'auto')}`}
          </span>
          <span className="sep" />
          <span title="Bu indirme için seçilen ağ yolu">{d.useProxy ? 'VPN / vekil' : 'Doğrudan'}</span>
          <span className="sep" />
          <span title={sizeIsEstimate ? T.library.sizeEstimate : undefined}>
            {sizeIsEstimate ? '~' : ''}
            {fmt.bytes(shownSize)}
          </span>
          {d.finishedAt ? <span className="sep" /> : null}
          {d.finishedAt ? <span>{fmt.relativeTime(d.finishedAt)}</span> : null}
          {queued ? <span className="sep" /> : null}
          {queued ? (
            <span style={{ color: 'var(--signal)' }}>
              {d.retryAt ? d.note || 'Otomatik yeniden denenecek' : T.topbar.queued}
              {/* A queued item's start time is perfectly predictable; saying
                  nothing about it was the part that felt like a black box. */}
              {eta ? ` — ${T.library.finishesIn} ${fmt.eta(eta)}` : ''}
            </span>
          ) : null}
        </div>

        {running || paused ? (
          <>
            <Meter percent={d.percent} tone={tone} parts={running ? d.parts : null} />
            <div className="dl-figures">
              <span className="pct">{fmt.percent(d.percent)}</span>
              <span>
                {fmt.bytes(d.downloaded)} {T.library.of} {fmt.bytes(target)}
              </span>
              {stage ? (
                <span style={{ color: 'var(--signal)' }}>
                  {stage}
                  {d.note ? ` — ${d.note}` : ''}
                </span>
              ) : (
                <>
                  <span>{fmt.speed(d.speed)}</span>
                  <span className="eta">
                    {eta !== null && eta !== undefined ? `${fmt.eta(eta)} ${T.library.remaining}` : ''}
                  </span>
                </>
              )}
              {d.phases > 1 ? (
                <span className="dim">
                  parça {d.phase}/{d.phases}
                </span>
              ) : null}
            </div>
          </>
        ) : null}

        {d.audioWarning ? <div className="dl-error" role="status">{d.audioWarning}</div> : null}
        {d.status === 'done' && d.missing ? (
          <span className="dl-missing">
            <Icon name="alert" size={12} />
            {T.library.missingFile}
          </span>
        ) : null}

        {playable ? (
          <button
            type="button"
            className="dl-path truncate"
            title={d.filePath ?? undefined}
            onClick={() => api.revealFile(d.filePath as string)}
          >
            {fmt.shortPath(d.filePath, 64)}
          </button>
        ) : null}

        {d.status === 'done' && !d.filePath ? (
          <span className="dl-path">{T.library.fileMissing}</span>
        ) : null}

        {d.subtitlePath || d.subtitleLanguage ? (
          <span className="dl-sub mono">
            <Icon name="captions" size={12} />
            {(d.subtitleLanguage || 'srt').toUpperCase()} altyazı eklendi
          </span>
        ) : null}

        {paused && d.note ? <span className="dl-error" role="status">{d.note}</span> : null}
        {d.error ? <span className="dl-error">{d.error}</span> : null}
      </div>

      <div className="dl-actions">
        {failed ? <AudioSelect value={retryAudio} onChange={setRetryAudio} title="Yeniden denemede indirilecek ses" /> : null}
        {running ? <IconBtn icon="pause" title={T.library.pause} onClick={() => api.pause(d.id)} /> : null}
        {paused || queued ? (
          <IconBtn
            icon={paused ? 'play' : 'pause'}
            title={paused ? T.library.resume : T.library.pause}
            onClick={() => (paused ? api.resume(d.id) : api.pause(d.id))}
          />
        ) : null}
        {running || queued || paused ? (
          <IconBtn icon="x" title={T.library.cancel} variant="danger" onClick={() => api.cancel(d.id)} />
        ) : null}
        {failed ? <IconBtn icon="refresh" title={T.library.retry} onClick={() => api.retry(d.id, { preferredAudioLanguage: retryAudio })} /> : null}
        {d.status === 'done' && d.missing ? (
          <IconBtn icon="download" title={T.library.redownload} onClick={() => api.redownload(d.id)} />
        ) : null}
        {playable ? (
          <>
            <IconBtn
              icon="play"
              title={T.library.play}
              onClick={() => api.playFile(d.filePath as string)}
            />
            <IconBtn
              icon="folder"
              title={T.library.reveal}
              onClick={() => api.revealFile(d.filePath as string)}
            />
          </>
        ) : null}

        <Menu title={T.common.more}>
          {(close) => (
            <>
              {queued ? <MenuItem icon="chevron" onClick={() => { api.prioritizeDownload(d.id); close() }}>Sırada öne al</MenuItem> : null}
              <MenuItem icon="layers" onClick={() => { onCollection(d); close() }}>Dizi / bölüm bilgilerini düzenle</MenuItem>
              {playable && !d.audioOnly ? <MenuItem icon="target" onClick={() => { onCheckMedia(d); close() }}>Videonun zamanlamasını kontrol et</MenuItem> : null}
              <div className="menu-label label">{T.library.setCategory}</div>
              <MenuItem
                icon={d.categoryId ? undefined : 'check'}
                onClick={() => {
                  api.setDownloadCategory([d.id], null)
                  close()
                }}
              >
                {T.nav.uncategorized}
              </MenuItem>
              {categories.map((c) => (
                <MenuItem
                  key={c.id}
                  icon={d.categoryId === c.id ? 'check' : undefined}
                  onClick={() => {
                    api.setDownloadCategory([d.id], c.id)
                    close()
                  }}
                >
                  {c.name}
                </MenuItem>
              ))}
              <div className="menu-sep" />
              {playable ? (
                <MenuItem
                  icon="captions"
                  onClick={() => {
                    onFindSubtitle(d)
                    close()
                  }}
                >
                  {T.subs.find}
                </MenuItem>
              ) : null}
              {playable ? (
                <MenuItem
                  icon="lock"
                  onClick={() => {
                    onToVault(d)
                    close()
                  }}
                >
                  {vaultingId === d.id ? T.library.movingToVault : T.library.toVault}
                </MenuItem>
              ) : null}
              {playable ? (
                <MenuItem
                  icon="play"
                  onClick={() => {
                    api.openFile(d.filePath as string)
                    close()
                  }}
                >
                  {T.library.openExternal}
                </MenuItem>
              ) : null}
              <MenuItem
                icon="external"
                onClick={() => {
                  api.openExternal(d.url)
                  close()
                }}
              >
                {T.item.openPage}
              </MenuItem>
              <MenuItem
                icon="trash"
                danger
                onClick={() => {
                  onRemove(d)
                  close()
                }}
              >
                {T.library.remove}
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
    </div>
  )
}
