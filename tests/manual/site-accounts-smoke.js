'use strict'
// Generated local HTTPS pages + fixture-only credentials. No real account,
// browser profile, system Keychain credential or external website is accessed.
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), https = require('node:https')
const { execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')
const { createAuthentication } = require('../../electron/lib/site-account-forms')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-account-smoke-'))
app.setPath('userData', path.join(root, 'profile'))
app.commandLine.appendSwitch('host-resolver-rules', 'MAP account.test 127.0.0.1, MAP other.test 127.0.0.1')
app.on('window-all-closed', () => {})
app.on('certificate-error', (event, _contents, url, _error, _certificate, callback) => {
  const host = new URL(url).hostname
  if (host === 'account.test' || host === 'other.test') { event.preventDefault(); callback(true) } else callback(false)
})
const key = path.join(root, 'key.pem'), cert = path.join(root, 'cert.pem')
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-nodes', '-days', '1', '-subj', '/CN=account.test'], { stdio: 'pipe', timeout: 20000 })
const posts = [], errors = [], fixtures = [], gets = []
let origin, server, win, external = 0
const account = { email: 'fixture@example.test', password: 'fixture-only-password', policy: { login: true, registration: false } }
const automation = createAuthentication({ accounts: { secretForOrigin: (target) => target === origin ? { ...account, policy: { ...account.policy } } : null } })
const html = (inner, action = '/session') => '<!doctype html><html><body><form method="post" action="' + action + '"><label>E-posta<input type="email" name="email" required></label>' + inner + '<button type="submit">' + (inner.includes('confirmation') ? 'Create account' : 'Log in') + '</button></form></body></html>'
async function load(route) { await win.loadURL(origin + route); await new Promise((resolve) => setTimeout(resolve, 50)) }
async function until(check) { const started = Date.now(); while (!await check()) { if (Date.now() - started > 5000) throw new Error('Synthetic form transition timed out'); await new Promise((resolve) => setTimeout(resolve, 25)) } }
app.whenReady().then(async () => {
  server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (request, response) => {
    if (request.method === 'POST') {
      let body = ''; request.on('data', (bytes) => { body += bytes }); request.on('end', () => { posts.push({ url: request.url, fields: Object.fromEntries(new URLSearchParams(body)) }); response.end('<title>Fixture submitted</title>Fixture submitted') }); return
    }
    gets.push(request.url)
    response.setHeader('Content-Type', 'text/html')
    const password = '<input type="password" name="password" autocomplete="current-password" required>'
    if (request.url === '/login') return response.end(html(password + '<a href="/forgot">Forgot password?</a><a href="/register">Register</a>'))
    if (request.url === '/register') return response.end(html('<input type="password" name="password" autocomplete="new-password" required><input type="password" name="confirmation" autocomplete="new-password" required>', '/register-session'))
    if (request.url === '/cross-origin') return response.end(html(password, origin.replace('account.test', 'other.test') + '/third-party'))
    if (request.url === '/get-form') return response.end(html(password).replace('method="post"', 'method="get"'))
    if (request.url === '/terms') return response.end(html(password + '<label><input type="checkbox" name="agree_terms" required>Terms</label>'))
    if (request.url === '/mfa') return response.end(html(password + '<input name="otp" autocomplete="one-time-code" required>'))
    if (request.url === '/extra') return response.end(html(password + '<input type="tel" name="phone" required>'))
    if (request.url === '/captcha') return response.end(html(password + '<div id="captcha" style="width:100px;height:30px">Verification</div>'))
    if (request.url === '/payment') return response.end(html(password + '<input name="card_number" autocomplete="cc-number">'))
    if (request.url === '/change-password') return response.end(html(password + '<input type="password" name="new_password" autocomplete="new-password" required>'))
    if (request.url === '/landing-login') return response.end('<p>Login required</p><a href="/login">Log in</a>')
    if (request.url === '/landing-register') return response.end('<p>Registration required</p><a href="/register">Register</a>')
    if (request.url === '/landing-loop') return response.end('<p>Registration required</p><a href="/register/loop">Register</a>')
    if (request.url === '/register/loop') { response.writeHead(302, { Location: '/landing-loop' }); return response.end() }
    if (request.url === '/arbitrary-links') return response.end('<p>Login required</p><a href="/watch">Log in</a><a href="/register">Pay now</a><a href="https://other.test/register">Register</a>')
    if (request.url === '/redirect-login') return response.end('<p>Login required</p><a href="/login/redirect">Log in</a>')
    if (request.url === '/login/redirect') { response.writeHead(302, { Location: origin.replace('account.test', 'other.test') + '/login' }); return response.end() }
    response.end('<title>No account form</title>No account form')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = 'https://account.test:' + server.address().port
  const ses = session.fromPartition('account-fixture')
  await ses.setProxy({ mode: 'direct' })
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const host = new URL(details.url).hostname
    if (!['account.test', 'other.test'].includes(host)) { external++; callback({ cancel: true }) } else callback({ cancel: false })
  })
  win = new BrowserWindow({ show: false, webPreferences: { partition: 'account-fixture', contextIsolation: true, nodeIntegration: false, sandbox: true } })
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  for (const [route, reason] of [['/cross-origin', 'unsafe-form'], ['/get-form', 'unsafe-form'], ['/terms', 'extra-fields'], ['/mfa', 'verification'], ['/extra', 'extra-fields'], ['/captcha', 'captcha'], ['/payment', 'payment'], ['/change-password', 'password-reset']]) {
    await load(route)
    const outcome = await automation.attemptAuthentication(win)
    assert.equal(outcome.state, 'needs-user', route); assert.equal(outcome.reason, reason, route)
    assert.equal(await win.webContents.executeJavaScript('document.querySelector("input[type=password]").value'), '')
    fixtures.push({ route, blocked: true })
  }
  await load('/register')
  assert.equal((await automation.attemptAuthentication(win)).reason, 'registration-disabled')
  assert.equal(posts.length, 0)
  account.policy.registration = true
  const registered = await automation.attemptAuthentication(win)
  assert.ok(['submitted', 'needs-user'].includes(registered.state))
  await until(() => posts.length === 1)
  assert.equal(posts[0].url, '/register-session'); assert.deepEqual(posts[0].fields, { email: account.email, password: account.password, confirmation: account.password })
  await load('/login')
  const loggedIn = await automation.attemptAuthentication(win)
  assert.ok(['submitted', 'needs-user'].includes(loggedIn.state))
  await until(() => posts.length === 2)
  assert.equal(posts[1].url, '/session'); assert.deepEqual(posts[1].fields, { email: account.email, password: account.password })
  await load('/login')
  assert.equal((await automation.attemptAuthentication(win)).reason, 'already-attempted')
  assert.equal(posts.length, 2)
  const navigation = createAuthentication({ accounts: { secretForOrigin: (target) => target === origin ? { ...account, policy: { ...account.policy } } : null } })
  await load('/landing-login')
  assert.equal((await navigation.attemptAuthentication(win)).state, 'no-form', 'link following must be explicitly gated by the resolver')
  assert.equal((await navigation.attemptAuthentication(win, { allowNavigation: true })).state, 'navigating')
  assert.ok(win.webContents.getURL().endsWith('/login'))
  await navigation.attemptAuthentication(win)
  await until(() => posts.length === 3)
  await load('/landing-register')
  assert.equal((await navigation.attemptAuthentication(win, { allowNavigation: true })).state, 'navigating')
  assert.ok(win.webContents.getURL().endsWith('/register'))
  await navigation.attemptAuthentication(win)
  await until(() => posts.length === 4)
  await load('/arbitrary-links')
  assert.equal((await navigation.attemptAuthentication(win, { allowNavigation: true })).state, 'no-form')
  assert.ok(win.webContents.getURL().endsWith('/arbitrary-links'))
  const loop = createAuthentication({ accounts: { secretForOrigin: () => ({ ...account, policy: { ...account.policy } }) } })
  await load('/landing-loop')
  assert.equal((await loop.attemptAuthentication(win, { allowNavigation: true })).state, 'navigating')
  assert.equal((await loop.attemptAuthentication(win, { allowNavigation: true })).state, 'no-form')
  assert.equal(gets.filter((url) => url === '/register/loop').length, 1)
  const redirected = createAuthentication({ accounts: { secretForOrigin: (target) => target === origin ? { ...account, policy: { ...account.policy } } : null } })
  await load('/redirect-login')
  assert.equal((await redirected.attemptAuthentication(win, { allowNavigation: true })).reason, 'origin-changed')
  assert.equal(await win.webContents.executeJavaScript('document.querySelector("input[type=password]").value'), '')
  assert.equal(posts.length, 4)
  await win.loadURL(origin.replace('account.test', 'other.test') + '/login')
  assert.equal((await automation.attemptAuthentication(win)).state, 'disabled')
  assert.equal(external, 0); assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, login: true, registration: true, extraRequirementsBlocked: fixtures, exactOrigin: true, attemptsBounded: true, gatedLoginAndRegisterLinks: true, rejectsArbitraryLinks: true, redirectDoesNotFill: true, navigationLoopBounded: true, externalRequests: external, rendererErrors: errors }))
}).catch((error) => { console.error(error); process.exitCode = 1 }).finally(async () => {
  win?.destroy()
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
  fs.rmSync(root, { recursive: true, force: true }); app.exit(process.exitCode || 0)
})
