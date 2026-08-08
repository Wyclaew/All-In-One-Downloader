import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, bridge, setToastSink } from './api'
import type { AppState, Download, ProgressEvent, Toast, Tools, VaultState } from './types'

const SCOPE_SAMPLES = 48

/**
 * Live view of main-process state.
 *
 * Structural changes arrive as whole-state broadcasts. Transfer progress rides
 * a separate channel and is kept in its own map, so a download ticking at 3 Hz
 * never re-renders the source list.
 */
export function useApp() {
  const [state, setState] = useState<AppState | null>(null)
  const [tools, setTools] = useState<Tools | null>(null)
  const [progress, setProgress] = useState<Record<string, ProgressEvent>>({})
  const [toasts, setToasts] = useState<Toast[]>([])
  const [menuAction, setMenuAction] = useState<{ action: string; at: number } | null>(null)

  const pushToast = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const toast: Toast = { id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, message, kind }
    setToasts((prev) => [...prev.slice(-3), toast])
    const ttl = kind === 'error' ? 7000 : 3600
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== toast.id)), ttl)
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  useEffect(() => {
    setToastSink(pushToast)
  }, [pushToast])

  useEffect(() => {
    let alive = true
    api.getState().then((s) => alive && s && setState(s))
    api.getTools().then((t) => alive && t && setTools(t))

    const offState = bridge.onState((s) => {
      setState(s)
      // Progress arrives on its own channel and was never cleaned up, so every
      // download the app had ever seen kept an entry after it was cleared away.
      setProgress((prev) => {
        const alive = new Set(s.downloads.map((d) => d.id))
        const stale = Object.keys(prev).filter((id) => !alive.has(id))
        if (!stale.length) return prev
        const next = { ...prev }
        for (const id of stale) delete next[id]
        return next
      })
    })
    const offProgress = bridge.onProgress((raw) => {
      const p = raw as ProgressEvent
      setProgress((prev) => ({ ...prev, [p.id]: p }))
    })
    const offToast = bridge.onToast((t) => pushToast(t.message, t.kind))
    const offMenu = bridge.onMenu((action) => setMenuAction({ action, at: Date.now() }))

    return () => {
      alive = false
      offState()
      offProgress()
      offToast()
      offMenu()
    }
  }, [pushToast])

  const refreshTools = useCallback(async () => {
    const t = await api.refreshTools()
    if (t) setTools(t)
    return t
  }, [])

  return { state, tools, progress, toasts, pushToast, dismissToast, refreshTools, menuAction }
}

/**
 * Vault state, kept apart from the app state on purpose: entry names only exist
 * in the main process while the vault is unlocked, so they can't live in the
 * broadcast that gets written to disk.
 */
export function useVault() {
  const [vault, setVault] = useState<VaultState>({
    exists: false,
    unlocked: false,
    count: null,
    autoLockMinutes: 15,
    dir: '',
    entries: [],
  })

  useEffect(() => {
    let alive = true
    api.vaultStatus().then((v) => alive && v && setVault(v))
    const off = bridge.onVault((v) => setVault(v))
    return () => {
      alive = false
      off()
    }
  }, [])

  return { vault, setVault }
}

/** Merge persisted download fields with the live progress channel. */
export function withProgress(download: Download, progress: Record<string, ProgressEvent>): Download {
  const live = progress[download.id]
  if (!live) return download
  return {
    ...download,
    status: live.status,
    stage: live.stage,
    percent: live.percent,
    speed: live.speed,
    eta: live.eta,
    downloaded: live.downloaded,
    total: live.total,
    phase: live.phase,
    phases: live.phases,
  }
}

/** Aggregate throughput history for the header scope. */
export function useThroughput(downloads: Download[]) {
  const [samples, setSamples] = useState<number[]>(() => new Array(SCOPE_SAMPLES).fill(0))
  const ref = useRef(0)

  const current = useMemo(
    () =>
      downloads.reduce(
        (sum, d) => (d.status === 'running' && d.speed ? sum + d.speed : sum),
        0
      ),
    [downloads]
  )
  ref.current = current

  useEffect(() => {
    const id = window.setInterval(() => {
      setSamples((prev) => [...prev.slice(1), ref.current])
    }, 600)
    return () => window.clearInterval(id)
  }, [])

  return { samples, current }
}

/** Resolve the effective theme, following the OS when asked to. */
export function useTheme(preference: 'dark' | 'light' | 'system' | undefined) {
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const theme = preference === 'system' || !preference ? (systemDark ? 'dark' : 'light') : preference

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
  }, [theme])

  return theme
}
