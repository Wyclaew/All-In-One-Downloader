import { useEffect, useState } from 'react'
import { api, bridge } from '../api'
import type { UpdateState } from '../types'
import { Btn, Icon, IconBtn } from './ui'

/**
 * "A new version is out" — shown once, at the top, with one button that does
 * the whole update. Dismissing it hides it for that version only.
 */
export default function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [hidden, setHidden] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api.updateStatus().then((u) => alive && u && setUpdate(u))
    const off = bridge.onUpdate((u) => setUpdate(u))
    return () => {
      alive = false
      off()
    }
  }, [])

  if (!update) return null
  const busy = update.phase === 'downloading' || update.phase === 'installing'
  if (!busy && update.phase !== 'available') return null
  if (!busy && hidden === update.latest) return null

  return (
    <div className="update-banner">
      <Icon name={busy ? 'spinner' : 'download'} size={15} className={busy ? 'spin' : undefined} />
      <span className="grow">
        {update.phase === 'downloading' ? (
          <>
            <b>v{update.latest}</b> indiriliyor… %{update.percent}
          </>
        ) : update.phase === 'installing' ? (
          update.message
        ) : (
          <>
            <b>Yeni sürüm mevcut: v{update.latest}</b>
            <span className="dim"> (şu an v{update.current})</span>
            {update.message ? <span className="bad"> — {update.message}</span> : null}
          </>
        )}
      </span>
      {update.phase === 'available' ? (
        <>
          <Btn size="sm" variant="ghost" onClick={() => api.openExternal(update.url)}>
            Neler yeni
          </Btn>
          <Btn size="sm" variant="primary" icon="download" onClick={() => api.updateInstall()}>
            {update.automatic ? 'İndir ve güncelle' : 'İndirme sayfasını aç'}
          </Btn>
          <IconBtn icon="x" title="Şimdilik gizle" size={12} onClick={() => setHidden(update.latest)} />
        </>
      ) : null}
      {update.phase === 'downloading' ? (
        <span className="update-meter">
          <span style={{ width: `${update.percent}%` }} />
        </span>
      ) : null}
    </div>
  )
}
