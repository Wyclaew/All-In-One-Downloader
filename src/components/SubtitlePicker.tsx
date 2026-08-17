import { useEffect, useState } from 'react'
import { api } from '../api'
import { T } from '../strings'
import type { Download, SubtitleHit, SubtitleSearch } from '../types'
import { Btn, Chip, Icon, IconBtn, Modal } from './ui'

interface Props {
  download: Download
  onClose: () => void
  onToast: (message: string, kind?: 'info' | 'warn' | 'error' | 'ok') => void
  onOpenSettings: () => void
}

export default function SubtitlePicker({ download, onClose, onToast, onOpenSettings }: Props) {
  const [state, setState] = useState<SubtitleSearch | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [editingQuery, setEditingQuery] = useState(false)

  const run = async (overrideQuery?: string) => {
    setLoading(true)
    setError(null)
    const res = await api.searchSubtitles({
      downloadId: download.id,
      ...(overrideQuery ? { query: overrideQuery } : {}),
    })
    setLoading(false)
    if (!res) {
      // The bridge already surfaced the reason as a toast; keep the panel quiet.
      setError('search-failed')
      return
    }
    setState(res)
    if (!query) setQuery(res.parsed.title || download.title)
  }

  useEffect(() => {
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [download.id])

  const apply = async (hit: SubtitleHit) => {
    setApplying(hit.fileId)
    const outcome = await api.applySubtitle({
      downloadId: download.id,
      fileId: hit.fileId,
      language: hit.language,
      hashMatch: hit.hashMatch,
    })
    setApplying(null)
    if (!outcome) return
    const extra = outcome.notes.length ? ` — ${outcome.notes.join(' ')}` : ''
    onToast(`${T.subs.added} (${hit.language})${extra}`, 'ok')
    onClose()
  }

  const results = state ? state.results : []

  return (
    <Modal
      title={T.subs.title}
      onClose={onClose}
      footer={
        <>
          <Btn variant="ghost" icon="refresh" onClick={() => run(query)} disabled={loading}>
            {T.subs.searchAgain}
          </Btn>
          <Btn onClick={onClose}>{T.common.close}</Btn>
        </>
      }
    >
      <p className="subs-file truncate" title={download.title}>
        {download.title}
      </p>

      {editingQuery ? (
        <div className="set-inline" style={{ marginBottom: 12 }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 0 }}
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setEditingQuery(false)
                run(query)
              }
            }}
          />
          <Btn
            size="sm"
            variant="primary"
            onClick={() => {
              setEditingQuery(false)
              run(query)
            }}
          >
            {T.compose.submit}
          </Btn>
        </div>
      ) : null}

      {loading ? (
        <div className="subs-state">
          <Icon name="spinner" className="spin" />
          <span>{T.subs.searching}</span>
        </div>
      ) : null}

      {!loading && error ? (
        <div className="subs-state">
          <span>{T.subs.noKey}</span>
          <span className="dim" style={{ fontSize: 11.5 }}>
            {T.subs.noKeyHow}
          </span>
          <Btn
            size="sm"
            icon="sliders"
            onClick={() => {
              onOpenSettings()
              onClose()
            }}
          >
            {T.subs.openSettings}
          </Btn>
        </div>
      ) : null}

      {!loading && !error && state ? (
        <>
          <p className="subs-note">{state.hashed && results.some((r) => r.hashMatch) ? T.subs.hashNote : T.subs.queryNote}</p>

          {!results.length ? (
            <div className="subs-state">
              <span>{T.subs.none}</span>
              <Btn size="sm" icon="search" onClick={() => setEditingQuery(true)}>
                {T.subs.searchAgain}
              </Btn>
            </div>
          ) : (
            <ul className="subs-list scroll">
              {results.map((hit) => (
                <li key={hit.fileId} className="subs-row">
                  <div className="subs-ident">
                    <div className="subs-line">
                      <Chip tone={hit.hashMatch ? 'ok' : undefined} lang="en">
                        {hit.language || '??'}
                      </Chip>
                      {hit.recommended ? <Chip tone="ok">{T.subs.recommended}</Chip> : null}
                      {hit.hashMatch ? <Chip tone="ok">{T.subs.inSync}</Chip> : null}
                      {hit.machine ? <Chip>{T.subs.machine}</Chip> : null}
                      {hit.hearingImpaired ? <Chip>SDH</Chip> : null}
                    </div>
                    <span className="subs-release truncate" title={hit.release || hit.fileName}>
                      {hit.release || hit.fileName}
                    </span>
                    {/* The order is a judgement, so it says what the judgement
                        was rather than leaving the user to infer it. */}
                    <span className="subs-meta mono">
                      {hit.why || `${hit.downloads.toLocaleString('tr-TR')} ${T.subs.downloads}`}
                      {hit.uploader ? ` · ${hit.uploader}` : ''}
                    </span>
                  </div>
                  <Btn
                    size="sm"
                    variant={hit.hashMatch ? 'primary' : 'default'}
                    icon="download"
                    spinning={applying === hit.fileId}
                    disabled={applying !== null}
                    onClick={() => apply(hit)}
                  >
                    {applying === hit.fileId ? T.subs.applying : T.subs.apply}
                  </Btn>
                </li>
              ))}
            </ul>
          )}

          {results.length && !editingQuery ? (
            <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
              <IconBtn icon="search" title={T.subs.searchAgain} onClick={() => setEditingQuery(true)} />
            </div>
          ) : null}
        </>
      ) : null}
    </Modal>
  )
}
