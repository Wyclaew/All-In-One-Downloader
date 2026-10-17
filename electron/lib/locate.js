'use strict'

// Finding a download's file when the recorded path no longer points at it.
//
// Exact string comparison was the bug behind both "the vault cannot find a file
// that is plainly in the folder" and "the folder button does nothing". Three
// things make two names for the same file differ:
//
//   normalisation  macOS hands paths from its file dialogs back decomposed
//                  ("C" + combining cedilla) while we stored the composed "Ç".
//                  They look identical and compare unequal.
//   sanitising     yt-dlp writes "Show ｜ Bölüm 2" for a title "Show | Bölüm 2",
//                  replacing characters a filename cannot hold with full-width
//                  look-alikes; our own safeName replaces them differently.
//   truncation     the filename template cuts long titles at 120 bytes.
//
// So names are compared by a key that survives all three: NFKC (which folds the
// full-width forms back), lower-cased, with everything that is not a letter or a
// digit removed.

const fs = require('fs')
const path = require('path')

const MEDIA_EXT = new Set([
  '.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.ts', '.flv',
  '.mp3', '.m4a', '.opus', '.ogg', '.oga', '.wav', '.flac', '.aac',
])

function nameKey(name) {
  return String(name || '')
    .normalize('NFKC')
    .toLocaleLowerCase('tr')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

function stemOf(name) {
  return path.basename(name, path.extname(name))
}

/** Same file, written two ways. */
function samePath(a, b) {
  if (!a || !b) return false
  return path.resolve(a).normalize('NFC') === path.resolve(b).normalize('NFC')
}

function isMedia(name) {
  return MEDIA_EXT.has(path.extname(name).toLowerCase())
}

/**
 * The file in `dir` that best matches any of `wanted` names.
 *
 * An exact key match wins. A prefix match is accepted only when the shorter key is
 * long enough to mean something — "Dune" must not claim "Dune 2", but a title
 * the template truncated at 120 bytes should still find its file.
 */
function findIn(dir, wanted) {
  let names = []
  try {
    names = fs.readdirSync(dir).filter(isMedia)
  } catch {
    return null
  }
  const candidates = names.map((n) => ({ name: n, key: nameKey(stemOf(n)) }))

  for (const want of wanted) {
    const key = nameKey(stemOf(want))
    if (!key) continue
    const exact = candidates.find((c) => c.key === key)
    if (exact) return path.join(dir, exact.name)
  }
  for (const want of wanted) {
    const key = nameKey(stemOf(want))
    if (key.length < 24) continue
    const prefix = candidates.filter(
      (c) => c.key.length >= 24 && (c.key.startsWith(key) || key.startsWith(c.key))
    )
    // Two files sharing a long prefix (episode 1 and episode 2 of a truncated
    // title) is ambiguous; guessing would hand the user the wrong episode.
    if (prefix.length === 1) return path.join(dir, prefix[0].name)
  }
  return null
}

/**
 * Where a download's file actually is, or null.
 *
 * Looks where it was recorded, then in that folder and the current download
 * folder by recorded name and by title.
 */
function locateDownload(download, downloadDir) {
  if (!download) return null
  const recorded = download.filePath
  if (recorded) {
    if (fs.existsSync(recorded)) return recorded
    const nfc = recorded.normalize('NFC')
    if (nfc !== recorded && fs.existsSync(nfc)) return nfc
    const nfd = recorded.normalize('NFD')
    if (nfd !== recorded && fs.existsSync(nfd)) return nfd
  }

  const wanted = []
  if (recorded) wanted.push(path.basename(recorded))
  if (download.title) wanted.push(`${download.title}.x`)

  const dirs = []
  if (recorded) dirs.push(path.dirname(recorded))
  if (downloadDir) dirs.push(downloadDir)
  for (const dir of [...new Set(dirs)]) {
    const found = findIn(dir, wanted)
    if (found) return found
  }
  return null
}

module.exports = { nameKey, samePath, findIn, locateDownload, isMedia, MEDIA_EXT }
