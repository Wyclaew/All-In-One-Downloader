'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn, execFile } = require('child_process')
const { ffmpegPath, ffprobePath, toolEnv } = require('./binaries')
const { languageCode } = require('./media-preferences')

function inspectAudio(filePath) {
  return new Promise((resolve) => {
    const bin = ffprobePath()
    if (!bin) return resolve([])
    execFile(bin, ['-v', 'error', '-select_streams', 'a', '-show_streams', '-of', 'json', filePath],
      { env: toolEnv(), timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (error, out) => {
        try { resolve(error ? [] : JSON.parse(out).streams || []) } catch { resolve([]) }
      })
  })
}

async function selectAudio(filePath, preferred, { onHandle, isStopped } = {}) {
  const lang = languageCode(preferred)
  const tracks = await inspectAudio(filePath)
  const selected = lang && lang !== 'auto' ? tracks.find((t) => languageCode(t.tags?.language) === lang) : null
  const known = [...new Set(tracks.map((t) => languageCode(t.tags?.language)).filter((l) => l && l !== 'und'))]
  // Until the remux really succeeds, playback still starts with the file's
  // current default. Finding the desired tag alone must not claim it was set.
  const current = tracks.find((t) => t.disposition?.default) || tracks[0]
  const currentLanguage = languageCode(current?.tags?.language)
  const result = { language: currentLanguage || null, warning: null,
    availableLanguages: known, requestedLanguage: lang && lang !== 'auto' ? lang : null }
  const requestedLabel = ({ en: 'İngilizce', tr: 'Türkçe' })[lang] || lang.toUpperCase()
  if (isStopped?.()) return result
  if (lang && lang !== 'auto' && !selected) {
    result.warning = known.length
      ? `İstenen ${requestedLabel} ses bulunamadı; mevcut ses: ${known.join(', ')}.`
      : `İstenen ${requestedLabel} ses doğrulanamadı; dosyada okunabilir bir ses dili etiketi bulunamadı.`
    return result
  }
  const bin = ffmpegPath()
  if (!selected || tracks.length < 2) return result
  if (!bin) {
    result.warning = `İstenen ${requestedLabel} ses dosyada var ancak ffmpeg bulunamadığı için tek ses olarak seçilemedi. Oynatıcıdan ses kanalını seçebilirsin.`
    return result
  }
  const ext = path.extname(filePath)
  const temp = `${filePath}.audio-${process.pid}-${crypto.randomBytes(6).toString('hex')}${ext}`
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(bin, ['-v', 'error', '-nostdin', '-y', '-i', filePath,
        '-map', '0:v?', '-map', `0:${selected.index}`, '-map', '0:s?', '-map_metadata', '0',
        '-c', 'copy', '-disposition:a:0', 'default', temp], { env: toolEnv(), windowsHide: true })
      onHandle?.(child)
      child.on('error', reject)
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error('Ses seçimi tamamlanamadı.')))
    })
    if (isStopped?.()) return result
    fs.renameSync(temp, filePath)
    return { ...result, language: languageCode(selected.tags?.language) || null }
  } catch (err) {
    const fallback = tracks.find((t) => t.disposition?.default) || tracks[0]
    const fallbackLanguage = languageCode(fallback?.tags?.language)
    return { ...result, language: fallbackLanguage || null, warning: `${err.message} Dosyada tüm sesler korundu.` }
  } finally { fs.rmSync(temp, { force: true }) }
}

module.exports = { inspectAudio, selectAudio }
