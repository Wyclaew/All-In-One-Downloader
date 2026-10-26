import AudioSelect, { type AudioChoice } from '../components/AudioSelect'
import { indexDownloads, mediaPreferenceKey } from '../download-state'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import * as fmt from '../format'
import { QUALITY_OPTIONS, fromDefault, sizeFor, toRequest } from '../quality'
import { T } from '../strings'
import type { AppState, Download, MediaItem, Source } from '../types'
import {
  Btn,
  Check,
  Chip,
  Empty,
  Icon,
  IconBtn,
  Menu,
  MenuItem,
  Meter,
  Modal,
  Thumb,
  thumbnailForRoute,
} from '../components/ui'

/**
 * Quality picks live in the shell, not here. This view unmounts every time the
 * user looks at the library or settings, and a per-row choice that evaporates on
 * the way back is worse than no choice at all.
 */
export interface QualityMemory {
  group: Record<string, string>
  row: Record<string, string>
  setGroup: (fn: (prev: Record<string, string>) => Record<string, string>) => void
  setRow: (fn: (prev: Record<string, string>) => Record<string, string>) => void
  audioGroup: Record<string, AudioChoice>
  audioRow: Record<string, AudioChoice>
  setAudioGroup: (fn: (prev: Record<string, AudioChoice>) => Record<string, AudioChoice>) => void
  setAudioRow: (fn: (prev: Record<string, AudioChoice>) => Record<string, AudioChoice>) => void
}

interface Props {
  state: AppState
  downloads: Download[]
  quality: QualityMemory
  onGoToLibrary: () => void
  onToast: (message: string, kind?: 'info' | 'warn' | 'error' | 'ok') => void
}

export default function Sources({
  state,
  downloads,
  quality: { group: groupQuality, row: rowQuality, setGroup: setGroupQuality, setRow: setRowQuality, audioGroup, audioRow, setAudioGroup, setAudioRow },
  onGoToLibrary,
  onToast,
}: Props) {
  const [pendingRemove, setPendingRemove] = useState<Source | null>(null)
  const [rescanning, setRescanning] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchQuality, setBatchQuality] = useState<string | null>(null)
  const [batchAudio, setBatchAudio] = useState<AudioChoice | null>(null)
  const [batchAction, setBatchAction] = useState<'retry' | 'stop' | null>(null)
  const [sourceActions, setSourceActions] = useState<Record<string, { stop?: boolean; metadata?: boolean }>>({})
  const [diagnostics, setDiagnostics] = useState<{ sourceId: string; title: string; text: string | null; loading: boolean } | null>(null)
  const [copyingReport, setCopyingReport] = useState(false)

  // A ticked item can disappear under you — a rescan replaces the list, or the
  // item is removed. Without this the bar counts things that no longer exist and
  // a bulk action would be sent ids the main process can't find.
  useEffect(() => {
    setSelected((prev) => {
      if (!prev.size) return prev
      const alive = new Set(state.items.map((i) => i.id))
      const kept = [...prev].filter((id) => alive.has(id))
      return kept.length === prev.size ? prev : new Set(kept)
    })
  }, [state.items])

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleMany = (ids: string[], turnOn: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (turnOn) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  const fallbackQuality = fromDefault(state.settings.defaultQuality)

  const itemsBySource = useMemo(() => {
    const map = new Map<string, MediaItem[]>()
    for (const item of state.items) {
      const list = map.get(item.sourceId)
      if (list) list.push(item)
      else map.set(item.sourceId, [item])
    }
    for (const list of map.values()) list.sort((a, b) => a.index - b.index)
    return map
  }, [state.items])

  const downloadsByItem = useMemo(() => {
    const find = indexDownloads(downloads)
    return new Map(state.items.map((item) => [item.id, find(item)]))
  }, [state.items, downloads])

  if (!state.sources.length) {
    return (
      <Empty
        icon="link"
        title={T.empty.sourcesTitle}
        body={T.empty.sourcesBody}
      />
    )
  }

  const qualityFor = (item: MediaItem) => {
    const previous = downloadsByItem.get(item.id)
    return rowQuality[mediaPreferenceKey(item)] ?? rowQuality[item.id] ?? groupQuality[item.sourceId] ??
      (previous ? previous.audioOnly ? 'audio' : fromDefault(previous.quality) : fallbackQuality)
  }
  const audioFor = (item: MediaItem): AudioChoice => (audioRow[mediaPreferenceKey(item)] ?? audioRow[item.id] ?? audioGroup[item.sourceId] ??
    downloadsByItem.get(item.id)?.preferredAudioLanguage ?? state.settings.preferredAudioLanguage ?? 'en') as AudioChoice

  const startDownload = (item: MediaItem) => {
    api.download({ itemIds: [item.id], ...toRequest(qualityFor(item)), preferredAudioLanguage: audioFor(item) })
  }

  const downloadAll = (source: Source, value: string) => {
    api.downloadSource(source.id, { ...toRequest(value), preferredAudioLanguage: audioGroup[source.id] ?? state.settings.preferredAudioLanguage ?? 'en' }).then((res) => {
      if (res && res.count) onGoToLibrary()
    })
  }

  // Encrypting takes seconds and the row vanishes when it lands, so say what is
  // happening before the list changes under the user.
  const toVault = async (d: Download) => {
    onToast(T.library.movingToVault, 'info')
    const entry = await api.vaultTakeDownload(d.id)
    if (entry) onToast(T.library.movedToVault, 'ok')
  }

  const rescan = async (source: Source) => {
    setRescanning((prev) => ({ ...prev, [source.id]: true }))
    await api.rescanSource(source.id)
    setRescanning((prev) => ({ ...prev, [source.id]: false }))
  }

  const busyCount = state.sources.filter((source) => source.status === 'queued' || source.status === 'probing' || source.enriching > 0).length
  const failedCount = state.sources.filter((source) => source.status === 'error').length
  const canceledCount = state.sources.filter((source) => source.status === 'canceled').length
  const readyCount = state.sources.filter((source) => source.status === 'ready').length

  const runBatchAction = async (action: 'retry' | 'stop') => {
    if (batchAction) return
    setBatchAction(action)
    try {
      const count = await (action === 'retry' ? api.retryFailedSources() : api.cancelAllSources())
      if (count) onToast(action === 'retry' ? `${count} kaynak yeniden tarama sırasına alındı.` : `${count} kaynak taraması durduruldu.`, 'info')
    } finally { setBatchAction(null) }
  }

  const runSourceAction = async (source: Source, action: 'stop' | 'metadata') => {
    if (sourceActions[source.id]?.[action]) return
    setSourceActions((prev) => ({ ...prev, [source.id]: { ...prev[source.id], [action]: true } }))
    try {
      const result = await (action === 'stop' ? api.cancelSource(source.id) : api.refreshSourceMetadata(source.id))
      if (result && action === 'stop') onToast('Kaynak taraması durduruldu.', 'info')
    } finally { setSourceActions((prev) => ({ ...prev, [source.id]: { ...prev[source.id], [action]: false } })) }
  }

  const openDiagnostics = async (source: Source) => {
    setDiagnostics({ sourceId: source.id, title: source.title || source.site, text: null, loading: true })
    const text = await api.sourceDiagnostics(source.id)
    setDiagnostics((current) => current?.sourceId === source.id ? { ...current, text, loading: false } : current)
  }

  return (
    <>
      <div className="source-toolbar" aria-label="Kaynak durumları">
        <div className="source-summary" role="status">
          <span><strong>{state.sources.length}</strong> kaynak</span>
          {busyCount ? <span><strong>{busyCount}</strong> işleniyor</span> : null}
          {readyCount ? <span><strong>{readyCount}</strong> hazır</span> : null}
          {failedCount ? <span className="source-failed"><strong>{failedCount}</strong> hata</span> : null}
          {canceledCount ? <span><strong>{canceledCount}</strong> durduruldu</span> : null}
        </div>
        <div className="source-toolbar-actions">
          <Btn size="sm" variant="ghost" icon="refresh" disabled={!(failedCount + canceledCount) || !!batchAction} spinning={batchAction === 'retry'} title="Hatalı ve durdurulan kaynakları yeniden dene" onClick={() => runBatchAction('retry')}>
            Yeniden dene{failedCount + canceledCount ? ` (${failedCount + canceledCount})` : ''}
          </Btn>
          <Btn size="sm" variant="ghost" icon="x" disabled={!busyCount || !!batchAction} spinning={batchAction === 'stop'} onClick={() => runBatchAction('stop')}>
            Tümünü durdur
          </Btn>
        </div>
      </div>
      {state.sources.map((source) => {
        const items = itemsBySource.get(source.id) || []
        const doneCount = items.filter((i) => {
          const d = downloadsByItem.get(i.id)
          return d && d.status === 'done'
        }).length
        const groupValue = groupQuality[source.id] ?? fallbackQuality
        const waiting = source.status === 'queued'
        const probing = source.status === 'probing' || waiting
        const busy = probing || source.enriching > 0 || !!sourceActions[source.id]?.stop || !!sourceActions[source.id]?.metadata
        const missingMetadata = items.filter((item) => !item.isLive && (!(item.duration && item.duration > 0) || !sizeFor(item, qualityFor(item)))).length
        const networkLabel = source.network?.label || (source.network?.kind === 'tor' ? 'Tor bağlantısı' : source.useProxy ? 'Vekil bağlantı' : 'Doğrudan bağlantı')
        const progressLabel = waiting ? T.source.waiting : source.stage === 'network' ? 'Ağ bağlantısı hazırlanıyor…' : source.stage === 'resolver' ? T.source.resolving : T.source.probing
        const open = !source.collapsed

        return (
          <section
            key={source.id}
            className={`group${probing ? ' probing' : ''}${source.status === 'error' ? ' bad' : ''}`}
          >
            <header
              className="group-head"
              onClick={() => api.toggleSource(source.id)}
              role="button"
              tabIndex={0}
              aria-expanded={open}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  api.toggleSource(source.id)
                }
              }}
            >
              {items.length ? (
                <span onClick={(e) => e.stopPropagation()}>
                  <Check
                    state={
                      items.every((i) => selected.has(i.id))
                        ? true
                        : items.some((i) => selected.has(i.id))
                          ? 'some'
                          : false
                    }
                    label={T.batch.selectGroup}
                    onChange={() =>
                      toggleMany(
                        items.map((i) => i.id),
                        !items.every((i) => selected.has(i.id))
                      )
                    }
                  />
                </span>
              ) : null}

              {probing ? (
                <Icon name="spinner" className="spin chevron" />
              ) : (
                <Icon name="chevron" className={`chevron${open ? ' open' : ''}`} />
              )}

              <div className="group-ident">
                <div className="group-line">
                  <Chip tone="site" title={source.url} lang="en">
                    {source.site}
                  </Chip>
                  {source.useProxy ? (
                    <Chip tone="signal" title={T.compose.proxyOnHint}>
                      <Icon name="shield" size={10} />
                      {T.compose.proxy}
                    </Chip>
                  ) : null}
                  <span className="group-title truncate">{source.title || source.url}</span>
                </div>
                <div className="group-meta">
                  {source.uploader ? <span className="truncate">{source.uploader}</span> : null}
                  {source.uploader ? <span className="sep" /> : null}
                  <span>
                    {items.length} {T.source.itemsOne}
                  </span>
                  {doneCount ? <span className="sep" /> : null}
                  {doneCount ? (
                    <span style={{ color: 'var(--ok)' }}>
                      {doneCount} {T.source.downloaded}
                    </span>
                  ) : null}
                  <span className="sep" />
                  <span>{fmt.relativeTime(source.addedAt)}</span>
                  <span className="sep" />
                  <span className="group-network" title={networkLabel}>
                    {source.network?.kind === 'tor' || source.network?.kind === 'proxy' || source.useProxy ? <Icon name="shield" size={11} /> : null}
                    {networkLabel}
                  </span>
                  {source.resolvedBy && source.resolvedBy !== 'yt-dlp' ? <span className="sep" /> : null}
                  {source.resolvedBy && source.resolvedBy !== 'yt-dlp' ? (
                    <span style={{ color: 'var(--signal)' }}>{source.resolvedBy}</span>
                  ) : null}
                  {source.enriching ? <span className="sep" /> : null}
                  {source.enriching ? (
                    <span style={{ color: 'var(--signal)' }}>{T.source.enriching(source.enriching)}</span>
                  ) : null}
                </div>
              </div>

              <div className="group-actions" onClick={(e) => e.stopPropagation()}>
                <IconBtn icon="shield" title={source.useProxy ? 'Doğrudan bağlantıya geç ve yeniden tara (bu kaynağın aktarımları duraklatılır)' : 'VPN / vekil ile yeniden tara (bu kaynağın aktarımları duraklatılır)'} onClick={() => api.setSourceProxy(source.id, !source.useProxy)} />
                {busy ? (
                  <Btn size="sm" variant="ghost" icon="x" disabled={!!sourceActions[source.id]?.stop} spinning={!!sourceActions[source.id]?.stop} onClick={() => runSourceAction(source, 'stop')}>
                    Durdur
                  </Btn>
                ) : null}
                {items.length > 1 ? <>
                <select
                  className="select"
                  value={groupValue}
                  title={T.item.quality}
                  onChange={(e) => setGroupQuality((prev) => ({ ...prev, [source.id]: e.target.value }))}
                >
                  {QUALITY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <AudioSelect value={audioGroup[source.id] ?? state.settings.preferredAudioLanguage ?? 'en'} onChange={(value) => setAudioGroup((previous) => ({ ...previous, [source.id]: value }))} title="Bu kaynağın indirilecek ses dili" />
                <Btn
                  size="sm"
                  icon="download"
                  disabled={!items.length}
                  onClick={() => downloadAll(source, groupValue)}
                >
                  {T.source.downloadAll}
                </Btn>
                </> : null}
                <IconBtn
                  icon="refresh"
                  title={T.source.rescan}
                  spinning={!!rescanning[source.id] || probing}
                  disabled={probing}
                  onClick={() => rescan(source)}
                />
                <IconBtn
                  icon="target"
                  title={T.source.capture}
                  disabled={probing}
                  onClick={() => api.captureSource(source.id)}
                />
                <IconBtn
                  icon="external"
                  title={T.source.openPage}
                  onClick={() => api.openSource(source.id)}
                />
                <IconBtn
                  icon="trash"
                  title={T.source.removeSource}
                  variant="danger"
                  onClick={() => setPendingRemove(source)}
                />
                <Menu title="Kaynak işlemleri">
                  {(close) => (
                    <>
                      <MenuItem icon="refresh" disabled={busy || !items.length || !missingMetadata} onClick={() => { void runSourceAction(source, 'metadata'); close() }}>
                        Eksik süre / boyut bilgilerini tamamla
                      </MenuItem>
                      <MenuItem icon="target" onClick={() => { void openDiagnostics(source); close() }}>
                        Tanılama raporunu aç
                      </MenuItem>
                    </>
                  )}
                </Menu>
              </div>

              <div className="group-counters">
                <span>{items.length ? `${doneCount}/${items.length}` : probing ? '' : '0'}</span>
              </div>
            </header>

            {open ? (
              <div className="group-body">
                {probing ? (
                  <div className="group-note" role="status">
                    {progressLabel}{source.note && source.note !== progressLabel ? ` — ${source.note}` : ''}
                  </div>
                ) : source.error ? (
                  <div className="group-note bad">{source.error}</div>
                ) : source.note ? (
                  <div className="group-note" role="status">{source.note}</div>
                ) : null}

                {missingMetadata && !probing ? (
                  <div className="group-note group-metadata">
                    <span>{source.enriching || sourceActions[source.id]?.metadata ? 'Süre ve boyut bilgileri kontrol ediliyor…' : `${missingMetadata} öğenin süre veya boyut bilgisi eksik.`}</span>
                    <Btn size="sm" variant="ghost" icon="refresh" spinning={!!sourceActions[source.id]?.metadata || source.enriching > 0} disabled={busy} onClick={() => runSourceAction(source, 'metadata')}>Bilgileri tamamla</Btn>
                  </div>
                ) : null}

                {items.map((item) => (
                  <Row
                    key={item.id}
                    item={item}
                    useProxy={source.useProxy}
                    download={downloadsByItem.get(item.id) || null}
                    quality={qualityFor(item)}
                    audioLanguage={audioFor(item)}
                    onAudioLanguage={(value) => setAudioRow((previous) => ({ ...previous, [mediaPreferenceKey(item)]: value }))}
                    selected={selected.has(item.id)}
                    onToggleSelect={() => toggleOne(item.id)}
                    onQuality={(value) => setRowQuality((prev) => ({ ...prev, [mediaPreferenceKey(item)]: value }))}
                    onDownload={() => startDownload(item)}
                    onToVault={toVault}
                    onToast={onToast}
                  />
                ))}
              </div>
            ) : null}
          </section>
        )
      })}

      {selected.size ? (
        <div className="selbar">
          <span className="count">{selected.size}</span>
          <span style={{ fontSize: 12.5, color: 'var(--ink-dim)' }}>{T.batch.picked}</span>
          <span className="sep" />
          <select
            className="select"
            value={batchQuality ?? fallbackQuality}
            title={T.item.quality}
            onChange={(e) => setBatchQuality(e.target.value)}
          >
            {QUALITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <AudioSelect value={batchAudio ?? state.settings.preferredAudioLanguage ?? 'en'} onChange={setBatchAudio} title="Seçili videoların indirilecek ses dili" />
          <Btn
            size="sm"
            variant="primary"
            icon="download"
            onClick={() => {
              api
                .download({
                  itemIds: [...selected],
                  ...toRequest(batchQuality ?? fallbackQuality),
                  preferredAudioLanguage: batchAudio ?? state.settings.preferredAudioLanguage ?? 'en',
                })
                .then((res) => {
                  setSelected(new Set())
                  if (res && res.count) onGoToLibrary()
                })
            }}
          >
            {T.batch.download}
          </Btn>
          <Btn
            size="sm"
            icon="trash"
            onClick={() => {
              for (const id of selected) api.removeItem(id)
              setSelected(new Set())
            }}
          >
            {T.batch.remove}
          </Btn>
          <span className="sep" />
          <IconBtn icon="x" title={T.batch.clear} onClick={() => setSelected(new Set())} />
        </div>
      ) : null}

      {pendingRemove ? (
        <Modal
          title={T.confirm.removeSource}
          onClose={() => setPendingRemove(null)}
          footer={
            <>
              <Btn onClick={() => setPendingRemove(null)}>{T.confirm.cancel}</Btn>
              <Btn
                variant="primary"
                onClick={() => {
                  api.removeSource(pendingRemove.id)
                  setPendingRemove(null)
                }}
              >
                {T.confirm.confirm}
              </Btn>
            </>
          }
        >
          {T.confirm.removeSourceBody}
        </Modal>
      ) : null}

      {diagnostics ? (
        <Modal title="Kaynak tanılama raporu" onClose={() => setDiagnostics(null)} footer={
          <>
            <Btn autoFocus onClick={() => setDiagnostics(null)}>Kapat</Btn>
            <Btn variant="primary" icon="link" disabled={!diagnostics.text || diagnostics.loading || copyingReport} spinning={copyingReport} onClick={async () => {
              if (!diagnostics.text) return
              setCopyingReport(true)
              try { if (await api.writeClipboard(diagnostics.text)) onToast('Tanılama raporu kopyalandı.', 'ok') } finally { setCopyingReport(false) }
            }}>Raporu kopyala</Btn>
          </>
        }>
          <p className="source-report-title">{diagnostics.title}</p>
          <p>Son tarama adımlarını, bağlantı yolunu ve bulunan medya bilgilerini içerir.</p>
          {diagnostics.loading ? <p role="status">Rapor hazırlanıyor…</p> : diagnostics.text ? <pre className="source-report" tabIndex={0} aria-label="Tanılama raporu JSON">{diagnostics.text}</pre> : <p role="status">Rapor hazırlanamadı. Pencereyi kapatıp yeniden dene.</p>}
        </Modal>
      ) : null}
    </>
  )
}

/* -------------------------------------------------------------------------- */

function Row({
  item,
  useProxy,
  download,
  quality,
  audioLanguage,
  onAudioLanguage,
  selected,
  onToggleSelect,
  onQuality,
  onDownload,
  onToVault,
  onToast,
}: {
  item: MediaItem
  useProxy?: boolean
  download: Download | null
  quality: string
  audioLanguage: AudioChoice
  onAudioLanguage: (value: AudioChoice) => void
  selected: boolean
  onToggleSelect: () => void
  onQuality: (value: string) => void
  onDownload: () => void
  onToVault: (d: Download) => void
  onToast: Props['onToast']
}) {
  const audio = quality === 'audio'
  const status = download ? download.status : null
  const idle = !download || download.status === 'canceled'
  // Answers for the quality picked on *this* row, and follows the dropdown.
  const size = sizeFor(item, quality)

  return (
    <div className={`row${selected ? ' selected' : ''}`}>
      <Check state={selected} label={T.batch.selectOne} onChange={onToggleSelect} />
      <Thumb src={thumbnailForRoute(item.thumbnail, useProxy)} duration={fmt.duration(item.duration)} audio={audio} />

      <div className="row-ident">
        <span className="row-title clamp2" title={item.title}>
          {item.title}
        </span>
        <div className="row-meta">
          {item.isLive ? (
            <>
              <Chip tone="bad">{T.item.live}</Chip>
            </>
          ) : null}
          {item.uploader ? <span className="truncate">{item.uploader}</span> : null}
          {item.uploader ? <span className="sep" /> : null}
          {item.height ? <span>{fmt.qualityLabel(item.height)}</span> : null}
          {item.height ? <span className="sep" /> : null}
          {size ? (
            <span
              className={item.filesizeEstimated ? 'dim' : undefined}
              title={item.filesizeEstimated ? T.item.sizeEstimateHint : T.item.sizeExact}
            >
              {item.filesizeEstimated ? '~' : ''}
              {fmt.bytes(size)}
            </span>
          ) : null}
          {size ? <span className="sep" /> : null}
          <span>{item.site}</span>
          {download ? <><span className="sep" /><span>{download.status === 'done' ? `Ses: ${fmt.audioLanguage(download.audioLanguage || (download.preferredAudioLanguage === 'original' ? 'original' : null))}` : `İstenen ses: ${fmt.audioLanguage(download.preferredAudioLanguage || 'auto')}`}</span></> : null}
          {item.audioTracks?.some((track) => track.lang || /original|orijinal|turkish|türkçe|turkce|english|ingilizce/i.test(track.name || '')) ? <><span className="sep" /><span title="Kaynağın bildirdiği ses seçenekleri">Sesler: {[...new Set(item.audioTracks.map((track) => {
            if (track.lang) return fmt.audioLanguage(track.lang)
            if (/original|orijinal/i.test(track.name || '')) return 'Orijinal ses'
            if (/turkish|türkçe|turkce/i.test(track.name || '')) return 'Türkçe'
            if (/english|ingilizce/i.test(track.name || '')) return 'İngilizce'
            return ''
          }).filter(Boolean))].join(", ")}</span></> : null}
          {!item.duration && !item.isLive ? <span className="sep" /> : null}
          {!item.duration && !item.isLive ? <span>{T.item.unknownDuration}</span> : null}
          {!size && !item.isLive ? <span className="sep" /> : null}
          {!size && !item.isLive ? <span>boyut bilinmiyor</span> : null}
        </div>
        {download?.status === 'error' && download.error ? <p className="dl-error" role="alert">{download.error}</p> : null}
      </div>

      <div className="row-actions">
        {download && (download.status === 'running' || download.status === 'paused') ? (
          <div className="row-progress">
            <Meter
              percent={download.percent}
              tone={download.status === 'paused' ? 'paused' : 'running'}
              slim
            />
            <div className="figures">
              <span>{fmt.percent(download.percent)}</span>
              <span>
                {download.status === 'paused'
                  ? T.library.pause
                  : download.eta !== null && download.eta !== undefined
                    ? `${fmt.eta(download.eta)} ${T.library.remaining}`
                    : fmt.speed(download.speed)}
              </span>
            </div>
          </div>
        ) : null}

        {status === 'queued' ? <Chip tone="signal">{T.item.inQueue}</Chip> : null}
        {status === 'done' && !download?.missing ? <Chip tone="ok">{T.item.done}</Chip> : null}
        {status === 'done' && download?.missing ? <Chip tone="bad">{T.item.missing}</Chip> : null}
        {status === 'error' ? <Chip tone="bad">{T.item.failed}</Chip> : null}

        {idle || status === 'done' || status === 'error' ? (
          <>
            <select
              className="select"
              value={quality}
              title={T.item.quality}
              onChange={(e) => onQuality(e.target.value)}
            >
              {QUALITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <AudioSelect value={audioLanguage} onChange={onAudioLanguage} title="Bu videonun indirilecek ses dili" />
            {!(status === "done" && download?.missing) ? <IconBtn icon={status === "error" ? "refresh" : "download"} title={status === "error" ? "Seçilen ses ve kaliteyle yeniden dene" : T.item.download} onClick={() => status === "error" && download ? api.retry(download.id, { ...toRequest(quality), preferredAudioLanguage: audioLanguage }) : onDownload()} /> : null}
          </>
        ) : null}

        {download && download.status === 'running' ? (
          <IconBtn icon="pause" title={T.library.pause} onClick={() => api.pause(download.id)} />
        ) : null}
        {download && download.status === 'paused' ? (
          <IconBtn icon="play" title={T.library.resume} onClick={() => api.resume(download.id)} />
        ) : null}
        {/* Pausing was the only way out of a mistaken click, which is not a way
            out at all. Cancelling stops it and takes the half-file with it. */}
        {download &&
        (download.status === 'running' ||
          download.status === 'paused' ||
          download.status === 'queued') ? (
          <IconBtn
            icon="x"
            title={T.library.cancel}
            variant="danger"
            onClick={() => api.cancel(download.id)}
          />
        ) : null}
        {download && download.status === 'done' && download.filePath && !download.missing ? (
          <>
            <IconBtn
              icon="play"
              title={T.library.play}
              onClick={() => api.playFile(download.filePath as string)}
            />
            <IconBtn
              icon="folder"
              title={T.library.reveal}
              onClick={() => api.revealFile(download.filePath as string)}
            />
          </>
        ) : null}
        {/* Finished once, but the file has since gone from the disk: say so, and
            offer the one action that helps, instead of a folder button that
            silently opens nothing. */}
        {download && download.status === 'done' && download.missing ? (
          <IconBtn
            icon="download"
            title={`${T.library.missingFile}. ${T.library.redownload}`}
            variant="danger"
            onClick={() => api.redownload(download.id)}
          />
        ) : null}

        <Menu title={T.common.more}>
          {(close) => (
            <>
              <MenuItem
                icon="external"
                onClick={() => {
                  api.openItem(item.id)
                  close()
                }}
              >
                {T.item.openPage}
              </MenuItem>
              {/* The row is already dense, so copying lives in the menu rather
                  than as another button competing for the same few pixels. */}
              {/* For a resolved item `url` is already the stream, and the page it
                  came from is the one in `resolved`. Getting these the wrong way
                  round would hand over a manifest address labelled as the page. */}
              <MenuItem
                icon="link"
                onClick={() => {
                  api.writeClipboard(item.resolved?.pageUrl || item.url)
                  onToast(T.item.linkCopied, 'ok')
                  close()
                }}
              >
                {T.item.copyLink}
              </MenuItem>
              {item.resolved ? (
                <MenuItem
                  icon="link"
                  onClick={() => {
                    api.writeClipboard(item.url)
                    onToast(T.item.streamCopied, 'ok')
                    close()
                  }}
                >
                  {T.item.copyStream}
                </MenuItem>
              ) : null}
              {download && download.status === 'done' && download.filePath && !download.missing ? (
                <MenuItem
                  icon="play"
                  onClick={() => {
                    api.playFile(download.filePath as string)
                    close()
                  }}
                >
                  {T.library.play}
                </MenuItem>
              ) : null}
              {download && download.status === 'done' && download.filePath && !download.missing ? (
                <MenuItem
                  icon="lock"
                  onClick={() => {
                    onToVault(download)
                    close()
                  }}
                >
                  {T.library.toVault}
                </MenuItem>
              ) : null}
              {download && (download.status === 'queued' || download.status === 'running') ? (
                <MenuItem
                  icon="x"
                  onClick={() => {
                    api.cancel(download.id)
                    close()
                  }}
                >
                  {T.library.cancel}
                </MenuItem>
              ) : null}
              <div className="menu-sep" />
              <MenuItem
                icon="trash"
                danger
                onClick={() => {
                  api.removeItem(item.id)
                  close()
                }}
              >
                {T.item.remove}
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
    </div>
  )
}
