'use strict'

// Tor, without a terminal.
//
// Running `tor` in a shell and leaving the window open works, but it means the
// anonymity of a download depends on a terminal the user must not close — and on
// remembering to close it afterwards. So the app starts its own tor, on its own
// port, with its own data directory, watches it bootstrap, and takes it down when
// the app quits. Nothing is installed and nothing global is touched: if there is
// no tor binary on the machine we say so and say where to get one, rather than
// pretending to have one.
//
// The port deliberately avoids 9050 (a system tor) and 9150 (Tor Browser), so a
// tor the user already runs keeps working beside this one.

const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { app } = require('electron')
const store = require('./store')
const { locate, IS_WIN } = require('./binaries')

const PORT_CANDIDATES = [9061, 9062, 9063, 9064, 9065]

/* -------------------------------------------------------------------------- */
/* finding a binary                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Tor Browser ships the same daemon the package managers do, and someone who has
 * been using Tor Browser already has it — so it counts as installed. The browser
 * does not need to be running for its copy to work.
 */
function bundledPaths() {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return [
      '/Applications/Tor Browser.app/Contents/MacOS/Tor/tor',
      path.join(home, 'Applications/Tor Browser.app/Contents/MacOS/Tor/tor'),
      '/opt/homebrew/bin/tor',
      '/usr/local/bin/tor',
    ]
  }
  if (IS_WIN) {
    const bases = [
      process.env['PROGRAMFILES'] || 'C:\\Program Files',
      process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
      process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
      path.join(home, 'Desktop'),
    ]
    return bases.map((base) => path.join(base, 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor.exe'))
  }
  return [
    '/usr/bin/tor',
    '/usr/local/bin/tor',
    path.join(home, '.local/share/torbrowser/tbb/x86_64/tor-browser/Browser/TorBrowser/Tor/tor'),
  ]
}

/** The tor we would run, or null. Settings win, then PATH, then Tor Browser. */
function findBinary(settings = store.getState().settings) {
  const configured = String(settings.torPath || '').trim()
  if (configured && fs.existsSync(configured)) return configured

  const onPath = locate(IS_WIN ? 'tor.exe' : 'tor')
  if (onPath) return onPath

  for (const candidate of bundledPaths()) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* unreadable path */
    }
  }
  return null
}

function installHint() {
  if (process.platform === 'darwin') return 'brew install tor — ya da Tor Browser kur, onunkini kullanırız.'
  if (IS_WIN) return 'Tor Browser kur (torproject.org); içindeki tor.exe yeterli.'
  return 'sudo apt install tor — ya da Tor Browser kur, onunkini kullanırız.'
}

/* -------------------------------------------------------------------------- */
/* ports and configuration                                                     */
/* -------------------------------------------------------------------------- */

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

async function pickPort() {
  for (const port of PORT_CANDIDATES) {
    if (await portFree(port)) return port
  }
  throw new Error('Boş bir yerel port bulunamadı.')
}

function dataDir() {
  const dir = path.join(app.getPath('userData'), 'tor')
  // Tor refuses to start if anyone else can read its data directory.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    /* Windows has no mode to set */
  }
  return dir
}

/** Each source bridge authenticates with its own random SOCKS identity. */
function writeConfig(dir, port) {
  const file = path.join(dir, 'torrc')
  const lines = [
    `SocksPort 127.0.0.1:${port} IsolateSOCKSAuth KeepAliveIsolateSOCKSAuth`,
    `DataDirectory ${JSON.stringify(dir)}`,
    'ClientOnly 1',
    'AvoidDiskWrites 1',
    'Log notice stdout',
  ]
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
  return file
}

/* -------------------------------------------------------------------------- */
/* running                                                                     */
/* -------------------------------------------------------------------------- */

/** A manager factory keeps lifecycle tests entirely away from the real daemon. */
function createTorManager({
  find = findBinary, freePort = pickPort, directory = dataDir, configure = writeConfig,
  launch = spawn, stateStore = store, bootstrapTimeoutMs = 90000,
  terminateTimeoutMs = 3000,
} = {}) {
  let child = null
  let attempt = null
  let retiring = null
  let status = { state: 'off', percent: 0, message: '', port: null, binary: null }
  const listeners = new Set()
  const aborted = () => Object.assign(new Error('Tor bağlantısı iptal edildi.'), { code: 'ABORTED' })
  function publish(patch) {
    status = { ...status, ...patch }
    stateStore.send('tor', status)
    for (const listener of listeners) {
      try { listener({ ...status }) } catch { /* progress must not break startup */ }
    }
    return { ...status }
  }
  function retire(proc) {
    if (!proc || proc.exitCode != null || proc.signalCode != null) return Promise.resolve()
    if (retiring?.proc === proc) return retiring.promise
    const entry = { proc, promise: null }
    entry.promise = new Promise((resolve, reject) => {
      let forceTimer, limitTimer
      const done = () => {
        clearTimeout(forceTimer); clearTimeout(limitTimer)
        if (retiring === entry) retiring = null
        resolve()
      }
      proc.once('close', done)
      forceTimer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* already exited */ }
        limitTimer = setTimeout(() => {
          proc.removeListener('close', done)
          // Keep this rejected retirement: starting another daemon over the same
          // data directory while the previous process is alive is unsafe.
          reject(new Error('Önceki Tor işlemi kapanmadı. Uygulamayı yeniden başlat.'))
        }, 1000)
        limitTimer.unref?.()
      }, terminateTimeoutMs)
      forceTimer.unref?.()
      try { proc.kill('SIGTERM') } catch { done() }
    })
    retiring = entry
    entry.promise.catch(() => {})
    return entry.promise
  }
  function settle(current, error) {
    if (current.settled) return
    current.settled = true
    clearTimeout(current.timer)
    if (attempt === current) attempt = null
    if (error) {
      if (child === current.proc) child = null
      if (current.proc) retire(current.proc)
      current.reject(error)
    } else current.resolve({ ...status })
  }
  function launchAttempt(settings) {
    const current = { proc: null, settled: false, waiters: 0, timer: null }
    current.promise = new Promise((resolve, reject) => { current.resolve = resolve; current.reject = reject })
    // A stop may happen before a caller has attached its own waiter.
    current.promise.catch(() => {})
    attempt = current
    publish({ state: 'starting', percent: 0, message: 'Başlatılıyor…', port: null })
    ;(async () => {
      if (retiring) await retiring.promise
      if (current.settled) return
      const binary = find(settings)
      if (!binary) throw new Error(`Tor bulunamadı. ${installHint()}`)
      const port = await freePort()
      if (current.settled) return
      const config = configure(directory(), port)
      const proc = launch(binary, ['-f', config], { windowsHide: true })
      current.proc = proc
      child = proc
      publish({ port, binary })
      current.timer = setTimeout(() => {
        if (current.settled) return
        const error = new Error('Tor 90 saniyede bağlanamadı. Ağ engelli olabilir.')
        publish({ state: 'error', percent: 0, message: error.message })
        settle(current, error)
      }, bootstrapTimeoutMs)
      let buffer = ''
      const read = (chunk) => {
        if (current.settled && child !== proc) return
        buffer = (buffer + String(chunk)).slice(-8192)
        if (/Could not bind|Address already in use/i.test(buffer) && !current.settled) {
          const error = new Error('Tor portu kullanımda. Tekrar dene.')
          publish({ state: 'error', percent: 0, message: error.message })
          settle(current, error)
          return
        }
        const matches = [...buffer.matchAll(/Bootstrapped (\d+)%(?:\s*\(([^)]*)\))?/g)]
        const match = matches[matches.length - 1]
        if (match && !current.settled) {
          const percent = Math.min(100, Number(match[1]))
          publish({ percent, message: match[2] || `%${percent}` })
          if (percent >= 100) {
            publish({ state: 'on', percent: 100, message: 'Bağlandı' })
            settle(current)
          }
        }
      }
      proc.stdout?.on('data', read)
      proc.stderr?.on('data', read)
      proc.on('error', (error) => {
        if (current.settled || child !== proc) return
        const failure = new Error(`Tor başlatılamadı: ${error.message}`)
        publish({ state: 'error', percent: 0, message: failure.message })
        settle(current, failure)
      })
      proc.on('close', (code) => {
        if (child !== proc) return
        child = null
        const error = new Error(`Tor beklenmedik şekilde kapandı (${code}).`)
        publish({ state: 'error', percent: 0, message: error.message })
        if (!current.settled) settle(current, error)
      })
    })().catch((error) => {
      if (current.settled) return
      publish({ state: 'error', percent: 0, message: error.message })
      settle(current, error)
    })
    return current
  }
  function ensureStarted({ settings = stateStore.getState().settings, signal, onProgress } = {}) {
    if (signal?.aborted) return Promise.reject(aborted())
    if (status.state === 'on' && child) {
      try { onProgress?.({ ...status }) } catch {}
      return Promise.resolve({ ...status })
    }
    const current = attempt || launchAttempt(settings)
    current.waiters += 1
    return new Promise((resolve, reject) => {
      let finished = false
      const done = (error, value) => {
        if (finished) return
        finished = true
        signal?.removeEventListener('abort', cancel)
        if (onProgress) listeners.delete(onProgress)
        current.waiters -= 1
        error ? reject(error) : resolve(value)
      }
      const cancel = () => {
        done(aborted())
        if (!current.settled && !current.waiters) {
          settle(current, aborted())
          publish({ state: 'off', percent: 0, message: '', port: null })
        }
      }
      if (onProgress) {
        listeners.add(onProgress)
        try { onProgress({ ...status }) } catch {}
      }
      signal?.addEventListener('abort', cancel, { once: true })
      current.promise.then((value) => done(null, value), (error) => done(error))
      if (signal?.aborted) cancel()
    })
  }
  async function start(options = {}) {
    const ready = await ensureStarted(options)
    stateStore.commit((state) => {
      state.settings.torAutoStart = true
      const selected = String(state.settings.proxyUrl || '').trim()
      if (!selected || /^socks5h?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):906[1-5]\/?$/i.test(selected)) {
        state.settings.proxyUrl = `socks5://127.0.0.1:${ready.port}`
      }
    })
    return ready
  }
  function stop() {
    const current = attempt
    if (current) settle(current, aborted())
    const proc = child
    child = null
    if (proc) retire(proc)
    return publish({ state: 'off', percent: 0, message: '', port: null })
  }
  function stopAndForget() {
    stateStore.commit((state) => { state.settings.torAutoStart = false })
    return stop()
  }
  function restoreIfWanted() {
    if (stateStore.getState().settings.torAutoStart) {
      ensureStarted().catch((error) => console.error('[tor]', error.message))
    }
  }
  function getStatus() { return { ...status, available: !!find(stateStore.getState().settings), hint: installHint() } }
  return { start, ensureStarted, stop, stopAndForget, restoreIfWanted, getStatus }
}

module.exports = { ...createTorManager(), findBinary, createTorManager }
