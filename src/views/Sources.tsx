import { useMemo, useState } from 'react'
import { api } from '../api'
import * as fmt from '../format'
import { QUALITY_OPTIONS, fromDefault, toRequest } from '../quality'
import { T } from '../strings'
import type { AppState, Download, MediaItem, Source } from '../types'
import { Btn, Chip, Empty, Icon, IconBtn, Menu, MenuItem, Meter, Modal, Thumb } from '../components/ui'

interface Props {
  state: AppState
  downloads: Download[]
  onGoToLibrary: () => void
}

export default function Sources({ state, downloads, onGoToLibrary }: Props) {
  const [groupQuality, setGroupQuality] = useState<Record<string, string>>({})
  const [rowQuality, setRowQuality] = useState<Record<string, string>>({})
  const [pendingRemove, setPendingRemove] = useState<Source | null>(null)
  const [rescanning, setRescanning] = useState<Record<string, boolean>>({})

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

  /**
   * Latest download per media URL, so a row can show its own state. Keyed on the
   * URL rather than the item id: rescanning a source mints new item ids, and the
   * "already downloaded" mark has to survive that.
   */
  const downloadByUrl = useMemo(() => {
    const map = new Map<string, Download>()
    for (const d of downloads) {
      if (!d.url) continue
      const existing = map.get(d.url)
      if (!existing || d.createdAt > existing.createdAt) map.set(d.url, d)
    }
    return map
  }, [downloads])

  if (!state.sources.length) {
    return (
      <Empty
        icon="link"
        title={T.empty.sourcesTitle}
        body={T.empty.sourcesBody}
      />
    )
  }

  const qualityFor = (item: MediaItem) =>
    rowQuality[item.id] ?? groupQuality[item.sourceId] ?? fallbackQuality

  const startDownload = (item: MediaItem) => {
    api.download({ itemIds: [item.id], ...toRequest(qualityFor(item)) })
  }

  const downloadAll = (source: Source, value: string) => {
    api.downloadSource(source.id, toRequest(value)).then((res) => {
      if (res && res.count) onGoToLibrary()
    })
  }

  const rescan = async (source: Source) => {
    setRescanning((prev) => ({ ...prev, [source.id]: true }))
    await api.rescanSource(source.id)
    setRescanning((prev) => ({ ...prev, [source.id]: false }))
  }

  return (
    <>
      {state.sources.map((source) => {
        const items = itemsBySource.get(source.id) || []
        const doneCount = items.filter((i) => {
          const d = downloadByUrl.get(i.url)
          return d && d.status === 'done'
        }).length
        const groupValue = groupQuality[source.id] ?? fallbackQuality
        const waiting = source.status === 'queued'
        const probing = source.status === 'probing' || waiting
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
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  api.toggleSource(source.id)
                }
              }}
            >
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
                  {source.enriching ? <span className="sep" /> : null}
                  {source.enriching ? (
                    <span style={{ color: 'var(--signal)' }}>{T.source.enriching(source.enriching)}</span>
                  ) : null}
                </div>
              </div>

              <div className="group-actions" onClick={(e) => e.stopPropagation()}>
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
                <Btn
                  size="sm"
                  icon="download"
                  disabled={!items.length}
                  onClick={() => downloadAll(source, groupValue)}
                >
                  {T.source.downloadAll}
                </Btn>
                <IconBtn
                  icon="refresh"
                  title={T.source.rescan}
                  spinning={!!rescanning[source.id] || probing}
                  disabled={probing}
                  onClick={() => rescan(source)}
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
              </div>

              <div className="group-counters">
                <span>{items.length ? `${doneCount}/${items.length}` : probing ? '' : '0'}</span>
              </div>
            </header>

            {open ? (
              <div className="group-body">
                {probing ? (
                  <div className="group-note">{waiting ? T.source.waiting : T.source.probing}</div>
                ) : source.error ? (
                  <div className="group-note bad">{source.error}</div>
                ) : null}

                {items.map((item) => (
                  <Row
                    key={item.id}
                    item={item}
                    download={downloadByUrl.get(item.url) || null}
                    quality={qualityFor(item)}
                    onQuality={(value) => setRowQuality((prev) => ({ ...prev, [item.id]: value }))}
                    onDownload={() => startDownload(item)}
                  />
                ))}
              </div>
            ) : null}
          </section>
        )
      })}

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
    </>
  )
}

/* -------------------------------------------------------------------------- */

function Row({
  item,
  download,
  quality,
  onQuality,
  onDownload,
}: {
  item: MediaItem
  download: Download | null
  quality: string
  onQuality: (value: string) => void
  onDownload: () => void
}) {
  const audio = quality === 'audio'
  const status = download ? download.status : null
  const idle = !download || download.status === 'canceled'

  return (
    <div className="row">
      <Thumb src={item.thumbnail} duration={fmt.duration(item.duration)} audio={audio} />

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
          {item.filesize ? <span>{fmt.bytes(item.filesize)}</span> : null}
          {item.filesize ? <span className="sep" /> : null}
          <span>{item.site}</span>
          {!item.enriched ? <span className="sep" /> : null}
          {!item.enriched ? <span style={{ color: 'var(--dimmer)' }}>{T.item.unknownDuration}</span> : null}
        </div>
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
                {download.status === 'paused' ? T.library.pause : fmt.speed(download.speed)}
              </span>
            </div>
          </div>
        ) : null}

        {status === 'queued' ? <Chip tone="signal">{T.item.inQueue}</Chip> : null}
        {status === 'done' ? <Chip tone="ok">{T.item.done}</Chip> : null}
        {status === 'error' ? <Chip tone="bad">{T.item.failed}</Chip> : null}

        {idle ? (
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
            <IconBtn icon="download" title={T.item.download} onClick={onDownload} />
          </>
        ) : null}

        {download && download.status === 'running' ? (
          <IconBtn icon="pause" title={T.library.pause} onClick={() => api.pause(download.id)} />
        ) : null}
        {download && download.status === 'paused' ? (
          <IconBtn icon="play" title={T.library.resume} onClick={() => api.resume(download.id)} />
        ) : null}
        {download && download.status === 'error' ? (
          <IconBtn icon="refresh" title={T.library.retry} onClick={() => api.retry(download.id)} />
        ) : null}
        {download && download.status === 'done' && download.filePath ? (
          <IconBtn
            icon="folder"
            title={T.library.reveal}
            onClick={() => api.revealFile(download.filePath as string)}
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
              {download && download.status === 'done' && download.filePath ? (
                <MenuItem
                  icon="play"
                  onClick={() => {
                    api.openFile(download.filePath as string)
                    close()
                  }}
                >
                  {T.library.open}
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
