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
  if (!vault.exists) return <Setup onToast={onToast} />
  if (!vault.unlocked) return <Locked vault={vault} onToast={onToast} retryAfter={vault.retryAfter || 0} />
  return <Contents vault={vault} autoLockMinutes={autoLockMinutes} onToast={onToast} />
}

/* -------------------------------------------------------------------------- */
/* first run                                                                   */
/* -------------------------------------------------------------------------- */

function Setup({ onToast }: { onToast: Props['onToast'] }) {
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
  const [busy, setBusy] = useState(false)

  const [remaining, setRemaining] = useState(retryAfter)
  useEffect(() => {
    setRemaining(retryAfter)
    const timer = window.setInterval(() => setRemaining((v) => Math.max(0, v - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [retryAfter])

  const unlockBiometric = async () => {
    if (busy) return
    setBusy(true)
    const res = await api.vaultUnlockBiometric()
    setBusy(false)
    if (res) onToast(T.vault.unlocked, 'ok')
  }

  const unlock = async () => {
    if (!pass || busy || remaining > 0) return
    setBusy(true)
    const res = await api.vaultUnlock(pass)
    setBusy(false)
    // The passphrase leaves the interface either way: on success it is no longer
    // needed, on failure it should not sit in a field waiting to be retried blind.
    setPass('')
    if (res) onToast(T.vault.unlocked, 'ok')
  }

  return (
    <div className="vault-gate">
      <div className="vault-card">
        <div className="vault-head">
          <Icon name="lock" size={18} />
          <span className="vault-title">{T.vault.lockedTitle}</span>
        </div>
        <p className="vault-body">{T.vault.lockedBody}</p>

        <label className="vault-field">
          <span>{T.vault.passphrase}</span>
          <input
            className="input"
            type="password"
            value={pass}
            autoFocus
            spellCheck={false}
            onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && unlock()}
          />
        </label>

        {remaining > 0 ? <p className="vault-warn" role="status">{T.vault.retry(remaining)}</p> : null}

        <Btn variant="primary" icon="unlock" disabled={!pass || busy || remaining > 0} spinning={busy} onClick={unlock}>
          {T.vault.unlock}
        </Btn>
        {vault.biometricAvailable && vault.biometricEnabled ? (
          <Btn variant="ghost" icon="unlock" disabled={busy} spinning={busy} onClick={unlockBiometric}>Touch ID ile aç</Btn>
        ) : null}
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
          {vault.biometricAvailable ? (
            <Btn size="sm" variant="ghost" icon="unlock" disabled={busy || !!vault.upgrading} onClick={async () => {
              setBusy(true)
              const res = await api.vaultSetBiometric(!vault.biometricEnabled)
              setBusy(false)
              if (res) onToast(res.biometricEnabled ? 'Touch ID etkinleştirildi.' : 'Touch ID kapatıldı.', 'ok')
            }}>{vault.biometricEnabled ? 'Touch ID’yi kapat' : 'Touch ID’yi etkinleştir'}</Btn>
          ) : null}
          <Btn size="sm" icon="lock" onClick={() => api.vaultLock()}>
            {T.vault.lock}
          </Btn>
        </div>

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
