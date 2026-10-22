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
