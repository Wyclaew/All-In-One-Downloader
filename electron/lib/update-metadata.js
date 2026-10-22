'use strict'
const path = require('path')

function parseVersion(v) {
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(String(v || '').trim())
  if (!m) return null
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (!parts.every(Number.isSafeInteger) || (m[4] || '').split('.').some((s) => /^0\d+$/.test(s))) return null
  return { parts, pre: m[4] || '' }
}

/** a > b ? 1 : a < b ? -1 : 0. A pre-release sorts below its release. */
function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i += 1) {
    if (x.parts[i] !== y.parts[i]) return x.parts[i] > y.parts[i] ? 1 : -1
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  const aIds = x.pre.split('.'), bIds = y.pre.split('.')
  for (let i = 0; i < Math.max(aIds.length, bIds.length); i += 1) {
    if (aIds[i] === undefined) return -1
    if (bIds[i] === undefined) return 1
    if (aIds[i] === bIds[i]) continue
    const an = /^\d+$/.test(aIds[i]), bn = /^\d+$/.test(bIds[i])
    if (an && bn) return BigInt(aIds[i]) > BigInt(bIds[i]) ? 1 : -1
    if (an !== bn) return an ? -1 : 1
    return aIds[i] > bIds[i] ? 1 : -1
  }
  return 0
}

/** The few fields we need from electron-builder's latest*.yml. */
function parseManifest(text) {
  const files = []
  const re = /-\s+url:\s*(\S+)\s*\n\s+sha512:\s*(\S+)\s*\n\s+size:\s*(\d+)/g
  let m
  while ((m = re.exec(text)) !== null) files.push({ url: m[1], sha512: m[2], size: Number(m[3]) })
  const version = (/^version:\s*(\S+)/m.exec(text) || [])[1] || ''
  return { version, files }
}

function validTarget(pick, asset, version) {
  return !!(pick && asset && parseVersion(version) && Number.isSafeInteger(pick.size) && pick.size > 0 &&
    asset.size === pick.size && /^[A-Za-z0-9+/]{86}==$/.test(pick.sha512) &&
    path.basename(pick.url) === pick.url && !/[\\/]/.test(pick.url))
}

module.exports = { parseVersion, compareVersions, parseManifest, validTarget }
