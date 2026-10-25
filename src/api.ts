import type {
  AppState,
  BrowserOption,
  Category,
  DownloadRequest,
  Outlook,
  Settings,
  SubtitleOutcome,
  SubtitleSearch,
  Toast,
  Tools,
  TorStatus,
  UpdateState,
  UserScript,
  VaultEntry,
  VaultState,
  SiteAccountPolicy,
  SiteAccountsStatus,
} from './types'

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

interface Bridge {
  platform: string
  getState(): Promise<Result<AppState>>
  getTools(): Promise<Result<Tools>>
  refreshTools(): Promise<Result<Tools>>
  updateYtdlp(): Promise<Result<{ ok: boolean; message: string }>>
  listBrowsers(): Promise<Result<BrowserOption[]>>
  addSource(input: string, useProxy?: boolean): Promise<Result<{ added: number }>>
  checkProxy(): Promise<Result<{ ok: boolean; message: string }>>
  proxyPresets(): Promise<Result<{ id: string; label: string; url: string; note: string; up: boolean }[]>>
  torStatus(): Promise<Result<TorStatus>>
  torStart(): Promise<Result<TorStatus>>
  torStop(): Promise<Result<TorStatus>>
  removeSource(id: string): Promise<Result<boolean>>
  toggleSource(id: string, collapsed?: boolean): Promise<Result<boolean>>
  rescanSource(id: string): Promise<Result<boolean>>
  captureSource(id: string): Promise<Result<boolean>>
  setSourceProxy(id: string, useProxy: boolean): Promise<Result<boolean>>
  cancelSource(id: string): Promise<Result<boolean>>
  refreshSourceMetadata(id: string): Promise<Result<boolean>>
  sourceDiagnostics(id: string): Promise<Result<string>>
  retryFailedSources(): Promise<Result<number>>
  cancelAllSources(): Promise<Result<number>>
  openSource(id: string): Promise<Result<boolean>>
  downloadSource(payload: {
    sourceId: string
    quality?: number
    audioOnly?: boolean
    categoryId?: string | null
    preferredAudioLanguage?: 'en' | 'tr' | 'auto'
  }): Promise<Result<{ count: number }>>
  removeItem(id: string): Promise<Result<boolean>>
  openItem(id: string): Promise<Result<boolean>>
  download(payload: DownloadRequest): Promise<Result<{ count: number }>>
  prioritizeDownload(id: string): Promise<Result<boolean>>
  backupLibrary(): Promise<Result<{ path: string }>>
  siteAccountsStatus(): Promise<Result<SiteAccountsStatus>>
  saveSiteAccountProfile(profile: { email: string; password: string }): Promise<Result<SiteAccountsStatus>>
  clearSiteAccountProfile(): Promise<Result<SiteAccountsStatus>>
  setSiteAccountPolicy(policy: SiteAccountPolicy): Promise<Result<SiteAccountsStatus>>
  removeSiteAccountPolicy(origin: string): Promise<Result<SiteAccountsStatus>>
  pause(id: string): Promise<Result<unknown>>
  resume(id: string): Promise<Result<unknown>>
  cancel(id: string): Promise<Result<unknown>>
  retry(id: string): Promise<Result<unknown>>
  removeDownload(id: string, deleteFile?: boolean): Promise<Result<unknown>>
  removeDownloads(ids: string[], deleteFile?: boolean): Promise<Result<number>>
  verifyDownloads(): Promise<Result<number>>
  redownload(id: string): Promise<Result<boolean>>
  clearMissing(): Promise<Result<number>>
  thumbFile(path: string, duration?: number | null): Promise<Result<string | null>>
  tidyFolder(): Promise<Result<unknown>>
  setDownloadSeries(id: string, series: string | null): Promise<Result<boolean>>
  setDownloadCategory(ids: string[], categoryId: string | null): Promise<Result<boolean>>
  clearDownloads(which: 'done' | 'failed'): Promise<Result<boolean>>
  addCategory(name: string): Promise<Result<Category>>
  renameCategory(id: string, name: string): Promise<Result<boolean>>
  removeCategory(id: string): Promise<Result<boolean>>
  updateSettings(patch: Partial<Settings>): Promise<Result<Settings>>
  pickDownloadDir(): Promise<Result<string | null>>
  resetSettings(): Promise<Result<Settings>>
  searchSubtitles(payload: { downloadId?: string; query?: string }): Promise<Result<SubtitleSearch>>
  applySubtitle(payload: {
    downloadId: string
    fileId: number
    language: string
    hashMatch: boolean
  }): Promise<Result<SubtitleOutcome>>
  subtitleTools(): Promise<Result<{ ffsubsync: boolean }>>
  listScripts(): Promise<Result<{ dir: string; scripts: UserScript[] }>>
  openScripts(): Promise<Result<boolean>>
  vaultStatus(): Promise<Result<VaultState>>
  vaultCreate(passphrase: string): Promise<Result<VaultState>>
  vaultUnlock(passphrase: string): Promise<Result<VaultState>>
  vaultSetBiometric(enabled: boolean): Promise<Result<VaultState>>
  vaultUnlockBiometric(): Promise<Result<VaultState>>
  openTouchIdSettings(): Promise<Result<boolean>>
  vaultLock(): Promise<Result<VaultState>>
  vaultChangePassphrase(current: string, next: string): Promise<Result<VaultState>>
  vaultTakeDownload(id: string): Promise<Result<VaultEntry>>
  vaultAddFiles(): Promise<Result<{ added: number }>>
  vaultOpen(id: string): Promise<Result<{ ok: boolean }>>
  vaultOpenExternal(id: string): Promise<Result<{ path: string }>>
  vaultExport(id: string): Promise<Result<{ path: string } | null>>
  vaultRemove(id: string): Promise<Result<boolean>>
  openFile(path: string): Promise<Result<boolean>>
  playFile(path: string): Promise<Result<{ path: string }>>
  revealFile(path: string): Promise<Result<boolean>>
  openExternal(url: string): Promise<Result<boolean>>
  readClipboard(): Promise<Result<string>>
  writeClipboard(text: string): Promise<Result<boolean>>
  onState(handler: (state: AppState) => void): () => void
  onVault(handler: (state: VaultState) => void): () => void
  onProgress(handler: (p: unknown) => void): () => void
  onOutlook(handler: (p: Outlook) => void): () => void
  onTor(handler: (p: TorStatus) => void): () => void
  onUpdate(handler: (p: UpdateState) => void): () => void
  updateStatus(): Promise<Result<UpdateState>>
  updateCheck(): Promise<Result<UpdateState>>
  updateInstall(): Promise<Result<UpdateState>>
  updateSetToken(value: string): Promise<Result<UpdateState>>
  onToast(handler: (t: Toast) => void): () => void
  onFinished(handler: (p: { id: string; title: string }) => void): () => void
  onMenu(handler: (action: string) => void): () => void
}

declare global {
  interface Window {
    api: Bridge
  }
}

export const bridge = window.api

type Sink = (message: string, kind: Toast['kind']) => void
let sink: Sink | null = null

/** The app shell registers itself here so any failed call surfaces as a toast. */
export function setToastSink(fn: Sink) {
  sink = fn
}

async function call<T>(promise: Promise<Result<T>>): Promise<T | null> {
  try {
    const res = await promise
    if (!res || !res.ok) {
      sink?.(res?.error || 'Beklenmeyen bir hata oldu.', 'error')
      return null
    }
    return res.data
  } catch (err) {
    sink?.(err instanceof Error ? err.message : String(err), 'error')
    return null
  }
}

export const api = {
  platform: bridge.platform,

  getState: () => call(bridge.getState()),
  getTools: () => call(bridge.getTools()),
  refreshTools: () => call(bridge.refreshTools()),
  updateEngine: () => call(bridge.updateYtdlp()),
  listBrowsers: () => call(bridge.listBrowsers()),

  addSource: (input: string, useProxy = false) => call(bridge.addSource(input, useProxy)),
  checkProxy: () => call(bridge.checkProxy()),
  proxyPresets: () => call(bridge.proxyPresets()),
  torStatus: () => call(bridge.torStatus()),
  updateStatus: () => call(bridge.updateStatus()),
  updateCheck: () => call(bridge.updateCheck()),
  updateInstall: () => call(bridge.updateInstall()),
  updateSetToken: (value: string) => call(bridge.updateSetToken(value)),
  torStart: () => call(bridge.torStart()),
  torStop: () => call(bridge.torStop()),
  removeSource: (id: string) => call(bridge.removeSource(id)),
  toggleSource: (id: string, collapsed?: boolean) => call(bridge.toggleSource(id, collapsed)),
  rescanSource: (id: string) => call(bridge.rescanSource(id)),
  captureSource: (id: string) => call(bridge.captureSource(id)),
  setSourceProxy: (id: string, useProxy: boolean) => call(bridge.setSourceProxy(id, useProxy)),
  cancelSource: (id: string) => call(bridge.cancelSource(id)),
  refreshSourceMetadata: (id: string) => call(bridge.refreshSourceMetadata(id)),
  sourceDiagnostics: (id: string) => call(bridge.sourceDiagnostics(id)),
  retryFailedSources: () => call(bridge.retryFailedSources()),
  cancelAllSources: () => call(bridge.cancelAllSources()),
  openSource: (id: string) => call(bridge.openSource(id)),
  downloadSource: (sourceId: string, opts: { quality?: number; audioOnly?: boolean; categoryId?: string | null; preferredAudioLanguage?: 'en' | 'tr' | 'auto' } = {}) =>
    call(bridge.downloadSource({ sourceId, ...opts })),

  removeItem: (id: string) => call(bridge.removeItem(id)),
  openItem: (id: string) => call(bridge.openItem(id)),
  download: (payload: DownloadRequest) => call(bridge.download(payload)),

  prioritizeDownload: (id: string) => call(bridge.prioritizeDownload(id)),
  backupLibrary: () => call(bridge.backupLibrary()),
  siteAccountsStatus: () => call(bridge.siteAccountsStatus()),
  saveSiteAccountProfile: (profile: { email: string; password: string }) => call(bridge.saveSiteAccountProfile(profile)),
  clearSiteAccountProfile: () => call(bridge.clearSiteAccountProfile()),
  setSiteAccountPolicy: (policy: SiteAccountPolicy) => call(bridge.setSiteAccountPolicy(policy)),
  removeSiteAccountPolicy: (origin: string) => call(bridge.removeSiteAccountPolicy(origin)),
  pause: (id: string) => call(bridge.pause(id)),
  resume: (id: string) => call(bridge.resume(id)),
  cancel: (id: string) => call(bridge.cancel(id)),
  retry: (id: string) => call(bridge.retry(id)),
  removeDownload: (id: string, deleteFile = false) => call(bridge.removeDownload(id, deleteFile)),
  removeDownloads: (ids: string[], deleteFile = false) => call(bridge.removeDownloads(ids, deleteFile)),
  verifyDownloads: () => call(bridge.verifyDownloads()),
  redownload: (id: string) => call(bridge.redownload(id)),
  clearMissing: () => call(bridge.clearMissing()),
  tidyFolder: () => call(bridge.tidyFolder()),
  setDownloadSeries: (id: string, series: string | null) => call(bridge.setDownloadSeries(id, series)),
  setDownloadCategory: (ids: string[], categoryId: string | null) =>
    call(bridge.setDownloadCategory(ids, categoryId)),
  clearDownloads: (which: 'done' | 'failed') => call(bridge.clearDownloads(which)),

  addCategory: (name: string) => call(bridge.addCategory(name)),
  renameCategory: (id: string, name: string) => call(bridge.renameCategory(id, name)),
  removeCategory: (id: string) => call(bridge.removeCategory(id)),

  updateSettings: (patch: Partial<Settings>) => call(bridge.updateSettings(patch)),
  pickDownloadDir: () => call(bridge.pickDownloadDir()),
  resetSettings: () => call(bridge.resetSettings()),

  searchSubtitles: (payload: { downloadId?: string; query?: string }) =>
    call(bridge.searchSubtitles(payload)),
  applySubtitle: (payload: {
    downloadId: string
    fileId: number
    language: string
    hashMatch: boolean
  }) => call(bridge.applySubtitle(payload)),
  subtitleTools: () => call(bridge.subtitleTools()),

  listScripts: () => call(bridge.listScripts()),
  openScripts: () => call(bridge.openScripts()),

  vaultStatus: () => call(bridge.vaultStatus()),
  vaultCreate: (passphrase: string) => call(bridge.vaultCreate(passphrase)),
  vaultUnlock: (passphrase: string) => call(bridge.vaultUnlock(passphrase)),
  vaultSetBiometric: (enabled: boolean) => call(bridge.vaultSetBiometric(enabled)),
  vaultUnlockBiometric: () => call(bridge.vaultUnlockBiometric()),
  openTouchIdSettings: () => call(bridge.openTouchIdSettings()),
  vaultLock: () => call(bridge.vaultLock()),
  vaultChangePassphrase: (current: string, next: string) => call(bridge.vaultChangePassphrase(current, next)),
  vaultTakeDownload: (id: string) => call(bridge.vaultTakeDownload(id)),
  vaultAddFiles: () => call(bridge.vaultAddFiles()),
  vaultOpen: (id: string) => call(bridge.vaultOpen(id)),
  vaultOpenExternal: (id: string) => call(bridge.vaultOpenExternal(id)),
  vaultExport: (id: string) => call(bridge.vaultExport(id)),
  vaultRemove: (id: string) => call(bridge.vaultRemove(id)),

  openFile: (p: string) => call(bridge.openFile(p)),
  playFile: (p: string) => call(bridge.playFile(p)),
  revealFile: (p: string) => call(bridge.revealFile(p)),
  openExternal: (url: string) => call(bridge.openExternal(url)),
  readClipboard: () => call(bridge.readClipboard()),
  writeClipboard: (text: string) => call(bridge.writeClipboard(text)),
}
