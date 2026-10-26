'use strict'

// A final file does not exist while HLS/ranged workers are still writing it.
// Claim its name atomically so another job cannot share its partials or cache.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const markerFor = (file) => `${file}.aio-owner`
const ownerKey = (id) => crypto.createHash('sha256').update(String(id)).digest('hex')
function owned(file, id) {
  if (!file || !id) return false
  try {
    const marker = markerFor(file), stat = fs.lstatSync(marker)
    return stat.isFile() && !stat.isSymbolicLink() && stat.size < 256 && fs.readFileSync(marker, 'utf8') === ownerKey(id)
  } catch { return false }
}
function release(file, id) {
  if (!file || !owned(file, id)) return false
  try { fs.unlinkSync(markerFor(file)); return true } catch { return false }
}
function reserve({ dir, base, ext, id, preferred }) {
  if (!id) throw new Error('İndirme kimliği bulunamadı.')
  dir = path.resolve(dir)
  function claim(file, resume = false) {
    if (fs.existsSync(file)) return false
    if (owned(file, id)) return true
    if (!resume && ['.part', '.segments', '.dash-segments', '.hls-cache', '.dash-cache'].some((suffix) => fs.existsSync(file + suffix))) return false
    try { fs.writeFileSync(markerFor(file), ownerKey(id), { flag: 'wx', mode: 0o600 }); return true }
    catch (error) { if (error.code === 'EEXIST') return false; throw error }
  }
  if (preferred && path.dirname(path.resolve(preferred)) === dir && claim(path.resolve(preferred), true)) return path.resolve(preferred)
  for (let n = 1; n <= 10000; n++) {
    const file = path.join(dir, `${base}${n === 1 ? '' : ` (${n})`}.${ext}`)
    if (claim(file)) return file
  }
  throw new Error('Bu ad için boş bir indirme hedefi bulunamadı.')
}
// yt-dlp learns the final title/extension asynchronously. A stable per-job
// suffix also isolates its video, audio, subtitle and fragment intermediates.
function outputTemplate(template, id) {
  const suffix = ` [aio-${ownerKey(id).slice(0, 24)}]`
  if (template.endsWith('.%(ext)s')) return template.slice(0, -8) + suffix + '.%(ext)s'
  const extension = template.match(/\.[A-Za-z0-9]{1,8}$/)?.[0]
  return extension ? template.slice(0, -extension.length) + suffix + extension : template + suffix
}
module.exports = { reserve, release, owned, outputTemplate }
