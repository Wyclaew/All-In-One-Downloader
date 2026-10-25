'use strict'
const fs = require('fs')
const path = require('path')
const MiB = 1024 * 1024
function freeSpace(dir) {
  if (typeof fs.statfsSync !== 'function') return null
  let current = path.resolve(dir)
  while (!fs.existsSync(current)) { const parent = path.dirname(current); if (parent === current) return null; current = parent }
  try {
    const stat = fs.statfsSync(current)
    const bytes = Number(stat.bavail) * Number(stat.bsize)
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : null
  } catch { return null }
}
function assertSpace(dir, { requiredBytes = 0, reserveBytes = 256 * MiB, availableBytes } = {}) {
  const freeBytes = availableBytes === undefined ? freeSpace(dir) : availableBytes
  if (freeBytes === null || !Number.isFinite(freeBytes)) return null
  const required = Math.max(0, Number(requiredBytes) || 0) + Math.max(0, Number(reserveBytes) || 0)
  if (freeBytes < required) {
    const error = new Error(`Diskte yeterli boş alan yok. Yaklaşık ${Math.ceil(required / MiB)} MB gerekli, ${Math.floor(freeBytes / MiB)} MB boş. Yer açıp indirmeyi sürdürebilirsin.`)
    error.code = 'ENOSPC'; error.freeBytes = freeBytes; error.requiredBytes = required
    throw error
  }
  return { freeBytes, requiredBytes: required }
}
module.exports = { freeSpace, assertSpace, MiB }
