'use strict'

// Poster frames for the home page, taken from the files themselves.
//
// The site's own thumbnail URL is a poor poster: it is often a cropped clickbait
// still, it needs the network, and loading it tells the site every time you open
// your own library. A frame from the file is offline and accurate, and it is what
// the user will actually see when they press play.
//
// Frames are cached under userData/thumbs, named after a hash of the path plus the
// file's size and modification time — so a file that is replaced gets a fresh
// frame, and `forget` can remove every frame of a path without an index.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { app } = require('electron')
const { ffmpegPath, toolEnv } = require('./binaries')

const WIDTH = 480
const MAX_PARALLEL = 2

const dir = () => path.join(app.getPath('userData'), 'thumbs')
const pathId = (file) =>
  crypto.createHash('sha1').update(path.resolve(file).normalize('NFC')).digest('hex').slice(0, 24)

let running = 0
const waiting = []
const inflight = new Map()

function slot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      running += 1
      fn()
        .then(resolve, reject)
        .finally(() => {
          running -= 1
          const next = waiting.shift()
          if (next) next()
        })
    }
    if (running < MAX_PARALLEL) run()
    else waiting.push(run)
  })
}

function grab(src, seconds) {
  return new Promise((resolve) => {
    const bin = ffmpegPath()
    if (!bin) return resolve(null)
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin']
    if (seconds > 0) args.push('-ss', String(seconds))
    args.push('-i', src, '-frames:v', '1', '-vf', `scale=${WIDTH}:-2`, '-q:v', '4', '-f', 'mjpeg', 'pipe:1')
    execFile(
      bin,
      args,
      { env: toolEnv(), timeout: 25000, windowsHide: true, maxBuffer: 6 * 1024 * 1024, encoding: 'buffer' },
      (err, out) => resolve(!err && out && out.length > 1500 ? out : null)
    )
  })
}

/**
 * A data URL for `file`, or null for audio and anything ffmpeg cannot read.
 *
 * The frame is taken some way in — frame zero is a black fade or a logo card far
 * more often than not — and falls back to earlier points for short clips.
 */
async function thumbFor(file, durationHint) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  const id = pathId(file)
  const name = `${id}-${Math.round(stat.mtimeMs)}-${stat.size}.jpg`
  const cached = path.join(dir(), name)
  try {
    return `data:image/jpeg;base64,${fs.readFileSync(cached).toString('base64')}`
  } catch {
    /* not made yet */
  }

  if (inflight.has(name)) return inflight.get(name)
  const job = slot(async () => {
    const duration = Number(durationHint) || 0
    const points = duration > 0 ? [Math.min(90, Math.max(3, duration * 0.12)), 1] : [30, 4, 0]
    let jpeg = null
    for (const at of points) {
      jpeg = await grab(file, at)
      if (jpeg) break
    }
    if (!jpeg) return null
    fs.mkdirSync(dir(), { recursive: true })
    // Older frames of the same path are stale the moment a new one exists.
    forget(file)
    fs.writeFileSync(cached, jpeg)
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`
  }).finally(() => inflight.delete(name))
  inflight.set(name, job)
  return job
}

/** Remove every cached frame of `file` — for one moved into the vault, above all. */
function forget(file) {
  if (!file) return
  const id = pathId(file)
  let names = []
  try {
    names = fs.readdirSync(dir())
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith(`${id}-`)) fs.rmSync(path.join(dir(), name), { force: true })
  }
}

module.exports = { thumbFor, forget }
