'use strict'
// Draft releases stay hidden until all platform packages and update metadata
// are uploaded and refer to the same version. No app data or credentials read.
const { execFileSync } = require('child_process')
const { parseManifest, validTarget } = require('../electron/lib/update-metadata')
const pkg = require('../package.json')
const repo = process.env.GITHUB_REPOSITORY || 'Wyclaew/All-In-One-Downloader'
const tag = process.argv[2] || process.env.GITHUB_REF_NAME
if (tag !== `v${pkg.version}`) throw new Error(`Tag/version mismatch: ${tag} vs v${pkg.version}`)
const api = (endpoint, extra = []) => execFileSync('gh', ['api', endpoint, ...extra], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
const release = JSON.parse(api(`repos/${repo}/releases/tags/${tag}`))
if (release.prerelease) throw new Error('Expected a stable release')
const assets = release.assets || []
const names = [
  ...['arm64', 'x64'].map((arch) => `${pkg.name}-${pkg.version}-${arch}-mac.zip`),
  ...['arm64', 'x64'].map((arch) => `${pkg.productName.replace(/ /g, '-')}-${pkg.version}-${arch}.dmg`),
  `${pkg.productName.replace(/ /g, '-')}-${pkg.version}-setup.exe`, 'latest-mac.yml', 'latest.yml',
]
for (const name of names) {
  const asset = assets.find((a) => a.name === name)
  if (!asset || asset.state !== 'uploaded' || !(asset.size > 0)) throw new Error(`Missing/incomplete asset: ${name}`)
}
for (const name of ['latest-mac.yml', 'latest.yml']) {
  const asset = assets.find((a) => a.name === name)
  const manifest = parseManifest(api(asset.url, ['-H', 'Accept: application/octet-stream']))
  if (manifest.version !== pkg.version) throw new Error(`Wrong update manifest version in ${name}`)
  const required = name === 'latest-mac.yml' ? names.filter((n) => n.endsWith('-mac.zip')) : names.filter((n) => n.endsWith('.exe'))
  for (const file of required) {
    const pick = manifest.files.find((f) => f.url === file)
    if (!validTarget(pick, assets.find((a) => a.name === file), manifest.version)) throw new Error(`Invalid update entry: ${file}`)
  }
}
console.log(`Verified ${tag}: ${names.length} required assets and both update manifests`)
