import { useEffect, useState } from 'react'
import { api } from '../api'
import * as fmt from '../format'
import { T } from '../strings'
import type { VaultEntry, VaultState } from '../types'
import { Btn, Empty, Icon, IconBtn, Info, Menu, MenuItem, Modal } from '../components/ui'

interface Props {
  vault: VaultState
  autoLockMinutes: number
  onToast: (message: string, kind?: 'info' | 'warn' | 'error' | 'ok') => void
}

export default function Vault({ vault, autoLockMinutes, onToast }: Props) {
  if (!vault.exists) return <Setup vault={vault} onToast={onToast} />
  if (!vault.unlocked) return <Locked vault={vault} onToast={onToast} retryAfter={vault.retryAfter || 0} />
  return <Contents vault={vault} autoLockMinutes={autoLockMinutes} onToast={onToast} />
}

/* -------------------------------------------------------------------------- */
/* first run                                                                   */
/* -------------------------------------------------------------------------- */

function Setup({ vault, onToast }: { vault: VaultState; onToast: Props['onToast'] }) {
  const [pass, setPass] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)

  const short = pass.length > 0 && pass.length < 8
  const mismatch = again.length > 0 && pass !== again
  const ready = pass.length >= 8 && pass === again && !busy

  const create = async () => {
    if (!ready) return
    setBusy(true)
    const res = await api.vaultCreate(pass)
    setBusy(false)
    if (res) {
      setPass('')
      setAgain('')
      onToast(T.vault.created, 'ok')
    }
  }

  return (
    <div className="vault-gate">
      <div className="vault-card">
        <div className="vault-head">
          <Icon name="lock" size={18} />
          <span className="vault-title">{T.vault.setupTitle}</span>
        </div>
        <p className="vault-body">{T.vault.setupBody}</p>

        <label className="vault-field">
          <span>{T.vault.passphrase}</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={pass}
            autoFocus
            spellCheck={false}
            onChange={(e) => setPass(e.target.value)}
          />
        </label>
        <label className="vault-field">
          <span>{T.vault.passphraseAgain}</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={again}
            spellCheck={false}
            onChange={(e) => setAgain(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
        </label>

        {short ? <p className="vault-warn">{T.vault.tooShort}</p> : null}
        {mismatch ? <p className="vault-warn">{T.vault.mismatch}</p> : null}

        <p className="vault-warn strong">{T.vault.noRecovery}</p>

        <Btn variant="primary" icon="lock" disabled={!ready} spinning={busy} onClick={create}>
          {T.vault.create}
        </Btn>

        <TouchIDPanel vault={vault} disabled={busy} />

        <details className="vault-detail">
          <summary>{T.vault.howTitle}</summary>
          <ul>
            {T.vault.how.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* locked                                                                      */
/* -------------------------------------------------------------------------- */

function Locked({ vault, onToast, retryAfter }: { vault: VaultState; onToast: Props['onToast']; retryAfter: number }) {
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState<'password' | 'biometric' | null>(null)

  const [remaining, setRemaining] = useState(retryAfter)
  useEffect(() => {
    setRemaining(retryAfter)
    const timer = window.setInterval(() => setRemaining((v) => Math.max(0, v - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [retryAfter])

  const unlockBiometric = async () => {
    if (busy) return
    setBusy('biometric')
    try {
      const res = await api.vaultUnlockBiometric()
      if (res) onToast(T.vault.unlocked, 'ok')
    } finally { setBusy(null) }
  }

  const unlock = async () => {
    if (!pass || busy || remaining > 0) return
    setBusy('password')
    try {
      const res = await api.vaultUnlock(pass)
      if (res) onToast(T.vault.unlocked, 'ok')
    } finally {
      setBusy(null)
      // Clear after either result, including a disconnected bridge.
      setPass('')
    }
  }

  return (
    <div className="vault-gate">
      <div className="vault-card">
        <div className="vault-head">
          <Icon name="lock" size={18} />
          <span className="vault-title">{T.vault.lockedTitle}</span>
        </div>
        <p className="vault-body">{T.vault.lockedBody}</p>

        <TouchIDPanel vault={vault} disabled={!!busy} unlocking={busy === 'biometric'} onUnlock={unlockBiometric} />

        <label className="vault-field">
          <span>{T.vault.passphrase}</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={pass}
            autoFocus
            spellCheck={false}
            onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && unlock()}
          />
        </label>

        {remaining > 0 ? <p className="vault-warn" role="status">{T.vault.retry(remaining)}</p> : null}

        <Btn variant={vault.biometricAvailable && vault.biometricReady ? 'default' : 'primary'} icon="unlock" disabled={!pass || !!busy || remaining > 0} spinning={busy === 'password'} onClick={unlock}>
          {T.vault.unlock}
        </Btn>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* unlocked                                                                    */
/* -------------------------------------------------------------------------- */

function Contents({
  vault,
  autoLockMinutes,
  onToast,
}: {
  vault: VaultState
  autoLockMinutes: number
  onToast: Props['onToast']
}) {
  const [pendingRemove, setPendingRemove] = useState<VaultEntry | null>(null)
  const [busy, setBusy] = useState(false)
  const [changing, setChanging] = useState(false)

  const totalSize = vault.entries.reduce((sum, e) => sum + (e.size || 0), 0)

  const addFiles = async () => {
    setBusy(true)
    const res = await api.vaultAddFiles()
    setBusy(false)
    if (res && res.added) onToast(T.vault.addedFiles(res.added), 'ok')
  }

  return (
    <>
      <section className="section">
        <div className="section-head">
          <span className="label">{T.vault.title}</span>
          <span className="count">{vault.entries.length}</span>
          <span className="spacer" />
          <span className="vault-status">
            <Icon name="unlock" size={12} />
            {autoLockMinutes > 0 ? T.vault.autoLockNote(autoLockMinutes) : T.vault.autoLockOff}
          </span>
          <Btn size="sm" variant="ghost" icon="plus" spinning={busy} onClick={addFiles}>
            {T.vault.addFiles}
          </Btn>
          <Btn size="sm" variant="ghost" icon="pencil" onClick={() => setChanging(true)}>
            {T.vault.changeTitle}
          </Btn>
          <Btn size="sm" icon="lock" onClick={() => api.vaultLock()}>
            {T.vault.lock}
          </Btn>
        </div>

        <TouchIDPanel vault={vault} disabled={busy} onToast={onToast} />

        {vault.upgrading ? (
          <div className="banner" style={{ marginBottom: 10 }}>
            <Icon name="spinner" size={14} className="spin" />
            <span className="grow">{T.vault.upgrading(vault.upgrading)}</span>
          </div>
        ) : null}

        {vault.entries.length ? (
          <div className="card">
            {vault.entries.map((entry) => (
              <div key={entry.id} className="vault-row">
                {entry.thumb ? (
                  <span className="vault-poster">
                    <img src={entry.thumb} alt="" />
                    {entry.duration ? (
                      <span className="vault-poster-time">{fmt.duration(entry.duration)}</span>
                    ) : null}
                  </span>
                ) : (
                  <span className="vault-glyph">
                    <Icon name="lock" size={15} />
                  </span>
                )}

                <div className="vault-ident">
                  <span className="vault-name clamp2" title={entry.name}>
                    {entry.title || entry.name}
                  </span>
                  <div className="row-meta">
                    <span>{fmt.bytes(entry.size)}</span>
                    {entry.duration ? <span className="sep" /> : null}
                    {entry.duration ? <span>{fmt.duration(entry.duration)}</span> : null}
                    {entry.site ? <span className="sep" /> : null}
                    {entry.site ? <span className="truncate">{entry.site}</span> : null}
                    <span className="sep" />
                    <span>{fmt.relativeTime(entry.addedAt)}</span>
                  </div>
                </div>

                <div className="dl-actions">
                  <IconBtn
                    icon="play"
                    title={T.vault.open}
                    onClick={async () => {
                      const res = await api.vaultOpen(entry.id)
                      if (res) onToast(T.vault.opened, 'info')
                    }}
                  />
                  <Menu title={T.common.more}>
                    {(close) => (
                      <>
                        <MenuItem
                          icon="play"
                          onClick={() => {
                            api.vaultOpenExternal(entry.id)
                            close()
                          }}
                        >
                          {T.vault.openExternal}
                        </MenuItem>
                        <MenuItem
                          icon="folder"
                          onClick={() => {
                            api.vaultExport(entry.id)
                            close()
                          }}
                        >
                          {T.vault.export}
                        </MenuItem>
                        <div className="menu-sep" />
                        <MenuItem
                          icon="trash"
                          danger
                          onClick={() => {
                            setPendingRemove(entry)
                            close()
                          }}
                        >
                          {T.vault.remove}
                        </MenuItem>
                      </>
                    )}
                  </Menu>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty icon="lock" title={T.vault.emptyTitle} body={T.vault.emptyBody} />
        )}
      </section>

      <p className="vault-foot">
        <span className="info-wrap">
          <span>
            {vault.entries.length
              ? T.vault.footer(vault.entries.length, fmt.bytes(totalSize))
              : T.vault.footerEmpty}
          </span>
          <Info label={T.vault.howTitle}>
            <p style={{ marginTop: 0 }}>{T.vault.whereTitle}</p>
            <code className="mono" style={{ wordBreak: 'break-all', fontSize: 11 }}>
              {vault.dir}
            </code>
            <p>{T.vault.whereBody}</p>
            <p style={{ marginBottom: 4 }}>{T.vault.howTitle}</p>
            <ul style={{ margin: 0, paddingLeft: 16 }}>
              {T.vault.how.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Info>
        </span>
        <Btn size="sm" variant="ghost" icon="folder" onClick={() => api.revealFile(vault.dir)}>
          {T.vault.reveal}
        </Btn>
      </p>

      {changing ? <ChangePassphrase onClose={() => setChanging(false)} onToast={onToast} /> : null}

      {pendingRemove ? (
        <Modal
          title={T.vault.removeTitle}
          onClose={() => setPendingRemove(null)}
          footer={
            <>
              <Btn onClick={() => setPendingRemove(null)}>{T.confirm.cancel}</Btn>
              <Btn
                variant="primary"
                onClick={() => {
                  api.vaultRemove(pendingRemove.id)
                  setPendingRemove(null)
                }}
              >
                {T.confirm.confirm}
              </Btn>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>{T.vault.removeBody(pendingRemove.title || pendingRemove.name)}</p>
        </Modal>
      ) : null}
    </>
  )
}

/* A visible path through setup, readiness and recovery, even when macOS cannot
 * currently authenticate. Hiding this section made the feature undiscoverable. */
function TouchIDPanel({
  vault,
  disabled = false,
  unlocking = false,
  onUnlock,
  onToast,
}: {
  vault: VaultState
  disabled?: boolean
  unlocking?: boolean
  onUnlock?: () => void
  onToast?: Props['onToast']
}) {
  const [working, setWorking] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const available = !!vault.biometricAvailable
  const enrolled = !!vault.biometricEnabled
  const ready = !!vault.biometricReady
  const checking = vault.biometricStatus === 'checking' || !vault.biometricStatus
  const inactive = disabled || working || refreshing
  const label = checking ? 'Denetleniyor' : !available ? 'Kullanılamıyor' : enrolled && ready ? 'Etkin' : enrolled ? 'Yeniden kurulum gerekli' : 'Kurulum gerekli'

  // Returning from System Settings updates enrollment/sensor state without an
  // authentication prompt. The status IPC broadcasts the refreshed capability.
  useEffect(() => {
    const refresh = () => { void api.vaultStatus() }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  const refresh = async () => {
    setRefreshing(true)
    try { await api.vaultStatus() } finally { setRefreshing(false) }
  }
  const setEnrollment = async (enabled: boolean) => {
    if (inactive) return
    setWorking(true)
    try {
      const res = await api.vaultSetBiometric(enabled)
      if (res) onToast?.(res.biometricEnabled ? 'Touch ID etkin. Kasa kilitliyken parmak izinle açabilirsin.' : 'Touch ID kapatıldı. Kasanı şifrenle açabilirsin.', 'ok')
    } finally { setWorking(false) }
  }

  let description: string
  if (checking) description = 'Bu Mac’in Touch ID durumu kontrol ediliyor.'
  else if (!available) description = vault.biometricReason || 'Touch ID şu anda kullanılamıyor. Kasanı şifrenle açabilirsin.'
  else if (!vault.exists) description = 'Önce kasa şifreni oluştur. Ardından bu bölümden Touch ID’yi etkinleştirip sonraki açılışlarda parmak izini kullanabilirsin.'
  else if (!vault.unlocked && !enrolled) description = 'İlk kurulum için kasayı aşağıdan şifrenle aç. Ardından burada “Touch ID’yi etkinleştir”i seç; sonraki açılışlarda parmak izini kullan.'
  else if (!ready && enrolled) description = vault.biometricReason || 'Kasayı şifrenle açıp Touch ID’yi yeniden etkinleştir.'
  else if (vault.upgrading) description = 'Kasa yükseltmesi tamamlanınca Touch ID’yi etkinleştirebilirsin.'
  else if (enrolled) description = 'Kasa bu Mac’te parmak izinle açılabilir. Kasa şifreni kurtarma ve yeniden kurulum için sakla.'
  else description = 'Touch ID’yi bir kez doğrula; kasa kilitliyken parmak izinle aç. Kasa şifren kaydedilmez.'

  return (
    <section aria-label="Touch ID ile kasa erişimi" style={{ border: '1px solid var(--rule)', borderRadius: 'var(--r)', background: 'var(--panel-2)', padding: 14, marginBottom: vault.unlocked ? 14 : 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
        <svg width="21" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" style={{ flex: 'none', color: 'var(--dim)' }}>
          <path d="M4 10a8 8 0 0 1 16 0M2.5 14v-3M21.5 11v4M7 20c2-3 2-6 2-9a3 3 0 0 1 6 0c0 5-.5 8-2 11M5 16v-5a7 7 0 0 1 .6-2.8M7 6.3A7 7 0 0 1 19 11c0 4-.3 7-1.2 9.2M12 11c0 4-.1 7-1.6 10M4 20l1-2M15 18.5l-.5 2" />
        </svg>
        <strong style={{ fontSize: 13 }}>Touch ID · Parmak izi</strong>
        <span className="vault-status" role="status" style={{ marginLeft: 'auto', textAlign: 'right', color: enrolled && ready && available ? 'var(--text)' : 'var(--dim)' }}>
          {enrolled && ready && available ? <Icon name="check" size={12} /> : null}{label}
        </span>
      </div>
      <p className="vault-body">{description}</p>
      {(vault.unlocked || (available && enrolled && ready && onUnlock) || (!available && !checking)) ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 12 }}>
          {available && enrolled && ready && !vault.unlocked && onUnlock ? (
            <Btn variant="primary" disabled={inactive} spinning={unlocking} onClick={onUnlock}>Touch ID ile aç</Btn>
          ) : null}
          {vault.unlocked && available ? (
            <Btn variant={enrolled && ready ? 'default' : 'primary'} disabled={inactive || !!vault.upgrading} spinning={working} onClick={() => setEnrollment(true)}>
              {enrolled ? 'Touch ID’yi yeniden etkinleştir' : 'Touch ID’yi etkinleştir'}
            </Btn>
          ) : null}
          {vault.unlocked && enrolled ? (
            <Btn size="sm" variant="ghost" disabled={inactive} spinning={working} onClick={() => setEnrollment(false)}>Touch ID’yi kapat</Btn>
          ) : null}
          {!available && vault.biometricAction === 'system-settings' ? (
            <Btn size="sm" variant="ghost" icon="external" disabled={inactive} onClick={() => api.openTouchIdSettings()}>Touch ID ayarlarını aç</Btn>
          ) : null}
          {!checking && vault.biometricStatus !== 'unsupported-platform' && (!available || (vault.unlocked && !enrolled)) ? (
            <Btn size="sm" variant="ghost" icon="refresh" disabled={inactive} spinning={refreshing} onClick={refresh}>Yeniden denetle</Btn>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* changing the passphrase                                                     */
/* -------------------------------------------------------------------------- */

function ChangePassphrase({ onClose, onToast }: { onClose: () => void; onToast: Props['onToast'] }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const short = next.length > 0 && next.length < 8
  const mismatch = again.length > 0 && next !== again
  const ready = !!current && next.length >= 8 && next === again && !busy

  const submit = async () => {
    if (!ready) return
    setBusy(true)
    const res = await api.vaultChangePassphrase(current, next)
    setBusy(false)
    setCurrent('')
    if (res) {
      onToast(T.vault.changed, 'ok')
      onClose()
    }
  }

  return (
    <Modal
      title={T.vault.changeTitle}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>{T.confirm.cancel}</Btn>
          <Btn variant="primary" icon="lock" disabled={!ready} spinning={busy} onClick={submit}>
            {T.vault.changeTitle}
          </Btn>
        </>
      }
    >
      {(
        [
          [T.vault.currentPass, current, setCurrent],
          [T.vault.newPass, next, setNext],
          [T.vault.newPassAgain, again, setAgain],
        ] as [string, string, (v: string) => void][]
      ).map(([label, value, set], i) => (
        <label key={label} className="vault-field">
          <span>{label}</span>
          <input
            className="input"
            type="password"
            value={value}
            autoFocus={i === 0}
            spellCheck={false}
            onChange={(e) => set(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </label>
      ))}
      {short ? <p className="vault-warn">{T.vault.tooShort}</p> : null}
      {mismatch ? <p className="vault-warn">{T.vault.mismatch}</p> : null}
    </Modal>
  )
}
