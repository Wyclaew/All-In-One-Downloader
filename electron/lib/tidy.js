'use strict'

// Clearing out what earlier versions left in the download folder.
//
// Two kinds of clutter, both ours:
//
//   oynat.html     the first in-app player was a page written beside the video.
//                  The player no longer works that way, but every folder it was
//                  ever used in still has one.
//   .vtt / .srt    subtitle files kept beside the video — by yt-dlp, which keeps a
//                  copy of every subtitle it embeds when asked for them
//                  explicitly, and by our own subtitle steps.
//
// Nothing here deletes anything that is not provably redundant. A player page is
// only removed if it is one of ours. A subtitle file is only removed once the
// same language is inside the video; otherwise it is muxed in first, and if that
// fails it is moved into the app's own subtitle folder, where our player still
// finds it. No subtitle is ever simply thrown away.

const fs = require('fs')
const path = require('path')
const subtitles = require('./subtitles')
const { isMedia } = require('./locate')

const SUB_EXT = new Set(['.vtt', '.srt', '.ass', '.ssa'])

/** Our old player page, recognised by what only it contains. */
function isOurPlayerPage(file) {
  try {
    if (fs.statSync(file).size > 64 * 1024) return false
    const text = fs.readFileSync(file, 'utf8')
    return text.includes('window.aioPlayer') && text.includes('<video')
  } catch {
    return false
  }
}

/** `Film.tr.vtt` → { video: 'Film.mp4', lang: 'tr' } when Film.<media> exists. */
function ownerOf(name, mediaByStem) {
  const ext = path.extname(name)
  const rest = name.slice(0, -ext.length)
  // "Film.srt" with no language tag — and a title that has dots of its own
  // ("Mr. Robot.srt") must not be split at them.
  const whole = mediaByStem.get(rest)
  if (whole) return { video: whole, lang: 'und' }
  const dot = rest.lastIndexOf('.')
  if (dot <= 0) return null
  const stem = rest.slice(0, dot)
  const tag = rest.slice(dot + 1)
  const video = mediaByStem.get(stem)
  if (!video) return null
  const lang = tag.toLowerCase().split(/[-_]/)[0]
  return { video, lang: /^[a-z]{2,3}$/.test(lang) ? lang : 'und' }
}

/**
 * Tidy one folder. `busy` is a set of paths that must not be rewritten right now
 * (a transfer still writing, a file open in the player).
 */
async function tidyFolder(dir, { busy = new Set() } = {}) {
  const report = { pages: 0, embedded: 0, removed: 0, moved: 0 }
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return report
  }

  for (const name of names) {
    if (name.toLowerCase() !== 'oynat.html') continue
    const file = path.join(dir, name)
    if (isOurPlayerPage(file)) {
      fs.rmSync(file, { force: true })
      report.pages += 1
    }
  }

  const mediaByStem = new Map()
  for (const name of names) {
    if (isMedia(name)) mediaByStem.set(path.basename(name, path.extname(name)), name)
  }

  // Group the loose subtitles by the video they belong to, so each video is
  // rewritten at most once.
  const byVideo = new Map()
  for (const name of names) {
    if (!SUB_EXT.has(path.extname(name).toLowerCase())) continue
    const owner = ownerOf(name, mediaByStem)
    if (!owner) continue
    const video = path.join(dir, owner.video)
    if (!byVideo.has(video)) byVideo.set(video, [])
    byVideo.get(video).push({ path: path.join(dir, name), lang: owner.lang })
  }

  for (const [video, subs] of byVideo) {
    if (busy.has(video)) continue
    const ext = path.extname(video).toLowerCase()
    const audioOnly = ['.mp3', '.m4a', '.opus', '.ogg', '.oga', '.wav', '.flac', '.aac'].includes(ext)
    // ffmpeg will not read a code-page SRT; give it UTF-8 copies to work from.
    const prepared = []
    for (const sub of subs) {
      try {
        const text = subtitles.decodeText(fs.readFileSync(sub.path))
        const copy = path.join(subtitles.storeDirFor(video), `${sub.lang}${path.extname(sub.path)}`)
        fs.mkdirSync(path.dirname(copy), { recursive: true })
        fs.writeFileSync(copy, text, 'utf8')
        prepared.push({ original: sub.path, path: copy, lang: sub.lang })
      } catch {
        /* unreadable; leave it where it is */
      }
    }
    if (!prepared.length) continue

    const result = audioOnly ? { ok: false } : await subtitles.embedMany(video, prepared)
    for (const sub of prepared) {
      fs.rmSync(sub.original, { force: true })
      if (result.ok) {
        fs.rmSync(sub.path, { force: true })
        report[result.already ? 'removed' : 'embedded'] += 1
      } else {
        // Not inside the video, so keep the copy we made in our own folder.
        report.moved += 1
      }
    }
  }
  return report
}

module.exports = { tidyFolder, isOurPlayerPage }
