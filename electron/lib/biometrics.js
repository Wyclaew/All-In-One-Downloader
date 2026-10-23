'use strict'

const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')

const helperPath = () => app.isPackaged
  ? path.join(process.resourcesPath, 'bin', 'vault-keychain')
  : path.join(__dirname, '..', '..', 'build', '.native', process.arch, 'vault-keychain')

const state = (status, reason, action = null) => ({ available: status === 'available', status, reason, action })
let capability = null
let checking = null

function helperState() {
  if (process.platform !== 'darwin') return state('unsupported-platform', 'Touch ID yalnızca desteklenen Mac’lerde kullanılabilir. Kasanı şifrenle açabilirsin.', 'password')
  try {
    fs.accessSync(helperPath(), fs.constants.X_OK)
  } catch {
    return state('helper-missing', 'Touch ID bileşeni bulunamadı veya çalıştırılamıyor. Uygulamayı güncelleyip yeniden aç; kasanı şifrenle açabilirsin.', 'password')
  }
  return null
}

function status() {
  const unavailable = helperState()
  if (unavailable) return unavailable
  // Electron's boolean has no failure reason and uses a different policy from
  // our biometric-only Keychain item. The helper is the authoritative check.
  return capability || state('checking', 'Touch ID kullanılabilirliği denetleniyor…', 'retry')
}

function available() {
  return status().available
}

const nativeErrors = {
  canceled: 'Touch ID doğrulaması iptal edildi. Tekrar deneyebilir veya kasa şifreni kullanabilirsin.',
  'authentication-failed': 'Parmak izi doğrulanamadı. Tekrar deneyebilir veya kasa şifreni kullanabilirsin.',
  'key-missing': 'Touch ID kaydı bulunamadı veya parmak izleri değişti. Kasayı şifrenle açıp Touch ID’yi yeniden etkinleştir.',
  'not-enrolled': 'macOS’te kayıtlı parmak izi yok. Sistem Ayarları → Touch ID ve Parola bölümünden parmak izi ekle.',
  'locked-out': 'Touch ID geçici olarak kilitli. Mac oturumunu giriş parolanla aç, sonra yeniden dene. Kasa şifreni de kullanabilirsin.',
  'session-unavailable': 'macOS şu anda Touch ID doğrulamasına izin vermiyor. Mac oturumunu açıp tekrar dene veya kasa şifreni kullan.',
  unavailable: 'Bu oturumda kullanılabilir bir Touch ID sensörü yok. Sistem Ayarları → Touch ID ve Parola bölümünü kontrol et; kasa şifreni kullanabilirsin.',
}

function operationError(code, message) {
  const error = new Error(message || nativeErrors[code] || 'Touch ID işlemi tamamlanamadı. Kasayı şifrenle açıp Touch ID’yi yeniden etkinleştirebilirsin.')
  error.code = code
  return error
}

function runHelper(operation, secret = null) {
  return new Promise((resolve, reject) => {
    const args = operation === 'status' ? [operation] : [operation, crypto.createHash('sha256').update(app.getPath('userData')).digest('hex')]
    const child = spawn(helperPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []
    let bytes = 0
    let errorText = ''
    let timedOut = false
    let oversized = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, operation === 'status' ? 5000 : 60000)
    child.stdout.on('data', (data) => {
      bytes += data.length
      if (bytes > 16384) { oversized = true; child.kill(); return }
      chunks.push(data)
    })
    child.stderr.on('data', (data) => { errorText = (errorText + data).slice(-2000) })
    child.stdin.on('error', () => {})
    child.on('error', () => { clearTimeout(timer); reject(operationError('helper-error', 'Touch ID bileşeni başlatılamadı. Uygulamayı güncelleyip yeniden aç; kasa şifreni kullanabilirsin.')) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const output = Buffer.concat(chunks)
      // The helper may have returned a vault key. Always clear all received
      // buffers, including rejected, truncated and timed-out responses.
      for (const chunk of chunks) chunk.fill(0)
      if (code === 0 && !timedOut && !oversized) return resolve(output)
      output.fill(0)
      let nativeCode
      try { nativeCode = JSON.parse(errorText).code } catch { /* an older or broken helper */ }
      reject(timedOut
        ? operationError('timeout', 'Touch ID işlemi zaman aşımına uğradı. Yeniden deneyebilir veya kasa şifreni kullanabilirsin.')
        : operationError(nativeCode || 'helper-error'))
    })
    child.stdin.end(secret)
  })
}

async function refresh() {
  const unavailable = helperState()
  if (unavailable) { capability = unavailable; return { ...unavailable } }
  if (checking) return checking
  checking = (async () => {
    let output
    try {
      output = await runHelper('status')
      const native = JSON.parse(output.toString('utf8'))
      const allowed = ['available', 'not-enrolled', 'locked-out', 'unavailable']
      if (!allowed.includes(native.status) || native.available !== (native.status === 'available')) throw new Error('Invalid capability')
      capability = state(native.status,
        native.status === 'available' ? 'Touch ID bu Mac’te kullanılabilir.' : nativeErrors[native.status],
        native.status === 'not-enrolled' || native.status === 'unavailable' ? 'system-settings' : native.status === 'locked-out' ? 'password' : null)
    } catch {
      capability = state('helper-error', 'Touch ID durumu okunamadı. Uygulamayı güncelleyip yeniden aç; kasanı şifrenle açabilirsin.', 'retry')
    } finally { output?.fill(0) }
    return { ...capability }
  })()
  try { return await checking } finally { checking = null }
}

async function keychain(operation, secret = null) {
  if (!['set', 'get', 'delete'].includes(operation)) throw operationError('invalid-operation')
  const unavailable = helperState()
  if (unavailable) {
    // Removing enrollment metadata must still work on another platform or if a
    // helper was removed. This never reads or writes an unprotected substitute.
    if (operation === 'delete') return null
    throw operationError(unavailable.status, unavailable.reason)
  }
  if (operation !== 'delete') {
    const current = await refresh()
    if (!current.available) throw operationError(current.status, current.reason)
  }
  return runHelper(operation, secret)
}

module.exports = { available, status, refresh, keychain }
