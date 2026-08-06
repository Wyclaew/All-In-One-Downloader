import { type ReactNode, useMemo, useState } from 'react'
import { api } from '../api'
import * as fmt from '../format'
import { describe } from '../quality'
import { T } from '../strings'
import type { AppState, Category, Download } from '../types'
import { Btn, Chip, Empty, Icon, IconBtn, Menu, MenuItem, Meter, Modal, Thumb } from '../components/ui'
import SubtitlePicker from '../components/SubtitlePicker'

const ACTIVE = new Set(['running', 'queued', 'paused'])
const PROBLEM = new Set(['error', 'canceled'])

interface Props {
  state: AppState
  downloads: Download[]
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
  category,
  query,
  onClearFilters,
  onGoToSources,
  onToast,
  onOpenSettings,
}: Props) {
  const [pendingRemove, setPendingRemove] = useState<Download | null>(null)
  const [alsoDeleteFile, setAlsoDeleteFile] = useState(false)
  const [subtitleFor, setSubtitleFor] = useState<Download | null>(null)
  const [vaulting, setVaulting] = useState<string | null>(null)

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
      return `${d.title} ${d.site} ${cat}`.toLowerCase().includes(needle)
    })
  }, [downloads, query, category, categoryById])

  const active = filtered.filter((d) => ACTIVE.has(d.status))
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

  if (!filtered.length) {
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

  const rowProps = {
    categories: state.categories,
    categoryById,
    vaultingId: vaulting,
    onRemove: (d: Download) => {
      setAlsoDeleteFile(deletePolicy === 'always' && !!d.filePath)
      setPendingRemove(d)
    },
    onFindSubtitle: (d: Download) => setSubtitleFor(d),
    onToVault: async (d: Download) => {
      setVaulting(d.id)
      const entry = await api.vaultTakeDownload(d.id)
      setVaulting(null)
      if (entry) onToast(T.library.movedToVault, 'ok')
    },
  }

  return (
    <>
      {active.length ? (
        <Section title={T.library.active} count={active.length}>
          {active.map((d) => (
            <Row key={d.id} download={d} {...rowProps} />
          ))}
        </Section>
      ) : null}

      {done.length ? (
        <Section
          title={T.library.finished}
          count={done.length}
          action={
            <Btn size="sm" variant="ghost" icon="trash" onClick={() => api.clearDownloads('done')}>
              {T.library.clearDone}
            </Btn>
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

      {pendingRemove ? (
        <Modal
          title={T.confirm.removeDownload}
          onClose={() => setPendingRemove(null)}
          footer={
            <>
              <Btn onClick={() => setPendingRemove(null)}>{T.confirm.cancel}</Btn>
              <Btn
                variant="primary"
                onClick={() => {
                  api.removeDownload(pendingRemove.id, alsoDeleteFile)
                  setPendingRemove(null)
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
                disabled={!pendingRemove.filePath}
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
  children,
}: {
  title: string
  count: number
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="section">
      <div className="section-head">
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
  categoryById,
  vaultingId,
  onRemove,
  onFindSubtitle,
  onToVault,
}: {
  download: Download
  categories: Category[]
  categoryById: Map<string, Category>
  vaultingId: string | null
  onRemove: (d: Download) => void
  onFindSubtitle: (d: Download) => void
  onToVault: (d: Download) => void
}) {
  const category = d.categoryId ? categoryById.get(d.categoryId) : null
  const running = d.status === 'running'
  const paused = d.status === 'paused'
  const queued = d.status === 'queued'
  const failed = d.status === 'error' || d.status === 'canceled'
  const stage = d.stage && d.stage !== 'downloading' ? STAGE_LABEL[d.stage] : null

  const tone = d.status === 'done' ? 'done' : failed ? 'bad' : paused ? 'paused' : 'running'

  // A segmented stream reports no total of its own, but the item measured one
  // before the transfer started — so the meter still has a figure to show.
  const target = d.total ?? d.expectedSize ?? null

  return (
    <div className={`dl${running ? ' running' : ''}`}>
      <Thumb src={d.thumbnail} duration={fmt.duration(d.duration)} audio={d.audioOnly} />

      <div className="dl-ident">
        <span className="dl-title clamp2" title={d.title}>
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
          <span className="sep" />
          <span title={d.fileSize || d.total ? undefined : T.library.sizeEstimate}>
            {d.fileSize || d.total ? '' : '~'}
            {fmt.bytes(d.fileSize ?? target)}
          </span>
          {d.finishedAt ? <span className="sep" /> : null}
          {d.finishedAt ? <span>{fmt.relativeTime(d.finishedAt)}</span> : null}
          {queued ? <span className="sep" /> : null}
          {queued ? <span style={{ color: 'var(--signal)' }}>{T.topbar.queued}</span> : null}
        </div>

        {running || paused ? (
          <>
            <Meter percent={d.percent} tone={tone} />
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
                    {d.eta !== null && d.eta !== undefined
                      ? `${fmt.eta(d.eta)} ${T.library.remaining}`
                      : ''}
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

        {d.status === 'done' && d.filePath ? (
          <button
            type="button"
            className="dl-path truncate"
            title={d.filePath}
            onClick={() => api.revealFile(d.filePath as string)}
          >
            {fmt.shortPath(d.filePath, 64)}
          </button>
        ) : null}

        {d.status === 'done' && !d.filePath ? (
          <span className="dl-path">{T.library.fileMissing}</span>
        ) : null}

        {d.subtitlePath ? (
          <span className="dl-sub mono">
            <Icon name="captions" size={12} />
            {(d.subtitleLanguage || 'srt').toUpperCase()} altyazı eklendi
          </span>
        ) : null}

        {d.error ? <span className="dl-error">{d.error}</span> : null}
      </div>

      <div className="dl-actions">
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
        {failed ? <IconBtn icon="refresh" title={T.library.retry} onClick={() => api.retry(d.id)} /> : null}
        {d.status === 'done' && d.filePath ? (
          <>
            <IconBtn icon="play" title={T.library.open} onClick={() => api.openFile(d.filePath as string)} />
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
              {d.status === 'done' && d.filePath ? (
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
              {d.status === 'done' && d.filePath ? (
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
