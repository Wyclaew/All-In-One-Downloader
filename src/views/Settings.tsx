import { type ReactNode, useEffect, useState } from 'react'
import { api } from '../api'
import { QUALITY_OPTIONS } from '../quality'
import { T } from '../strings'
import type {
  BrowserOption,
  Settings as SettingsShape,
  Tools,
  TorStatus,
  UpdateState,
  UserScript as UserScriptInfo,
} from '../types'
import { bridge } from '../api'
import { Btn, Icon, Info, Toggle } from '../components/ui'

interface Props {
  settings: SettingsShape
  tools: Tools | null
  /** Null until the vault status has been read once. */
  vaultExists: boolean | null
  onRefreshTools: () => void
  onToast: (message: string, kind?: 'info' | 'warn' | 'error' | 'ok') => void
}

export default function Settings({ settings, tools, vaultExists, onRefreshTools, onToast }: Props) {
  const [updating, setUpdating] = useState(false)
  const [template, setTemplate] = useState(settings.filenameTemplate)
  const [rate, setRate] = useState(settings.rateLimit)
  const [subLangs, setSubLangs] = useState(settings.subLangs)
  const [browsers, setBrowsers] = useState<BrowserOption[] | null>(null)
  const [apiKey, setApiKey] = useState(settings.subtitleApiKey)
  const [subtitleLangs, setSubtitleLangs] = useState(settings.subtitleLangs)
  const [subsTools, setSubsTools] = useState<{ ffsubsync: boolean } | null>(null)
  const [blockedHosts, setBlockedHosts] = useState(settings.extraBlockedHosts)
  const [proxyUrl, setProxyUrl] = useState(settings.proxyUrl || '')
  const [checking, setChecking] = useState(false)
  const [proxyResult, setProxyResult] = useState<string | null>(null)
  const [scripts, setScripts] = useState<{ dir: string; scripts: UserScriptInfo[] } | null>(null)
  const [presets, setPresets] = useState<
    { id: string; label: string; url: string; note: string; up: boolean }[] | null
  >(null)

  useEffect(() => {
    setProxyUrl(settings.proxyUrl || '')
  }, [settings.proxyUrl])

  useEffect(() => {
    setProxyResult(null)
  }, [proxyUrl])

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
    api.listScripts().then((list) => {
      if (alive && list) setScripts(list)
    })
    api.proxyPresets().then((list) => {
      if (alive && list) setPresets(list)
    })
    return () => {
      alive = false
    }
  }, [])

  const patch = (next: Partial<SettingsShape>) => api.updateSettings(next)
  const managedTorSelected = !proxyUrl.trim() || /^socks(?:5h?)?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):906[1-5]\/?$/i.test(proxyUrl.trim())

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

        <Row label={T.settings.connections} hint={T.settings.connectionsHint}>
          <select
            className="select"
            value={settings.connections ?? 8}
            onChange={(e) => patch({ connections: Number(e.target.value) })}
          >
            {[1, 2, 4, 6, 8, 12, 16].map((n) => (
              <option key={n} value={n}>
                {n === 1 ? '1 (kapalı)' : n}
              </option>
            ))}
          </select>
        </Row>

        <Row label="Geçici hataları otomatik düzelt" hint="Bağlantıyı yeniler, gerekirse akışı tekrar çözümler. Giriş ve disk hataları tekrar denenmez.">
          <Toggle checked={settings.autoRecover !== false} onChange={(v) => patch({ autoRecover: v })} label="Otomatik kurtarma" />
        </Row>
        {settings.autoRecover !== false ? (
          <Row label="Otomatik deneme sayısı">
            <select className="select" value={settings.recoveryAttempts ?? 3} onChange={(e) => patch({ recoveryAttempts: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </Row>
        ) : null}

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

        <Row label={T.settings.deletePolicy} hint={T.settings.deletePolicyHint}>
          <select
            className="select"
            value={settings.deleteFileWithRecord || 'ask'}
            onChange={(e) =>
              patch({ deleteFileWithRecord: e.target.value as SettingsShape['deleteFileWithRecord'] })
            }
          >
            <option value="ask">{T.settings.deletePolicyAsk}</option>
            <option value="always">{T.settings.deletePolicyAlways}</option>
            <option value="never">{T.settings.deletePolicyNever}</option>
          </select>
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

        <Row label="Tercih edilen ses dili" hint="Varsa bu dildeki ses seçilir. Bulunamazsa mevcut dil bildirilir; etiketsiz sesin dili doğrulanamaz.">
          <select className="select" value={settings.preferredAudioLanguage || 'en'} onChange={(e) => patch({ preferredAudioLanguage: e.target.value as SettingsShape['preferredAudioLanguage'] })}>
            <option value="en">İngilizce</option>
            <option value="tr">Türkçe</option>
            <option value="auto">Kaynağın varsayılan sesi</option>
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

        <Row label={T.settings.proxy} hint={T.settings.proxyHint}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
            <div className="set-inline">
              <input
                className="input wide"
                value={proxyUrl}
                spellCheck={false}
                placeholder="socks5://127.0.0.1:9061"
                aria-label="Vekil sunucu adresi"
                autoComplete="off"
                onChange={(e) => setProxyUrl(e.target.value)}
                onBlur={() => patch({ proxyUrl: proxyUrl.trim() })}
              />
              <Btn
                size="sm"
                icon="target"
                spinning={checking}
                disabled={checking || !proxyUrl.trim()}
                onClick={async () => {
                  setChecking(true)
                  try {
                    await patch({ proxyUrl: proxyUrl.trim() })
                    const res = await api.checkProxy()
                    if (res) {
                      setProxyResult(res.message)
                      onToast(res.message, res.ok ? 'ok' : 'error')
                    }
                  } finally {
                    setChecking(false)
                  }
                }}
              >
                {T.settings.proxyTest}
              </Btn>
            </div>
            {proxyResult ? <div className="set-hint">{proxyResult}</div> : null}
            {/* Which local privacy proxies are actually listening right now. */}
            <div className="set-inline" style={{ flexWrap: 'wrap' }}>
              {(presets || []).map((p) => (
                <Btn
                  key={p.id}
                  size="sm"
                  variant={p.up ? 'default' : 'ghost'}
                  icon={p.up ? 'check' : undefined}
                  title={p.up ? `${p.url} — açık` : `${p.url} — kapalı${p.note ? ` (${p.note})` : ''}`}
                  onClick={() => {
                    setProxyUrl(p.url)
                    patch({ proxyUrl: p.url })
                  }}
                >
                  {p.label}
                </Btn>
              ))}
            </div>
            <div className="tor-options">
              <div>
                <Toggle
                  checked={settings.autoStartTor !== false}
                  onChange={(v) => patch({ autoStartTor: v })}
                  label="Gerektiğinde Tor’u otomatik başlat"
                />
                <p className="set-hint">
                  VPN açık bir bağlantıyı çözümlerken uygulamanın Tor seçeneği kullanılıyorsa önce Tor’a bağlanılır.
                  Özel vekil ve WARP seçimin korunur.
                </p>
              </div>
              <div>
                <Toggle
                  checked={settings.isolateTorSources !== false}
                  onChange={(v) => patch({ isolateTorSources: v })}
                  label="Her kaynak için ayrı Tor oturumu kullan"
                />
                <p className="set-hint">
                  Tor arka planda tek kez çalışır. Bu seçenek açıkken iki kaynak aynı Tor devrelerini paylaşmaz;
                  aynı kaynağın çözümlemesi ve indirmesi birlikte kalır.
                </p>
              </div>
              <p className="set-hint">
                Ayrı oturumlar farklı çıkış adresi veya daha fazla hız garantilemez. Tor genellikle daha yavaştır.
              </p>
              <TorPanel
                onToast={onToast}
                autoStart={settings.autoStartTor !== false}
                managedSelected={managedTorSelected}
              />
            </div>
            <Toggle
              checked={!!settings.proxyByDefault}
              onChange={(v) => patch({ proxyByDefault: v })}
              label={T.settings.proxyDefault}
            />
            <div className="set-hint" style={{ marginTop: 0 }}>
              {T.settings.proxyWarp}
            </div>
          </div>
        </Row>

        <Row label={T.settings.engine} hint={T.settings.engineHint}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Toggle
              checked={settings.useYtdlp !== false}
              onChange={(v) => patch({ useYtdlp: v })}
              label={T.settings.engineOn}
            />
            {settings.useYtdlp === false ? (
              <div className="set-hint" style={{ marginTop: 0, color: 'var(--signal)' }}>
                {T.settings.engineOffNote}
              </div>
            ) : null}
          </div>
        </Row>

        <Row label={T.settings.scripts} hint={T.settings.scriptsHint}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
            <Toggle
              checked={settings.useUserScripts !== false}
              onChange={(v) => patch({ useUserScripts: v })}
              label={T.settings.scriptsOn}
            />
            <div className="set-inline">
              <span style={{ fontSize: 12.5, color: 'var(--dim)' }}>
                {scripts && scripts.scripts.length
                  ? T.settings.scriptsCount(scripts.scripts.length)
                  : T.settings.scriptsNone}
              </span>
              <Btn
                size="sm"
                icon="folder"
                onClick={async () => {
                  await api.openScripts()
                  const list = await api.listScripts()
                  if (list) setScripts(list)
                }}
              >
                {T.settings.scriptsOpen}
              </Btn>
            </div>
            {scripts && scripts.scripts.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {scripts.scripts.map((s) => (
                  <div key={s.file} className="set-hint" style={{ marginTop: 0 }}>
                    <b style={{ color: 'var(--text)' }}>{s.name}</b>
                    {s.matches.length ? ` — ${s.matches.join(', ')}` : ' — her sayfa'}
                  </div>
                ))}
              </div>
            ) : null}
            <div className="set-hint" style={{ marginTop: 0 }}>{T.settings.scriptsApi}</div>
          </div>
        </Row>

        <Row label={T.settings.resolver} hint={T.settings.resolverHint}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Toggle
              checked={settings.useResolver}
              onChange={(v) => patch({ useResolver: v })}
              label={T.settings.resolverOn}
            />
            <Toggle
              checked={settings.resolverFirst !== false}
              onChange={(v) => patch({ resolverFirst: v })}
              label="Genel sitelerde önce kendi çözümleyicisini dene"
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
            <div className="set-inline">
              <span style={{ fontSize: 12.5, color: 'var(--dim)' }}>
                {T.settings.resolverParallel}
              </span>
              <select
                className="select"
                value={settings.resolverConcurrency}
                onChange={(e) => patch({ resolverConcurrency: Number(e.target.value) })}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </Row>

        <Row label="Videoları parçalarla aktar" hint="Desteklenen HLS videolarını uygulama indirir; tamamlanan parçalar duraklatma ve yeniden denemede korunur. Parçalar sonunda yerel olarak birleştirilir.">
          <Toggle checked={settings.nativeHls !== false} onChange={(v) => patch({ nativeHls: v })} label="HLS için uygulamanın aktarım motorunu kullan" />
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

      <Section title={T.settings.vaultSection}>
        <Row label={T.settings.vaultAutoLock} hint={T.settings.vaultAutoLockHint}>
          <select
            className="select"
            value={settings.vaultAutoLockMinutes ?? 15}
            onChange={(e) => patch({ vaultAutoLockMinutes: Number(e.target.value) })}
          >
            {[0, 5, 15, 30, 60, 120].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? T.common.none : `${n} dk`}
              </option>
            ))}
          </select>
          {vaultExists === false ? (
            <div className="set-hint">{T.settings.vaultNotSet}</div>
          ) : null}
        </Row>
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

        <Row label="Güncellemeler" hint="GitHub'da yeni sürüm çıkınca üstte bildirim gösterir; tek tıkla indirip doğrular ve kurar.">
          <UpdateRow
            auto={settings.autoCheckUpdates !== false}
            onAuto={(v) => patch({ autoCheckUpdates: v })}
            onToast={onToast}
          />
        </Row>

        <Row
          label="İndirme klasörü"
          hint="Eski sürümlerden kalan oynat.html dosyalarını kaldırır; videonun yanındaki .vtt/.srt altyazıları videonun içine gömer (ya da uygulamanın kendi klasörüne taşır). Hiçbir altyazı silinip atılmaz."
        >
          <Btn size="sm" icon="refresh" onClick={() => api.tidyFolder()}>
            Klasörü şimdi toparla
          </Btn>
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
        <ToolLine
          name="ffprobe"
          ok={!!tools?.ffprobe}
          version={tools?.ffprobe?.version || null}
          path={tools?.ffprobe?.path || null}
          okLabel="Medya bilgisi aracı hazır"
          missingLabel="Bulunamadı — bazı videoların süre, boyut ve ses bilgisi eksik kalabilir. FFmpeg ile birlikte kurulur."
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

/**
 * Tor, started and stopped from here.
 *
 * The point is that nobody has to keep a terminal open: the app runs its own tor
 * on its own port and takes it down on quit. Custom proxy choices are preserved. If
 * no tor binary exists on the machine we say exactly that and how to get one,
 * rather than offering a switch that cannot do anything.
 */
function TorPanel({ onToast, autoStart, managedSelected }: {
  onToast: (message: string, kind?: 'info' | 'warn' | 'error' | 'ok') => void
  autoStart: boolean
  managedSelected: boolean
}) {
  const [tor, setTor] = useState<TorStatus | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    let alive = true
    let receivedEvent = false
    api.torStatus().then((s) => {
      if (alive && s) setTor((previous) => receivedEvent && previous
        ? { ...s, ...previous, available: s.available, hint: s.hint }
        : s)
    })
    // Bootstrapping reports its progress as it goes, so the button is not the
    // only thing the user has to look at while it takes half a minute.
    const off = bridge.onTor((s) => {
      receivedEvent = true
      setTor((prev) => ({ ...(prev || s), ...s }))
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  if (!tor) return null

  const on = tor.state === 'on'
  const starting = tor.state === 'starting'
  const line = on
    ? 'Tor bağlı. VPN açık kaynaklar seçilen vekil üzerinden aktarılır.'
    : starting
      ? `Bağlanıyor… %${tor.percent}${tor.message ? ` — ${tor.message}` : ''}`
      : tor.state === 'error'
        ? tor.message
        : tor.available
          ? managedSelected && autoStart
            ? 'Hazır. VPN açık ilk Tor bağlantısını eklediğinde otomatik bağlanır.'
            : managedSelected
              ? 'Tor kapalı. Otomatik başlatma kapalıyken bağlantı eklemeden önce Tor’u başlat.'
              : 'Tor kapalı. Seçili özel vekil için Tor başlatılmaz.'
          : `Bu makinede tor yok. ${tor.hint || ''}`

  return (
    <div className="tor-status">
      <div className="set-inline">
        <Btn
          size="sm"
          icon={on ? 'check' : 'shield'}
          variant={on ? 'default' : 'ghost'}
          spinning={working || starting}
          disabled={(working && !starting) || (!tor.available && !on && !starting)}
          onClick={async () => {
            setWorking(true)
            try {
              const stopping = on || starting
              const next = stopping ? await api.torStop() : await api.torStart()
              if (next) setTor(next)
              if (!stopping && next && next.state !== 'on') onToast(next.message || 'Tor açılamadı.', 'error')
            } finally {
              setWorking(false)
            }
          }}
        >
          {on ? "Tor'u kapat" : starting ? 'Bağlanmayı durdur' : "Tor'u arka planda başlat"}
        </Btn>
        {tor.binary ? (
          <span className="mono dim" style={{ fontSize: 11 }} title={tor.binary}>
            {tor.binary.split(/[\\/]/).slice(-1)[0]}
          </span>
        ) : null}
      </div>
      <div className="set-hint" role="status" style={{ marginTop: 0, color: on ? 'var(--ok, #5c9c74)' : undefined }}>
        {line}
      </div>
      {on && !managedSelected ? <div className="set-hint">Tor açık; bağlantılar seçili özel vekili kullanmaya devam eder.</div> : null}
    </div>
  )
}

function UpdateRow({
  auto,
  onAuto,
  onToast,
}: {
  auto: boolean
  onAuto: (v: boolean) => void
  onToast: (message: string, kind?: 'info' | 'warn' | 'error' | 'ok') => void
}) {
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    let alive = true
    api.updateStatus().then((u) => alive && u && setUpdate(u))
    const off = bridge.onUpdate((u) => setUpdate(u))
    return () => {
      alive = false
      off()
    }
  }, [])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="set-inline">
        <span className="mono dim" style={{ fontSize: 12 }}>
          v{update?.current || '…'}
        </span>
        <Btn
          size="sm"
          icon="refresh"
          spinning={checking}
          disabled={checking}
          onClick={async () => {
            setChecking(true)
            const res = await api.updateCheck()
            setChecking(false)
            if (res && res.phase === 'current') onToast('Uygulama güncel.', 'ok')
            if (res && res.phase === 'error') onToast(res.message, 'error')
          }}
        >
          Şimdi denetle
        </Btn>
        {update && update.phase === 'available' ? (
          <Btn size="sm" variant="primary" icon="download" onClick={() => api.updateInstall()}>
            v{update.latest} kur
          </Btn>
        ) : null}
      </div>
      <Toggle checked={auto} onChange={onAuto} label="Açılışta ve birkaç saatte bir yeni sürüm ara" />
      {update && update.phase === 'error' && update.message ? (
        <div className="set-hint" style={{ marginTop: 0, color: 'var(--bad)' }}>{update.message}</div>
      ) : null}
      <TokenField has={!!update?.hasToken} onToast={onToast} onSaved={setUpdate} />
    </div>
  )
}

/**
 * Only needed while the repository is private. The value is sent once to the
 * main process, sealed with the OS keystore there, and never shown again.
 */
function TokenField({
  has,
  onToast,
  onSaved,
}: {
  has: boolean
  onToast: (message: string, kind?: 'info' | 'warn' | 'error' | 'ok') => void
  onSaved: (u: UpdateState) => void
}) {
  const [value, setValue] = useState('')
  return (
    <div className="set-inline">
      <input
        className="input wide"
        type="password"
        value={value}
        spellCheck={false}
        placeholder={has ? 'GitHub anahtarı kayıtlı (değiştirmek için yenisini yaz)' : 'Gizli depo için GitHub anahtarı (isteğe bağlı)'}
        onChange={(e) => setValue(e.target.value)}
      />
      <Btn
        size="sm"
        disabled={!value.trim()}
        onClick={async () => {
          const res = await api.updateSetToken(value)
          setValue('')
          if (res) {
            onSaved(res)
            onToast('GitHub anahtarı şifreli olarak kaydedildi.', 'ok')
          }
        }}
      >
        Kaydet
      </Btn>
      {has ? (
        <Btn
          size="sm"
          variant="ghost"
          onClick={async () => {
            const res = await api.updateSetToken('')
            if (res) onSaved(res)
          }}
        >
          Sil
        </Btn>
      ) : null}
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
