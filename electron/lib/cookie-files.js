'use strict'

// Cookie material stays in marker-owned private directories. Never infer
// ownership from an old filename, and never remove a file used by a source,
// cached export, resolver or transfer.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')

const MAGIC = 'AIO_COOKIE_JAR_V1'
const HEADER = '# Netscape HTTP Cookie File\n'
const MARKER = '.aio-cookie-owner.json'
const JAR_NAME = /^jar-[A-Za-z0-9_-]{6,64}$/
const TEMP_NAME = /^\.cookie-write-[a-f0-9]{16}\.tmp$/
const NOOP = () => {}

function createCookieFiles({ directory, now = Date.now, filesystem = fs,
  graceMs = 15 * 60 * 1000, maxEntries = 512 } = {}) {
  const io = filesystem
  const leases = new Map()
  let references = new Set()
  let closed = false
  const entryLimit = Math.max(1, Math.min(4096, Math.floor(Number(maxEntries) || 512)))
  const grace = Math.max(0, Number(graceMs) || 0)
  const root = () => path.resolve(typeof directory === 'function' ? directory() : directory ||
    path.join(os.tmpdir(), 'aio-cookie-jars-' + crypto.createHash('sha256').update(require('electron').app.getPath('userData')).digest('hex').slice(0, 24)))
  const ownsUid = (stat) => process.platform === 'win32' || typeof process.getuid !== 'function' || stat.uid === process.getuid()
  const privateMode = (stat, mask) => process.platform === 'win32' || (stat.mode & mask) === 0
  function safeRoot(create = false) {
    const base = root()
    if (!io.existsSync(base)) {
      if (!create) return null
      io.mkdirSync(base, { recursive: true, mode: 0o700 })
    }
    const stat = io.lstatSync(base)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !ownsUid(stat) || !privateMode(stat, 0o077)) throw new Error('Oturum dosyaları için özel ve güvenli bir klasör gerekli.')
    return base
  }
  function entries() {
    const base = safeRoot()
    if (!base) return []
    const result = []
    const dir = io.opendirSync(base)
    try {
      let entry
      while (result.length < entryLimit && (entry = dir.readSync())) result.push(entry.name)
    } finally { dir.closeSync() }
    return result
  }
  function record(file, { allowMissing = false } = {}) {
    try {
      if (typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file) !== 'cookies.txt') return null
      const base = safeRoot(), dir = path.dirname(path.resolve(file)), id = path.basename(dir)
      if (!base || path.dirname(dir) !== base || !JAR_NAME.test(id)) return null
      const dirStat = io.lstatSync(dir)
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || !ownsUid(dirStat) || !privateMode(dirStat, 0o077)) return null
      const markerFile = path.join(dir, MARKER), markerStat = io.lstatSync(markerFile)
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || !ownsUid(markerStat) || markerStat.size > 2048 || !privateMode(markerStat, 0o077)) return null
      const marker = JSON.parse(io.readFileSync(markerFile, 'utf8'))
      if (marker.magic !== MAGIC || marker.id !== id || !Number.isFinite(marker.createdAt) || marker.createdAt < 0 || !Number.isFinite(marker.lastUsed) || marker.lastUsed < marker.createdAt) return null
      let fileStat
      try { fileStat = io.lstatSync(file) } catch (error) { if (!allowMissing || error.code !== 'ENOENT') throw error }
      if (fileStat && (!fileStat.isFile() || fileStat.isSymbolicLink() || !ownsUid(fileStat) || !privateMode(fileStat, 0o077))) return null
      return { file: path.resolve(file), dir, marker, markerFile }
    } catch { return null }
  }
  function safeContents(dir) {
    try {
      const names = io.readdirSync(dir)
      if (names.length > 16) return false
      return names.every((name) => {
        if (name !== 'cookies.txt' && name !== MARKER && name !== 'empty.info.json' && !TEMP_NAME.test(name)) return false
        const stat = io.lstatSync(path.join(dir, name))
        return stat.isFile() && !stat.isSymbolicLink() && ownsUid(stat) && privateMode(stat, 0o077)
      })
    } catch { return false }
  }
  function remove(record) {
    if (!record || leases.has(record.file) || references.has(record.file) || !safeContents(record.dir)) return false
    // No recursive deletion: a symlink/foreign directory inserted after the
    // ownership check cannot make cleanup descend outside this jar directory.
    try {
      for (const name of io.readdirSync(record.dir)) {
        const stat = io.lstatSync(path.join(record.dir, name))
        if (!stat.isFile() || stat.isSymbolicLink()) return false
      }
      // Leave the ownership marker until credential deletion succeeded. A
      // temporarily locked jar must remain recoverable on the next sweep.
      const names = io.readdirSync(record.dir).sort((a, b) => Number(a === MARKER) - Number(b === MARKER))
      for (const name of names) io.unlinkSync(path.join(record.dir, name))
      io.rmdirSync(record.dir)
      return true
    } catch {
      // Windows can temporarily lock the directory itself after its files were
      // removed. Restore only the non-secret marker in an otherwise empty,
      // still-private directory so a later sweep can reclaim the slot.
      try {
        const stat = io.lstatSync(record.dir)
        if (stat.isDirectory() && !stat.isSymbolicLink() && ownsUid(stat) && privateMode(stat, 0o077) && io.readdirSync(record.dir).length === 0) {
          io.writeFileSync(record.markerFile, JSON.stringify(record.marker), { flag: 'wx', mode: 0o600 })
        }
      } catch {}
      return false
    }
  }
  function sweep({ forceUnused = false } = {}) {
    let removed = 0, examined = 0
    try {
      for (const name of entries()) {
        if (!JAR_NAME.test(name)) continue
        const candidate = record(path.join(root(), name, 'cookies.txt'), { allowMissing: true })
        examined++
        if (!candidate || !forceUnused && now() - candidate.marker.lastUsed < grace) continue
        if (remove(candidate)) removed++
      }
    } catch { /* A permission or malformed-root error is never a delete request. */ }
    return { removed, examined }
  }
  function allocate(kind = 'resolver') {
    if (closed) throw new Error('Oturum dosyası yöneticisi kapalı.')
    const base = safeRoot(true)
    sweep()
    if (entries().length >= entryLimit) throw new Error('Geçici oturum dosyası sınırına ulaşıldı. Kullanılmayan kaynakları kapatıp yeniden dene.')
    const dir = io.mkdtempSync(path.join(base, 'jar-'))
    const file = path.join(dir, 'cookies.txt'), stamp = Math.max(0, now())
    try {
      io.chmodSync(dir, 0o700)
      io.writeFileSync(path.join(dir, MARKER), JSON.stringify({ magic: MAGIC, id: path.basename(dir), kind: String(kind).slice(0, 32), createdAt: stamp, lastUsed: stamp }), { mode: 0o600, flag: 'wx' })
      io.writeFileSync(file, HEADER, { mode: 0o600, flag: 'wx' })
      return file
    } catch (error) {
      // This directory was exclusively created by this call and never issued.
      try { for (const name of io.readdirSync(dir)) io.unlinkSync(path.join(dir, name)); io.rmdirSync(dir) } catch {}
      throw error
    }
  }
  function write(file, text) {
    const candidate = record(file)
    if (!candidate) throw new Error('Yazılacak oturum dosyası bu uygulamaya ait değil.')
    const temp = path.join(candidate.dir, '.cookie-write-' + crypto.randomBytes(8).toString('hex') + '.tmp')
    try {
      io.writeFileSync(temp, String(text), { flag: 'wx', mode: 0o600 })
      io.renameSync(temp, candidate.file)
    } finally { try { io.rmSync(temp, { force: true }) } catch {} }
  }
  function retain(file) {
    const candidate = record(file)
    if (!candidate) return NOOP
    touch(candidate.file)
    const key = candidate.file
    leases.set(key, (leases.get(key) || 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (leases.get(key) || 1) - 1
      if (count > 0) leases.set(key, count); else { leases.delete(key); touch(key) }
    }
  }
  function touch(file) {
    const candidate = record(file)
    if (!candidate) return false
    const temp = path.join(candidate.dir, '.cookie-write-' + crypto.randomBytes(8).toString('hex') + '.tmp')
    try {
      const marker = { ...candidate.marker, lastUsed: Math.max(candidate.marker.createdAt, now()) }
      io.writeFileSync(temp, JSON.stringify(marker), { flag: 'wx', mode: 0o600 })
      io.renameSync(temp, candidate.markerFile)
      return true
    } catch { return false }
    finally { try { io.rmSync(temp, { force: true }) } catch {} }
  }
  function setReferences(files = []) {
    // References to legacy/foreign paths may exist in the library; they are
    // harmless here and can never become deletion candidates.
    references = new Set(Array.from(files).filter((file) => typeof file === 'string' && path.isAbsolute(file)).map((file) => path.resolve(file)))
  }
  function discard(file) { return remove(record(file, { allowMissing: true })) }
  function shutdown({ referencedFiles } = {}) {
    if (referencedFiles) setReferences(referencedFiles)
    closed = true
    return sweep({ forceUnused: true })
  }
  return { allocate, write, retain, touch, setReferences, sweep, discard, shutdown }
}

module.exports = { ...createCookieFiles(), createCookieFiles }
