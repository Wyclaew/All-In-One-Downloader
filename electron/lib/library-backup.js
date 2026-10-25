'use strict'
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const { atomicWrite } = require('./util')
const LIMIT = 64 * 1024 * 1024
const lastProtected = new Map()
let snapshotStamp = 0
function validLibrary(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    ['version', 'settings', 'downloads', 'sources', 'items'].some((key) => key in value) &&
    ['sources', 'items', 'downloads', 'categories'].every((key) => value[key] === undefined || Array.isArray(value[key])) &&
    (value.settings === undefined || !!value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings))
}
function readLibrary(file) {
  try { if (fs.statSync(file).size > LIMIT) return null; const data = JSON.parse(fs.readFileSync(file, 'utf8')); return validLibrary(data) ? data : null } catch { return null }
}
function snapshot(file, reason = 'manual') {
  if (!readLibrary(file)) throw new Error('Okunabilir bir kitaplık yedeği oluşturulamadı.')
  const dir = path.join(path.dirname(file), 'backups')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  snapshotStamp = Math.max(Date.now(), snapshotStamp + 1)
  const name = `library-${snapshotStamp}-${reason}-${crypto.randomBytes(4).toString('hex')}.json`
  const target = path.join(dir, name)
  fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600)
  const files = fs.readdirSync(dir).filter((n) => /^library-\d+-(?:manual|startup)-[a-f0-9]+\.json$/.test(n)).sort().reverse()
  for (const old of files.slice(8)) fs.rmSync(path.join(dir, old), { force: true })
  return target
}
function loadLibrary(file) {
  const exists = fs.existsSync(file)
  const data = exists ? readLibrary(file) : null
  if (data) return { data, notice: null }
  // Preserve the damaged original before any state write can replace it.
  const damaged = `${file}.damaged-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  if (exists) { fs.copyFileSync(file, damaged, fs.constants.COPYFILE_EXCL); fs.chmodSync(damaged, 0o600) }
  const dir = path.join(path.dirname(file), 'backups')
  let snapshots = []
  try { snapshots = fs.readdirSync(dir).filter((n) => /^library-\d+-(?:manual|startup)-[a-f0-9]+\.json$/.test(n)).sort().reverse().map((n) => path.join(dir, n)) } catch {}
  for (const candidate of [`${file}.last-good`, ...snapshots]) {
    const recovered = readLibrary(candidate)
    if (recovered) return { data: recovered, notice: exists ? 'Kitaplık dosyası okunamadı; sağlam yerel yedekten kurtarıldı. Hasarlı dosya ayrıca korundu.' : 'Kitaplık dosyası bulunamadı; sağlam yerel yedekten kurtarıldı.' }
  }
  if (!exists) return { data: null, notice: null }
  return { data: null, notice: 'Kitaplık dosyası okunamadı. Hasarlı dosya korunarak yeni liste açıldı; yedek klasörünü kontrol edebilirsin.' }
}
function writeLibrary(file, data) {
  if (!file) return
  if (!validLibrary(data)) throw new Error('Geçersiz kitaplık kaydı.')
  const now = Date.now()
  if (!lastProtected.has(file) || now - lastProtected.get(file) > 5 * 60000 || !fs.existsSync(`${file}.last-good`)) {
    if (readLibrary(file)) { atomicWrite(`${file}.last-good`, fs.readFileSync(file, 'utf8')); lastProtected.set(file, now) }
  }
  atomicWrite(file, JSON.stringify(data))
}
module.exports = { validLibrary, readLibrary, snapshot, loadLibrary, writeLibrary }
