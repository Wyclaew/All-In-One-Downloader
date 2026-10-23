'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

// Isolated processes/platforms, never the user's actual Keychain or vault.
function fixture({ platform = 'darwin', packaged = false, executable = true, electronAvailable = false } = {}) {
  const calls = []
  let native = { available: true, status: 'available' }
  let nativeError = null
  let errorOperation = null
  let output = null
  const app = { isPackaged: packaged, getPath: () => '/private/test-profile' }
  const spawn = (file, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = new EventEmitter()
    child.kill = () => { child.emit('close', null); return true }
    child.stdin.end = (secret) => {
      calls.push({ file, args, options, secret: secret ? Buffer.from(secret) : null })
      queueMicrotask(() => {
        if (nativeError && (!errorOperation || errorOperation === args[0])) {
          child.stderr.emit('data', Buffer.from(JSON.stringify(nativeError)))
          child.emit('close', 1)
        } else {
          output = Buffer.from(args[0] === 'status' ? JSON.stringify(native) : args[0] === 'get' ? 'protected-vault-key' : '')
          child.stdout.emit('data', output)
          child.emit('close', 0)
        }
      })
    }
    return child
  }
  const module = { exports: {} }
  const file = path.resolve(__dirname, '../electron/lib/biometrics.js')
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module,
    exports: module.exports,
    __dirname: path.dirname(file),
    process: { platform, arch: 'arm64', resourcesPath: '/Applications/Test.app/Contents/Resources' },
    Buffer, setTimeout, clearTimeout,
    require: (name) => {
      if (name === 'electron') return { app, systemPreferences: { canPromptTouchID: () => electronAvailable } }
      if (name === 'fs') return { constants: fs.constants, accessSync: () => { if (!executable) throw new Error('ENOENT') } }
      if (name === 'child_process') return { spawn }
      return require(name)
    },
  }, { filename: file })
  return { biometrics: module.exports, calls, setNative: (value) => { native = value }, setError: (value, operation = null) => { nativeError = value; errorOperation = operation }, output: () => output }
}

test('unsupported platforms and a missing helper explain password fallback without spawning', async () => {
  for (const [options, status] of [[{ platform: 'win32' }, 'unsupported-platform'], [{ executable: false }, 'helper-missing']]) {
    const { biometrics, calls } = fixture(options)
    assert.equal((await biometrics.refresh()).status, status)
    assert.equal(biometrics.available(), false)
    await assert.rejects(biometrics.keychain('get'), (err) => err.code === status && /şifren/.test(err.message))
    await biometrics.keychain('delete')
    assert.equal(calls.length, 0)
  }
})

test('native biometric-only capability is authoritative even when Electron reports false', async () => {
  const { biometrics, calls } = fixture({ electronAvailable: false })
  assert.equal(biometrics.status().status, 'checking')
  const [first, second] = await Promise.all([biometrics.refresh(), biometrics.refresh()])
  assert.equal(first.available, true)
  assert.equal(second.status, 'available')
  assert.equal(biometrics.available(), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.join(','), 'status')
  assert.equal(calls[0].secret, null)
  assert.equal(calls[0].file, path.resolve(__dirname, '../build/.native/arm64/vault-keychain'))
})

test('packaged helper path is external to asar and diagnostics guide enrollment or temporary lockout', async () => {
  const { biometrics, calls, setNative } = fixture({ packaged: true })
  setNative({ available: false, status: 'not-enrolled' })
  assert.equal((await biometrics.refresh()).action, 'system-settings')
  assert.match(biometrics.status().reason, /parmak izi ekle/)
  assert.equal(calls[0].file, '/Applications/Test.app/Contents/Resources/bin/vault-keychain')
  setNative({ available: false, status: 'locked-out' })
  assert.equal((await biometrics.refresh()).status, 'locked-out')
  assert.match(biometrics.status().reason, /giriş parolan/)
  await assert.rejects(biometrics.keychain('set', Buffer.from('secret')), { code: 'locked-out' })
  assert.equal(calls.some((call) => call.args[0] === 'set'), false)
})

test('each authentication rechecks current availability and cancellation keeps an actionable typed error', async () => {
  const { biometrics, calls, setNative, setError } = fixture()
  await biometrics.refresh()
  setNative({ available: false, status: 'not-enrolled' })
  await assert.rejects(biometrics.keychain('get'), { code: 'not-enrolled' })
  assert.equal(calls.length, 2)
  setNative({ available: true, status: 'available' })
  setError({ code: 'canceled', message: 'native cancellation detail' }, 'get')
  await assert.rejects(biometrics.keychain('get'), (error) => error.code === 'canceled' && /iptal edildi/.test(error.message) && !error.message.includes('native cancellation detail'))
  setError({ code: 'key-missing' }, 'get')
  await assert.rejects(biometrics.keychain('get'), (error) => error.code === 'key-missing' && /yeniden etkinleştir/.test(error.message))
  setError(null)
})

test('keys travel only over stdin and returned native buffers are cleared', async () => {
  const { biometrics, calls, output } = fixture()
  const key = Buffer.from('test-secret')
  await biometrics.keychain('set', key)
  const enrollment = calls.find((call) => call.args[0] === 'set')
  assert.equal(enrollment.args.length, 2)
  assert.match(enrollment.args[1], /^[a-f0-9]{64}$/)
  assert.equal(enrollment.args.join('').includes(key.toString()), false)
  assert.equal(enrollment.args.join('').includes('/private/test-profile'), false)
  assert.equal(enrollment.secret.equals(key), true)
  const read = await biometrics.keychain('get')
  assert.equal(read.toString(), 'protected-vault-key')
  assert.equal(output().every((byte) => byte === 0), true)
  read.fill(0)
  key.fill(0)
})

test('malformed helper diagnostics fail closed with a visible recovery reason', async () => {
  const { biometrics, setNative } = fixture()
  setNative({ available: true, status: 'not-enrolled' })
  const result = await biometrics.refresh()
  assert.equal(result.available, false)
  assert.equal(result.status, 'helper-error')
  assert.equal(result.action, 'retry')
  assert.match(result.reason, /güncelleyip/)
})

test('a failed helper capability command never permits a Keychain read', async () => {
  const { biometrics, calls, setError } = fixture()
  setError({ code: 'keychain-error' }, 'status')
  await assert.rejects(biometrics.keychain('get'), { code: 'helper-error' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args[0], 'status')
})
