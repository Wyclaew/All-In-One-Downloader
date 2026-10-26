import { useEffect, useState } from 'react'
import { api, bridge } from '../api'
import type { Download, MediaInspection } from '../types'
import { Btn, Modal } from './ui'
import * as fmt from '../format'

export default function MediaHealth({ download, onClose }: { download: Download; onClose: () => void }) {
  const [report, setReport] = useState<MediaInspection | null>(null)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(true)
  useEffect(() => {
    let alive = true
    bridge.inspectDownloadMedia(download.id).then((result) => {
      if (!alive) return
      if (result.ok && result.data) setReport(result.data)
      else setError(result.ok ? 'Kontrol iptal edildi.' : result.error)
      setChecking(false)
    }).catch(() => { if (alive) { setError('Dosya kontrolü tamamlanamadı. Yeniden deneyebilirsin.'); setChecking(false) } })
    return () => { alive = false; void api.cancelDownloadMediaCheck(download.id) }
  }, [download.id])
  const close = () => { if (checking) void api.cancelDownloadMediaCheck(download.id); onClose() }
  const summary = report?.kind === 'matching-audio-video-gaps'
    ? 'Ses ve görüntüde aynı noktalarda boşluklar bulundu. Takılmanın nedeni dosyadaki eksik içerik olabilir.'
    : report?.kind === 'timing-variation'
      ? 'Zamanlama değişiklikleri bulundu. Bunlar değişken kare hızlı bir videoda normal olabilir; tek başına bozukluk kanıtı değildir.'
      : 'Belirgin zamanlama boşluğu bulunmadı.'
  return <Modal title="Videonun zamanlamasını kontrol et" onClose={close} footer={<Btn autoFocus onClick={close}>{checking ? 'Durdur ve kapat' : 'Kapat'}</Btn>}>
    <p className="clamp2">{download.title}</p>
    {checking ? <p role="status">Dosyadaki ses ve görüntü paketleri inceleniyor. Büyük dosyalarda iki dakikaya kadar sürebilir.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {report ? <>
      <p role="status">{summary}</p>
      <dl className="media-health-facts">
        <dt>Birlikte kesilen ses / görüntü</dt><dd>{report.correlatedGaps}</dd>
        <dt>En uzun görüntü beklemesi</dt><dd>{report.longestVideoHold.toFixed(2)} sn</dd>
        <dt>İncelenen paket</dt><dd>{report.packetCount.toLocaleString('tr-TR')}</dd>
        <dt>Görüntü</dt><dd>{report.video ? `${report.video.codec.toUpperCase()} · ${report.video.width || '?'} × ${report.video.height || '?'}` : 'Görüntü izi yok'}</dd>
        <dt>Ses</dt><dd>{report.audio.length ? report.audio.map((track) => `${fmt.audioLanguage(track.language)} (${track.codec.toUpperCase()})`).join(', ') : 'Ses izi yok'}</dd>
      </dl>
      {report.firstCorrelatedGaps.length ? <p>İlk kesintiler: {report.firstCorrelatedGaps.map((gap) => `${fmt.duration(gap.at)} (${gap.duration.toFixed(1)} sn)`).join(', ')}</p> : null}
      <p className="dim">Bu kontrol dosyayı değiştirmez; her karenin çözülebildiğini veya kaynağın tüm sahneleri içerdiğini doğrulamaz. Eksik içerik için farklı bir kaynaktan yeniden indirme gerekebilir.</p>
    </> : null}
  </Modal>
}
