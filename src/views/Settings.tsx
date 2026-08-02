import { type ReactNode, useEffect, useState } from 'react'
import { api } from '../api'
import { QUALITY_OPTIONS } from '../quality'
import { T } from '../strings'
import type { BrowserOption, Settings as SettingsShape, Tools } from '../types'
import { Btn, Icon, Info, Toggle } from '../components/ui'

interface Props {
  settings: SettingsShape
  tools: Tools | null
  onRefreshTools: () => void
  onToast: (message: string, kind?: 'info' | 'warn' | 'error' | 'ok') => void
}

export default function Settings({ settings, tools, onRefreshTools, onToast }: Props) {
  const [updating, setUpdating] = useState(false)
  const [template, setTemplate] = useState(settings.filenameTemplate)
  const [rate, setRate] = useState(settings.rateLimit)
  const [subLangs, setSubLangs] = useState(settings.subLangs)
  const [browsers, setBrowsers] = useState<BrowserOption[] | null>(null)
  const [apiKey, setApiKey] = useState(settings.subtitleApiKey)
  const [subtitleLangs, setSubtitleLangs] = useState(settings.subtitleLangs)
  const [subsTools, setSubsTools] = useState<{ ffsubsync: boolean } | null>(null)
  const [blockedHosts, setBlockedHosts] = useState(settings.extraBlockedHosts)

  // Only offer browsers whose cookie store actually exists on this machine —
  // picking a missing one used to fail every request with a cryptic error.
  useEffect(() => {
    let alive = true
    api.listBrowsers().then((list) => {
      if (alive && list) setBrowsers(list)
    })
    api.subtitleTools().then((t) => {
      if (alive && t) setSubsTools(t)
    })
    return () => {
      alive = false
    }
  }, [])

  const patch = (next: Partial<SettingsShape>) => api.updateSettings(next)

  const updateEngine = async () => {
    setUpdating(true)
    const res = await api.updateEngine()
    setUpdating(false)
    if (res) onToast(res.message, res.ok ? 'ok' : 'warn')
    onRefreshTools()
  }

  return (
    <div className="settings">
      <Section title={T.settings.sectionFiles}>
        <Row label={T.settings.downloadDir} hint={T.settings.downloadDirHint}>
          <div className="set-inline">
            <span className="path-box truncate" title={settings.downloadDir}>
              {settings.downloadDir}
            </span>
            <Btn size="sm" icon="folder" onClick={() => api.pickDownloadDir()}>
              {T.settings.choose}
            </Btn>
            <Btn size="sm" variant="ghost" onClick={() => api.openFile(settings.downloadDir)}>
              {T.settings.openDir}
            </Btn>
          </div>
        </Row>

        <Row label={T.settings.filenameTemplate} hint={T.settings.filenameHint}>
          <input
            className="input wide"
            value={template}
            spellCheck={false}
            onChange={(e) => setTemplate(e.target.value)}
            onBlur={() => patch({ filenameTemplate: template.trim() || '%(title).120B.%(ext)s' })}
          />
        </Row>
      </Section>

      <Section title={T.settings.sectionTransfer}>
        <Row label={T.settings.concurrency} hint={T.settings.concurrencyHint}>
          <select
            className="select"
            value={settings.concurrency}
            onChange={(e) => patch({ concurrency: Number(e.target.value) })}
          >
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Row>

        <Row label={T.settings.rateLimit} hint={T.settings.rateLimitHint}>
          <input
            className="input"
            style={{ width: 120 }}
            value={rate}
            placeholder="sınırsız"
            spellCheck={false}
            onChange={(e) => setRate(e.target.value)}
            onBlur={() => patch({ rateLimit: rate.trim() })}
          />
        </Row>

        <Row label="">
          <Toggle
            checked={settings.autoStartDownloads}
            onChange={(v) => patch({ autoStartDownloads: v })}
            label={T.settings.autoStart}
          />
        </Row>
      </Section>

      <Section title={T.settings.sectionMedia}>
        <Row label={T.settings.defaultQuality}>
          <select
            className="select"
            value={settings.defaultQuality ? String(settings.defaultQuality) : 'best'}
            onChange={(e) =>
              patch({ defaultQuality: e.target.value === 'best' ? 0 : Number(e.target.value) })
            }
          >
            {QUALITY_OPTIONS.filter((o) => o.value !== 'audio').map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Row>

        <Row label={T.settings.container}>
          <select
            className="select"
            value={settings.container}
            onChange={(e) => patch({ container: e.target.value })}
          >
            {['mp4', 'mkv', 'webm', 'auto'].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Row>

        <Row label={T.settings.audioFormat}>
          <select
            className="select"
            value={settings.audioFormat}
            onChange={(e) => patch({ audioFormat: e.target.value })}
          >
            {['mp3', 'm4a', 'opus', 'flac', 'wav'].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Row>

        <Row label="">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Toggle
              checked={settings.embedThumbnail}
              onChange={(v) => patch({ embedThumbnail: v })}
              label={T.settings.embedThumbnail}
            />
            <Toggle
              checked={settings.embedMetadata}
              onChange={(v) => patch({ embedMetadata: v })}
              label={T.settings.embedMetadata}
            />
            <Toggle
              checked={settings.writeSubs}
              onChange={(v) => patch({ writeSubs: v })}
              label={T.settings.writeSubs}
            />
          </div>
        </Row>

        {settings.writeSubs ? (
          <Row label={T.settings.subLangs}>
            <input
              className="input"
              style={{ width: 160 }}
              value={subLangs}
              spellCheck={false}
              onChange={(e) => setSubLangs(e.target.value)}
              onBlur={() => patch({ subLangs: subLangs.trim() || 'tr,en' })}
            />
          </Row>
        ) : null}
      </Section>

      <Section title={T.settings.sectionAccess}>
        <Row label={T.settings.cookiesBrowser} hint={T.settings.cookiesHint}>
          <select
            className="select"
            value={settings.cookiesBrowser}
            onChange={(e) => patch({ cookiesBrowser: e.target.value })}
          >
            <option value="">{T.settings.cookiesNone}</option>
            {(browsers || []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
            {/* A previously stored choice we can no longer find on disk. */}
            {settings.cookiesBrowser &&
            browsers &&
            !browsers.some((b) => b.id === settings.cookiesBrowser) ? (
              <option value={settings.cookiesBrowser}>
                {settings.cookiesBrowser} — bulunamadı
              </option>
            ) : null}
          </select>
          {browsers && !browsers.length ? (
            <div className="set-hint">Bu makinede çerez deposu olan bir tarayıcı bulunamadı.</div>
          ) : null}
        </Row>

        <Row label={T.settings.resolver} hint={T.settings.resolverHint}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Toggle
              checked={settings.useResolver}
              onChange={(v) => patch({ useResolver: v })}
              label={T.settings.resolverOn}
            />
            <div className="set-inline">
              <span style={{ fontSize: 12.5, color: 'var(--dim)' }}>{T.settings.resolverWait}</span>
              <select
                className="select"
                value={settings.resolverTimeout}
                onChange={(e) => patch({ resolverTimeout: Number(e.target.value) })}
              >
                {[15000, 30000, 45000, 60000, 90000].map((ms) => (
                  <option key={ms} value={ms}>
                    {ms / 1000} sn
                  </option>
                ))}
              </select>
            </div>
          </div>
        </Row>

        <Row label={T.settings.minStream} hint={T.settings.minStreamHint}>
          <select
            className="select"
            value={settings.minStreamSeconds}
            onChange={(e) => patch({ minStreamSeconds: Number(e.target.value) })}
          >
            {[0, 60, 120, 300, 600].map((s) => (
              <option key={s} value={s}>
                {s === 0 ? T.common.none : `${s < 60 ? s : s / 60} ${s < 60 ? 'sn' : 'dk'}`}
              </option>
            ))}
          </select>
        </Row>

        <Row label={T.settings.blocker} hint={T.settings.blockerHint}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
            <Toggle
              checked={settings.blockTrackers}
              onChange={(v) => patch({ blockTrackers: v })}
              label={T.settings.blockTrackers}
            />
            <textarea
              className="input wide"
              rows={3}
              value={blockedHosts}
              spellCheck={false}
              placeholder={'ornek-reklam.com\nbaska-reklam.net'}
              style={{ resize: 'vertical', paddingTop: 7, paddingBottom: 7, lineHeight: 1.5 }}
              onChange={(e) => setBlockedHosts(e.target.value)}
              onBlur={() => patch({ extraBlockedHosts: blockedHosts })}
            />
          </div>
        </Row>

        <Row label={T.settings.enrichLimit} hint={T.settings.enrichHint}>
          <select
            className="select"
            value={settings.enrichLimit}
            onChange={(e) => patch({ enrichLimit: Number(e.target.value) })}
          >
            {[0, 20, 50, 80, 150, 300].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? T.common.none : n}
              </option>
            ))}
          </select>
        </Row>
      </Section>

      <Section title={T.settings.sectionSubs}>
        <Row label={T.settings.subsKey} hint={T.settings.subsKeyHint}>
          <input
            className="input wide"
            type="password"
            value={apiKey}
            spellCheck={false}
            placeholder="opensubtitles.com API key"
            onChange={(e) => setApiKey(e.target.value)}
            onBlur={() => patch({ subtitleApiKey: apiKey.trim() })}
          />
        </Row>

        <Row label={T.settings.subsLangs} hint={T.settings.subsLangsHint}>
          <input
            className="input"
            style={{ width: 160 }}
            value={subtitleLangs}
            spellCheck={false}
            onChange={(e) => setSubtitleLangs(e.target.value)}
            onBlur={() => patch({ subtitleLangs: subtitleLangs.trim() || 'tr,en' })}
          />
        </Row>

        <Row label="">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Toggle
              checked={settings.autoFetchSubtitles}
              onChange={(v) => patch({ autoFetchSubtitles: v })}
              label={T.settings.subsAuto}
            />
            <Toggle
              checked={settings.syncSubtitles}
              onChange={(v) => patch({ syncSubtitles: v })}
              label={T.settings.subsSync}
            />
            <Toggle
              checked={settings.embedSubtitleFile}
              onChange={(v) => patch({ embedSubtitleFile: v })}
              label={T.settings.subsEmbed}
            />
            <Toggle
              checked={settings.skipSameLanguageSubtitles}
              onChange={(v) => patch({ skipSameLanguageSubtitles: v })}
              label={T.settings.subsSkipSame}
            />
          </div>
        </Row>

        {settings.syncSubtitles ? (
          <Row label="">
            <div className="set-hint" style={{ marginTop: 0 }}>
              {subsTools === null
                ? '…'
                : subsTools.ffsubsync
                  ? T.settings.subsSyncReady
                  : T.settings.subsSyncMissing}
            </div>
          </Row>
        ) : null}
      </Section>

      <Section title={T.settings.sectionApp}>
        <Row label={T.settings.theme}>
          <select
            className="select"
            value={settings.theme}
            onChange={(e) => patch({ theme: e.target.value as SettingsShape['theme'] })}
          >
            <option value="dark">{T.settings.themeDark}</option>
            <option value="light">{T.settings.themeLight}</option>
            <option value="system">{T.settings.themeSystem}</option>
          </select>
        </Row>

        <Row label="">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Toggle
              checked={settings.autoDetectClipboard}
              onChange={(v) => patch({ autoDetectClipboard: v })}
              label={T.settings.clipboardWatch}
            />
            <Toggle
              checked={settings.notifyOnFinish}
              onChange={(v) => patch({ notifyOnFinish: v })}
              label={T.settings.notify}
            />
          </div>
        </Row>
      </Section>

      <Section title={T.settings.sectionTools}>
        <ToolLine
          name="yt-dlp"
          ok={!!tools?.ytdlp}
          version={tools?.ytdlp?.version || null}
          path={tools?.ytdlp?.path || null}
          okLabel={T.settings.ytdlpFound}
          missingLabel={T.settings.ytdlpMissing}
        />
        <ToolLine
          name="ffmpeg"
          ok={!!tools?.ffmpeg}
          version={tools?.ffmpeg?.version || null}
          path={tools?.ffmpeg?.path || null}
          okLabel={T.settings.ffmpegFound}
          missingLabel={T.settings.ffmpegMissing}
        />

        <p className="set-hint" style={{ marginTop: 10 }}>
          {T.settings.toolsHint} <code className="mono">{tools?.installHint || 'brew install yt-dlp ffmpeg'}</code>
        </p>

        <div className="set-inline" style={{ marginTop: 12 }}>
          <Btn size="sm" icon="refresh" onClick={onRefreshTools}>
            {T.settings.recheck}
          </Btn>
          <Btn size="sm" icon="download" spinning={updating} disabled={updating} onClick={updateEngine}>
            {T.settings.updateEngine}
          </Btn>
          <Btn
            size="sm"
            variant="ghost"
            className="danger"
            onClick={() => {
              api.resetSettings().then(() => onToast('Ayarlar sıfırlandı.', 'ok'))
            }}
          >
            {T.settings.reset}
          </Btn>
        </div>
      </Section>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="set-section">
      <span className="label">{title}</span>
      {children}
    </section>
  )
}

/**
 * The explanation sits behind an ⓘ next to the label rather than under it, so a
 * long settings page stays scannable and the detail is one click away.
 */
function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="set-row">
      <div className="set-key">
        <span className="info-wrap">
          <span>{label}</span>
          {hint ? <Info label={`${label} hakkında`}>{hint}</Info> : null}
        </span>
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

function ToolLine({
  name,
  ok,
  version,
  path,
  okLabel,
  missingLabel,
}: {
  name: string
  ok: boolean
  version: string | null
  path: string | null
  okLabel: string
  missingLabel: string
}) {
  return (
    <div className="tool-line">
      <span className={`dot ${ok ? 'ok' : 'bad'}`} />
      <span className="name">{name}</span>
      <span className="path truncate" title={path || ''}>
        {ok ? path : missingLabel}
      </span>
      {version ? <span className="mono dim" style={{ fontSize: 11 }}>{version}</span> : null}
      {ok ? <Icon name="check" size={13} /> : <Icon name="alert" size={13} />}
      <span className="sr-only" style={{ display: 'none' }}>
        {ok ? okLabel : missingLabel}
      </span>
    </div>
  )
}
