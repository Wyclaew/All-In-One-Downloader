'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto')
const { createSiteAccounts, normaliseOrigin } = require('../electron/lib/site-accounts')

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-accounts-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const key = crypto.randomBytes(32)
  const safeStorage = {
    isEncryptionAvailable: () => options.available !== false,
    getSelectedStorageBackend: () => options.backend || 'keychain',
    encryptString: (value) => {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), bytes])
    },
    decryptString: (bytes) => {
      if (options.decryptFailure) throw new Error('synthetic secret-containing error must not leak')
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      cipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8')
    },
  }
  return { root, file: path.join(root, 'site-accounts.enc'), safeStorage,
    accounts: createSiteAccounts({ app: { getPath: () => root }, safeStorage }) }
}
const profile = { email: 'fixture@example.test', password: 'fixture-only-password' }

test('credentials and origin policies are encrypted outside the library; status contains no password', (t) => {
  const { accounts, file } = fixture(t)
  const status = accounts.setProfile(profile)
  assert.equal(status.email, profile.email); assert.equal(status.hasPassword, true)
  assert.equal('password' in status, false)
  accounts.setSitePolicy({ origin: 'https://accounts.example.test', login: true, registration: false })
  const raw = fs.readFileSync(file, 'utf8')
  for (const plain of [profile.email, profile.password, 'accounts.example.test']) assert.equal(raw.includes(plain), false)
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(accounts.secretForOrigin('https://accounts.example.test').password, profile.password)
  assert.equal(accounts.secretForOrigin('https://www.accounts.example.test'), null)
  assert.equal(accounts.secretForOrigin('https://accounts.example.test:8443'), null)
  assert.equal(accounts.secretForOrigin('http://accounts.example.test'), null)
  assert.equal(accounts.secretForOrigin('https://accounts.example.test.evil.test'), null)
})
test('plaintext storage backends and locked keychains fail closed without creating a secret file', (t) => {
  for (const options of [{ available: false }, { backend: 'basic_text' }]) {
    const { accounts, file } = fixture(t, options)
    assert.equal(accounts.getStatus().available, false)
    assert.throws(() => accounts.setProfile(profile), /anahtarlığ/)
    assert.equal(fs.existsSync(file), false)
  }
})
test('profile updates preserve a blank password only for the same email; delete revokes every site', (t) => {
  const { accounts, file } = fixture(t)
  accounts.setProfile(profile)
  accounts.setSitePolicy({ origin: 'https://accounts.example.test', registration: true })
  assert.equal(accounts.getStatus().sites[0].login, true)
  accounts.setProfile({ email: profile.email, password: '' })
  assert.equal(accounts.secretForOrigin('https://accounts.example.test').password, profile.password)
  assert.throws(() => accounts.setProfile({ email: 'other@example.test', password: '' }), /Parola/)
  accounts.setSitePolicy({ origin: 'https://accounts.example.test', login: false })
  assert.equal(accounts.secretForOrigin('https://accounts.example.test'), null)
  accounts.clearProfile()
  assert.equal(fs.existsSync(file), false); assert.equal(accounts.getStatus().hasPassword, false)
  assert.deepEqual(accounts.getStatus().sites, [])
})
test('corrupt or inaccessible ciphertext produces a useful generic status and can still be removed', (t) => {
  const { accounts, file } = fixture(t)
  accounts.setProfile(profile)
  fs.writeFileSync(file, '{broken')
  const state = accounts.getStatus()
  assert.match(state.reason, /açılamadı/)
  assert.equal(state.reason.includes(profile.password), false)
  assert.throws(() => accounts.setProfile(profile), /açılamadı/)
  accounts.clearProfile(); assert.equal(accounts.getStatus().reason, null)
})
test('site permission scope rejects URL credentials, non-HTTPS, page paths and malformed profiles', (t) => {
  const { accounts } = fixture(t)
  for (const origin of ['http://example.test', 'https://person:secret@example.test', 'https://example.test/login', 'https://example.test/?token=x', 'https://example.test/#page', 'file:///secret', 'https://localhost']) assert.throws(() => normaliseOrigin(origin))
  assert.throws(() => accounts.setSitePolicy({ origin: 'https://example.test' }), /Önce/)
  assert.throws(() => accounts.setProfile({ email: 'not-an-email', password: '123456789' }), /e-posta/)
  assert.throws(() => accounts.setProfile({ email: profile.email, password: 'short' }), /Parola/)
})

const { createAuthentication } = require('../electron/lib/site-account-forms')
function browserFixture({ descriptor, changedOrigin, abort } = {}) {
  const scripts = [], controller = new AbortController()
  const origin = 'https://accounts.example.test'
  let inspected = false
  const contents = {
    isDestroyed: () => false,
    getURL: () => inspected && changedOrigin ? 'https://other.example.test/login' : origin + '/login',
    mainFrame: { executeJavaScript: async (script) => {
      scripts.push(script)
      if (scripts.length === 1) { inspected = true; if (abort) controller.abort(); return descriptor }
      return { submitted: true }
    } },
  }
  const auth = createAuthentication({ accounts: { secretForOrigin: (url) => url === origin ? { ...profile, policy: { login: true, registration: true } } : null } })
  return { auth, win: { webContents: contents }, scripts, controller }
}
const descriptor = { state: 'ready', mode: 'login', marker: 'aio-account-fixture', passwordCount: 1, action: 'https://accounts.example.test/session' }
test('origin changes or cancellation between form inspection and filling never send credentials', async () => {
  for (const options of [{ changedOrigin: true }, { abort: true }]) {
    const fixture = browserFixture({ descriptor, ...options })
    const outcome = await fixture.auth.attemptAuthentication(fixture.win, { signal: fixture.controller.signal })
    assert.equal(outcome.state, 'aborted'); assert.equal(fixture.scripts.length, 1)
    assert.equal(fixture.scripts[0].includes(profile.password), false)
    assert.equal(fixture.scripts[0].includes(profile.email), false)
  }
})
test('untrusted inspector data cannot choose a third-party form target or arbitrary submission mode', async () => {
  for (const malformed of [
    { ...descriptor, action: 'https://other.example.test/session' },
    { ...descriptor, action: 'https://person:secret@accounts.example.test/session' },
    { ...descriptor, mode: 'payment' },
    { ...descriptor, passwordCount: 999 },
    { ...descriptor, marker: 'invalid"selector' },
  ]) {
    const fixture = browserFixture({ descriptor: malformed })
    const outcome = await fixture.auth.attemptAuthentication(fixture.win)
    assert.equal(outcome.state, 'needs-user'); assert.equal(outcome.reason, 'unsafe-form')
    assert.equal(fixture.scripts.length, 1)
  }
  const navigated = browserFixture({ descriptor: null })
  assert.equal((await navigated.auth.attemptAuthentication(navigated.win)).state, 'no-form')
})

const { safeDestination } = require('../electron/lib/site-account-forms')
test('auth navigation requires matching destination and visible purpose on the exact approved origin', () => {
  const origin = 'https://accounts.example.test', current = origin + '/watch'
  assert.equal(safeDestination({ mode: 'login', url: origin + '/login', text: 'Log in' }, origin, current), true)
  assert.equal(safeDestination({ mode: 'registration', url: origin + '/register', text: 'Kayıt ol' }, origin, current), true)
  assert.equal(safeDestination({ mode: 'registration', url: origin + '/wp-login.php?action=register', text: 'Register' }, origin, current), true)
  for (const link of [
    { mode: 'login', url: origin + '/watch', text: 'Log in' },
    { mode: 'registration', url: origin + '/register', text: 'Pay now' },
    { mode: 'registration', url: 'https://other.example.test/register', text: 'Register' },
    { mode: 'registration', url: 'https://sub.accounts.example.test/register', text: 'Register' },
    { mode: 'registration', url: 'javascript:alert(1)', text: 'Register' },
  ]) assert.equal(safeDestination(link, origin, current), false)
  assert.equal(safeDestination({ mode: 'login', url: origin + '/login#same', text: 'Log in' }, origin, origin + '/login'), false)
})
