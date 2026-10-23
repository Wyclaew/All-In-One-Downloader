'use strict'

// Opt-in integration smoke: electron tests/manual/tor-smoke.js
// Only Tor Project's small check API is contacted. No media, credentials or exit
// addresses are printed. This profile and the daemon it starts belong to this
// test; an existing Tor service / Tor Browser is never stopped or reconfigured.
const { app, session } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-tor-smoke-'))
const downloads = path.join(profile, 'downloads')
const sessionsPath = path.join(profile, 'sessions')
fs.mkdirSync(downloads)
fs.mkdirSync(sessionsPath)
app.setName('All in One Downloader Tor smoke')
app.setPath('userData', profile)
app.setPath('sessionData', sessionsPath)
app.setPath('downloads', downloads)
app.on('window-all-closed', () => {})
// Existing state prevents the production store's legacy migration from looking
// for another application's library. Every writable path is inside this profile.
fs.writeFileSync(path.join(profile, 'library.json'), JSON.stringify({
  version: 1, sources: [], items: [], downloads: [], categories: [],
  settings: { downloadDir: downloads, settingsRev: 3, cookiesBrowser: '',
    proxyUrl: 'socks5://127.0.0.1:9061', autoStartTor: true, isolateTorSources: true,
    torAutoStart: false, autoCheckUpdates: false, autoDetectClipboard: false },
}))

const controller = new AbortController()
const started = Date.now()
const sessions = []
let store, tor, network, child, phase = 'startup', launches = 0
let originalConnect, proxy
const identities = new Map()
const checkUrl = 'https://check.torproject.org/api/ip'
let timeout
const deadline = new Promise((_resolve, reject) => {
  timeout = setTimeout(() => {
    controller.abort()
    reject(new Error('Tor integration smoke exceeded its 110-second budget.'))
  }, 110000)
})

function recordIdentity(upstream, host, port, options) {
  // Only a one-way digest exists in the test observations. The app's actual
  // credentials remain private, and observations are never written to disk.
  if (upstream.username && upstream.password) {
    const identity = crypto.createHash('sha256').update(upstream.username)
      .update('\0').update(upstream.password).digest('hex')
    if (!identities.has(phase)) identities.set(phase, new Set())
    identities.get(phase).add(identity)
  }
  return originalConnect(upstream, host, port, options)
}

async function scenario() {
  await app.whenReady()
  if (controller.signal.aborted) throw new Error('Smoke canceled before Electron was ready.')
  store = require('../../electron/lib/store')
  store.init()
  const { createTorManager, findBinary } = require('../../electron/lib/tor')
  if (!findBinary()) return { ok: true, skipped: true, reason: 'tor-unavailable' }
  tor = createTorManager({
    stateStore: store,
    launch(...args) { launches += 1; child = spawn(...args); return child },
  })
  proxy = require('../../electron/lib/proxy')
  originalConnect = proxy.socks5Connect
  proxy.socks5Connect = recordIdentity
  // Load after installing the observation hook: the source bridge captures its
  // SOCKS connector when the module is loaded.
  const { createNetworkContextManager } = require('../../electron/lib/network-context')
  network = createNetworkContextManager({ torManager: tor })
  const settings = store.getState().settings
  const [a, b] = await Promise.all(['source-a', 'source-b'].map((id) =>
    network.ensureForSource(id, { settings, signal: controller.signal })))
  assert.equal(tor.getStatus().state, 'on')
  assert.equal(launches, 1, 'two sources must share one managed Tor daemon')
  assert.equal(settings.torAutoStart, false, 'on-demand bootstrap must not change remembered startup preferences')
  assert.notEqual(a, b, 'simultaneous sources need different local bridges')
  assert.equal(network.getContext('source-a').isolated, true)
  assert.equal(network.getContext('source-b').isolated, true)
  const config = fs.readFileSync(path.join(profile, 'tor', 'torrc'), 'utf8')
  assert.match(config, /IsolateSOCKSAuth/, 'the real daemon must enforce SOCKS identity isolation')

  phase = 'node'
  const nodeResults = await Promise.all([a, b].map(async (bridge) => {
    const response = await proxy.fetchVia(checkUrl, {
      proxy: bridge, signal: controller.signal, retries: 0, timeoutMs: 18000,
      maxBytes: 64 * 1024, headers: { 'User-Agent': 'AIO-Tor-Integration-Smoke' },
    })
    assert.equal(response.status, 200)
    return JSON.parse(response.text).IsTor === true
  }))
  assert.ok(nodeResults.every(Boolean), 'Node requests must exit through Tor')
  assert.equal(identities.get('node')?.size, 2, 'two sources must authenticate with different Tor identities')

  phase = 'chromium'
  const chromiumResults = await Promise.all([a, b].map(async (bridge, index) => {
    const ses = session.fromPartition(`tor-smoke-${index}`, { cache: false })
    sessions.push(ses)
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: proxy.electronRules(bridge), proxyBypassRules: '<-loopback>' })
    if (controller.signal.aborted) throw new Error('Smoke canceled before Chromium check.')
    const route = await ses.resolveProxy(checkUrl)
    assert.ok(route.includes(new URL(bridge).port), 'Chromium must select the same source bridge as Node')
    const response = await ses.fetch(checkUrl, { cache: 'no-store', credentials: 'omit', signal: controller.signal })
    assert.equal(response.status, 200)
    return (await response.json()).IsTor === true
  }))
  assert.ok(chromiumResults.every(Boolean), 'Chromium requests must exit through Tor')
  const nodeIdentities = identities.get('node')
  const chromiumIdentities = identities.get('chromium')
  assert.equal(chromiumIdentities?.size, 2, 'Chromium must preserve both source identities')
  assert.ok([...chromiumIdentities].every((value) => nodeIdentities.has(value)), 'Node and Chromium must use the same source identities')
  return { ok: true, torActive: true, simultaneousSources: 2, identitiesIsolated: true,
    nodeThroughTor: true, chromiumThroughTor: true, sharedSourceIdentities: true }
}

async function cleanup() {
  controller.abort()
  await Promise.allSettled(sessions.map(async (ses) => {
    await ses.closeAllConnections()
    await ses.clearCache()
    await ses.clearStorageData()
  }))
  network?.shutdown()
  const stopped = child && child.exitCode == null && child.signalCode == null
    ? new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} resolve() }, 4500)
      child.once('close', () => { clearTimeout(timer); resolve() })
    }) : Promise.resolve()
  tor?.stop()
  await stopped
  assert.ok(!child || child.exitCode != null || child.signalCode != null, 'the smoke-owned Tor daemon did not exit')
  if (proxy && originalConnect) proxy.socks5Connect = originalConnect
  store?.flush()
  fs.rmSync(profile, { recursive: true, force: true })
}

;(async () => {
  let result, code = 0
  try { result = await Promise.race([scenario(), deadline]) }
  catch (error) {
    code = 1
    // Error messages cannot include the API response, which contains an IP.
    result = { ok: false, error: String(error.message).replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[address]') }
  } finally {
    clearTimeout(timeout)
    try { await cleanup() } catch { code = 1; result = { ok: false, error: 'Smoke cleanup failed.' } }
    console.log(JSON.stringify({ ...result, elapsedMs: Date.now() - started }))
    app.exit(code)
  }
})()
