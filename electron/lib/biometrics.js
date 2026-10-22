'use strict'

const { app, systemPreferences } = require('electron')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')

const helperPath = () => app.isPackaged
  ? path.join(process.resourcesPath, 'bin', 'vault-keychain')
  : path.join(__dirname, '..', '..', 'build', '.native', process.arch, 'vault-keychain')

function available() {
  return process.platform === 'darwin' && systemPreferences.canPromptTouchID() && fs.existsSync(helperPath())
}

function keychain(operation, secret = null) {
  if (!available() && operation !== 'delete') return Promise.reject(new Error('Touch ID kullanılamıyor. Kasa şifrenle açabilirsin.'))
  if (process.platform !== 'darwin' || !fs.existsSync(helperPath())) return Promise.resolve(null)
  const account = crypto.createHash('sha256').update(app.getPath('userData')).digest('hex')
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath(), [operation, account], { stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []
    let errorText = ''
    const timer = setTimeout(() => child.kill(), 60000)
    child.stdout.on('data', (data) => chunks.push(data))
    child.stderr.on('data', (data) => { errorText = (errorText + data).slice(-2000) })
    child.stdin.on('error', () => {})
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(`Touch ID işlemi tamamlanamadı. Şifrenle açıp yeniden etkinleştirebilirsin. ${errorText.trim()}`))
    })
    child.stdin.end(secret)
  })
}

module.exports = { available, keychain }
