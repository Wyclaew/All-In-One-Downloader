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

let child = null
let status = { state: 'off', percent: 0, message: '', port: null, binary: null }
let starting = null

function publish(patch) {
  status = { ...status, ...patch }
  store.send('tor', status)
  return status
}

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
function findBinary() {
  const configured = String(store.getState().settings.torPath || '').trim()
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

/**
 * IsolateSOCKSAuth is what makes several connections worthwhile over Tor: each
 * distinct SOCKS username gets its own circuit, so the parts of a multi-part
 * download travel separately instead of queueing behind one another.
 */
function writeConfig(dir, port) {
  const file = path.join(dir, 'torrc')
  const lines = [
    `SocksPort 127.0.0.1:${port} IsolateSOCKSAuth KeepAliveIsolateSOCKSAuth`,
    `DataDirectory ${dir}`,
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

const RE_BOOTSTRAP = /Bootstrapped (\d+)%(?:\s*\(([^)]*)\))?/

function start() {
  if (status.state === 'on' && child) return Promise.resolve(status)
  if (starting) return starting

  starting = (async () => {
    const binary = findBinary()
    if (!binary) {
      publish({ state: 'error', percent: 0, message: `Tor bulunamadı. ${installHint()}`, binary: null })
      throw new Error(status.message)
    }

    const port = await pickPort()
    const dir = dataDir()
    const config = writeConfig(dir, port)

    publish({ state: 'starting', percent: 0, message: 'Başlatılıyor…', port, binary })

    return new Promise((resolve, reject) => {
      let settled = false
      const proc = spawn(binary, ['-f', config], { windowsHide: true })
      child = proc

      const fail = (message) => {
        if (settled) return
        settled = true
        // Kill the process directly rather than going through stop(): stop()
        // resets the status to "off" with an empty message, which would wipe the
        // reason we are about to show the user.
        killChild(proc)
        if (child === proc) child = null
        publish({ state: 'error', percent: 0, message })
        reject(new Error(message))
      }

      // Bootstrapping over a slow line is normal; never finishing is not.
      const timer = setTimeout(() => fail('Tor 90 saniyede bağlanamadı. Ağ engelli olabilir.'), 90000)

      const read = (chunk) => {
        const text = String(chunk)
        const match = RE_BOOTSTRAP.exec(text)
        if (match) {
          const percent = Number(match[1])
          publish({ percent, message: match[2] || `%${percent}` })
          if (percent >= 100 && !settled) {
            settled = true
            clearTimeout(timer)
            publish({ state: 'on', percent: 100, message: 'Bağlandı' })
            store.commit((s) => {
              s.settings.proxyUrl = `socks5://127.0.0.1:${port}`
              s.settings.torAutoStart = true
            })
            store.toast(`Tor hazır — vekil adresi socks5://127.0.0.1:${port} olarak ayarlandı.`, 'ok')
            resolve(status)
          }
        }
        if (/Could not bind|Address already in use/i.test(text)) fail('Port kullanımda. Tekrar dene.')
      }

      proc.stdout.on('data', read)
      proc.stderr.on('data', read)
      proc.on('error', (err) => {
        clearTimeout(timer)
        fail(`Tor başlatılamadı: ${err.message}`)
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (child === proc) child = null
        if (!settled) return fail(`Tor beklenmedik şekilde kapandı (${code}).`)
        // A tor that dies later still has to stop claiming it is connected.
        if (status.state === 'on') publish({ state: 'off', percent: 0, message: 'Kapandı' })
      })
    })
  })()

  return starting.finally(() => {
    starting = null
  })
}

function killChild(proc) {
  if (!proc) return
  try {
    proc.kill('SIGTERM')
    // Tor closes its circuits on the way out; if it takes too long, insist.
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, 3000)
    if (timer.unref) timer.unref()
  } catch {
    /* already gone */
  }
}

function stop() {
  const proc = child
  child = null
  killChild(proc)
  if (status.state !== 'off') publish({ state: 'off', percent: 0, message: '' })
  return status
}

/** Turning it off is a decision, so it survives a restart just as turning it on does. */
function stopAndForget() {
  store.commit((s) => {
    s.settings.torAutoStart = false
  })
  return stop()
}

function restoreIfWanted() {
  if (!store.getState().settings.torAutoStart) return
  start().catch((err) => console.error('[tor]', err.message))
}

function getStatus() {
  return { ...status, available: !!findBinary(), hint: installHint() }
}

module.exports = { start, stop, stopAndForget, restoreIfWanted, getStatus, findBinary }
