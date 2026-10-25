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
  const env = { ...process.env, PATH: parts.join(sep) }
  // Routing belongs to the individual source. Shell/launcher proxy variables
  // must neither send direct jobs into a proxy nor bypass an explicit one via
  // NO_PROXY. Callers add the selected proxy explicitly after this baseline.
  for (const key of Object.keys(env)) if (/^(?:(?:https?|all|ftp|no)_proxy|NODE_USE_ENV_PROXY)$/i.test(key)) delete env[key]
  return env
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

function inspectTool(binPath, args) {
  return new Promise((resolve) => {
    execFile(binPath, args, { env: toolEnv(), timeout: 12000, windowsHide: true }, (err, stdout, stderr) => {
      const output = String(stdout || stderr || '').trim()
      const runnable = !err && !!output
      resolve({ path: binPath, version: runnable ? output.split('\n')[0].slice(0, 300) : null, runnable,
        error: runnable ? null : err?.killed ? 'Araç yanıt vermedi. Kurulumu kontrol edip yeniden denetle.' : 'Araç bulundu ancak çalıştırılamadı. Kurulumu kontrol edip yeniden denetle.' })
    })
  })
}

let cache = null, checking = null

async function detectTools({ force = false } = {}) {
  if (cache && !force) return cache
  if (checking) return checking
  checking = (async () => {
    const ytdlpPath = locate('yt-dlp'), ffmpegFound = locate('ffmpeg')
    let ffprobeFound = locate('ffprobe')
    if (!ffprobeFound && ffmpegFound) {
      const sibling = path.join(path.dirname(ffmpegFound), `ffprobe${EXE}`)
      if (isExecutable(sibling)) ffprobeFound = sibling
    }
    const [ytdlp, ffmpeg, ffprobe] = await Promise.all([
      ytdlpPath ? inspectTool(ytdlpPath, ['--version']) : null,
      ffmpegFound ? inspectTool(ffmpegFound, ['-version']) : null,
      ffprobeFound ? inspectTool(ffprobeFound, ['-version']) : null,
    ])
    if (ffmpeg?.version) ffmpeg.version = ffmpeg.version.replace(/^ffmpeg version\s*/i, '').split(' ')[0]
    if (ffprobe?.version) ffprobe.version = ffprobe.version.replace(/^ffprobe version\s*/i, '').split(' ')[0]
    cache = { ytdlp, ffmpeg, ffprobe, platform: process.platform,
      installHint: IS_WIN ? 'winget install yt-dlp.yt-dlp ; winget install Gyan.FFmpeg' : 'brew install yt-dlp ffmpeg' }
    return cache
  })()
  try { return await checking } finally { checking = null }
}

function ytdlpPathOrThrow() {
  if (cache?.ytdlp?.runnable === false) { const err = new Error('yt-dlp bulundu ancak çalıştırılamıyor. Ayarlar → Araçlar bölümünü kontrol et.'); err.code = 'NO_YTDLP'; throw err }
  const p = cache && cache.ytdlp ? cache.ytdlp.path : locate('yt-dlp')
  if (!p) {
    const err = new Error('yt-dlp bulunamadı')
    err.code = 'NO_YTDLP'
    throw err
  }
  return p
}

function ffmpegPath() {
  if (cache?.ffmpeg?.runnable === false) return null
  return cache && cache.ffmpeg ? cache.ffmpeg.path : locate('ffmpeg')
}

function ffprobePath() {
  if (cache?.ffprobe?.runnable === false) return null
  if (cache && cache.ffprobe) return cache.ffprobe.path
  const direct = locate('ffprobe')
  if (direct) return direct
  const ff = ffmpegPath()
  if (ff) {
    const sibling = path.join(path.dirname(ff), `ffprobe${EXE}`)
    if (isExecutable(sibling)) return sibling
  }
  return null
}

/** `yt-dlp -U`. Only works for standalone binaries; package managers own theirs. */
function updateYtdlp() {
  return new Promise((resolve) => {
    let bin
    try {
      bin = ytdlpPathOrThrow()
    } catch (err) {
      return resolve({ ok: false, message: err.message || 'yt-dlp bulunamadı.' })
    }
    execFile(bin, ['-U'], { env: toolEnv(), timeout: 120000, windowsHide: true }, async (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim()
      await detectTools({ force: true })
      if (err && !out) return resolve({ ok: false, message: 'Güncelleme çalıştırılamadı.' })
      const managed = /not.*writable|Permission denied|installed by/i.test(out)
      resolve({
        ok: !err && !managed,
        message: managed
          ? `Bu yt-dlp bir paket yöneticisiyle kurulmuş. ${IS_WIN ? 'Kurulum yaptığın paket yöneticisinden güncelle.' : 'Terminalden güncelle: brew upgrade yt-dlp'}`
          : out.split('\n').slice(-2).join(' ') || 'Güncel.',
      })
    })
  })
}

module.exports = {
  detectTools,
  toolEnv,
  ytdlpPathOrThrow,
  ffmpegPath,
  ffprobePath,
  updateYtdlp,
  locate,
  IS_WIN,
}
