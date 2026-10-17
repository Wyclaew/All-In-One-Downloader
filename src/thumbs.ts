import { useEffect, useState } from 'react'
import { bridge } from './api'

/**
 * Poster frames taken from the files themselves, shared across every card that
 * shows the same file. Failures are remembered too, so a file ffmpeg cannot read
 * is asked about once, not on every render.
 */
const cache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

function load(path: string, duration: number | null | undefined): Promise<string | null> {
  if (cache.has(path)) return Promise.resolve(cache.get(path) ?? null)
  const pending = inflight.get(path)
  if (pending) return pending
  const job = bridge
    .thumbFile(path, duration ?? null)
    .then((res) => (res && res.ok ? res.data : null))
    .catch(() => null)
    .then((url) => {
      cache.set(path, url)
      inflight.delete(path)
      return url
    })
  inflight.set(path, job)
  return job
}

export function useFileThumb(path: string | null | undefined, duration?: number | null) {
  const [url, setUrl] = useState<string | null>(() => (path ? cache.get(path) ?? null : null))
  useEffect(() => {
    if (!path) return
    let alive = true
    load(path, duration).then((u) => alive && setUrl(u))
    return () => {
      alive = false
    }
  }, [path, duration])
  return url
}
