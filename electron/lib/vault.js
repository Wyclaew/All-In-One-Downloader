'use strict'

// The vault: a folder inside the app where a file's *contents and its name* are
// both encrypted, so nothing on disk says what is in there.
//
// Layout under userData/vault:
//   meta.json      salt + KDF parameters. Public by design: a salt is not a secret.
//   index.bin      the encrypted catalogue — names, titles, sizes, dates.
//   blobs/<id>     one encrypted file per entry, named after a random id.
//
// Both index.bin and each blob are AES-256-GCM with a random 96-bit nonce and the
// 16-byte tag appended, so a modified file fails to open instead of decrypting to
// garbage. The key is scrypt(passphrase, salt) and lives only in this process's
// memory while the vault is unlocked — it is never written down and never crosses
// the IPC bridge.
//
// What this protects against: someone who has the disk, the backup, or the folder.
// What it cannot protect against: someone at the keyboard while the vault is
// unlocked. Playing a file necessarily writes a decrypted copy to a private temp
// directory for as long as the player holds it open; those copies are deleted when
// the vault locks, on quit, and after an idle timeout.

const crypto = require('crypto')
const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const { pipeline } = require('stream/promises')
const { app, shell } = require('electron')
const { ffmpegPath, toolEnv } = require('./binaries')

const MAGIC = Buffer.from('AIO1')
const NONCE_LEN = 12
const TAG_LEN = 16
const HEADER_LEN = MAGIC.length + NONCE_LEN

// scrypt at N=2^15 costs ~100 ms and 32 MB per guess, which is the point: it is
// paid once on unlock and a great many times by anyone guessing.
const KDF = { N: 32768, r: 8, p: 1, keyLen: 32, maxmem: 96 * 1024 * 1024 }
const MIN_PASSPHRASE = 6
const DEFAULT_AUTOLOCK_MS = 15 * 60 * 1000

/** key, entries and temp paths exist only while unlocked. */
let key = null
let entries = []
let openedTemps = new Set()
let lockTimer = null
let autoLockMs = DEFAULT_AUTOLOCK_MS
let onLockedListener = null
/** Long encrypt/decrypt operations in flight. The idle lock waits for them. */
let busy = 0

/* -------------------------------------------------------------------------- */
/* paths                                                                       */
/* -------------------------------------------------------------------------- */

function root() {
  return path.join(app.getPath('userData'), 'vault')
}
const metaFile = () => path.join(root(), 'meta.json')
const indexFile = () => path.join(root(), 'index.bin')
const blobDir = () => path.join(root(), 'blobs')
const blobFile = (id) => path.join(blobDir(), id)
/** Poster frame for an entry, encrypted with the same key as everything else. */
const thumbFile = (id) => path.join(blobDir(), `${id}.t`)

function tempRoot() {
  // Not the shared /tmp: a per-user directory we create with 0700 ourselves.
  return path.join(os.tmpdir(), `aio-vault-${process.pid}`)
}

/* -------------------------------------------------------------------------- */
/* crypto                                                                      */
/* -------------------------------------------------------------------------- */

function deriveKey(passphrase, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(String(passphrase), 'utf8'),
      salt,
      KDF.keyLen,
      { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: KDF.maxmem },
      (err, derived) => (err ? reject(err) : resolve(derived))
    )
  })
}

function readMeta() {
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile(), 'utf8'))
    if (!meta || typeof meta.salt !== 'string') return null
    return meta
  } catch {
    return null
  }
}

function sealBuffer(plain) {
  const nonce = crypto.randomBytes(NONCE_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([MAGIC, nonce, body, cipher.getAuthTag()])
}

function openBuffer(blob) {
  if (blob.length < HEADER_LEN + TAG_LEN || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Kasa dosyası tanınmıyor.')
  }
  const nonce = blob.subarray(MAGIC.length, HEADER_LEN)
  const tag = blob.subarray(blob.length - TAG_LEN)
  const body = blob.subarray(HEADER_LEN, blob.length - TAG_LEN)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

/** Stream a file in, so a 4 GB video never sits in memory. */
async function sealFile(srcPath, destPath) {
  const nonce = crypto.randomBytes(NONCE_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  const out = fs.createWriteStream(destPath, { mode: 0o600 })
  await new Promise((resolve, reject) => {
    out.write(Buffer.concat([MAGIC, nonce]), (err) => (err ? reject(err) : resolve()))
  })
  await pipeline(fs.createReadStream(srcPath), cipher, out, { end: false })
  // The tag is only known once the last byte is in, so it lands at the end.
  await new Promise((resolve, reject) => {
    out.end(cipher.getAuthTag(), (err) => (err ? reject(err) : resolve()))
  })
}

async function openFileTo(srcPath, destPath) {
  const stat = await fsp.stat(srcPath)
  if (stat.size < HEADER_LEN + TAG_LEN) throw new Error('Kasa dosyası bozuk.')

  const handle = await fsp.open(srcPath, 'r')
  let nonce
  let tag
  try {
    const head = Buffer.alloc(HEADER_LEN)
    await handle.read(head, 0, HEADER_LEN, 0)
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Kasa dosyası tanınmıyor.')
    nonce = head.subarray(MAGIC.length)
    tag = Buffer.alloc(TAG_LEN)
    await handle.read(tag, 0, TAG_LEN, stat.size - TAG_LEN)
  } finally {
    await handle.close()
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)

  // An empty file seals to header + tag and nothing between. A read stream whose
  // end lands before its start throws, so verify the tag and write the empty file.
  if (stat.size === HEADER_LEN + TAG_LEN) {
    decipher.final()
    await fsp.writeFile(destPath, Buffer.alloc(0), { mode: 0o600 })
    return
  }

  await pipeline(
    fs.createReadStream(srcPath, { start: HEADER_LEN, end: stat.size - TAG_LEN - 1 }),
    decipher,
    fs.createWriteStream(destPath, { mode: 0o600 })
  )
}

/* -------------------------------------------------------------------------- */
/* poster frames                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A frame from the video itself, made while the plaintext is still on disk.
 *
 * The alternative was to keep the site's thumbnail URL and let the interface load
 * it, which would have meant the vault phoning the source site every time you
 * looked at the list — telling that site what you are keeping and when you look
 * at it. Extracting one frame locally and encrypting it with everything else
 * keeps the vault self-contained and offline.
 */
function makeThumb(srcPath) {
  return new Promise((resolve) => {
    const bin = ffmpegPath()
    if (!bin) return resolve(null)
    // Five seconds in, because frame zero of a film is usually black. If the file
    // is shorter than that ffmpeg returns nothing and we simply have no poster.
    execFile(
      bin,
      [
        '-hide_banner', '-loglevel', 'error',
        '-ss', '5',
        '-i', srcPath,
        '-frames:v', '1',
        '-vf', 'scale=320:-2',
        '-q:v', '5',
        '-f', 'mjpeg',
        'pipe:1',
      ],
      { env: toolEnv(), timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout) => {
        if (!err && stdout && stdout.length > 1024) return resolve(stdout)
        // Too short to seek into: take the first frame instead.
        execFile(
          bin,
          [
            '-hide_banner', '-loglevel', 'error',
            '-i', srcPath,
            '-frames:v', '1',
            '-vf', 'scale=320:-2',
            '-q:v', '5',
            '-f', 'mjpeg',
            'pipe:1',
          ],
          { env: toolEnv(), timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' },
          (err2, out2) => resolve(!err2 && out2 && out2.length > 1024 ? out2 : null)
        )
      }
    )
  })
}

/** id -> data URL, held only while unlocked. */
let thumbCache = new Map()

function thumbFor(id) {
  if (thumbCache.has(id)) return thumbCache.get(id)
  let url = null
  try {
    const jpeg = openBuffer(fs.readFileSync(thumbFile(id)))
    url = `data:image/jpeg;base64,${jpeg.toString('base64')}`
  } catch {
    url = null // no poster for this one; the list falls back to a padlock
  }
  thumbCache.set(id, url)
  return url
}

/* -------------------------------------------------------------------------- */
/* index                                                                       */
/* -------------------------------------------------------------------------- */

async function saveIndex() {
  requireUnlocked()
  const blob = sealBuffer(Buffer.from(JSON.stringify({ entries }), 'utf8'))
  const tmp = `${indexFile()}.tmp`
  await fsp.writeFile(tmp, blob, { mode: 0o600 })
  await fsp.rename(tmp, indexFile())
}

async function loadIndex() {
  let blob
  try {
    blob = await fsp.readFile(indexFile())
  } catch {
    return []
  }
  const parsed = JSON.parse(openBuffer(blob).toString('utf8'))
  return Array.isArray(parsed.entries) ? parsed.entries : []
}

/* -------------------------------------------------------------------------- */
/* lock state                                                                  */
/* -------------------------------------------------------------------------- */

function requireUnlocked() {
  if (!key) {
    const err = new Error('Kasa kilitli.')
    err.code = 'LOCKED'
    throw err
  }
}

function armAutoLock() {
  if (lockTimer) clearTimeout(lockTimer)
  lockTimer = null
  if (!key || !autoLockMs || busy) return
  lockTimer = setTimeout(() => lock({ reason: 'timeout' }), autoLockMs)
  // Don't hold the process open just to lock something that quitting locks anyway.
  if (lockTimer.unref) lockTimer.unref()
}

/** Any vault action counts as activity and pushes the idle lock back. */
function touch() {
  if (key) armAutoLock()
}

/**
 * Encrypting or decrypting a multi-gigabyte file takes far longer than a tick, and
 * the idle timer does not know that. Locking mid-decrypt was the worst kind of
 * bug: the sweep ran first, then the decryption finished and wrote a *plaintext*
 * copy into the temp directory of a vault that now claimed to be locked. So a
 * transfer in flight holds the lock off, and the timer is re-armed when it ends.
 */
async function whileWorking(fn) {
  busy += 1
  if (lockTimer) {
    clearTimeout(lockTimer)
    lockTimer = null
  }
  try {
    return await fn()
  } finally {
    busy = Math.max(0, busy - 1)
    if (!busy) armAutoLock()
  }
}

function clearTemps() {
  for (const file of openedTemps) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* the player may still hold it; the directory sweep below catches it */
    }
  }
  openedTemps = new Set()
  try {
    fs.rmSync(tempRoot(), { recursive: true, force: true })
  } catch {
    /* fine */
  }
}

function lock({ reason = 'user' } = {}) {
  if (lockTimer) {
    clearTimeout(lockTimer)
    lockTimer = null
  }
  if (key) {
    // Overwrite before dropping the reference: a freed buffer keeps its bytes.
    key.fill(0)
    key = null
  }
  entries = []
  // Decrypted posters are still pictures of what is inside; they go with the key.
  thumbCache = new Map()
  clearTemps()
  if (reason !== 'quit' && onLockedListener) onLockedListener(reason)
  return true
}

function isUnlocked() {
  return !!key
}

function exists() {
  return !!readMeta()
}

function status() {
  return {
    exists: exists(),
    unlocked: isUnlocked(),
    count: isUnlocked() ? entries.length : null,
    autoLockMinutes: Math.round(autoLockMs / 60000),
    // Safe to show and worth showing: knowing where the vault lives is how you
    // back it up. What is there is ciphertext under random names.
    dir: root(),
  }
}

function configure({ autoLockMinutes } = {}) {
  const minutes = Number(autoLockMinutes)
  if (Number.isFinite(minutes) && minutes >= 0) {
    autoLockMs = Math.min(minutes, 720) * 60 * 1000
    if (key) armAutoLock()
  }
}

function onLocked(fn) {
  onLockedListener = fn
}

/* -------------------------------------------------------------------------- */
/* public                                                                      */
/* -------------------------------------------------------------------------- */

async function create(passphrase) {
  if (exists()) throw new Error('Kasa zaten kurulmuş.')
  const pass = String(passphrase || '')
  if (pass.length < MIN_PASSPHRASE) {
    throw new Error(`Şifre en az ${MIN_PASSPHRASE} karakter olmalı.`)
  }
  await fsp.mkdir(blobDir(), { recursive: true })
  const salt = crypto.randomBytes(16)
  key = await deriveKey(pass, salt)
  entries = []
  await fsp.writeFile(
    metaFile(),
    JSON.stringify({ version: 1, salt: salt.toString('base64'), kdf: { N: KDF.N, r: KDF.r, p: KDF.p }, createdAt: Date.now() }, null, 2),
    { mode: 0o600 }
  )
  await saveIndex()
  armAutoLock()
  return status()
}

async function unlock(passphrase) {
  const meta = readMeta()
  if (!meta) throw new Error('Henüz bir kasa kurulmamış.')
  if (key) return status()

  const salt = Buffer.from(meta.salt, 'base64')
  const kdf = meta.kdf || {}
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(String(passphrase || ''), 'utf8'),
      salt,
      KDF.keyLen,
      {
        N: Number(kdf.N) || KDF.N,
        r: Number(kdf.r) || KDF.r,
        p: Number(kdf.p) || KDF.p,
        maxmem: KDF.maxmem,
      },
      (err, out) => (err ? reject(err) : resolve(out))
    )
  })

  key = derived
  try {
    entries = await loadIndex()
  } catch (err) {
    // A GCM tag mismatch is what a wrong passphrase looks like — there is no
    // stored hash to compare against, which is deliberate.
    key.fill(0)
    key = null
    entries = []
    const wrong = new Error('Şifre yanlış.')
    wrong.code = 'BAD_PASSPHRASE'
    wrong.cause = err
    throw wrong
  }
  armAutoLock()
  return status()
}

function list() {
  requireUnlocked()
  touch()
  return entries.map((e) => ({ ...e, thumb: thumbFor(e.id) }))
}

/**
 * Encrypt `srcPath` into the vault. The plaintext original is removed only after
 * the encrypted copy is written and verified, so a failure halfway can never lose
 * the file.
 */
function addFile(srcPath, meta = {}) {
  requireUnlocked()
  return whileWorking(async () => {
    const stat = await fsp.stat(srcPath)
    if (!stat.isFile()) throw new Error('Yalnızca dosya eklenebilir.')

    await fsp.mkdir(blobDir(), { recursive: true })
    const id = crypto.randomBytes(16).toString('hex')
    const dest = blobFile(id)

    try {
      await sealFile(srcPath, dest)
      const sealed = await fsp.stat(dest)
      if (sealed.size !== stat.size + HEADER_LEN + TAG_LEN) {
        throw new Error('Şifrelenen dosyanın boyutu beklenenle uyuşmadı.')
      }
    } catch (err) {
      await fsp.rm(dest, { force: true }).catch(() => {})
      throw err
    }

    // Taken before the plaintext goes, and stored encrypted like everything else.
    const poster = await makeThumb(srcPath).catch(() => null)
    if (poster) {
      try {
        await fsp.writeFile(thumbFile(id), sealBuffer(poster), { mode: 0o600 })
      } catch {
        /* a missing poster is cosmetic; the entry is not */
      }
    }

    const entry = {
      id,
      name: path.basename(srcPath),
      title: meta.title || path.basename(srcPath),
      site: meta.site || '',
      duration: Number.isFinite(meta.duration) ? meta.duration : null,
      sourceUrl: meta.sourceUrl || '',
      size: stat.size,
      addedAt: Date.now(),
    }
    entries.unshift(entry)
    await saveIndex()

    // Only now is the plaintext expendable.
    await fsp.rm(srcPath, { force: true })
    return { ...entry }
  })
}

function entryOf(id) {
  const entry = entries.find((e) => e.id === id)
  if (!entry) throw new Error('Kasa kaydı bulunamadı.')
  return entry
}

/** Decrypt into a private temp directory and hand the file to the OS player. */
function openEntry(id) {
  requireUnlocked()
  const entry = entryOf(id)
  return whileWorking(async () => {
    const dir = path.join(tempRoot(), crypto.randomBytes(6).toString('hex'))
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    // Deliberately not the real name. Handing a file to the OS player puts it in
    // that player's recent-documents list, and on macOS that list survives the
    // file — so a vaulted title would sit in QuickTime's right-click menu long
    // after the decrypted copy was deleted. An opaque name keeps the extension
    // (players need it) and says nothing else.
    const target = path.join(dir, `${crypto.randomBytes(8).toString('hex')}${path.extname(entry.name)}`)
    // Registered before the write, so a lock racing the decrypt still knows what
    // to delete.
    openedTemps.add(target)
    await openFileTo(blobFile(id), target)
    const err = await shell.openPath(target)
    if (err) throw new Error(err)
    return { path: target }
  })
}

/** Write a plaintext copy back out, leaving the vault copy in place. */
function exportEntry(id, destDir) {
  requireUnlocked()
  const entry = entryOf(id)
  return whileWorking(async () => {
    await fsp.mkdir(destDir, { recursive: true })

    let target = path.join(destDir, entry.name)
    const ext = path.extname(entry.name)
    const base = path.basename(entry.name, ext)
    let n = 2
    while (fs.existsSync(target)) target = path.join(destDir, `${base} (${n++})${ext}`)

    await openFileTo(blobFile(id), target)
    return { path: target }
  })
}

async function removeEntry(id) {
  requireUnlocked()
  const entry = entries.find((e) => e.id === id)
  if (!entry) return false
  // Unlinking is enough: what is left on the disk is ciphertext, which is the
  // whole point of encrypting at rest.
  await fsp.rm(blobFile(id), { force: true })
  await fsp.rm(thumbFile(id), { force: true })
  thumbCache.delete(id)
  entries = entries.filter((e) => e.id !== id)
  await saveIndex()
  touch()
  return true
}

/**
 * Blobs with no index entry, and entries with no blob. Neither should happen;
 * both are recoverable, and silence about them would be worse.
 */
async function audit() {
  requireUnlocked()
  let files = []
  try {
    files = await fsp.readdir(blobDir())
  } catch {
    /* no blobs yet */
  }
  const known = new Set(entries.map((e) => e.id))
  // Poster frames live beside their blob as <id>.t; they belong to a known entry,
  // not to nobody.
  const orphanBlobs = files.filter((f) => !known.has(f.replace(/\.t$/, '')))
  const missingBlobs = entries.filter((e) => !files.includes(e.id)).map((e) => e.name)
  return { orphanBlobs: orphanBlobs.length, missingBlobs }
}

module.exports = {
  status,
  create,
  unlock,
  lock,
  list,
  addFile,
  openEntry,
  exportEntry,
  removeEntry,
  audit,
  configure,
  onLocked,
  isUnlocked,
  touch,
  MIN_PASSPHRASE,
}
