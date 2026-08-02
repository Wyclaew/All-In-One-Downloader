import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { Btn, Chip, Icon, IconBtn, Modal, Scope } from './components/ui'
import * as fmt from './format'
import { T } from './strings'
import { useApp, useTheme, useThroughput, withProgress } from './store'
import type { Category } from './types'
import Library from './views/Library'
import Settings from './views/Settings'
import SourcesView from './views/Sources'

type View = 'sources' | 'library' | 'settings'
const ALL = null
const UNCATEGORIZED = '__none__'

export default function App() {
  const { state, tools, progress, toasts, pushToast, dismissToast, refreshTools, menuAction } = useApp()
  const [view, setView] = useState<View>('sources')
  const [category, setCategory] = useState<string | null>(ALL)
  const [query, setQuery] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [clip, setClip] = useState<string | null>(null)
  const [managingCategories, setManagingCategories] = useState(false)

  const urlRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const dismissedClips = useRef<Set<string>>(new Set())

  useTheme(state?.settings.theme)

  const downloads = useMemo(
    () => (state ? state.downloads.map((d) => withProgress(d, progress)) : []),
    [state, progress]
  )
  const { samples, current } = useThroughput(downloads)

  const runningCount = downloads.filter((d) => d.status === 'running').length
  const queuedCount = downloads.filter((d) => d.status === 'queued').length

  const submit = useCallback(
    async (raw?: string) => {
      const value = (raw ?? url).trim()
      if (!value || busy) return
      setBusy(true)
      const res = await api.addSource(value)
      setBusy(false)
      if (res) {
        setUrl('')
        setView('sources')
      }
    },
    [url, busy]
  )

  /* ---- clipboard watch: offer, never auto-add ---------------------------- */

  const checkClipboard = useCallback(async () => {
    if (!state?.settings.autoDetectClipboard) return
    const text = await api.readClipboard()
    const value = (text || '').trim()
    if (!/^https?:\/\/\S+\.\S+/i.test(value)) return setClip(null)
    if (dismissedClips.current.has(value)) return setClip(null)
    if (state.sources.some((s) => s.url === value)) return setClip(null)
    if (value === url.trim()) return setClip(null)
    setClip(value)
  }, [state, url])

  useEffect(() => {
    checkClipboard()
    const onFocus = () => checkClipboard()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [checkClipboard])

  /* ---- native menu actions ---------------------------------------------- */

  useEffect(() => {
    if (!menuAction) return
    const { action } = menuAction
    if (action === 'settings') setView('settings')
    if (action === 'view:sources') setView('sources')
    if (action === 'view:library') setView('library')
    if (action === 'focus-url') {
      urlRef.current?.focus()
      urlRef.current?.select()
    }
    if (action === 'search') {
      setView('library')
      window.setTimeout(() => searchRef.current?.focus(), 40)
    }
    if (action === 'paste-add') {
      api.readClipboard().then((text) => {
        const value = (text || '').trim()
        if (/^https?:\/\/\S+/i.test(value)) submit(value)
        else pushToast('Panoda bir bağlantı yok.', 'warn')
      })
    }
  }, [menuAction, submit, pushToast])

  /* ---- drag and drop ----------------------------------------------------- */

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
    if (text && /https?:\/\//i.test(text)) submit(text)
  }

  const collapseAll = (collapsed: boolean) => {
    if (!state) return
    for (const s of state.sources) if (s.collapsed !== collapsed) api.toggleSource(s.id, collapsed)
  }

  if (!state) {
    return (
      <div className="shell">
        <div className={`titlebar${api.platform === 'darwin' ? ' mac' : ''}`}>
          <span className="wordmark" lang="en">
            <b>All in One</b>
            <span>Downloader</span>
          </span>
        </div>
        <div />
        <div className="empty">
          <Icon name="spinner" size={20} className="spin" />
        </div>
      </div>
    )
  }

  const itemCount = state.items.length
  const anyExpanded = state.sources.some((s) => !s.collapsed)

  const categoryCounts = new Map<string, number>()
  let uncategorized = 0
  for (const d of downloads) {
    if (!d.categoryId) uncategorized += 1
    else categoryCounts.set(d.categoryId, (categoryCounts.get(d.categoryId) || 0) + 1)
  }

  const goLibrary = (cat: string | null) => {
    setCategory(cat)
    setView('library')
  }

  return (
    <div className="shell" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {/* ---- title bar ---- */}
      <header className={`titlebar${api.platform === 'darwin' ? ' mac' : ''}`}>
        <span className="wordmark" lang="en">
          <b>All in One</b>
          <span>Downloader</span>
        </span>

        <span className="titlebar-spacer" />

        <div className="scope" title={T.topbar.throughput}>
          <span className={`lamp${runningCount ? ' on' : ''}`} />
          <Scope samples={samples} />
          <span className="scope-readout">
            <span className={`scope-rate${current ? '' : ' idle'}`}>
              {current ? fmt.speed(current) : '—'}
            </span>
            <span className="scope-note">
              {runningCount
                ? `${runningCount} ${T.topbar.active}${queuedCount ? ` · ${queuedCount} ${T.topbar.queued}` : ''}`
                : T.topbar.idle}
            </span>
          </span>
        </div>

        <IconBtn
          icon="folder"
          title={T.topbar.openFolder}
          onClick={() => api.openFile(state.settings.downloadDir)}
        />
        <IconBtn
          icon="sliders"
          title={T.nav.settings}
          variant={view === 'settings' ? 'on' : undefined}
          onClick={() => setView(view === 'settings' ? 'sources' : 'settings')}
        />
      </header>

      {/* ---- compose ---- */}
      <div className="compose">
        <div className="compose-row">
          <label className="field">
            <span className="field-tag">URL</span>
            <input
              ref={urlRef}
              value={url}
              spellCheck={false}
              placeholder={T.compose.placeholder}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
            />
          </label>
          <Btn
            variant="primary"
            size="tall"
            icon="download"
            spinning={busy}
            disabled={busy || !url.trim()}
            onClick={() => submit()}
          >
            {busy ? T.compose.working : T.compose.submit}
          </Btn>
        </div>

        {clip ? (
          <div className="clipboard-hint">
            <Icon name="link" size={12} />
            <span>{T.compose.clipboard}</span>
            <span className="url truncate">{clip}</span>
            <Btn
              size="sm"
              onClick={() => {
                submit(clip)
                setClip(null)
              }}
            >
              {T.compose.clipboardAdd}
            </Btn>
            <IconBtn
              icon="x"
              title={T.common.close}
              size={12}
              onClick={() => {
                dismissedClips.current.add(clip)
                setClip(null)
              }}
            />
          </div>
        ) : null}
      </div>

      {/* ---- body ---- */}
      <div className="body">
        <nav className="rail">
          <RailItem
            icon="layers"
            label={T.nav.sources}
            count={state.sources.length}
            active={view === 'sources'}
            onClick={() => setView('sources')}
          />
          <RailItem
            icon="archive"
            label={T.nav.library}
            count={downloads.length}
            active={view === 'library'}
            onClick={() => goLibrary(ALL)}
          />
          <RailItem
            icon="sliders"
            label={T.nav.settings}
            active={view === 'settings'}
            onClick={() => setView('settings')}
          />

          <div className="rail-head">
            <span className="label">{T.nav.categories}</span>
            <IconBtn
              icon="plus"
              title={T.nav.newCategory}
              size={12}
              onClick={() => setManagingCategories(true)}
            />
          </div>

          <RailItem
            label={T.nav.allCategories}
            count={downloads.length}
            active={view === 'library' && category === ALL}
            onClick={() => goLibrary(ALL)}
            swatch="var(--dimmer)"
          />
          <RailItem
            label={T.nav.uncategorized}
            count={uncategorized}
            active={view === 'library' && category === UNCATEGORIZED}
            onClick={() => goLibrary(UNCATEGORIZED)}
            swatch="transparent"
          />
          {state.categories.map((c) => (
            <RailItem
              key={c.id}
              label={c.name}
              count={categoryCounts.get(c.id) || 0}
              active={view === 'library' && category === c.id}
              onClick={() => goLibrary(c.id)}
              swatch={c.color}
            />
          ))}
          {!state.categories.length ? (
            <p className="rail-empty">
              Kategori yok. <b>+</b> ile ekle, sonra indirmeleri buraya taşı.
            </p>
          ) : null}
        </nav>

        <main className="pane">
          <div className="pane-head">
            <span className="pane-title">
              {view === 'sources' ? T.nav.sources : view === 'library' ? T.nav.library : T.settings.title}
            </span>
            <span className="pane-sub">
              {view === 'sources'
                ? `${state.sources.length} kaynak · ${itemCount} öğe`
                : view === 'library'
                  ? `${downloads.length} kayıt`
                  : ''}
            </span>

            <span style={{ flex: 1 }} />

            {view === 'sources' && state.sources.length ? (
              <Btn
                size="sm"
                variant="ghost"
                icon="chevron"
                onClick={() => collapseAll(anyExpanded)}
              >
                {anyExpanded ? T.source.collapse : T.source.expand}
              </Btn>
            ) : null}

            {view === 'library' ? (
              <>
                <div className="search">
                  <Icon name="search" size={13} />
                  <input
                    ref={searchRef}
                    value={query}
                    placeholder={T.library.searchPlaceholder}
                    spellCheck={false}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query ? (
                    <IconBtn icon="x" title={T.common.close} size={12} onClick={() => setQuery('')} />
                  ) : null}
                </div>
                {category !== ALL ? (
                  <Chip tone="signal">
                    {category === UNCATEGORIZED
                      ? T.nav.uncategorized
                      : state.categories.find((c) => c.id === category)?.name || ''}
                  </Chip>
                ) : null}
              </>
            ) : null}
          </div>

          <div className="pane-body scroll" style={{ overflowY: 'auto' }}>
            {tools && !tools.ytdlp ? (
              <div className="banner">
                <Icon name="alert" size={15} />
                <span className="grow">
                  {T.settings.ytdlpMissing}. {T.settings.toolsHint}{' '}
                  <code>{tools.installHint}</code>
                </span>
                <Btn size="sm" icon="refresh" onClick={refreshTools}>
                  {T.settings.recheck}
                </Btn>
              </div>
            ) : null}

            {tools && tools.ytdlp && !tools.ffmpeg ? (
              <div className="banner" style={{ borderColor: 'var(--signal-deep)', background: 'transparent' }}>
                <Icon name="alert" size={15} />
                <span className="grow">
                  {T.settings.ffmpegMissing}. Birleştirme ve ses dönüştürme çalışmaz.{' '}
                  <code>{tools.installHint}</code>
                </span>
                <Btn size="sm" icon="refresh" onClick={refreshTools}>
                  {T.settings.recheck}
                </Btn>
              </div>
            ) : null}

            {view === 'sources' ? (
              <SourcesView state={state} downloads={downloads} onGoToLibrary={() => goLibrary(ALL)} />
            ) : null}

            {view === 'library' ? (
              <Library
                state={state}
                downloads={downloads}
                category={category}
                query={query}
                onClearFilters={() => {
                  setQuery('')
                  setCategory(ALL)
                }}
                onGoToSources={() => setView('sources')}
                onToast={pushToast}
                onOpenSettings={() => setView('settings')}
              />
            ) : null}

            {view === 'settings' ? (
              <Settings
                settings={state.settings}
                tools={tools}
                onRefreshTools={refreshTools}
                onToast={pushToast}
              />
            ) : null}
          </div>
        </main>
      </div>

      {managingCategories ? (
        <CategoryManager
          categories={state.categories}
          onClose={() => setManagingCategories(false)}
        />
      ) : null}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <Icon
              name={t.kind === 'error' ? 'alert' : t.kind === 'ok' ? 'check' : 'link'}
              size={13}
            />
            <span className="msg">{t.message}</span>
            <IconBtn icon="x" title={T.common.close} size={12} onClick={() => dismissToast(t.id)} />
          </div>
        ))}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function RailItem({
  icon,
  label,
  count,
  active,
  onClick,
  swatch,
}: {
  icon?: 'layers' | 'archive' | 'sliders'
  label: string
  count?: number
  active: boolean
  onClick: () => void
  swatch?: string
}) {
  return (
    <button type="button" className={`rail-item${active ? ' active' : ''}`} onClick={onClick}>
      {icon ? <Icon name={icon} size={14} /> : null}
      {swatch ? (
        <span
          className="swatch"
          style={{
            background: swatch,
            boxShadow: swatch === 'transparent' ? 'inset 0 0 0 1px var(--dimmer)' : undefined,
          }}
        />
      ) : null}
      <span className="truncate">{label}</span>
      {count !== undefined ? <span className="count">{count}</span> : null}
    </button>
  )
}

function CategoryManager({
  categories,
  onClose,
}: {
  categories: Category[]
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)

  const add = async () => {
    const clean = name.trim()
    if (!clean) return
    const created = await api.addCategory(clean)
    if (created) setName('')
  }

  return (
    <Modal
      title={T.nav.categories}
      onClose={onClose}
      footer={<Btn onClick={onClose}>{T.common.close}</Btn>}
    >
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <input
          className="input wide"
          value={name}
          autoFocus
          placeholder="Yeni kategori adı"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <Btn variant="primary" icon="plus" onClick={add} disabled={!name.trim()}>
          {T.common.add}
        </Btn>
      </div>

      {categories.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {categories.map((c) => (
            <div key={c.id} className="tool-line" style={{ marginBottom: 0 }}>
              <span className="swatch" style={{ background: c.color }} />
              {editing?.id === c.id ? (
                <input
                  className="input"
                  style={{ flex: 1, minWidth: 0 }}
                  value={editing.value}
                  autoFocus
                  onChange={(e) => setEditing({ id: c.id, value: e.target.value })}
                  onBlur={() => {
                    if (editing.value.trim()) api.renameCategory(c.id, editing.value.trim())
                    setEditing(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') setEditing(null)
                  }}
                />
              ) : (
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5 }} className="truncate">
                  {c.name}
                </span>
              )}
              <IconBtn
                icon="pencil"
                title="Adını değiştir"
                size={13}
                onClick={() => setEditing({ id: c.id, value: c.name })}
              />
              <IconBtn
                icon="trash"
                title="Kategoriyi kaldır"
                variant="danger"
                size={13}
                onClick={() => api.removeCategory(c.id)}
              />
            </div>
          ))}
        </div>
      ) : (
        <p style={{ margin: 0 }}>Henüz kategori yok.</p>
      )}
    </Modal>
  )
}
