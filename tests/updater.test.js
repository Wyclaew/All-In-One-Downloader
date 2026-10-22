'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const { Readable, Writable } = require('stream')
const { EventEmitter } = require('events')
const { root, electron, load } = require('./helpers.cjs')
electron.app.getVersion = () => '0.10.0'
electron.app.isPackaged = true
const store = load('electron/lib/store.js')
store.send = () => {}
const bytes = Buffer.from('release package fixture')
const digest = crypto.createHash('sha512').update(bytes).digest('base64')
const mac = process.platform === 'darwin'
const supported = mac || process.platform === 'win32'
const file = mac ? `all-in-one-downloader-0.13.0-${process.arch}-mac.zip` : 'all-in-one-downloader-0.13.0-setup.exe'
const manifestName = mac ? 'latest-mac.yml' : 'latest.yml'
const releaseUrl = 'https://github.com/Wyclaew/All-In-One-Downloader/releases/tag/v0.13.0'
const manifestUrl = `https://github.com/Wyclaew/All-In-One-Downloader/releases/download/v0.13.0/${manifestName}`
const packageUrl = `https://github.com/Wyclaew/All-In-One-Downloader/releases/download/v0.13.0/${file}`
let mode = '', failWrite = false, apiCount = 0, gate = null
const release = () => ({ tag_name: 'v0.13.0', html_url: releaseUrl, body: 'Resolver improvements', assets: [
  { name: manifestName, size: 500, browser_download_url: manifestUrl },
  { name: file, size: bytes.length, browser_download_url: packageUrl },
] })
const transport = { get(url, _opts, callback) {
  const req = new EventEmitter()
  req.destroy = (err) => { if (err) req.emit('error', err) }
  setImmediate(async () => {
    if (gate && url.includes(gate.part)) await gate.promise
    let status = 200, body
    if (url.endsWith('/releases/latest')) {
      apiCount++
      if (mode === 'offline') status = 503
      const data = release()
      if (mode === 'invalid-tag') data.tag_name = 'v0.13.0/garbage'
      body = JSON.stringify(data)
    } else if (url === manifestUrl) {
      body = `version: ${mode === 'wrong-version' ? '0.12.0' : '0.13.0'}\nfiles:\n  - url: ${file}\n    sha512: ${digest}\n    size: ${bytes.length}\n`
    } else if (url === packageUrl) body = Buffer.alloc(bytes.length, 0x78) // Wrong digest deliberately: never install a fixture.
    else { status = 404; body = '' }
    const res = Readable.from([Buffer.from(body)])
    res.statusCode = status; res.headers = {}
    callback(res)
  })
  return req
} }
const updater = load('electron/lib/updater.js', { https: transport, fs: { ...fs, createWriteStream(...args) {
  if (!failWrite) return fs.createWriteStream(...args)
  return new Writable({ write(_chunk, _encoding, next) { next(Object.assign(new Error('Disk full'), { code: 'ENOSPC' })) } })
} } })
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

test('update versions use numeric prerelease ordering and reject malformed tags', () => {
  assert.equal(updater.compareVersions('0.13.0', '0.12.99'), 1)
  assert.equal(updater.compareVersions('v1.0.0-beta.10', '1.0.0-beta.2'), 1)
  assert.equal(updater.compareVersions('1.0.0-beta', '1.0.0-beta.1'), -1)
  assert.equal(updater.compareVersions('1.0.0-1', '1.0.0-beta'), -1)
  assert.equal(updater.compareVersions('1.0.0+build.1', '1.0.0'), 0)
  for (const bad of ['1.0.0/garbage', '1.0.0-beta.01', '01.0.0', '999999999999999999999.0.0']) assert.equal(updater.compareVersions(bad, '0.10.0'), 0)
})
test('update target requires a safe filename and matching asset size/digest', () => {
  const pick = { url: file, sha512: digest, size: bytes.length }, asset = { size: bytes.length }
  assert.equal(updater.validTarget(pick, asset, '0.13.0'), true)
  assert.equal(updater.validTarget({ ...pick, url: '../package.zip' }, asset, '0.13.0'), false)
  assert.equal(updater.validTarget({ ...pick, sha512: 'invalid' }, asset, '0.13.0'), false)
  assert.equal(updater.validTarget(pick, { size: 1 }, '0.13.0'), false)
})
test('simultaneous update checks share one request and announce the newer release', async () => {
  let releaseGate
  gate = { part: '/releases/latest', promise: new Promise((r) => { releaseGate = r }) }
  const before = apiCount
  const a = updater.check(), b = updater.check({ manual: true })
  assert.equal(a, b)
  releaseGate(); gate = null
  const result = await a
  assert.equal(apiCount, before + 1)
  assert.equal(result.phase, 'available')
  assert.equal(result.latest, '0.13.0')
  assert.equal(result.automatic, supported)
})
test('a failed background poll preserves an already available release', async () => {
  mode = 'offline'
  const result = await updater.check()
  assert.equal(result.phase, 'available')
  assert.equal(result.latest, '0.13.0')
  mode = ''
})
test('a stale manifest never enables automatic installation of the wrong version', { skip: !supported }, async () => {
  mode = 'wrong-version'
  assert.equal((await updater.check()).automatic, false)
  mode = ''
})
test('SHA-512 mismatch removes the partial package and returns to available', { skip: !supported }, async () => {
  await updater.check()
  await assert.rejects(updater.install(), /SHA-512/)
  assert.equal(updater.getStatus().phase, 'available')
  assert.equal(fs.existsSync(path.join(root, 'updates')), false)
})
test('disk writer failure is handled without hanging or crashing the updater', { skip: !supported }, async () => {
  await updater.check(); failWrite = true
  try { await assert.rejects(updater.install(), { code: 'ENOSPC' }) } finally { failWrite = false }
  assert.equal(updater.getStatus().phase, 'available')
})
test('checking during an update cannot overwrite its downloading state', { skip: !supported }, async () => {
  await updater.check()
  let releaseGate
  gate = { part: file, promise: new Promise((r) => { releaseGate = r }) }
  const work = updater.install()
  assert.equal((await updater.check()).phase, 'downloading')
  releaseGate(); gate = null
  await assert.rejects(work, /SHA-512/)
})
