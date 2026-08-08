import { useState } from 'react'
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
  if (!vault.unlocked) return <Locked onToast={onToast} />
  return <Contents vault={vault} autoLockMinutes={autoLockMinutes} onToast={onToast} />
}

/* -------------------------------------------------------------------------- */
/* first run                                                                   */
/* -------------------------------------------------------------------------- */

function Setup({ onToast }: { onToast: Props['onToast'] }) {
  const [pass, setPass] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)

  const short = pass.length > 0 && pass.length < 6
  const mismatch = again.length > 0 && pass !== again
  const ready = pass.length >= 6 && pass === again && !busy

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

function Locked({ onToast }: { onToast: Props['onToast'] }) {
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)

  const unlock = async () => {
    if (!pass || busy) return
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

        <Btn variant="primary" icon="unlock" disabled={!pass || busy} spinning={busy} onClick={unlock}>
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
          <Btn size="sm" icon="lock" onClick={() => api.vaultLock()}>
            {T.vault.lock}
          </Btn>
        </div>

        {vault.entries.length ? (
          <div className="card">
            {vault.entries.map((entry) => (
              <div key={entry.id} className="vault-row">
                <span className="vault-glyph">
                  <Icon name="lock" size={15} />
                </span>

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
