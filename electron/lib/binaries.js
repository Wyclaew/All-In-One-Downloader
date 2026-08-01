'use strict'

// Locating yt-dlp / ffmpeg, on macOS and Windows alike.
//
// The important macOS detail: a GUI Electron app does NOT inherit the shell's
// PATH, so /opt/homebrew/bin is invisible unless we add it ourselves. Every
// child process in this app is spawned with the env from toolEnv().

const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { app } = require('electron')

const IS_WIN = process.platform === 'win32'
const EXE = IS_WIN ? '.exe' : ''

/** Directories we search in addition to PATH. */
function extraDirs() {
  if (IS_WIN) {
    const dirs = []
    if (process.env.LOCALAPPDATA) {
      dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps'))
      dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs'))
    }
    if (process.env.ProgramFiles) dirs.push(path.join(process.env.ProgramFiles, 'yt-dlp'))
    return dirs
  }
  const home = process.env.HOME || ''
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    home ? path.join(home, '.local', 'bin') : '',
    home ? path.join(home, 'bin') : '',
  ].filter(Boolean)
}

/** Binaries shipped inside the packaged app (resources/bin/...). */
function bundledDirs() {
  const dirs = []
  try {
    if (process.resourcesPath) {
      dirs.push(path.join(process.resourcesPath, 'bin'))
      dirs.push(path.join(process.resourcesPath, 'bin', process.platform))
    }
  } catch {
    /* not packaged */
  }
  try {
    dirs.push(path.join(app.getAppPath(), 'resources', 'bin'))
  } catch {
    /* app not ready */
  }
  return dirs
}

/** Env for spawning tools: PATH widened so brew/winget installs are found. */
function toolEnv() {
  const sep = IS_WIN ? ';' : ':'
  const current = (process.env.PATH || '').split(sep).filter(Boolean)
  const merged = [...bundledDirs(), ...current, ...extraDirs()]
  const seen = new Set()
  const parts = merged.filter((d) => d && !seen.has(d) && seen.add(d))
  return { ...process.env, PATH: parts.join(sep) }
}

function isExecutable(p) {
  try {
    const st = fs.statSync(p)
    if (!st.isFile()) return false
    if (IS_WIN) return true
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function locate(name) {
  const filename = name + EXE
  const sep = IS_WIN ? ';' : ':'
  const dirs = [...bundledDirs(), ...(process.env.PATH || '').split(sep), ...extraDirs()]
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = path.join(dir, filename)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

function runVersion(binPath, args) {
  return new Promise((resolve) => {
    execFile(binPath, args, { env: toolEnv(), timeout: 12000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve(null)
      const out = String(stdout || stderr || '').trim()
      resolve(out.split('\n')[0] || null)
    })
  })
}

let cache = null

/** { ytdlp: {path, version} | null, ffmpeg: {path, version} | null } */
async function detectTools({ force = false } = {}) {
  if (cache && !force) return cache
  const ytdlpPath = locate('yt-dlp')
  const ffmpegPath = locate('ffmpeg')
  const [ytdlpVersion, ffmpegVersion] = await Promise.all([
    ytdlpPath ? runVersion(ytdlpPath, ['--version']) : Promise.resolve(null),
    ffmpegPath ? runVersion(ffmpegPath, ['-version']) : Promise.resolve(null),
  ])
  cache = {
    ytdlp: ytdlpPath ? { path: ytdlpPath, version: ytdlpVersion } : null,
    ffmpeg: ffmpegPath
      ? {
          path: ffmpegPath,
          version: (ffmpegVersion || '').replace(/^ffmpeg version\s*/i, '').split(' ')[0] || null,
        }
      : null,
    platform: process.platform,
    installHint: IS_WIN
      ? 'winget install yt-dlp.yt-dlp ; winget install Gyan.FFmpeg'
      : 'brew install yt-dlp ffmpeg',
  }
  return cache
}

function ytdlpPathOrThrow() {
  const p = cache && cache.ytdlp ? cache.ytdlp.path : locate('yt-dlp')
  if (!p) {
    const err = new Error('yt-dlp bulunamadı')
    err.code = 'NO_YTDLP'
    throw err
  }
  return p
}

function ffmpegPath() {
  return cache && cache.ffmpeg ? cache.ffmpeg.path : locate('ffmpeg')
}

/** `yt-dlp -U`. Only works for standalone binaries; package managers own theirs. */
function updateYtdlp() {
  return new Promise((resolve) => {
    let bin
    try {
      bin = ytdlpPathOrThrow()
    } catch {
      return resolve({ ok: false, message: 'yt-dlp bulunamadı.' })
    }
    execFile(bin, ['-U'], { env: toolEnv(), timeout: 120000, windowsHide: true }, async (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim()
      await detectTools({ force: true })
      if (err && !out) return resolve({ ok: false, message: 'Güncelleme çalıştırılamadı.' })
      const managed = /not.*writable|Permission denied|installed by/i.test(out)
      resolve({
        ok: !managed,
        message: managed
          ? 'Bu yt-dlp bir paket yöneticisiyle kurulmuş. Terminalden güncelle: brew upgrade yt-dlp'
          : out.split('\n').slice(-2).join(' ') || 'Güncel.',
      })
    })
  })
}

module.exports = { detectTools, toolEnv, ytdlpPathOrThrow, ffmpegPath, updateYtdlp, locate, IS_WIN }
