export type SourceStatus = 'queued' | 'probing' | 'ready' | 'empty' | 'error'

export interface Source {
  id: string
  url: string
  /** Chosen when the link was added; resolving and downloading follow it. */
  useProxy?: boolean
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
  /** The size came from bitrate × duration, not from a real byte length. */
  filesizeEstimated?: boolean
  /** height -> bytes, plus an optional `audio` key. Answers per quality. */
  sizes?: Record<string, number>
  isLive: boolean
  site: string
  addedAt: number
  enriched: boolean
  downloadId?: string | null
  language?: string | null
  resolved?: Resolved | null
  /** Heights offered by a resolved HLS master playlist. */
  variants?: number[]
  /** Stream is protected by a key system we won't touch. */
  drm?: boolean
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
  /** Inherited from the source; the address itself is read at spawn time. */
  useProxy?: boolean
  /** Set after a cookie-related failure so the retry runs without cookies. */
  noCookies?: boolean
  resolved?: Resolved | null
  subtitlePath?: string | null
  subtitleLanguage?: string | null
  /** Declared by the extractor; used to skip same-language subtitles. */
  language?: string | null
  /** Detected from the finished file's audio tracks. */
  audioLanguage?: string | null
  status: DownloadStatus
  stage: DownloadStage
  /** A line about what the engine is doing right now, when it isn't obvious. */
  note?: string | null
  percent: number | null
  downloaded: number
  total: number | null
  /** Known before the first byte, from the item's own size. */
  expectedSize?: number | null
  /** Live per-connection progress while a multi-part transfer runs. */
  parts?: DownloadPart[] | null
  speed: number | null
  eta: number | null
  phase: number
  phases: number
  attempts: number
  filePath: string | null
  fileSize: number | null
  /** Finished, but the file is no longer on disk. */
  missing?: boolean
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
  connections: number
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

  proxyUrl: string
  proxyByDefault: boolean

  useYtdlp: boolean
  useResolver: boolean
  useUserScripts: boolean
  resolverTimeout: number
  minStreamSeconds: number
  blockTrackers: boolean
  extraBlockedHosts: string
  resolverConcurrency: number

  deleteFileWithRecord: 'ask' | 'always' | 'never'
  vaultAutoLockMinutes: number

  subtitleLangs: string
  subtitleApiKey: string
  autoFetchSubtitles: boolean
  syncSubtitles: boolean
  embedSubtitleFile: boolean
  skipSameLanguageSubtitles: boolean

  /** The app runs its own tor when this is on; empty path means "go and find it". */
  torAutoStart: boolean
  autoCheckUpdates: boolean
  torPath: string
  playerSubtitleSize: 'small' | 'normal' | 'large' | 'huge'
}

export interface TorStatus {
  state: 'off' | 'starting' | 'on' | 'error'
  percent: number
  message: string
  port: number | null
  binary: string | null
  /** Whether a tor binary exists on this machine at all. */
  available?: boolean
  hint?: string
}

/**
 * When everything outstanding finishes, and when each transfer does — worked out
 * against the whole queue rather than one connection at a time.
 */
export interface Outlook {
  etas: Record<string, number>
  total: number | null
  lineSpeed: number
}

export interface SubtitleHit {
  fileId: number
  fileName: string
  language: string
  release: string
  downloads: number
  hearingImpaired: boolean
  fps: number | null
  /** Timed against this exact file — already in sync. */
  hashMatch: boolean
  trusted?: boolean
  machine?: boolean
  uploader: string
  /** How the list was ordered, and the reason in words. */
  score?: number
  why?: string
  recommended?: boolean
}

export interface SubtitleSearch {
  results: SubtitleHit[]
  parsed: { title: string; season: number | null; episode: number | null }
  hashed: boolean
}

export interface SubtitleOutcome {
  path: string
  synced: boolean
  embedded: boolean
  notes: string[]
}

/** A site recipe: a script that runs inside the page while resolving. */
export interface UserScript {
  file: string
  name: string
  description: string
  matches: string[]
  runAt: string
  enabled: boolean
  bytes: number
}

/** One encrypted file in the vault. Only ever populated while unlocked. */
export interface VaultEntry {
  id: string
  name: string
  title: string
  site: string
  duration: number | null
  sourceUrl: string
  size: number
  addedAt: number
  /** A frame taken from the video itself, decrypted only while unlocked. */
  thumb?: string | null
}

export interface VaultState {
  exists: boolean
  unlocked: boolean
  count: number | null
  autoLockMinutes: number
  /** Where the encrypted blobs live on disk. */
  dir: string
  /** Old-format files still being converted after an upgrade. */
  upgrading?: number
  /** Seconds before another unlock attempt is accepted. */
  retryAfter?: number
  strong?: boolean
  entries: VaultEntry[]
}

/** A browser whose cookie store we found on this machine. */
export interface BrowserOption {
  id: string
  label: string
  profile: string
  arg: string
  available: boolean
}

/** Where a video was left off. Keyed `file:<path>` or `vault:<id>`. */
export interface PlaybackPosition {
  at: number
  duration: number
  seen: number
}

export interface AppState {
  version: number
  sources: Source[]
  items: MediaItem[]
  downloads: Download[]
  categories: Category[]
  positions?: Record<string, PlaybackPosition>
  /** key -> when it was watched to the end. */
  watched?: Record<string, number>
  settings: Settings
}

/** One connection's share of a multi-part transfer. */
export interface DownloadPart {
  done: number
  size: number
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
  parts?: DownloadPart[] | null
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

/** Where the app stands against its latest GitHub release. */
export interface UpdateState {
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'installing' | 'error'
  current: string | null
  latest: string | null
  notes: string
  percent: number
  message: string
  url: string
  /** False when this platform or build can only be updated from the release page. */
  automatic?: boolean
  /** The repository is private and no token has been given. */
  private?: boolean
  hasToken?: boolean
}
