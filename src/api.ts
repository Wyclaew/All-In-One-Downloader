import type {
  AppState,
  BrowserOption,
  Category,
  DownloadRequest,
  Settings,
  Toast,
  Tools,
} from './types'

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

interface Bridge {
  platform: string
  getState(): Promise<Result<AppState>>
  getTools(): Promise<Result<Tools>>
  refreshTools(): Promise<Result<Tools>>
  updateYtdlp(): Promise<Result<{ ok: boolean; message: string }>>
  listBrowsers(): Promise<Result<BrowserOption[]>>
  addSource(url: string): Promise<Result<{ added: number }>>
  removeSource(id: string): Promise<Result<boolean>>
  toggleSource(id: string, collapsed?: boolean): Promise<Result<boolean>>
  rescanSource(id: string): Promise<Result<boolean>>
  openSource(id: string): Promise<Result<boolean>>
  downloadSource(payload: {
    sourceId: string
    quality?: number
    audioOnly?: boolean
    categoryId?: string | null
  }): Promise<Result<{ count: number }>>
  removeItem(id: string): Promise<Result<boolean>>
  openItem(id: string): Promise<Result<boolean>>
  download(payload: DownloadRequest): Promise<Result<{ count: number }>>
  pause(id: string): Promise<Result<unknown>>
  resume(id: string): Promise<Result<unknown>>
  cancel(id: string): Promise<Result<unknown>>
  retry(id: string): Promise<Result<unknown>>
  removeDownload(id: string, deleteFile?: boolean): Promise<Result<unknown>>
  setDownloadCategory(ids: string[], categoryId: string | null): Promise<Result<boolean>>
  clearDownloads(which: 'done' | 'failed'): Promise<Result<boolean>>
  addCategory(name: string): Promise<Result<Category>>
  renameCategory(id: string, name: string): Promise<Result<boolean>>
  removeCategory(id: string): Promise<Result<boolean>>
  updateSettings(patch: Partial<Settings>): Promise<Result<Settings>>
  pickDownloadDir(): Promise<Result<string | null>>
  resetSettings(): Promise<Result<Settings>>
  openFile(path: string): Promise<Result<boolean>>
  revealFile(path: string): Promise<Result<boolean>>
  openExternal(url: string): Promise<Result<boolean>>
  readClipboard(): Promise<Result<string>>
  onState(handler: (state: AppState) => void): () => void
  onProgress(handler: (p: unknown) => void): () => void
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

  addSource: (url: string) => call(bridge.addSource(url)),
  removeSource: (id: string) => call(bridge.removeSource(id)),
  toggleSource: (id: string, collapsed?: boolean) => call(bridge.toggleSource(id, collapsed)),
  rescanSource: (id: string) => call(bridge.rescanSource(id)),
  openSource: (id: string) => call(bridge.openSource(id)),
  downloadSource: (sourceId: string, opts: { quality?: number; audioOnly?: boolean; categoryId?: string | null } = {}) =>
    call(bridge.downloadSource({ sourceId, ...opts })),

  removeItem: (id: string) => call(bridge.removeItem(id)),
  openItem: (id: string) => call(bridge.openItem(id)),
  download: (payload: DownloadRequest) => call(bridge.download(payload)),

  pause: (id: string) => call(bridge.pause(id)),
  resume: (id: string) => call(bridge.resume(id)),
  cancel: (id: string) => call(bridge.cancel(id)),
  retry: (id: string) => call(bridge.retry(id)),
  removeDownload: (id: string, deleteFile = false) => call(bridge.removeDownload(id, deleteFile)),
  setDownloadCategory: (ids: string[], categoryId: string | null) =>
    call(bridge.setDownloadCategory(ids, categoryId)),
  clearDownloads: (which: 'done' | 'failed') => call(bridge.clearDownloads(which)),

  addCategory: (name: string) => call(bridge.addCategory(name)),
  renameCategory: (id: string, name: string) => call(bridge.renameCategory(id, name)),
  removeCategory: (id: string) => call(bridge.removeCategory(id)),

  updateSettings: (patch: Partial<Settings>) => call(bridge.updateSettings(patch)),
  pickDownloadDir: () => call(bridge.pickDownloadDir()),
  resetSettings: () => call(bridge.resetSettings()),

  openFile: (p: string) => call(bridge.openFile(p)),
  revealFile: (p: string) => call(bridge.revealFile(p)),
  openExternal: (url: string) => call(bridge.openExternal(url)),
  readClipboard: () => call(bridge.readClipboard()),
}
