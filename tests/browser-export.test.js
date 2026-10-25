'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const cp = require('node:child_process')

const HEADER = '# Netscape HTTP Cookie File\n'
const EXPORTED = HEADER + '# Synthetic test export\n\noffline.invalid\tFALSE\t/\tFALSE\t4102444800\tsynthetic\tfixture-only\n'
const source = fs.readFileSync(path.resolve(__dirname, '../electron/lib/browsers.js'), 'utf8')

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-browser-export-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const calls = []
  let now = 1000000
  const module = { exports: {} }
  const testFs = { ...fs, ...(options.fs || {}) }
  const execute = options.execFile || ((bin, args, config, callback) => calls.push({ bin, args, config, callback }))
  vm.runInNewContext(source, {
    module, exports: module.exports, Buffer,
    process: { platform: process.platform, env: { HOME: root, USERPROFILE: root, LOCALAPPDATA: path.join(root, 'local'), APPDATA: path.join(root, 'roaming') } },
    Date: class extends Date { static now() { return now } },
    require: (name) => {
      if (name === 'fs') return testFs
      if (name === 'os') return { tmpdir: () => root }
      if (name === 'child_process') return { execFile: execute }
      if (name === './binaries') return { toolEnv: () => options.env || {}, ytdlpPathOrThrow: () => { if (options.missingTool) throw new Error('missing'); return 'synthetic-yt-dlp' } }
      return require(name)
    },
  }, { filename: 'browsers.js' })
  const complete = (call, error = null, content = EXPORTED) => {
    if (content !== null) fs.writeFileSync(call.args[call.args.indexOf('--cookies') + 1], content)
    call.callback(error)
  }
  return { browsers: module.exports, root, calls, complete, advance: (ms) => { now += ms } }
}

function outputFile(call) { return call.args[call.args.indexOf('--cookies') + 1] }
function infoFile(call) { return call.args[call.args.indexOf('--load-info-json') + 1] }
function exportDirs(root) { return fs.readdirSync(root).filter((name) => name.startsWith('edl-browser-cookies-')) }

test('cookie export starts in a private unique directory and supplies only an empty local playlist', async (t) => {
  const { browsers, calls, complete } = fixture(t)
  const pending = browsers.exportCookieJar('firefox:/synthetic/profile')
  assert.equal(calls.length, 1)
  const call = calls[0]
  const file = outputFile(call)
  const info = infoFile(call)
  assert.equal(fs.readFileSync(file, 'utf8'), HEADER)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(fs.statSync(info).mode & 0o777, 0o600)
  }
  const playlist = JSON.parse(fs.readFileSync(info, 'utf8'))
  assert.equal(playlist._type, 'playlist')
  assert.deepEqual(playlist.entries, [])
  assert.equal('url' in playlist || 'webpage_url' in playlist, false)
  assert.ok(call.args.includes('--skip-download'))
  assert.ok(call.args.includes('--no-clean-info-json'))
  assert.ok(call.args.includes('--ignore-config'))
  assert.equal(call.args.some((arg) => /^https?:\/\//i.test(arg)), false)
  complete(call)
  assert.equal(await pending, file)
  assert.equal(fs.existsSync(info), false)
  assert.equal(fs.existsSync(file), true)
})

test('concurrent sources sharing the same resolved browser argument share one export', async (t) => {
  const { browsers, calls, complete, root } = fixture(t)
  const opera = process.platform === 'darwin'
    ? path.join(root, 'Library', 'Application Support', 'com.operasoftware.OperaGX')
    : process.platform === 'win32' ? path.join(root, 'roaming', 'Opera Software', 'Opera GX Stable')
      : path.join(root, '.config', 'opera-gx')
  fs.mkdirSync(opera, { recursive: true })
  fs.writeFileSync(path.join(opera, 'Cookies'), 'synthetic existence marker')
  const first = browsers.exportCookieJar('opera-gx')
  const second = browsers.exportCookieJar('opera:' + opera)
  assert.equal(first, second)
  assert.equal(calls.length, 1)
  complete(calls[0])
  const [a, b] = await Promise.all([first, second])
  assert.equal(a, b)
  assert.equal(await browsers.exportCookieJar('opera-gx'), a)
  assert.equal(calls.length, 1)
})

test('one cancelled cookie-export waiter leaves other sources and cached output intact', async (t) => {
  const { browsers, calls, complete } = fixture(t)
  const controller = new AbortController()
  const cancelled = browsers.exportCookieJar('firefox:/synthetic/profile', { signal: controller.signal })
  const surviving = browsers.exportCookieJar('firefox:/synthetic/profile')
  const rejected = assert.rejects(cancelled, { code: 'ABORTED' })
  controller.abort()
  await rejected
  assert.equal(calls.length, 1)
  complete(calls[0])
  assert.equal(await surviving, outputFile(calls[0]))
  assert.equal(await browsers.exportCookieJar('firefox:/synthetic/profile'), outputFile(calls[0]))
  const already = new AbortController(); already.abort()
  await assert.rejects(browsers.exportCookieJar('firefox:/synthetic/never', { signal: already.signal }), { code: 'ABORTED' })
  assert.equal(calls.length, 1)
})

test('different browsers never collide at the same clock time and cache separately', async (t) => {
  const { browsers, calls, complete } = fixture(t)
  const first = browsers.exportCookieJar('firefox:/synthetic/one')
  const second = browsers.exportCookieJar('firefox:/synthetic/two')
  assert.equal(calls.length, 2)
  assert.notEqual(outputFile(calls[0]), outputFile(calls[1]))
  complete(calls[0]); complete(calls[1])
  const [a, b] = await Promise.all([first, second])
  assert.equal(await browsers.exportCookieJar('firefox:/synthetic/one'), a)
  assert.equal(await browsers.exportCookieJar('firefox:/synthetic/two'), b)
  assert.equal(calls.length, 2)
})

test('refreshing an expired jar preserves the previously issued file for active transfers', async (t) => {
  const { browsers, calls, complete, advance } = fixture(t)
  const initial = browsers.exportCookieJar('firefox:/synthetic/profile')
  complete(calls[0]); const oldFile = await initial
  advance(5 * 60 * 1000 + 1)
  const replacement = browsers.exportCookieJar('firefox:/synthetic/profile')
  complete(calls[1]); const nextFile = await replacement
  assert.notEqual(oldFile, nextFile)
  assert.equal(fs.existsSync(oldFile), true)
  assert.equal(fs.readFileSync(oldFile, 'utf8'), EXPORTED)
  assert.equal(fs.existsSync(nextFile), true)
})

test('failed or untouched exports return null, remove their private output and can be retried', async (t) => {
  const { browsers, root, calls, complete } = fixture(t)
  const failed = browsers.exportCookieJar('firefox:/synthetic/profile')
  complete(calls[0], new Error('synthetic failure'))
  assert.equal(await failed, null)
  assert.deepEqual(exportDirs(root), [])
  const untouched = browsers.exportCookieJar('firefox:/synthetic/profile')
  complete(calls[1], null, null)
  assert.equal(await untouched, null)
  assert.deepEqual(exportDirs(root), [])
  const retry = browsers.exportCookieJar('firefox:/synthetic/profile')
  complete(calls[2])
  assert.equal(await retry, outputFile(calls[2]))
})

test('synchronous setup, tool and process errors remain null results with no leaked export directory', async (t) => {
  const missing = fixture(t, { missingTool: true })
  assert.equal(await missing.browsers.exportCookieJar('firefox:/synthetic/profile'), null)
  assert.deepEqual(exportDirs(missing.root), [])
  const spawn = fixture(t, { execFile: () => { throw new Error('synthetic process error') } })
  assert.equal(await spawn.browsers.exportCookieJar('firefox:/synthetic/profile'), null)
  assert.deepEqual(exportDirs(spawn.root), [])
  const writing = fixture(t, { fs: { writeFileSync: () => { throw new Error('synthetic disk error') } } })
  assert.equal(await writing.browsers.exportCookieJar('firefox:/synthetic/profile'), null)
  assert.deepEqual(exportDirs(writing.root), [])
})

test('file protection failures discard new cookies and cleanup errors never reject callers', async (t) => {
  const protect = fixture(t, { fs: { chmodSync: () => { throw new Error('synthetic permission error') } } })
  const pending = protect.browsers.exportCookieJar('firefox:/synthetic/profile')
  protect.complete(protect.calls[0])
  assert.equal(await pending, null)
  assert.deepEqual(exportDirs(protect.root), [])
  let attemptedCleanup = false
  const cleanup = fixture(t, { fs: { rmSync: () => { attemptedCleanup = true; throw new Error('synthetic cleanup error') } } })
  const failed = cleanup.browsers.exportCookieJar('firefox:/synthetic/profile')
  cleanup.complete(cleanup.calls[0], new Error('synthetic extraction error'))
  assert.equal(await failed, null)
  assert.equal(attemptedCleanup, true)
})

function executable(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const file = path.join(dir, name + (process.platform === 'win32' ? '.exe' : ''))
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file } catch {}
  }
  return null
}

test('real yt-dlp exports a synthetic Firefox profile from local info while sockets are forbidden', async (t) => {
  const bin = executable('yt-dlp')
  if (!bin) return t.skip('yt-dlp is not installed')
  const shebang = fs.readFileSync(bin, 'utf8').split('\n', 1)[0].match(/^#!(\S+)(?:\s+(\S+))?$/)
  if (!shebang || !/python/.test(shebang[1] + (shebang[2] || ''))) return t.skip('socket guard requires a Python-script yt-dlp installation')
  const python = shebang[1]
  const prefix = shebang[2] ? [shebang[2]] : []
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-cookie-offline-test-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const profile = path.join(base, 'synthetic-firefox')
  fs.mkdirSync(profile, { mode: 0o700 })
  const db = path.join(profile, 'cookies.sqlite')
  const create = cp.spawnSync(python, [...prefix, '-c',
    'import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.execute("CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER)")\nc.execute("INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?)", ("offline.invalid", "synthetic", "fixture-only", "/", 4102444800, 0))\nc.commit()\nc.close()', db], { encoding: 'utf8', timeout: 10000 })
  assert.equal(create.status, 0, create.stderr)
  const networkLog = path.join(base, 'network-attempts.txt')
  const guard = path.join(base, 'offline-guard.py')
  fs.writeFileSync(guard,
    'import socket,sys,runpy\n' +
    'def blocked(*args,**kwargs):\n' +
    '    with open(' + JSON.stringify(networkLog) + ',"a") as f: f.write("network attempt\\n")\n' +
    '    raise RuntimeError("network forbidden by synthetic cookie-export test")\n' +
    'socket.socket.connect=blocked\nsocket.socket.connect_ex=blocked\nsocket.create_connection=blocked\nsocket.getaddrinfo=blocked\n' +
    'target=sys.argv.pop(1)\nrunpy.run_path(target,run_name="__main__")\n', { mode: 0o600 })
  const env = { ...process.env, HOME: base, USERPROFILE: base }
  const offline = fixture(t, { env, execFile: (_bin, args, options, callback) => cp.execFile(python, [...prefix, guard, bin, ...args], options, callback) })
  const file = await offline.browsers.exportCookieJar('firefox:' + profile)
  assert.ok(file, 'empty local playlist must finish successfully and produce a jar')
  assert.match(fs.readFileSync(file, 'utf8'), /offline\.invalid\tFALSE\t\/\tFALSE\t4102444800\tsynthetic\tfixture-only/)
  assert.equal(fs.existsSync(networkLog), false, 'no network or DNS attempt is permitted')
})
