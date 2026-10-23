'use strict'
// Read-only public release check using the real updater and an isolated profile.
// No token, package download, install, or user's application state is used.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { root, electron, load } = require('../helpers.cjs')
const current = process.argv[2] || '0.13.0'
const expected = process.argv[3] || require('../../package.json').version
electron.app.getVersion = () => current
electron.app.isPackaged = true
const updater = load('electron/lib/updater.js')
;(async () => {
  try {
    const result = await updater.check({ manual: true })
    assert.equal(result.phase, 'available', result.message)
    assert.equal(result.latest, expected)
    assert.equal(result.automatic, true)
    console.log(JSON.stringify({ ok: true, current, latest: result.latest, phase: result.phase, automatic: result.automatic }))
  } catch (err) { console.error(err); process.exitCode = 1 }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
})()
