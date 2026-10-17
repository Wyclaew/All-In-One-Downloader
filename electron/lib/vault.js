'use strict'

// The vault: a folder inside the app where a file's contents *and its name* are
// encrypted, so nothing on disk says what is in there — and where nothing is ever
// decrypted to disk just to be watched.
//
// Layout under userData/vault (0700):
//   meta.json    KDF parameters, salt, and the master key wrapped under the
//                passphrase. Public by design: none of it helps without the
//                passphrase.
//   index2.bin   the encrypted catalogue — names, titles, sizes, dates.
//   blobs/<id>   one encrypted file per entry, named after a random id.
//   blobs/<id>.t its poster frame, encrypted the same way.
//
// Keys. A random 256-bit master key encrypts everything. It is stored only
// wrapped (AES-256-GCM) under a key-encryption key derived from the passphrase
// with scrypt at N=2^17, r=8 — about 128 MB of memory and half a second per
// guess, paid once on unlock and once per guess by anyone trying passphrases.
// Changing the passphrase rewraps the master key; nothing else moves. Wrong
// passphrases are told apart by the wrap failing to authenticate: no hash of the
// passphrase is stored anywhere.
//
// Blobs ("AIO2"). A file is sealed in 1 MiB chunks, each its own AES-256-GCM
// message with a nonce built from a per-file random prefix and the chunk's
// index, and the file header — which records the chunk size and the plaintext
// length — bound into every chunk as associated data, along with a flag on the
// last one. So a chunk cannot be altered, moved, repeated, dropped or have the
// file cut short without a tag failing. And because each chunk stands alone, the
// player can be served any byte range by decrypting only the chunks it covers,
// in memory: watching a vaulted film writes no plaintext anywhere.
//
// Vaults made by earlier versions ("AIO1" blobs under a key scrypt'ed directly
// from the passphrase at N=2^15) are upgraded in place the first time they are
// unlocked: a fresh master key, the stronger KDF, and every blob re-encrypted in
// the background straight from the old ciphertext to the new — never through a
// plaintext file. Until a blob has been converted it is still readable with the
// old key, which is held wrapped beside the master key and destroyed once the
// last blob is done.
//
// What this protects against: someone who has the disk, a backup, or the folder,
// or who finds the machine with the vault locked. It locks itself after idle
// time, on sleep and when the screen locks. What it cannot protect against is
// someone at the keyboard while it is unlocked, or "open in the system player"
// and "export", which write plaintext because the user asked for exactly that.

const crypto = require('crypto')
const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const { Readable } = require('stream')
const { execFile } = require('child_process')
const { app, shell } = require('electron')
const { ffmpegPath, toolEnv } = require('./binaries')

/* ---- formats ---- */

const MAGIC1 = Buffer.from('AIO1')
const MAGIC2 = Buffer.from('AIO2')
const NONCE_LEN = 12
const TAG_LEN = 16
const HEADER1_LEN = MAGIC1.length + NONCE_LEN
const HEADER2_LEN = 32
const CHUNK = 1024 * 1024

// The legacy parameters, kept only to open vaults made by earlier versions.
const KDF_V1 = { N: 32768, r: 8, p: 1 }
// 128 * N * r bytes of memory per evaluation: 128 MiB here.
const KDF_V2 = { N: 131072, r: 8, p: 1 }
const KDF_MAXMEM = 320 * 1024 * 1024
const KEY_LEN = 32

const MIN_PASSPHRASE = 8
const DEFAULT_AUTOLOCK_MS = 15 * 60 * 1000

/* ---- state, all of it gone on lock ---- */

let master = null
let legacy = null
let entries = []
let openedTemps = new Set()
let lockTimer = null
let autoLockMs = DEFAULT_AUTOLOCK_MS
let onLockedListener = null
let onChangedListener = null
let busy = 0
let migrating = null
let thumbCache = new Map()

/* ---- unlock throttling ---- */

let failures = 0
let blockedUntil = 0

/* -------------------------------------------------------------------------- */
/* paths                                                                       */
/* -------------------------------------------------------------------------- */

const root = () => path.join(app.getPath('userData'), 'vault')
const metaFile = () => path.join(root(), 'meta.json')
const indexFile = () => path.join(root(), 'index2.bin')
const legacyIndexFile = () => path.join(root(), 'index.bin')
const blobDir = () => path.join(root(), 'blobs')
const blobFile = (id) => path.join(blobDir(), id)
const thumbFile = (id) => path.join(blobDir(), `${id}.t`)

const TEMP_PREFIX = 'aio-vault-'
const tempRoot = () => path.join(os.tmpdir(), `${TEMP_PREFIX}${process.pid}`)

/** Ids are ours and hex; anything else must never reach a path join. */
function checkId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) throw new Error('Geçersiz kasa kaydı.')
  return id
}

/* -------------------------------------------------------------------------- */
/* small sealed buffers: the index, posters and wrapped keys                   */
/* -------------------------------------------------------------------------- */

function sealWith(key, plain) {
  const nonce = crypto.randomBytes(NONCE_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([MAGIC1, nonce, body, cipher.getAuthTag()])
}

function openWith(key, blob) {
  if (blob.length < HEADER1_LEN + TAG_LEN || !blob.subarray(0, 4).equals(MAGIC1)) {
    throw new Error('Kasa dosyası tanınmıyor.')
  }
  const nonce = blob.subarray(4, HEADER1_LEN)
  const tag = blob.subarray(blob.length - TAG_LEN)
  const body = blob.subarray(HEADER1_LEN, blob.length - TAG_LEN)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

/** A small sealed buffer under whichever key it was made with. */
function openAny(blob) {
  try {
    return openWith(master, blob)
  } catch (err) {
    if (!legacy) throw err
    return openWith(legacy, blob)
  }
}

/* -------------------------------------------------------------------------- */
/* key derivation                                                              */
/* -------------------------------------------------------------------------- */

function scrypt(passphrase, salt, { N, r, p }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(String(passphrase), 'utf8'),
      salt,
      KEY_LEN,
      { N, r, p, maxmem: KDF_MAXMEM },
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

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  await fsp.rename(tmp, file)
}

/** Wrap the master key (and the legacy key, while one exists) under a passphrase. */
async function writeKeys(passphrase, { createdAt } = {}) {
  const salt = crypto.randomBytes(16)
  const kek = await scrypt(passphrase, salt, KDF_V2)
  try {
    const meta = {
      version: 2,
      kdf: { alg: 'scrypt', ...KDF_V2 },
      salt: salt.toString('base64'),
      wrapped: sealWith(kek, master).toString('base64'),
      createdAt: createdAt || Date.now(),
    }
    if (legacy) meta.legacy = sealWith(kek, legacy).toString('base64')
    await writeJsonAtomic(metaFile(), meta)
  } finally {
    kek.fill(0)
  }
}

/* -------------------------------------------------------------------------- */
/* chunked blobs                                                               */
/* -------------------------------------------------------------------------- */

function header2(plainSize, prefix) {
  const h = Buffer.alloc(HEADER2_LEN)
  MAGIC2.copy(h, 0)
  h.writeUInt8(1, 4)
  h.writeUInt32BE(CHUNK, 8)
  h.writeBigUInt64BE(BigInt(plainSize), 12)
  prefix.copy(h, 20)
  return h
}

function parseHeader2(h) {
  if (h.length < HEADER2_LEN || !h.subarray(0, 4).equals(MAGIC2) || h.readUInt8(4) !== 1) {
    throw new Error('Kasa dosyası tanınmıyor.')
  }
  const chunkSize = h.readUInt32BE(8)
  if (chunkSize < 4096 || chunkSize > 64 * 1024 * 1024) throw new Error('Kasa dosyası bozuk.')
  const plainSize = Number(h.readBigUInt64BE(12))
  return { chunkSize, plainSize, prefix: h.subarray(20, 28), header: h.subarray(0, HEADER2_LEN) }
}

const chunkCount = (plainSize, chunkSize) => Math.max(1, Math.ceil(plainSize / chunkSize))

function chunkNonce(prefix, index) {
  const n = Buffer.alloc(NONCE_LEN)
  prefix.copy(n, 0)
  n.writeUInt32BE(index, 8)
  return n
}

function chunkAad(header, last) {
  return Buffer.concat([header, Buffer.from([last ? 1 : 0])])
}

function sealChunk(key, info, index, plain) {
  const last = index === chunkCount(info.plainSize, info.chunkSize) - 1
  const cipher = crypto.createCipheriv('aes-256-gcm', key, chunkNonce(info.prefix, index))
  cipher.setAAD(chunkAad(info.header, last))
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
}

function openChunk(key, info, index, sealed) {
  const last = index === chunkCount(info.plainSize, info.chunkSize) - 1
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, chunkNonce(info.prefix, index))
  decipher.setAAD(chunkAad(info.header, last))
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_LEN))
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_LEN)), decipher.final()])
}

const sealedSize = (plainSize) => HEADER2_LEN + plainSize + chunkCount(plainSize, CHUNK) * TAG_LEN

/**
 * Seal whatever `source` yields (a file's bytes, or an old blob as it decrypts)
 * into a chunked blob at `dest`. `plainSize` must be known up front: it is bound
 * into every chunk.
 */
async function sealStreamTo(source, plainSize, dest) {
  const prefix = crypto.randomBytes(8)
  const head = header2(plainSize, prefix)
  const info = parseHeader2(head)
  const out = await fsp.open(dest, 'w', 0o600)
  try {
    await out.write(head, 0, head.length, 0)
    let position = HEADER2_LEN
    let index = 0
    let pending = []
    let pendingLen = 0
    let seen = 0

    const flush = async (buf) => {
      const sealed = sealChunk(master, info, index, buf)
      await out.write(sealed, 0, sealed.length, position)
      position += sealed.length
      index += 1
    }

    for await (const piece of source) {
      seen += piece.length
      if (seen > plainSize) throw new Error('Şifrelenen dosyanın boyutu değişti.')
      pending.push(piece)
      pendingLen += piece.length
      // A full chunk is only "not the last" if more bytes follow it; the final
      // chunk waits for the end of the source so it is sealed with that flag set.
      while (pendingLen > CHUNK || (pendingLen === CHUNK && seen < plainSize)) {
        const all = pending.length === 1 ? pending[0] : Buffer.concat(pending)
        await flush(all.subarray(0, CHUNK))
        pending = [all.subarray(CHUNK)]
        pendingLen -= CHUNK
      }
    }
    if (seen !== plainSize) throw new Error('Şifrelenen dosyanın boyutu değişti.')
    const rest = Buffer.concat(pending)
    if (rest.length || index === 0) await flush(rest)
    if (index !== chunkCount(plainSize, CHUNK)) throw new Error('Şifreleme yarıda kaldı.')
    await out.sync()
  } finally {
    await out.close()
  }
}

/** Read and authenticate the header of a chunked blob. */
async function blobInfo(file) {
  const handle = await fsp.open(file, 'r')
  try {
    const head = Buffer.alloc(HEADER2_LEN)
    const { bytesRead } = await handle.read(head, 0, HEADER2_LEN, 0)
    if (bytesRead < 4) throw new Error('Kasa dosyası bozuk.')
    if (head.subarray(0, 4).equals(MAGIC1)) return { format: 1 }
    const info = parseHeader2(head)
    const stat = await handle.stat()
    if (stat.size !== HEADER2_LEN + info.plainSize + chunkCount(info.plainSize, info.chunkSize) * TAG_LEN) {
      throw new Error('Kasa dosyası eksik ya da bozuk.')
    }
    return { format: 2, ...info }
  } finally {
    await handle.close()
  }
}

/**
 * Plaintext bytes [start, end] of a chunked blob, decrypted chunk by chunk as the
 * consumer reads. Nothing is written anywhere; at most one chunk is in memory.
 */
function rangeStream(file, info, start, end) {
  const { chunkSize, plainSize } = info
  const stride = chunkSize + TAG_LEN
  let index = Math.floor(start / chunkSize)
  const lastIndex = Math.floor(end / chunkSize)
  let handle = null

  return new Readable({
    async read() {
      try {
        if (!master) throw new Error('Kasa kilitli.')
        if (!handle) handle = await fsp.open(file, 'r')
        if (index > lastIndex) {
          await handle.close()
          handle = null
          this.push(null)
          return
        }
        const plainLen = Math.min(chunkSize, plainSize - index * chunkSize)
        const sealed = Buffer.alloc(plainLen + TAG_LEN)
        await handle.read(sealed, 0, sealed.length, HEADER2_LEN + index * stride)
        const plain = openChunk(master, info, index, sealed)
        const from = index === Math.floor(start / chunkSize) ? start - index * chunkSize : 0
        const to = index === lastIndex ? end - index * chunkSize + 1 : plain.length
        index += 1
        this.push(plain.subarray(from, to))
      } catch (err) {
        if (handle) handle.close().catch(() => {})
        handle = null
        this.destroy(err)
      }
    },
    destroy(err, cb) {
      if (handle) handle.close().catch(() => {})
      handle = null
      cb(err)
    },
  })
}

/** An old single-message blob, decrypted as a stream. The tag is checked at the end. */
async function legacyStream(file) {
  if (!legacy) throw new Error('Bu dosyanın eski anahtarı yok.')
  const stat = await fsp.stat(file)
  if (stat.size < HEADER1_LEN + TAG_LEN) throw new Error('Kasa dosyası bozuk.')
  const handle = await fsp.open(file, 'r')
  const head = Buffer.alloc(HEADER1_LEN)
  const tag = Buffer.alloc(TAG_LEN)
  try {
    await handle.read(head, 0, HEADER1_LEN, 0)
    await handle.read(tag, 0, TAG_LEN, stat.size - TAG_LEN)
  } finally {
    await handle.close()
  }
  if (!head.subarray(0, 4).equals(MAGIC1)) throw new Error('Kasa dosyası tanınmıyor.')
  const decipher = crypto.createDecipheriv('aes-256-gcm', legacy, head.subarray(4))
  decipher.setAuthTag(tag)
  const plainSize = stat.size - HEADER1_LEN - TAG_LEN
  if (!plainSize) {
    decipher.final()
    return { plainSize, stream: Readable.from([]) }
  }
  const body = fs.createReadStream(file, { start: HEADER1_LEN, end: stat.size - TAG_LEN - 1 })
  return { plainSize, stream: body.pipe(decipher) }
}

/** Write a blob's plaintext to `dest` — only ever for an explicit export or external open. */
async function decryptTo(id, dest) {
  const file = blobFile(id)
  const info = await blobInfo(file)
  let stream
  if (info.format === 1) stream = (await legacyStream(file)).stream
  else stream = info.plainSize ? rangeStream(file, info, 0, info.plainSize - 1) : Readable.from([])
  const out = fs.createWriteStream(dest, { mode: 0o600 })
  await require('stream/promises').pipeline(stream, out)
}

/* -------------------------------------------------------------------------- */
/* poster frames                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A frame from the video itself, made while the plaintext is still on disk.
 *
 * Keeping the site's thumbnail URL instead would have had the vault phone the
 * source site every time you looked at the list. One frame, extracted locally and
 * encrypted with everything else, keeps the vault self-contained and offline.
 */
function makeThumb(srcPath) {
  const grab = (args) =>
    new Promise((resolve) => {
      const bin = ffmpegPath()
      if (!bin) return resolve(null)
      execFile(
        bin,
        ['-hide_banner', '-loglevel', 'error', ...args, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', '-f', 'mjpeg', 'pipe:1'],
        { env: toolEnv(), timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' },
        (err, out) => resolve(!err && out && out.length > 1024 ? out : null)
      )
    })
  return grab(['-ss', '5', '-i', srcPath]).then((jpeg) => jpeg || grab(['-i', srcPath]))
}

function thumbFor(id) {
  if (thumbCache.has(id)) return thumbCache.get(id)
  let url = null
  try {
    const jpeg = openAny(fs.readFileSync(thumbFile(id)))
    url = `data:image/jpeg;base64,${jpeg.toString('base64')}`
  } catch {
    url = null
  }
  thumbCache.set(id, url)
  return url
}

/* -------------------------------------------------------------------------- */
/* index                                                                       */
/* -------------------------------------------------------------------------- */

async function saveIndex() {
  requireUnlocked()
  const blob = sealWith(master, Buffer.from(JSON.stringify({ entries }), 'utf8'))
  const tmp = `${indexFile()}.${process.pid}.tmp`
  await fsp.writeFile(tmp, blob, { mode: 0o600 })
  await fsp.rename(tmp, indexFile())
}

async function loadIndexWith(key, file) {
  let blob
  try {
    blob = await fsp.readFile(file)
  } catch {
    return []
  }
  const parsed = JSON.parse(openWith(key, blob).toString('utf8'))
  return Array.isArray(parsed.entries) ? parsed.entries : []
}

/* -------------------------------------------------------------------------- */
/* lock state                                                                  */
/* -------------------------------------------------------------------------- */

function requireUnlocked() {
  if (!master) {
    const err = new Error('Kasa kilitli.')
    err.code = 'LOCKED'
    throw err
  }
}

function armAutoLock() {
  if (lockTimer) clearTimeout(lockTimer)
  lockTimer = null
  if (!master || !autoLockMs || busy) return
  lockTimer = setTimeout(() => lock({ reason: 'timeout' }), autoLockMs)
  if (lockTimer.unref) lockTimer.unref()
}

/** Any vault action — including a player reading a chunk — counts as activity. */
function touch() {
  if (master && !busy) armAutoLock()
}

/**
 * A long encrypt or decrypt holds the idle lock off and re-arms it when done.
 * Locking mid-operation once let a decryption finish into a vault that claimed to
 * be locked; nothing may start or finish across a lock.
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
      /* the directory sweep below catches it */
    }
  }
  openedTemps = new Set()
  try {
    fs.rmSync(tempRoot(), { recursive: true, force: true })
  } catch {
    /* fine */
  }
}

/**
 * Plaintext left by a run that crashed or was killed before it could lock.
 *
 * The temp folder is per process, so a later run never looked at an earlier one's
 * — and a copy opened in an external player stayed there indefinitely. Every
 * vault temp folder that does not belong to this process goes on startup.
 */
function sweepStaleTemps() {
  let names = []
  try {
    names = fs.readdirSync(os.tmpdir())
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX) || name === `${TEMP_PREFIX}${process.pid}`) continue
    try {
      fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true })
      removed += 1
    } catch {
      /* someone else's, or already gone */
    }
  }
  return removed
}

function lock({ reason = 'user' } = {}) {
  if (lockTimer) {
    clearTimeout(lockTimer)
    lockTimer = null
  }
  // Overwrite before dropping the reference: a freed buffer keeps its bytes.
  if (master) master.fill(0)
  if (legacy) legacy.fill(0)
  master = null
  legacy = null
  entries = []
  thumbCache = new Map()
  clearTemps()
  if (reason !== 'quit' && onLockedListener) onLockedListener(reason)
  return true
}

const isUnlocked = () => !!master
const exists = () => !!readMeta()

function status() {
  const meta = readMeta()
  return {
    exists: !!meta,
    unlocked: isUnlocked(),
    count: isUnlocked() ? entries.length : null,
    autoLockMinutes: Math.round(autoLockMs / 60000),
    dir: root(),
    // Shown so an upgrade in progress is not mistaken for a hang.
    upgrading: isUnlocked() ? entries.filter((e) => e.k !== 2).length : 0,
    retryAfter: Math.max(0, Math.ceil((blockedUntil - Date.now()) / 1000)),
    strong: !!(meta && meta.version === 2),
  }
}

function configure({ autoLockMinutes } = {}) {
  const minutes = Number(autoLockMinutes)
  if (Number.isFinite(minutes) && minutes >= 0) {
    autoLockMs = Math.min(minutes, 720) * 60 * 1000
    if (master) armAutoLock()
  }
}

function onLocked(fn) {
  onLockedListener = fn
}

function onChanged(fn) {
  onChangedListener = fn
}

/* -------------------------------------------------------------------------- */
/* creating and unlocking                                                      */
/* -------------------------------------------------------------------------- */

function checkStrength(pass) {
  if (pass.length < MIN_PASSPHRASE) throw new Error(`Şifre en az ${MIN_PASSPHRASE} karakter olmalı.`)
  // A long run of one character, or a famous password, is short in every way
  // that matters to someone guessing.
  if (/^(.)\1+$/.test(pass) || /^(12345678|123456789|password|şifre|sifre|qwerty)/i.test(pass)) {
    throw new Error('Bu şifre tahmin edilmesi çok kolay; daha uzun ve karışık bir şey seç.')
  }
}

async function ensureDirs() {
  await fsp.mkdir(blobDir(), { recursive: true, mode: 0o700 })
  for (const dir of [root(), blobDir()]) {
    try {
      await fsp.chmod(dir, 0o700)
    } catch {
      /* Windows has no mode bits */
    }
  }
}

async function create(passphrase) {
  if (exists()) throw new Error('Kasa zaten kurulmuş.')
  const pass = String(passphrase || '')
  checkStrength(pass)
  await ensureDirs()
  master = crypto.randomBytes(KEY_LEN)
  legacy = null
  entries = []
  await saveIndex()
  await writeKeys(pass)
  armAutoLock()
  return status()
}

function throttle() {
  const wait = blockedUntil - Date.now()
  if (wait > 0) {
    const err = new Error(`Çok fazla yanlış deneme. ${Math.ceil(wait / 1000)} saniye sonra tekrar dene.`)
    err.code = 'THROTTLED'
    throw err
  }
}

function wrongPassphrase(cause) {
  failures += 1
  // Free for the first three slips; then 5 s, 10 s, 20 s … up to five minutes.
  if (failures >= 3) blockedUntil = Date.now() + Math.min(300000, 5000 * 2 ** (failures - 3))
  const err = new Error('Şifre yanlış.')
  err.code = 'BAD_PASSPHRASE'
  err.cause = cause
  return err
}

/**
 * Open a vault made before key wrapping: derive the old key, prove it against the
 * old index, then move to a random master key and the stronger KDF. The old key
 * survives only wrapped, until the last old blob has been converted.
 */
async function upgradeFromV1(pass, meta) {
  const salt = Buffer.from(meta.salt, 'base64')
  const kdf = meta.kdf || {}
  const old = await scrypt(pass, salt, {
    N: Number(kdf.N) || KDF_V1.N,
    r: Number(kdf.r) || KDF_V1.r,
    p: Number(kdf.p) || KDF_V1.p,
  })
  let list
  try {
    list = await loadIndexWith(old, legacyIndexFile())
  } catch (err) {
    old.fill(0)
    throw wrongPassphrase(err)
  }
  master = crypto.randomBytes(KEY_LEN)
  legacy = old
  entries = list.map((e) => ({ ...e, k: 1 }))
  // The new index is written before the new meta, and the old index is removed
  // only after both: a crash at any point leaves one complete, openable vault.
  await saveIndex()
  await writeKeys(pass, { createdAt: meta.createdAt })
  await fsp.rm(legacyIndexFile(), { force: true })
}

async function unlock(passphrase) {
  const meta = readMeta()
  if (!meta) throw new Error('Henüz bir kasa kurulmamış.')
  if (master) return status()
  throttle()
  const pass = String(passphrase || '')

  if (meta.version !== 2) {
    await upgradeFromV1(pass, meta)
  } else {
    const kek = await scrypt(pass, Buffer.from(meta.salt, 'base64'), {
      N: Number(meta.kdf && meta.kdf.N) || KDF_V2.N,
      r: Number(meta.kdf && meta.kdf.r) || KDF_V2.r,
      p: Number(meta.kdf && meta.kdf.p) || KDF_V2.p,
    })
    try {
      master = openWith(kek, Buffer.from(meta.wrapped, 'base64'))
      legacy = meta.legacy ? openWith(kek, Buffer.from(meta.legacy, 'base64')) : null
    } catch (err) {
      master = null
      legacy = null
      throw wrongPassphrase(err)
    } finally {
      kek.fill(0)
    }
    try {
      entries = await loadIndexWith(master, indexFile())
    } catch (err) {
      lock({ reason: 'quit' })
      throw new Error(`Kasa dizini açılamadı: ${err.message}`)
    }
  }

  failures = 0
  blockedUntil = 0
  await ensureDirs()
  armAutoLock()
  migrateInBackground(pass)
  return status()
}

/** Rewrap the master key under a new passphrase. The files themselves do not move. */
async function changePassphrase(current, next) {
  requireUnlocked()
  throttle()
  const meta = readMeta()
  const kek = await scrypt(String(current || ''), Buffer.from(meta.salt, 'base64'), {
    N: Number(meta.kdf && meta.kdf.N) || KDF_V2.N,
    r: Number(meta.kdf && meta.kdf.r) || KDF_V2.r,
    p: Number(meta.kdf && meta.kdf.p) || KDF_V2.p,
  })
  try {
    const check = openWith(kek, Buffer.from(meta.wrapped, 'base64'))
    const same = crypto.timingSafeEqual(check, master)
    check.fill(0)
    if (!same) throw new Error('mismatch')
  } catch (err) {
    throw wrongPassphrase(err)
  } finally {
    kek.fill(0)
  }
  const pass = String(next || '')
  checkStrength(pass)
  await writeKeys(pass, { createdAt: meta.createdAt })
  touch()
  return status()
}

/* -------------------------------------------------------------------------- */
/* upgrading old blobs                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Convert every old blob, one at a time, straight from old ciphertext to new.
 *
 * The new blob is written beside the old one and renamed over it only once it is
 * complete and the old one's tag has verified; the index is saved after each, so
 * an interrupted upgrade simply carries on next unlock. When none are left, the
 * wrapped legacy key is dropped from meta.json for good.
 */
function migrateInBackground(pass) {
  if (migrating || !legacy) return
  migrating = whileWorking(async () => {
    for (const entry of entries) {
      if (!master) return
      if (entry.k === 2) continue
      const file = blobFile(entry.id)
      try {
        const info = await blobInfo(file)
        if (info.format === 1) {
          const { plainSize, stream } = await legacyStream(file)
          const tmp = `${file}.v2tmp`
          try {
            await sealStreamTo(stream, plainSize, tmp)
          } catch (err) {
            await fsp.rm(tmp, { force: true })
            throw err
          }
          await fsp.rename(tmp, file)
        }
        try {
          const poster = openAny(await fsp.readFile(thumbFile(entry.id)))
          await fsp.writeFile(`${thumbFile(entry.id)}.tmp`, sealWith(master, poster), { mode: 0o600 })
          await fsp.rename(`${thumbFile(entry.id)}.tmp`, thumbFile(entry.id))
        } catch {
          /* no poster, or it was already new */
        }
        entry.k = 2
        await saveIndex()
      } catch (err) {
        console.error('[vault] upgrade', entry.id, err.message)
      }
    }
    if (master && entries.every((e) => e.k === 2)) {
      legacy.fill(0)
      legacy = null
      await writeKeys(pass, { createdAt: (readMeta() || {}).createdAt })
    }
  })
    .catch((err) => console.error('[vault] upgrade', err))
    .finally(() => {
      migrating = null
      if (onChangedListener && master) onChangedListener()
    })
}

/* -------------------------------------------------------------------------- */
/* entries                                                                     */
/* -------------------------------------------------------------------------- */

function list() {
  requireUnlocked()
  touch()
  return entries.map(({ k, ...e }) => ({ ...e, thumb: thumbFor(e.id) }))
}

function entryOf(id) {
  checkId(id)
  const entry = entries.find((e) => e.id === id)
  if (!entry) throw new Error('Kasa kaydı bulunamadı.')
  return entry
}

/**
 * Encrypt `srcPath` into the vault. The plaintext original is removed only after
 * the encrypted copy is complete and its first and last chunks decrypt, so a
 * failure part way can never lose the file.
 */
function addFile(srcPath, meta = {}) {
  requireUnlocked()
  return whileWorking(async () => {
    const stat = await fsp.stat(srcPath)
    if (!stat.isFile()) throw new Error('Yalnızca dosya eklenebilir.')
    await ensureDirs()
    const id = crypto.randomBytes(16).toString('hex')
    const dest = blobFile(id)

    try {
      await sealStreamTo(fs.createReadStream(srcPath, { highWaterMark: CHUNK }), stat.size, dest)
      const sealed = await fsp.stat(dest)
      if (sealed.size !== sealedSize(stat.size)) throw new Error('Şifrelenen dosyanın boyutu beklenenle uyuşmadı.')
      const info = await blobInfo(dest)
      if (stat.size) {
        await new Promise((resolve, reject) => {
          const probe = rangeStream(dest, info, 0, Math.min(stat.size, CHUNK) - 1)
          probe.on('data', () => {})
          probe.on('end', resolve)
          probe.on('error', reject)
        })
        await new Promise((resolve, reject) => {
          const probe = rangeStream(dest, info, Math.max(0, stat.size - 16), stat.size - 1)
          probe.on('data', () => {})
          probe.on('end', resolve)
          probe.on('error', reject)
        })
      }
    } catch (err) {
      await fsp.rm(dest, { force: true }).catch(() => {})
      throw err
    }

    const poster = await makeThumb(srcPath).catch(() => null)
    if (poster) {
      try {
        await fsp.writeFile(thumbFile(id), sealWith(master, poster), { mode: 0o600 })
      } catch {
        /* a missing poster is cosmetic; the entry is not */
      }
    }

    const entry = {
      id,
      k: 2,
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
    const { k, ...shown } = entry
    return shown
  })
}

/**
 * What the player needs to stream an entry without a plaintext file: its size
 * and a function that yields any byte range, decrypted in memory. An entry still
 * waiting for its upgrade is converted first.
 */
async function streamSource(id) {
  requireUnlocked()
  const entry = entryOf(id)
  const file = blobFile(id)
  let info = await blobInfo(file)
  if (info.format === 1) {
    await whileWorking(async () => {
      const { plainSize, stream } = await legacyStream(file)
      const tmp = `${file}.v2tmp`
      try {
        await sealStreamTo(stream, plainSize, tmp)
      } catch (err) {
        await fsp.rm(tmp, { force: true })
        throw err
      }
      await fsp.rename(tmp, file)
      entry.k = 2
      await saveIndex()
    })
    info = await blobInfo(file)
  }
  touch()
  return {
    size: info.plainSize,
    name: entry.name,
    title: entry.title || entry.name,
    read(start, end) {
      touch()
      if (!info.plainSize) return Readable.from([])
      const s = Math.max(0, Math.min(start, info.plainSize - 1))
      const e = Math.max(s, Math.min(end, info.plainSize - 1))
      return rangeStream(file, info, s, e)
    },
  }
}

/** Decrypt into a private temp folder and hand the file to the OS player. */
function openEntry(id) {
  requireUnlocked()
  const entry = entryOf(id)
  return whileWorking(async () => {
    const dir = path.join(tempRoot(), crypto.randomBytes(6).toString('hex'))
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    // An opaque name: the OS player puts it in its recent-documents list, which
    // on macOS outlives the file.
    const target = path.join(dir, `${crypto.randomBytes(8).toString('hex')}${path.extname(entry.name)}`)
    openedTemps.add(target)
    await decryptTo(id, target)
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
    // The stored name came out of our own index, but it is still a name: strip
    // anything that could make the join leave the chosen folder.
    const safe = path.basename(String(entry.name || 'video')).replace(/[\\/]/g, '_') || 'video'
    const ext = path.extname(safe)
    const base = path.basename(safe, ext)
    let target = path.join(destDir, safe)
    let n = 2
    while (fs.existsSync(target)) target = path.join(destDir, `${base} (${n++})${ext}`)
    await decryptTo(id, target)
    return { path: target }
  })
}

async function removeEntry(id) {
  requireUnlocked()
  checkId(id)
  const entry = entries.find((e) => e.id === id)
  if (!entry) return false
  await fsp.rm(blobFile(id), { force: true })
  await fsp.rm(thumbFile(id), { force: true })
  thumbCache.delete(id)
  entries = entries.filter((e) => e.id !== id)
  await saveIndex()
  touch()
  return true
}

/** Blobs with no index entry, and entries with no blob. */
async function audit() {
  requireUnlocked()
  let files = []
  try {
    files = await fsp.readdir(blobDir())
  } catch {
    /* no blobs yet */
  }
  const known = new Set(entries.map((e) => e.id))
  const orphanBlobs = files.filter((f) => !known.has(f.replace(/\.(t|v2tmp)$/, '')))
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
  streamSource,
  openEntry,
  exportEntry,
  removeEntry,
  changePassphrase,
  sweepStaleTemps,
  audit,
  configure,
  onLocked,
  onChanged,
  isUnlocked,
  touch,
  MIN_PASSPHRASE,
  // for the tests
  _internals: { sealStreamTo, blobInfo, rangeStream, sealedSize, CHUNK },
}
