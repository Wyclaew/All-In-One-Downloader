'use strict'

// Classify the original error, before it is translated for the interface.
function failureKind(error) {
  const text = [error?.code, error?.message, error?.raw, error].join(' ')
  if (error?.code === 'ABORTED' || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return 'aborted'
  if (/ENOSPC|EACCES|EROFS|disk full|no space left|permission denied/i.test(text)) return 'disk'
  if (/DRM|Widevine|FairPlay|PlayReady/i.test(text)) return 'protected'
  if (/members.only|private video|login required|sign in|log in|authentication required|captcha/i.test(text)) return 'auth'
  if (/\b429\b|too many requests/i.test(text)) return 'busy'
  if (/\b(?:401|403|410)\b|expired|signature|token.*invalid|akış adresi geçmiş/i.test(text)) return 'expired'
  if (/\b(?:408|425|500|502|503|504)\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EPIPE|socket|timed? ?out|timeout|network|connection|remote.*closed|incomplete|premature|aborted|fetch failed|zaman aşımı|yanıt vermedi|eksik indi|sonrasını vermedi/i.test(text)) return 'network'
  return 'permanent'
}

function retryDelay(attempt, kind = 'network', retryAfter = null) {
  const seconds = Number(retryAfter)
  const date = Date.parse(retryAfter)
  const server = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000
    : Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0
  return Math.min(120000, Math.max(server, (kind === 'busy' ? 10000 : 1500) * 2 ** Math.min(attempt, 5)))
}

function httpError(status, headers = {}) {
  const err = new Error(`Sunucu HTTP ${status} döndürdü.`)
  err.status = status
  err.retryAfter = headers['retry-after'] || null
  return err
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(Object.assign(new Error('Aktarım durduruldu.'), { code: 'ABORTED' })) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve() }, ms)
    if (signal?.aborted) aborted()
    else signal?.addEventListener('abort', aborted, { once: true })
  })
}

module.exports = { failureKind, retryDelay, httpError, sleep }
