'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('fs'), path = require('path')
const { root, load } = require('./helpers.cjs')
const directory = path.join(root, 'synthetic-bin')
let calls = 0
const previousPath = process.env.PATH
process.env.PATH = directory
const binaries = load('electron/lib/binaries.js', {
  fs: { constants: fs.constants, statSync: (file) => { if (path.dirname(file) !== directory) throw new Error('missing'); return { isFile: () => true } }, accessSync() {} },
  child_process: { execFile: (bin, _args, _options, callback) => { calls++; setImmediate(() => callback(bin.includes('ffmpeg') ? new Error('bad architecture') : null, bin.includes('ffprobe') ? 'ffprobe version 8.0' : '2026.1', '')) } },
})
test('health checks distinguish present-but-broken binaries and share concurrent scans', async () => {
  try {
    const [a, b] = await Promise.all([binaries.detectTools({ force: true }), binaries.detectTools({ force: true })])
    assert.equal(a, b); assert.equal(calls, 3)
    assert.equal(a.ytdlp.runnable, true); assert.equal(a.ffprobe.runnable, true)
    assert.equal(a.ffmpeg.runnable, false); assert.match(a.ffmpeg.error, /çalıştırılamadı/)
    assert.equal(binaries.ffmpegPath(), null)
    assert.ok(binaries.ffprobePath())
  } finally { process.env.PATH = previousPath }
})
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

test('child tools never inherit implicit proxy routes or bypass lists from the launcher', () => {
  const keys = ['http_proxy', 'HTTPS_PROXY', 'ALL_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY']
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  try {
    for (const key of keys) process.env[key] = key === 'NODE_USE_ENV_PROXY' ? '1' : 'fixture-proxy'
    const env = binaries.toolEnv()
    for (const key of keys) assert.equal(env[key], undefined, key)
    for (const entry of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) assert.ok(env.PATH.split(path.delimiter).includes(entry))
  } finally {
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]
  }
})
