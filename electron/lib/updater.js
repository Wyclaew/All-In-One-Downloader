'use strict'

// Updating the app from its GitHub releases.
//
// The stock route (electron-updater) is out on macOS: it hands the swap to
// Squirrel.Mac, which refuses any update whose code signature does not satisfy
// the running app's designated requirement — and an ad-hoc signed build's
// requirement is its own hash, which every new build changes. So the swap is done
// here, the same way on every platform:
//
//   1. ask the GitHub API for the latest release and compare versions;
//   2. download this platform's package from the release, following GitHub's
//      redirect to its storage host and nowhere else;
//   3. check its size and SHA-512 against latest-mac.yml / latest.yml, which
//      electron-builder publishes in the same release — a truncated or altered
//      download is thrown away, never installed;
//   4. macOS: unpack the .app beside the old one, and once this process has
//      exited, move it into place and relaunch. Windows: run the installer
//      silently, which closes us, installs, and starts the new version.
//
// Nothing is installed without the user pressing the button.

const crypto = require('crypto')
const fs = require('fs')
const https = require('https')
const path = require('path')
const { spawn, execFile } = require('child_process')
const { Transform } = require('stream')
const { pipeline } = require('stream/promises')
const { app, shell, safeStorage } = require('electron')
const store = require('./store')
const { parseVersion, compareVersions, parseManifest, validTarget } = require('./update-metadata')

const OWNER = 'Wyclaew'
const REPO = 'All-In-One-Downloader'
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`
const UA = `AllInOneDownloader/${app.getVersion ? app.getVersion() : '0'} (updater)`

// Release assets redirect from github.com to GitHub's storage hosts. Anything else
// in a redirect chain is refused rather than followed.
const TRUSTED_HOST = /^(?:github\.com|api\.github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com|[a-z0-9-]+\.githubusercontent\.com)$/i

let state = { phase: 'idle', current: null, latest: null, notes: '', percent: 0, message: '', url: RELEASES_PAGE }
let pending = null
let timer = null
let startupTimer = null
let checking = null
let manualCheck = false

function publish(patch) {
  state = { ...state, ...patch }
  store.send('update', state)
  return state
}

/* -------------------------------------------------------------------------- */
/* versions                                                                    */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* network                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The access token for a private repository, if the user gave one.
 *
 * Kept encrypted with the OS keystore (Keychain on macOS, DPAPI on Windows), so
 * the plain-text settings file holds only ciphertext. It is never sent anywhere
 * but api.github.com — when GitHub redirects a download to its storage host, the
 * signed address carries its own permission and the token stays behind.
 */
function token() {
  const sealed = store.getState().settings.updateTokenSealed
  if (!sealed) return ''
  try {
    return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
  } catch {
    return ''
  }
}

function setToken(value) {
  const clean = String(value || '').trim()
  let sealed = ''
  if (clean) {
    if (!/^(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{40,})$/.test(clean)) {
      throw new Error('Bu bir GitHub erişim anahtarına benzemiyor (ghp_… ya da github_pat_… ile başlar).')
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Bu sistemde anahtarı güvenle saklayacak bir anahtar deposu yok.')
    sealed = safeStorage.encryptString(clean).toString('base64')
  }
  store.commit((s) => {
    s.settings.updateTokenSealed = sealed
  })
  return !!sealed
}

function get(url, { json = false, accept = '*/*', redirects = 6, auth = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      return reject(new Error('Güncelleme adresi geçersiz.'))
    }
    if (parsed.protocol !== 'https:' || !TRUSTED_HOST.test(parsed.hostname)) {
      return reject(new Error(`Güncelleme beklenmeyen bir adrese yönlendirdi: ${parsed.hostname}`))
    }
    const headers = { 'User-Agent': UA, Accept: json ? 'application/vnd.github+json' : accept }
    const secret = auth && parsed.hostname === 'api.github.com' ? token() : ''
    if (secret) headers.Authorization = `Bearer ${secret}`
    const req = https.get(url, { headers, timeout: 30000, signal }, (res) => {
      res.on('error', () => {})
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        if (redirects <= 0) return reject(new Error('Çok fazla yönlendirme.'))
        let next
        try { next = new URL(res.headers.location, url).href } catch { return reject(new Error('Güncelleme yönlendirmesi geçersiz.')) }
        return resolve(get(next, { json, accept, redirects: redirects - 1, auth, signal }))
      }
      if (res.statusCode !== 200) {
        res.resume()
        if (res.statusCode === 404 && parsed.hostname === 'api.github.com' && !secret) {
          const err = new Error(
            'GitHub deposu gizli olduğu için sürümler görünmüyor. Depoyu herkese açık yap ya da Ayarlar → Uygulama → Güncellemeler bölümüne salt-okunur bir GitHub anahtarı gir.'
          )
          err.code = 'PRIVATE'
          return reject(err)
        }
        if (res.statusCode === 401) return reject(new Error('GitHub anahtarı geçersiz ya da süresi dolmuş.'))
        return reject(new Error(res.statusCode === 403 ? 'GitHub şu an çok fazla istek aldı; biraz sonra tekrar dene.' : `GitHub ${res.statusCode} döndü.`))
      }
      resolve(res)
    })
    req.on('timeout', () => req.destroy(new Error('GitHub yanıt vermedi.')))
    req.on('error', reject)
  })
}

async function getText(url, opts) {
  const res = await get(url, { ...opts, signal: AbortSignal.timeout(30000) })
  const chunks = []
  let size = 0
  for await (const c of res) {
    size += c.length
    if (size > 2 * 1024 * 1024) { res.destroy(); throw new Error('Güncelleme yanıtı boyut sınırını aştı.') }
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/* -------------------------------------------------------------------------- */
/* what to download                                                            */
/* -------------------------------------------------------------------------- */

function platformPick(manifest) {
  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    return manifest.files.find((f) => f.url.endsWith(`-${arch}-mac.zip`)) || null
  }
  if (process.platform === 'win32') return manifest.files.find((f) => /\.exe$/i.test(f.url)) || null
  return null
}


function manifestName() {
  if (process.platform === 'darwin') return 'latest-mac.yml'
  if (process.platform === 'win32') return 'latest.yml'
  return null
}

/* -------------------------------------------------------------------------- */
/* public                                                                      */
/* -------------------------------------------------------------------------- */

/** Ask GitHub whether a newer version exists. Quiet unless something changed. */
function check({ manual = false } = {}) {
  if (state.phase === 'downloading' || state.phase === 'installing') return Promise.resolve(state)
  manualCheck ||= manual
  if (!checking) checking = performCheck().finally(() => { checking = null; manualCheck = false })
  return checking
}

async function performCheck() {
  const current = app.getVersion()
  const previous = state
  publish({ phase: 'checking', current, message: '' })
  try {
    const release = JSON.parse(await getText(API, { json: true, auth: true }))
    const latest = String(release.tag_name || '').replace(/^v/, '')
    if (!parseVersion(latest) || release.draft || release.prerelease) throw new Error('GitHub geçerli bir kararlı sürüm döndürmedi.')
    if (compareVersions(latest, current) <= 0) {
      pending = null
      return publish({ phase: 'current', latest, automatic: false, notes: '', message: manualCheck ? 'Uygulama güncel.' : '' })
    }
    const name = manifestName()
    const assetOf = (n) => (release.assets || []).find((a) => a.name === n)
    // Through the API with the token for a private repository; the public
    // download address otherwise. Both end at the same signed storage URL.
    const fetchAsset = (asset) =>
      token()
        ? { url: asset.url, opts: { accept: 'application/octet-stream', auth: true } }
        : { url: asset.browser_download_url, opts: {} }
    let target = null
    if (name && assetOf(name)) {
      const m = fetchAsset(assetOf(name))
      const manifest = parseManifest(await getText(m.url, m.opts))
      const pick = platformPick(manifest)
      const asset = pick && assetOf(pick.url)
      if (manifest.version === latest && validTarget(pick, asset, manifest.version)) {
        const d = fetchAsset(asset)
        target = { ...pick, download: d.url, downloadOpts: d.opts, name: pick.url }
      }
    }
    pending = { latest, target }
    // Only the first paragraph of the notes: the full text is on the release page.
    const notes = String(release.body || '')
      .split(/\r?\n\r?\n/)
      .slice(0, 2)
      .join('\n\n')
      .slice(0, 600)
    return publish({
      phase: 'available',
      latest,
      notes,
      url: release.html_url || RELEASES_PAGE,
      automatic: !!(target && app.isPackaged),
      message: '',
    })
  } catch (err) {
    if (pending && previous.phase === 'available') return publish({ ...previous, message: manualCheck ? err.message : previous.message })
    return publish({ phase: manualCheck ? 'error' : 'idle', automatic: false, message: manualCheck ? err.message : '', private: err.code === 'PRIVATE' })
  }
}

/** Download, verify, and swap in the new version, then restart. */
async function install() {
  if (!pending || state.phase !== 'available') throw new Error('Yüklenecek bir güncelleme yok.')
  const { target, latest } = pending
  if (!target || !app.isPackaged) {
    // No package for this platform, or a development run: the release page it is.
    await shell.openExternal(state.url || RELEASES_PAGE)
    return publish({ message: 'Yeni sürüm tarayıcıda açıldı.' })
  }

  const dir = path.join(app.getPath('userData'), 'updates')
  const file = path.join(dir, path.basename(target.name))

  publish({ phase: 'downloading', percent: 0, message: '' })
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const res = await get(target.download, target.downloadOpts || {})
    const hash = crypto.createHash('sha512')
    let got = 0
    let last = 0
    const meter = new Transform({ transform(chunk, _encoding, next) {
      try {
      got += chunk.length
      if (got > target.size) throw new Error('İndirilen dosya beklenenden büyük.')
      hash.update(chunk)
      const percent = Math.floor((got / target.size) * 100)
      if (percent !== last) {
        last = percent
        publish({ percent })
      }
      next(null, chunk)
      } catch (err) { next(err) }
    } })
    await pipeline(res, meter, fs.createWriteStream(file))
    if (got !== target.size) throw new Error('İndirme yarım kaldı.')
    if (hash.digest('base64') !== target.sha512) {
      throw new Error('İndirilen dosyanın imzası (SHA-512) uyuşmadı; kurulmadı.')
    }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true })
    publish({ phase: 'available', message: err.message })
    throw err
  }

  publish({ phase: 'installing', percent: 100, message: `${latest} kuruluyor, uygulama yeniden açılacak…` })
  try {
    if (process.platform === 'darwin') await swapMac(file, dir)
    else if (process.platform === 'win32') await runWindowsInstaller(file)
  } catch (err) {
    publish({ phase: 'available', message: err.message })
    throw err
  }
  setTimeout(() => app.quit(), 400)
  return state
}

/** The .app this process runs from. */
function currentBundle() {
  // …/All in One Downloader.app/Contents/MacOS/All in One Downloader
  return path.resolve(path.dirname(process.execPath), '..', '..')
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

async function swapMac(zip, dir) {
  const bundle = currentBundle()
  if (!bundle.endsWith('.app')) throw new Error('Uygulama paketi bulunamadı.')
  const parent = path.dirname(bundle)
  try {
    fs.accessSync(parent, fs.constants.W_OK)
    fs.accessSync(bundle, fs.constants.W_OK)
  } catch {
    await shell.openExternal(state.url || RELEASES_PAGE)
    throw new Error(`${parent} klasörüne yazma izni yok; yeni sürüm tarayıcıda açıldı, oradan kurabilirsin.`)
  }

  const unpacked = path.join(dir, 'unpacked')
  fs.mkdirSync(unpacked, { recursive: true })
  await new Promise((resolve, reject) =>
    execFile('/usr/bin/ditto', ['-x', '-k', zip, unpacked], (err) => (err ? reject(new Error('Güncelleme paketi açılamadı.')) : resolve()))
  )
  const app2 = fs.readdirSync(unpacked).find((n) => n.endsWith('.app'))
  if (!app2) throw new Error('Güncelleme paketinde uygulama yok.')
  const fresh = path.join(unpacked, app2)
  // Staged on the same volume as the target so the final move is a rename.
  const staged = path.join(parent, `.${path.basename(bundle)}.update`)
  fs.rmSync(staged, { recursive: true, force: true })
  await new Promise((resolve, reject) =>
    execFile('/usr/bin/ditto', [fresh, staged], (err) => (err ? reject(new Error('Yeni sürüm yerine kopyalanamadı.')) : resolve()))
  )

  // Runs after we exit: wait for this process to be gone, swap, relaunch. If the
  // swap fails half way the old bundle is put back, so the user is never left
  // with no app at all.
  const backup = `${bundle}.old`
  const script = path.join(dir, 'swap.sh')
  fs.writeFileSync(
    script,
    [
      '#!/bin/sh',
      `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done`,
      `rm -rf ${shellQuote(backup)}`,
      `if mv ${shellQuote(bundle)} ${shellQuote(backup)} && mv ${shellQuote(staged)} ${shellQuote(bundle)}; then`,
      `  rm -rf ${shellQuote(backup)}`,
      'else',
      `  [ -d ${shellQuote(backup)} ] && [ ! -d ${shellQuote(bundle)} ] && mv ${shellQuote(backup)} ${shellQuote(bundle)}`,
      'fi',
      `xattr -dr com.apple.quarantine ${shellQuote(bundle)} 2>/dev/null`,
      `open ${shellQuote(bundle)}`,
      `rm -rf ${shellQuote(dir)}`,
      '',
    ].join('\n'),
    { mode: 0o700 }
  )
  await launchDetached('/bin/sh', [script])
}

function launchDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

function runWindowsInstaller(exe) {
  // /S: silent. --force-run: start the app again once installed. The installer
  // closes the running copy itself, which is us, a moment after we quit anyway.
  return launchDetached(exe, ['/S', '--updated', '--force-run'])
}

/** Check shortly after start, then every six hours, if the user allows it. */
function schedule() {
  if (timer) clearInterval(timer)
  clearTimeout(startupTimer)
  const run = () => {
    if (store.getState().settings.autoCheckUpdates === false) return
    check().catch(() => {})
  }
  startupTimer = setTimeout(run, 15000)
  startupTimer.unref?.()
  timer = setInterval(run, 6 * 3600 * 1000)
  if (timer.unref) timer.unref()
}

const getStatus = () => ({ ...state, current: app.getVersion(), hasToken: !!store.getState().settings.updateTokenSealed })

module.exports = { check, install, schedule, getStatus, setToken, compareVersions, parseManifest, validTarget, _swapMac: swapMac }
