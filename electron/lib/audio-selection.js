'use strict'

const fs = require('fs')
const path = require('path')
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
  const selected = tracks.find((t) => languageCode(t.tags?.language) === lang)
  const known = [...new Set(tracks.map((t) => languageCode(t.tags?.language)).filter((l) => l && l !== 'und'))]
  const current = selected || tracks.find((t) => t.disposition?.default) || tracks[0]
  const currentLanguage = languageCode(current?.tags?.language)
  const result = { language: currentLanguage && currentLanguage !== 'und' ? currentLanguage : null, warning: null }
  if (lang && lang !== 'auto' && !selected) {
    result.warning = known.length
      ? `İstenen ${lang.toUpperCase()} ses bulunamadı; mevcut ses: ${known.join(', ')}.`
      : 'Ses dili kaynakta etiketlenmemiş; İngilizce olduğu doğrulanamadı.'
    return result
  }
  const bin = ffmpegPath()
  if (!selected || tracks.length < 2 || !bin || isStopped?.()) return result
  const ext = path.extname(filePath)
  const temp = `${filePath}.audio-${process.pid}${ext}`
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
    return result
  } catch (err) {
    const fallback = tracks.find((t) => t.disposition?.default) || tracks[0]
    const fallbackLanguage = languageCode(fallback?.tags?.language)
    return { language: fallbackLanguage && fallbackLanguage !== 'und' ? fallbackLanguage : null, warning: `${err.message} Dosyada tüm sesler korundu.` }
  } finally { fs.rmSync(temp, { force: true }) }
}

module.exports = { inspectAudio, selectAudio }
