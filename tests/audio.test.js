'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { root, load } = require('./helpers.cjs')
const { ffmpegPath, toolEnv } = load('electron/lib/binaries.js')
const { inspectAudio, selectAudio } = load('electron/lib/audio-selection.js')
const own = load('electron/lib/ownengine.js')
const ffmpeg = ffmpegPath()
test.after(() => fs.rmSync(root, { recursive: true, force: true }))
test('a real Turkish-default dual-audio file is remuxed to English without reencoding', { skip: !ffmpeg }, async () => {
  const file = path.join(root, 'dual.mp4')
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=600:duration=1',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'mpeg4', '-c:a', 'aac',
    '-metadata:s:a:0', 'language=tur', '-metadata:s:a:1', 'language=eng', '-y', file], { env: toolEnv() })
  assert.equal((await inspectAudio(file)).length, 2)
  const selected = await selectAudio(file, 'en')
  assert.equal(selected.warning, null)
  const after = await inspectAudio(file)
  assert.equal(after.length, 1)
  assert.equal(after[0].tags.language, 'eng')
})
test('missing preferred language produces a warning, not a false English claim', { skip: !ffmpeg }, async () => {
  const file = path.join(root, 'turkish.mp4')
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=1',
    '-c:a', 'aac', '-metadata:s:a:0', 'language=tur', '-y', file], { env: toolEnv() })
  const selected = await selectAudio(file, 'en')
  assert.equal(selected.language, 'tr')
  assert.match(selected.warning, /bulunamadı/)
  assert.equal((await inspectAudio(file)).length, 1)
})
test('ffmpeg receives the separate audio input and explicit mapping', () => {
  const args = own.ffmpegArgs({ url: 'https://cdn.example.test/video.m3u8', audioUrl: 'https://cdn.example.test/en/audio.m3u8',
    resolved: null, download: { audioOnly: false }, settings: {}, destPath: '/tmp/film.mp4', workPath: '/tmp/film.mp4.part' })
  assert.equal(args.filter((x) => x === '-i').length, 2)
  assert.equal(args.includes('1:a:0'), true)
  assert.equal(args.includes('-reconnect_at_eof'), false)
})

const { ffprobePath } = load('electron/lib/binaries.js')
const { languageCode, formatSelector, rankCandidates } = require('../electron/lib/media-preferences')
function packetHashes(file, index) {
  return JSON.parse(execFileSync(ffprobePath(), ['-v', 'error', '-select_streams', `a:${index}`, '-show_packets', '-show_entries', 'packet=data_hash', '-show_data_hash', 'sha256', '-of', 'json', file], { env: toolEnv() })).packets.map((packet) => packet.data_hash)
}
test('per-download Turkish and English choices select the actual corresponding AAC packets', { skip: !ffmpeg || !ffprobePath() }, async () => {
  const source = path.join(root, 'english-default-dual.mp4')
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'mpeg4', '-c:a', 'aac',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=tur', '-disposition:a:0', 'default', '-disposition:a:1', '0', '-y', source], { env: toolEnv() })
  for (const [lang, index, tag] of [['tr', 1, 'tur'], ['en', 0, 'eng']]) {
    const copy = path.join(root, lang + '-selected.mp4')
    fs.copyFileSync(source, copy)
    const expected = packetHashes(source, index)
    const selected = await selectAudio(copy, lang)
    assert.equal(selected.language, lang); assert.equal(selected.warning, null)
    const tracks = await inspectAudio(copy)
    assert.equal(tracks.length, 1); assert.equal(tracks[0].tags.language, tag)
    assert.deepEqual(packetHashes(copy, 0), expected, 'selected audio is stream-copied from the requested source track')
  }
})
test('audio selectors honor the individual job over global settings and never exceed its resolution cap', () => {
  const turkish = formatSelector({ preferredAudioLanguage: 'tr', quality: 720 }, { preferredAudioLanguage: 'en' })
  assert.ok(turkish.startsWith('bv[height<=?720]+ba[language^=tr]/b[height<=?720][language^=tr]'))
  assert.equal(turkish.includes('language^=en'), false)
  assert.ok(turkish.split('/').every((option) => option.includes('[height<=?720]')))
  const english = formatSelector({ preferredAudioLanguage: 'en', audioOnly: true }, { preferredAudioLanguage: 'tr' })
  assert.ok(english.startsWith('ba[language^=en]/b[language^=en]'))
  assert.equal(formatSelector({ preferredAudioLanguage: 'auto' }, { preferredAudioLanguage: 'en' }).includes('language'), false)
})
test('language normalization accepts regional labels and treats absent metadata as unknown', () => {
  assert.equal(languageCode(' TR-tr '), 'tr')
  assert.equal(languageCode('İngilizce'), 'en')
  assert.equal(languageCode('TÜRKÇE'), 'tr')
  assert.equal(languageCode('eng-US'), 'en')
  for (const value of ['', 'und', 'unknown', 'mul']) assert.equal(languageCode(value), '')
  assert.deepEqual(rankCandidates([{ id: 'unknown', language: 'und' }, { id: 'wrong', language: 'tr' }, { id: 'right', language: 'en' }], 'en').map((item) => item.id), ['right', 'unknown', 'wrong'])
})
function syntheticSelection(tracks, { ffmpeg = null, stopped = false } = {}) {
  const vm = require('node:vm')
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../electron/lib/audio-selection.js'), 'utf8'), {
    module, exports: module.exports, process,
    require: (name) => name === './binaries' ? { ffmpegPath: () => ffmpeg, ffprobePath: () => 'synthetic-probe', toolEnv: () => ({}) }
      : name === './media-preferences' ? require('../electron/lib/media-preferences')
        : name === 'child_process' ? { execFile: (_bin, _args, _options, callback) => callback(null, JSON.stringify({ streams: tracks })) }
          : require(name),
  })
  return module.exports.selectAudio('/synthetic/file.mp4', 'tr', { isStopped: () => stopped })
}
test('finding a desired secondary tag does not claim a remux succeeded when ffmpeg is unavailable or stopped', async () => {
  const tracks = [{ index: 1, tags: { language: 'eng' }, disposition: { default: 1 } }, { index: 2, tags: { language: 'tur' }, disposition: { default: 0 } }]
  const absent = await syntheticSelection(tracks)
  assert.equal(absent.language, 'en'); assert.match(absent.warning, /ffmpeg/)
  assert.ok(absent.availableLanguages.includes('tr'))
  const stopped = await syntheticSelection(tracks, { ffmpeg: 'synthetic-mux', stopped: true })
  assert.equal(stopped.language, 'en'); assert.equal(stopped.warning, null)
  const unknown = await syntheticSelection([{ index: 1, tags: { language: 'und' } }])
  assert.equal(unknown.language, null); assert.match(unknown.warning, /Türkçe/)
  assert.equal(unknown.warning.includes('İngilizce'), false)
})

test('real yt-dlp accepts unknown height while excluding a known video above the selected cap', { skip: !load('electron/lib/binaries.js').locate('yt-dlp') }, () => {
  const bin = load('electron/lib/binaries.js').locate('yt-dlp')
  const infoFile = path.join(root, 'offline-format-selection.json')
  const unknown = { format_id: 'unknown', url: 'http://127.0.0.1:9/never-requested.mp4', ext: 'mp4', vcodec: 'avc1', acodec: 'aac', protocol: 'http' }
  const over = { ...unknown, format_id: 'over-limit', height: 1080 }
  const allowed = { ...unknown, format_id: 'allowed', height: 720 }
  const selector = formatSelector({ quality: 720, preferredAudioLanguage: 'auto' })
  for (const [formats, expected] of [[[unknown, over], 'unknown'], [[unknown, allowed, over], 'allowed']]) {
    fs.writeFileSync(infoFile, JSON.stringify({ id: 'offline-fixture', title: 'Offline format fixture', extractor: 'generic', formats }))
    const output = execFileSync(bin, ['--ignore-config', '--proxy', '', '--skip-download', '--no-check-formats', '--load-info-json', infoFile, '-f', selector, '--print', 'format_id'], { env: toolEnv(), encoding: 'utf8', timeout: 15000 })
    assert.equal(output.trim(), expected)
  }
})
