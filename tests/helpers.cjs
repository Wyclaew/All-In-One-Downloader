'use strict'
const Module = require('module')
const fs = require('fs')
const os = require('os')
const path = require('path')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-test-'))
const electron = {
  app: { getPath: () => root, getAppPath: () => path.resolve(__dirname, '..'), isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  systemPreferences: { canPromptTouchID: () => false },
  Notification: { isSupported: () => false },
  shell: {}, session: {},
}
function load(file, overrides = {}) {
  const original = Module._load
  Module._load = function(name, parent, isMain) {
    if (name === 'electron') return electron
    const replacement = overrides[name]
    return replacement !== undefined ? replacement : original.apply(this, arguments)
  }
  try { return require(path.resolve(__dirname, '..', file)) } finally { Module._load = original }
}
module.exports = { root, electron, load }
