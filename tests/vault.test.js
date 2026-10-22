'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { root, load } = require('./helpers.cjs')
let stored = null
let rejectGet = false
let gate = null
const biometrics = {
  available: () => true,
  keychain: async (operation, secret) => {
    if (operation === 'set') { stored = Buffer.from(secret); return null }
    if (operation === 'delete') { stored?.fill(0); stored = null; return null }
    if (rejectGet) throw new Error('Touch ID canceled')
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
  await vault.setBiometric(true)
  assert.equal(vault.status().biometricEnabled, true)
  const meta = fs.readFileSync(path.join(root, 'vault', 'meta.json'), 'utf8')
  const secret = JSON.parse(stored.toString())
  assert.equal(meta.includes(secret.key), false)
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
