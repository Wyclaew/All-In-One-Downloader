'use strict'

// Bounded, explicit local inspection. Records, not renderer-supplied paths,
// determine which file may be read. A closing dialog cancels its own job.
function createMediaInspection({ getDownload, resolvePath, inspect, commit, maximum = 2 }) {
  const jobs = new Map()
  function check(id) {
    if (typeof id !== 'string' || !id) return Promise.reject(new Error('Video kaydı bulunamadı.'))
    if (jobs.has(id)) return jobs.get(id).promise
    const download = getDownload(id)
    if (!download || download.status !== 'done') return Promise.reject(new Error('Önce indirmesi tamamlanmış bir video seç.'))
    const file = resolvePath(download)
    if (!file) return Promise.reject(new Error('Video dosyası bulunamadı.'))
    if (jobs.size >= maximum) return Promise.reject(new Error('İki video zaten kontrol ediliyor. Biri bitince yeniden dene.'))
    const job = { controller: new AbortController(), promise: null }
    jobs.set(id, job)
    job.promise = Promise.resolve().then(() => inspect(file, { signal: job.controller.signal }))
      .then((report) => {
        if (job.controller.signal.aborted || getDownload(id) !== download || resolvePath(download) !== file) throw Object.assign(new Error('Video değişti veya kontrol iptal edildi.'), { code: 'ABORTED' })
        commit(() => { download.mediaInspection = report })
        return report
      }).catch((error) => {
        if (job.controller.signal.aborted) throw Object.assign(new Error('Kontrol iptal edildi.'), { code: 'ABORTED' })
        throw error
      }).finally(() => { if (jobs.get(id) === job) jobs.delete(id) })
    return job.promise
  }
  function cancel(id) { const job = jobs.get(id); if (!job) return false; job.controller.abort(); return true }
  function shutdown() { for (const job of jobs.values()) job.controller.abort() }
  return { check, cancel, shutdown }
}
module.exports = { createMediaInspection }
