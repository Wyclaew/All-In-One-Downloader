'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { root, load } = require('./helpers.cjs')
let stored = null
let rejectGet = false
let gate = null
let gateSet = null
let getError = null
let capability = { available: true, status: 'available', reason: 'Touch ID kullanılabilir.', action: null }
const biometrics = {
  available: () => true,
  status: () => ({ ...capability }),
  refresh: async () => ({ ...capability }),
  keychain: async (operation, secret) => {
    if (operation === 'set') { stored = Buffer.from(secret); if (gateSet) await gateSet; return null }
    if (operation === 'delete') { stored?.fill(0); stored = null; return null }
    if (rejectGet) throw new Error('Touch ID canceled')
    if (getError) throw getError
    if (gate) await gate
    if (!stored) throw new Error('Key missing')
    return Buffer.from(stored)
  },
}
const vault = load('electron/lib/vault.js', { './biometrics': biometrics })
const pass = 'A-long-vault-test-passphrase!42'
test.after(() => { vault.lock({ reason: 'quit' }); stored?.fill(0); fs.rmSync(root, { recursive: true, force: true }) })
test('biometric enrollment requires an unlocked vault', async () => {
  await assert.rejects(vault.setBiometric(true))
  await vault.create(pass)
  assert.equal(vault.status().biometricReady, false)
  await vault.setBiometric(true)
  assert.equal(vault.status().biometricEnabled, true)
  const meta = fs.readFileSync(path.join(root, 'vault', 'meta.json'), 'utf8')
  const secret = JSON.parse(stored.toString())
  assert.equal(meta.includes(secret.key), false)
})
test('vault exposes an actionable biometric status even when authentication is unavailable', async () => {
  capability = { available: false, status: 'not-enrolled', reason: 'Sistem Ayarları’ndan parmak izi ekle.', action: 'system-settings' }
  const state = await vault.refreshBiometricStatus()
  assert.equal(state.biometricAvailable, false)
  assert.equal(state.biometricStatus, 'not-enrolled')
  assert.equal(state.biometricAction, 'system-settings')
  assert.match(state.biometricReason, /Sistem Ayarları/)
  capability = { available: true, status: 'available', reason: 'Touch ID kullanılabilir.', action: null }
})
test('Touch ID opens the same encrypted vault without storing the passphrase', async () => {
  assert.equal(stored.includes(Buffer.from(pass)), false)
  vault.lock()
  await vault.unlockBiometric()
  assert.equal(vault.isUnlocked(), true)
})
test('canceling native authentication leaves the vault locked and password still works', async () => {
  vault.lock()
  rejectGet = true
  await assert.rejects(vault.unlockBiometric(), /canceled/)
  assert.equal(vault.isUnlocked(), false)
  rejectGet = false
  await vault.unlock(pass)
  assert.equal(vault.isUnlocked(), true)
})
test('sleep/lock during biometric authentication cannot reopen the vault', async () => {
  vault.lock()
  let release
  gate = new Promise((r) => { release = r })
  const pending = vault.unlockBiometric()
  vault.lock({ reason: 'sleep' })
  release()
  await assert.rejects(pending, /kilitlendi/)
  gate = null
  assert.equal(vault.isUnlocked(), false)
})
test('sleep during password derivation cannot reopen the vault and a new password attempt still works', async () => {
  const pending = vault.unlock(pass)
  vault.lock({ reason: 'sleep' })
  await assert.rejects(pending, { code: 'SESSION_CANCELED' })
  assert.equal(vault.isUnlocked(), false)
  await vault.unlock(pass)
  assert.equal(vault.isUnlocked(), true)
  vault.lock()
})
test('password candidate keys stay private until index loading completes and a lock cancels that session', async () => {
  const fsp = require('node:fs/promises')
  const readFile = fsp.readFile
  let entered
  let release
  const atIndex = new Promise((resolve) => { entered = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  fsp.readFile = async (...args) => {
    if (args[0] === path.join(root, 'vault', 'index2.bin')) { entered(); await gate }
    return readFile(...args)
  }
  try {
    const pending = vault.unlock(pass)
    await atIndex
    assert.equal(vault.isUnlocked(), false)
    vault.lock({ reason: 'screen-lock' })
    release()
    await assert.rejects(pending, { code: 'SESSION_CANCELED' })
    assert.equal(vault.isUnlocked(), false)
  } finally {
    release()
    fsp.readFile = readFile
  }
})
test('missing or changed Keychain enrollment provides a re-enrollment path and preserves password access', async () => {
  getError = Object.assign(new Error('Touch ID kaydı bulunamadı. Şifrenle açıp yeniden etkinleştir.'), { code: 'key-missing' })
  await assert.rejects(vault.unlockBiometric(), { code: 'key-missing' })
  assert.equal(vault.status().biometricEnabled, true)
  assert.equal(vault.status().biometricReady, false)
  assert.match(vault.status().biometricReason, /yeniden etkinleştir/)
  getError = null
  await vault.unlock(pass)
  await vault.setBiometric(true)
  assert.equal(vault.status().biometricReady, true)
})
test('a stale Keychain key never opens the vault and can be replaced after password unlock', async () => {
  vault.lock()
  const secret = JSON.parse(stored.toString())
  secret.identity = 'another-vault'
  stored.fill(0)
  stored = Buffer.from(JSON.stringify(secret))
  await assert.rejects(vault.unlockBiometric(), { code: 'invalid-key' })
  assert.equal(vault.isUnlocked(), false)
  assert.equal(vault.status().biometricReady, false)
  await vault.unlock(pass)
  await vault.setBiometric(true)
  assert.equal(vault.status().biometricReady, true)
})
test('changing the password invalidates enrollment and keeps password fallback', async () => {
  await vault.unlock(pass)
  await vault.changePassphrase(pass, pass + '-new')
  assert.equal(vault.status().biometricEnabled, false)
  assert.equal(stored, null)
  vault.lock()
  await assert.rejects(vault.unlockBiometric())
  await vault.unlock(pass + '-new')
  await vault.setBiometric(true)
  await vault.setBiometric(false)
  assert.equal(stored, null)
})
test('locking during enrollment removes its Keychain key and cannot leave a ready enrollment', async () => {
  let release
  gateSet = new Promise((r) => { release = r })
  const pending = vault.setBiometric(true)
  vault.lock({ reason: 'sleep' })
  release()
  await assert.rejects(pending, /kilitlendi/)
  gateSet = null
  assert.equal(stored, null)
  assert.equal(vault.isUnlocked(), false)
  assert.equal(vault.status().biometricEnabled, false)
  assert.equal(vault.status().biometricReady, false)
})

test('legacy entitlement errors expose re-enrollment while password access remains available', async () => {
  await vault.unlock(pass + '-new')
  await vault.setBiometric(true)
  vault.lock()
  getError = Object.assign(new Error('Önceki macOS Anahtar Zinciri izni eksik. Şifrenle açıp Touch ID’yi yeniden etkinleştir.'), { code: 'missing-entitlement' })
  await assert.rejects(vault.unlockBiometric(), { code: 'missing-entitlement' })
  assert.equal(vault.status().biometricReady, false)
  assert.match(vault.status().biometricReason, /izni eksik/)
  getError = null
  await vault.unlock(pass + '-new')
  await vault.setBiometric(true)
  assert.equal(vault.status().biometricReady, true)
  vault.lock()
  await vault.unlockBiometric()
  assert.equal(vault.isUnlocked(), true)
})
