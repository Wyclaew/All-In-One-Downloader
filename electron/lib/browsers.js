'use strict'

// Which browsers on this machine actually have a cookie store, and what to hand
// yt-dlp for each.
//
// yt-dlp knows a fixed set of browser names and looks them up at hardcoded
// paths. Opera GX is the common casualty: it lives at com.operasoftware.OperaGX
// while yt-dlp only checks com.operasoftware.Opera, so selecting "opera" fails
// with "could not find opera cookies database". The fix is yt-dlp's own
// BROWSER:PROFILE_PATH form, pointing at the real profile directory.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const { toolEnv, ytdlpPathOrThrow } = require('./binaries')

const HOME = process.env.HOME || process.env.USERPROFILE || ''
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

function mac(...parts) {
  return path.join(HOME, 'Library', 'Application Support', ...parts)
}

function win(base, ...parts) {
  const root = base === 'local' ? process.env.LOCALAPPDATA : process.env.APPDATA
  return root ? path.join(root, ...parts) : ''
}

/**
 * Candidate browsers. `engine` decides how we look for a cookie store:
 *   chromium -> a `Cookies` sqlite file in the dir or one level down
 *   firefox  -> a profile dir holding cookies.sqlite
 *   safari   -> a single binarycookies file
 * `ytdlp` is the browser name yt-dlp understands; when `explicitPath` is true we
 * append the resolved profile path so yt-dlp doesn't guess.
 */
function candidates() {
  if (IS_MAC) {
    return [
      { id: 'chrome', label: 'Chrome', ytdlp: 'chrome', engine: 'chromium', dir: mac('Google', 'Chrome') },
      { id: 'brave', label: 'Brave', ytdlp: 'brave', engine: 'chromium', dir: mac('BraveSoftware', 'Brave-Browser') },
      { id: 'edge', label: 'Edge', ytdlp: 'edge', engine: 'chromium', dir: mac('Microsoft Edge') },
      { id: 'vivaldi', label: 'Vivaldi', ytdlp: 'vivaldi', engine: 'chromium', dir: mac('Vivaldi') },
      { id: 'chromium', label: 'Chromium', ytdlp: 'chromium', engine: 'chromium', dir: mac('Chromium') },
      { id: 'opera', label: 'Opera', ytdlp: 'opera', engine: 'chromium', dir: mac('com.operasoftware.Opera') },
      {
        id: 'opera-gx',
        label: 'Opera GX',
        ytdlp: 'opera',
        engine: 'chromium',
        dir: mac('com.operasoftware.OperaGX'),
        explicitPath: true,
      },
      {
        id: 'opera-beta',
        label: 'Opera Beta',
        ytdlp: 'opera',
        engine: 'chromium',
        dir: mac('com.operasoftware.OperaNext'),
        explicitPath: true,
      },
      { id: 'firefox', label: 'Firefox', ytdlp: 'firefox', engine: 'firefox', dir: mac('Firefox', 'Profiles') },
      {
        id: 'safari',
        label: 'Safari',
        ytdlp: 'safari',
        engine: 'safari',
        dir: path.join(HOME, 'Library', 'Containers', 'com.apple.Safari', 'Data', 'Library', 'Cookies'),
        altDir: path.join(HOME, 'Library', 'Cookies'),
      },
    ]
  }

  if (IS_WIN) {
    return [
      { id: 'chrome', label: 'Chrome', ytdlp: 'chrome', engine: 'chromium', dir: win('local', 'Google', 'Chrome', 'User Data') },
      { id: 'brave', label: 'Brave', ytdlp: 'brave', engine: 'chromium', dir: win('local', 'BraveSoftware', 'Brave-Browser', 'User Data') },
      { id: 'edge', label: 'Edge', ytdlp: 'edge', engine: 'chromium', dir: win('local', 'Microsoft', 'Edge', 'User Data') },
      { id: 'vivaldi', label: 'Vivaldi', ytdlp: 'vivaldi', engine: 'chromium', dir: win('local', 'Vivaldi', 'User Data') },
      { id: 'chromium', label: 'Chromium', ytdlp: 'chromium', engine: 'chromium', dir: win('local', 'Chromium', 'User Data') },
      { id: 'opera', label: 'Opera', ytdlp: 'opera', engine: 'chromium', dir: win('roaming', 'Opera Software', 'Opera Stable') },
      {
        id: 'opera-gx',
        label: 'Opera GX',
        ytdlp: 'opera',
        engine: 'chromium',
        dir: win('roaming', 'Opera Software', 'Opera GX Stable'),
        explicitPath: true,
      },
      { id: 'firefox', label: 'Firefox', ytdlp: 'firefox', engine: 'firefox', dir: win('roaming', 'Mozilla', 'Firefox', 'Profiles') },
    ]
  }

  const config = path.join(HOME, '.config')
  return [
    { id: 'chrome', label: 'Chrome', ytdlp: 'chrome', engine: 'chromium', dir: path.join(config, 'google-chrome') },
    { id: 'chromium', label: 'Chromium', ytdlp: 'chromium', engine: 'chromium', dir: path.join(config, 'chromium') },
    { id: 'brave', label: 'Brave', ytdlp: 'brave', engine: 'chromium', dir: path.join(config, 'BraveSoftware', 'Brave-Browser') },
    { id: 'opera', label: 'Opera', ytdlp: 'opera', engine: 'chromium', dir: path.join(config, 'opera') },
    { id: 'opera-gx', label: 'Opera GX', ytdlp: 'opera', engine: 'chromium', dir: path.join(config, 'opera-gx'), explicitPath: true },
    { id: 'firefox', label: 'Firefox', ytdlp: 'firefox', engine: 'firefox', dir: path.join(HOME, '.mozilla', 'firefox') },
  ]
}

function exists(p) {
  try {
    return !!p && fs.existsSync(p)
  } catch {
    return false
  }
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** Chromium keeps cookies at <dir>/Cookies or <dir>/<Profile>/Cookies. */
function findChromiumProfile(dir) {
  if (!exists(dir)) return null
  if (exists(path.join(dir, 'Cookies'))) return dir
  if (exists(path.join(dir, 'Network', 'Cookies'))) return dir
  const preferred = ['Default', 'Profile 1', 'Profile 2']
  const names = [...preferred, ...listDirs(dir).filter((n) => !preferred.includes(n))]
  for (const name of names) {
    const profile = path.join(dir, name)
    if (exists(path.join(profile, 'Cookies')) || exists(path.join(profile, 'Network', 'Cookies'))) {
      return profile
    }
  }
  return null
}

function findFirefoxProfile(dir) {
  if (!exists(dir)) return null
  for (const name of listDirs(dir)) {
    if (exists(path.join(dir, name, 'cookies.sqlite'))) return path.join(dir, name)
  }
  return null
}

let cache = null

/**
 * Every browser we could pull cookies from, in a shape the settings UI can
 * render directly. Only entries with `available: true` will work.
 */
function detectBrowsers({ force = false } = {}) {
  if (cache && !force) return cache

  const found = []
  for (const c of candidates()) {
    let profile = null

    if (c.engine === 'chromium') {
      profile = findChromiumProfile(c.dir)
    } else if (c.engine === 'firefox') {
      profile = findFirefoxProfile(c.dir)
    } else if (c.engine === 'safari') {
      if (exists(path.join(c.dir, 'Cookies.binarycookies'))) profile = c.dir
      else if (exists(path.join(c.altDir || '', 'Cookies.binarycookies'))) profile = c.altDir
    }

    if (!profile) continue

    found.push({
      id: c.id,
      label: c.label,
      profile,
      // Safari's store isn't a profile directory yt-dlp accepts, and the names it
      // already knows work without help.
      arg: c.explicitPath ? `${c.ytdlp}:${profile}` : c.ytdlp,
      available: true,
    })
  }

  cache = found
  return cache
}

/**
 * Setting id -> the value for --cookies-from-browser.
 * Unknown ids pass through untouched so an older stored setting still works.
 */
function resolveCookieArg(id) {
  if (!id) return ''
  const match = detectBrowsers().find((b) => b.id === id)
  if (match) return match.arg
  return id
}

/**
 * Dump the selected browser's cookies to a Netscape jar.
 *
 * yt-dlp already knows how to decrypt every browser's cookie store (including
 * asking macOS Keychain for the Chromium key), and it writes the jar out on
 * exit even when the URL it was handed fails to extract. That makes it the
 * cheapest way to hand the user's real session to our own page resolver, so
 * pages that need them to be signed in work without a second login.
 *
 * Cached for a few minutes — the keychain round trip isn't free.
 */
let jarCache = { arg: null, file: null, at: 0 }
const JAR_TTL = 5 * 60 * 1000

function exportCookieJar(browserId) {
  const arg = resolveCookieArg(browserId)
  if (!arg) return Promise.resolve(null)

  if (jarCache.arg === arg && jarCache.file && Date.now() - jarCache.at < JAR_TTL) {
    try {
      if (fs.existsSync(jarCache.file)) return Promise.resolve(jarCache.file)
    } catch {
      /* fall through and re-export */
    }
  }

  return new Promise((resolve) => {
    let bin
    try {
      bin = ytdlpPathOrThrow()
    } catch {
      return resolve(null)
    }
    const file = path.join(os.tmpdir(), `edl-browser-cookies-${Date.now()}.txt`)
    execFile(
      bin,
      [
        '--ignore-config',
        '--no-warnings',
        '--cookies-from-browser',
        arg,
        '--cookies',
        file,
        '--simulate',
        // Any URL works: the jar is written on exit regardless of extraction.
        'https://example.com',
      ],
      { env: toolEnv(), timeout: 60000, windowsHide: true },
      () => {
        try {
          if (fs.existsSync(file) && fs.statSync(file).size > 0) {
            try { fs.chmodSync(file, 0o600) } catch {}
            jarCache = { arg, file, at: Date.now() }
            return resolve(file)
          }
        } catch {
          /* nothing written */
        }
        resolve(null)
      }
    )
  })
}

module.exports = { detectBrowsers, resolveCookieArg, exportCookieJar }
