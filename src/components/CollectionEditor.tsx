import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { CollectionEditPreview, CollectionEditRequest, CollectionEditResult, Download } from '../types'
import { Btn, Modal } from './ui'

type Mode = 'preserve' | 'set' | 'clear'
type Props = { downloads: Download[]; onClose: () => void; onApplied: (result: CollectionEditResult) => void }
const common = <T,>(values: T[]): T | undefined => values.length && values.every((value) => value === values[0]) ? values[0] : undefined
const episodeLabel = (value: { season: number | null; episode: number | null }) => [value.season === null ? null : `S${value.season}`, value.episode === null ? null : `B${value.episode}`].filter(Boolean).join(' · ') || 'Numara yok'

export default function CollectionEditor({ downloads, onClose, onApplied }: Props) {
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const [seriesMode, setSeriesMode] = useState<Mode>(() => common(downloads.map((download) => download.series || '')) === undefined ? 'preserve' : 'set')
  const [series, setSeries] = useState(() => common(downloads.map((download) => download.series || '')) || '')
  const [seasonMode, setSeasonMode] = useState<Mode>('preserve')
  const [season, setSeason] = useState(() => String(common(downloads.map((download) => download.season ?? null)) ?? 1))
  const [episodeMode, setEpisodeMode] = useState<Mode>('preserve')
  const [episode, setEpisode] = useState('1')
  const [order, setOrder] = useState<'existing' | 'title' | 'created'>('existing')
  const [preview, setPreview] = useState<CollectionEditPreview | null>(null)
  const [previewFor, setPreviewFor] = useState('')
  const [working, setWorking] = useState<'preview' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const dialog = document.querySelector('.collection-fields')?.closest<HTMLElement>('[role="dialog"]')
    if (!dialog) return
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'))
    if (!dialog.contains(document.activeElement)) controls()[0]?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const elements = controls(), first = elements[0], last = elements.at(-1)
      if (!first || !last) { event.preventDefault(); return }
      if (!dialog.contains(document.activeElement) || !event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    }
    document.addEventListener('keydown', trap)
    return () => { document.removeEventListener('keydown', trap); if (opener.current?.isConnected) opener.current.focus() }
  }, [])
  const request: CollectionEditRequest = useMemo(() => ({
    ids: downloads.map((download) => download.id), order,
    ...(seriesMode === 'preserve' ? {} : { series: seriesMode === 'clear' ? null : series.trim() || null }),
    ...(seasonMode === 'preserve' ? {} : { season: seasonMode === 'clear' ? null : Number(season) }),
    ...(episodeMode === 'preserve' ? {} : { episodeStart: episodeMode === 'clear' ? null : Number(episode) }),
  }), [downloads, seriesMode, series, order, seasonMode, season, episodeMode, episode])
  const signature = JSON.stringify(request)
  const current = preview && previewFor === signature ? preview : null
  const valid = downloads.length <= 1000 && (seriesMode !== 'set' || series.trim().length <= 160) &&
    (seasonMode !== 'set' || season.trim() !== '' && Number.isInteger(Number(season)) && Number(season) >= 0 && Number(season) <= 999) &&
    (episodeMode !== 'set' || episode.trim() !== '' && Number.isInteger(Number(episode)) && Number(episode) >= 1 && Number(episode) + downloads.length - 1 <= 9999)

  const inspect = async () => {
    if (!valid || working) return
    setWorking('preview'); setError(null)
    const result = await api.previewCollectionEdit(request)
    setWorking(null)
    if (result) { setPreview(result); setPreviewFor(signature) }
    else { setPreview(null); setError('Önizleme hazırlanamadı. Bilgileri kontrol edip yeniden dene.') }
  }
  const save = async () => {
    if (!current || working) return
    setWorking('save'); setError(null)
    const result = await api.applyCollectionEdit({ ...request, revision: current.revision })
    setWorking(null)
    if (result) onApplied(result)
    else { setPreview(null); setError('Düzenleme kaydedilemedi. Önizlemeyi yenileyip tekrar dene.') }
  }
  return <Modal title={downloads.length > 1 ? `${downloads.length} videonun dizi / bölüm bilgileri` : 'Dizi / bölüm bilgilerini düzenle'} onClose={working ? () => {} : onClose} footer={<>
    <Btn disabled={!!working} onClick={onClose}>Vazgeç</Btn>
    <Btn disabled={!!working || !valid} spinning={working === 'preview'} onClick={inspect}>Önizle</Btn>
    <Btn variant="primary" disabled={!!working || !valid || !current} spinning={working === 'save'} onClick={save}>Değişiklikleri kaydet</Btn>
  </>}>
    <p className="collection-intro">Bölümleri aynı koleksiyonda topla ve sıralarını düzenle. Dosya adları ve indirme durumu korunur.</p>
    <fieldset className="collection-fields" disabled={!!working}>
      <label className="collection-field"><span>Dizi / koleksiyon adı</span><select className="select" aria-label="Koleksiyon adı düzenlemesi" value={seriesMode} onChange={(event) => setSeriesMode(event.target.value as Mode)}><option value="preserve">Mevcut koleksiyonları koru</option><option value="set">Aynı koleksiyonda topla</option><option value="clear">Koleksiyon bağlantısını kaldır</option></select>{seriesMode === 'set' ? <input className="input" aria-label="Dizi / koleksiyon adı" autoFocus autoComplete="off" maxLength={160} placeholder="Örn. The Mentalist" value={series} onChange={(event) => setSeries(event.target.value)} /> : null}<small>{seriesMode === 'set' ? 'Boş ad seçilen videoların koleksiyon bağlantısını kaldırır.' : 'Bölüm bilgileri ayrıca seçtiğin işleme göre düzenlenir.'}</small></label>
      <div className="collection-pair">
        <label className="collection-field"><span>Sezon</span><select className="select" aria-label="Sezon düzenlemesi" value={seasonMode} onChange={(event) => setSeasonMode(event.target.value as Mode)}><option value="preserve">Mevcut sezonları koru</option><option value="set">Hepsine sezon ata</option><option value="clear">Sezon bilgisini temizle</option></select>{seasonMode === 'set' ? <input className="input" type="number" min={0} max={999} step={1} inputMode="numeric" aria-label="Sezon numarası" value={season} onChange={(event) => setSeason(event.target.value)} /> : null}</label>
        <label className="collection-field"><span>Bölüm numarası</span><select className="select" aria-label="Bölüm numarası düzenlemesi" value={episodeMode} onChange={(event) => setEpisodeMode(event.target.value as Mode)}><option value="preserve">Mevcut numaraları koru</option><option value="set">Sırayla numaralandır</option><option value="clear">Bölüm numaralarını temizle</option></select>{episodeMode === 'set' ? <input className="input" type="number" min={1} max={9999} step={1} inputMode="numeric" aria-label="İlk bölüm numarası" value={episode} onChange={(event) => setEpisode(event.target.value)} /> : null}</label>
      </div>
      <label className="collection-field"><span>{episodeMode === 'set' ? 'Numaralandırma sırası' : 'Önizleme sırası'}</span><select className="select" aria-label="Bölüm sıralaması" value={order} onChange={(event) => setOrder(event.target.value as typeof order)}><option value="existing">Mevcut sezon / bölüm sırası</option><option value="title">Başlık (1, 2, 10 sırasıyla)</option><option value="created">Eklenme tarihi (eskiden yeniye)</option></select></label>
    </fieldset>
    {!valid ? <p className="collection-error" role="status">En çok 1000 video seçilebilir. Sezon 0–999, bölüm 1–9999 arasında tam sayı olmalı; son bölüm de sınırı aşamaz.</p> : null}
    {error ? <p className="collection-error" role="status">{error}</p> : null}
    {current ? <div className="collection-preview" aria-label="Koleksiyon düzenleme önizlemesi">
      <p><strong>{current.count} video</strong> · {seriesMode === 'preserve' ? 'Mevcut koleksiyon adları korunacak' : current.rows[0]?.after.series || 'Bağımsız videolar'}</p>
      <ol>{current.rows.slice(0, 8).map((row) => <li key={row.id}><span className="truncate" title={row.title}>{row.title}</span><span className="mono">{episodeLabel(row.before)} → {episodeLabel(row.after)}</span></li>)}</ol>
      {current.count > 8 ? <p className="dim">Diğer {current.count - 8} video da seçtiğin sıraya göre düzenlenecek.</p> : null}
    </div> : <p className="collection-preview-note" role="status">Kaydetmeden önce bölüm sırasını Önizle ile kontrol et.</p>}
  </Modal>
}
