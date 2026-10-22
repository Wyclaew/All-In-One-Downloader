'use strict'

// electron-builder skips macOS signing outright when `mac.identity` is null: the
// bundle ships with no signature at all. That is worse than it sounds, because an
// arm64 binary without a signature is refused by the kernel before Gatekeeper is
// even consulted — the user gets "the app is damaged" and no way past it.
//
// An ad-hoc signature is not a certificate. It does not silence the notarisation
// warning ("Apple could not verify..."), and nothing short of a paid Developer ID
// plus notarisation will. What it does do is make the bundle valid, self-consistent
// code, so the user's first-open override actually opens the app, and so one build
// runs on both Apple Silicon and Intel.
//
// A real Developer ID signature is applied by electron-builder *after* this hook,
// so when signing is configured this hook stands aside.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const run = (command, args) => execFileSync(command, args, { stdio: 'pipe', encoding: 'utf8' })

const failureText = (error) => {
  const stderr = error && error.stderr ? String(error.stderr).trim() : ''
  return stderr || (error && error.message) || 'unknown error'
}

// codesign --deep descends into the standard nested-code locations (Frameworks,
// Helpers, PlugIns) but not into Resources. Helper binaries dropped into
// resources/bin therefore have to be signed on their own, before the bundle seal
// is computed over them.
const shippedBinaries = (appPath) => {
  const binDir = path.join(appPath, 'Contents', 'Resources', 'bin')
  if (!fs.existsSync(binDir)) return []
  const found = []
  for (const entry of fs.readdirSync(binDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath || entry.path || binDir, entry.name)
    if (fs.statSync(file).mode & 0o111) found.push(file)
  }
  return found
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  // codesign exists only on macOS; a mac build produced elsewhere stays unsigned.
  if (process.platform !== 'darwin') return

  const mac = context.packager.platformSpecificBuildOptions || {}
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (!fs.existsSync(appPath)) return
  require('./biometric-helper').buildHelper(
    path.join(appPath, 'Contents', 'Resources', 'bin', 'vault-keychain'),
    context.arch === 1 ? 'x64' : 'arm64'
  )
  if (mac.identity || process.env.CSC_LINK || process.env.CSC_NAME) return

  // Extended attributes picked up from the checkout make codesign fail with
  // "resource fork, Finder information, or similar detritus not allowed".
  try {
    run('xattr', ['-cr', appPath])
  } catch (error) {
    console.log(`  • could not clear extended attributes: ${failureText(error)}`)
  }

  for (const binary of shippedBinaries(appPath)) {
    try {
      run('codesign', ['--force', '--sign', '-', binary])
    } catch (error) {
      console.log(`  • could not ad-hoc sign ${path.basename(binary)}: ${failureText(error)}`)
    }
  }

  try {
    run('codesign', ['--force', '--deep', '--sign', '-', appPath])
    run('codesign', ['--verify', '--deep', '--strict', appPath])
  } catch (error) {
    // Publishing a bundle that cannot be signed means publishing one that will not
    // launch on Apple Silicon at all. Fail the build instead.
    throw new Error(`ad-hoc signing failed for ${appPath}: ${failureText(error)}`)
  }

  console.log(`  • ad-hoc signed ${path.basename(appPath)} (${path.basename(context.appOutDir)})`)
}
