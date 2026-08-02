export type SourceStatus = 'queued' | 'probing' | 'ready' | 'empty' | 'error'

export interface Source {
  id: string
  url: string
  host: string
  site: string
  title: string | null
  uploader: string | null
  kind: 'video' | 'playlist' | 'unknown'
  status: SourceStatus
  error: string | null
  collapsed: boolean
  addedAt: number
  probedAt?: number
  count: number
  enriching: number
  /** What the source is doing right now, and a human line about it. */
  stage?: 'ytdlp' | 'resolver' | null
  note?: string | null
  /** 'yt-dlp' | 'sayfa taraması' | 'tarayıcı motoru' */
  resolvedBy?: string | null
}

/** A stream our own resolver found, plus what yt-dlp needs to fetch it. */
export interface Resolved {
  pageUrl: string
  referer: string
  origin: string
  userAgent: string
  cookieFile: string | null
  kind: 'hls' | 'dash' | 'file'
  engine?: string
}

export interface MediaItem {
  id: string
  sourceId: string
  index: number
  url: string
  title: string
  duration: number | null
  thumbnail: string | null
  uploader: string | null
  ext: string | null
  height: number | null
  filesize: number | null
  isLive: boolean
  site: string
  addedAt: number
  enriched: boolean
  downloadId?: string | null
  resolved?: Resolved | null
}

export type DownloadStatus = 'queued' | 'running' | 'paused' | 'done' | 'error' | 'canceled'
export type DownloadStage = 'starting' | 'downloading' | 'merging' | 'processing' | null

export interface Download {
  id: string
  itemId: string | null
  sourceId: string | null
  url: string
  title: string
  site: string
  thumbnail: string | null
  duration: number | null
  quality: number
  audioOnly: boolean
  categoryId: string | null
  /** Set after a cookie-related failure so the retry runs without cookies. */
  noCookies?: boolean
  resolved?: Resolved | null
  status: DownloadStatus
  stage: DownloadStage
  percent: number | null
  downloaded: number
  total: number | null
  speed: number | null
  eta: number | null
  phase: number
  phases: number
  attempts: number
  filePath: string | null
  fileSize: number | null
  error: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface Category {
  id: string
  name: string
  color: string
  createdAt: number
}

export interface Settings {
  downloadDir: string
  concurrency: number
  defaultQuality: number
  container: string
  audioFormat: string
  filenameTemplate: string
  cookiesBrowser: string
  writeSubs: boolean
  subLangs: string
  embedThumbnail: boolean
  embedMetadata: boolean
  rateLimit: string
  theme: 'dark' | 'light' | 'system'
  autoDetectClipboard: boolean
  autoStartDownloads: boolean
  enrichLimit: number
  notifyOnFinish: boolean

  useResolver: boolean
  resolverTimeout: number

  subtitleLangs: string
  subtitleApiKey: string
  autoFetchSubtitles: boolean
  syncSubtitles: boolean
  embedSubtitleFile: boolean
}

/** A browser whose cookie store we found on this machine. */
export interface BrowserOption {
  id: string
  label: string
  profile: string
  arg: string
  available: boolean
}

export interface AppState {
  version: number
  sources: Source[]
  items: MediaItem[]
  downloads: Download[]
  categories: Category[]
  settings: Settings
}

export interface ProgressEvent {
  id: string
  status: DownloadStatus
  stage: DownloadStage
  percent: number | null
  speed: number | null
  eta: number | null
  downloaded: number
  total: number | null
  phase: number
  phases: number
}

export interface Tools {
  ytdlp: { path: string; version: string | null } | null
  ffmpeg: { path: string; version: string | null } | null
  platform: string
  installHint: string
}

export interface Toast {
  id: string
  message: string
  kind: 'info' | 'warn' | 'error' | 'ok'
}

export interface DownloadRequest {
  itemIds?: string[]
  url?: string
  quality?: number
  audioOnly?: boolean
  categoryId?: string | null
}
