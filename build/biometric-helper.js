'use strict'

const { execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')

function buildHelper(output, arch = process.arch) {
  fs.mkdirSync(path.dirname(output), { recursive: true })
  execFileSync('/usr/bin/swiftc', [
    '-O', '-target', `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos11.0`,
    path.join(__dirname, '..', 'electron', 'native', 'vault-keychain.swift'),
    '-o', output,
  ], { stdio: 'pipe', timeout: 120000 })
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', output], { stdio: 'pipe' })
  return output
}

module.exports = { buildHelper }
if (require.main === module && process.platform === 'darwin') buildHelper(path.join(__dirname, '.native', process.arch, 'vault-keychain'))
