'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { EventEmitter } = require('node:events')
const Core = require('../electron/player/core')
const file = path.resolve(__dirname, '../electron/lib/player.js')
const source = fs.readFileSync(file, 'utf8')
const localRequire = createRequire(file)

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-player-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const subtitles = { ...localRequire('./subtitles'), storeDirFor: () => path.join(root, 'subtitles') }
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports, __dirname: path.dirname(file), process, Buffer, Response,
    AbortController, setTimeout, clearTimeout,
    require: (name) => {
      if (name === 'electron') return { BrowserWindow: {}, ipcMain: {}, protocol: {}, shell: {} }
      if (name === './binaries') return { ffmpegPath: () => options.spawn ? 'synthetic-ffmpeg' : null, ffprobePath: () => options.execFile ? 'synthetic-ffprobe' : null, toolEnv: () => ({}) }
      if (name === './store') return { getState: () => ({ downloads: [] }) }
      if (name === './subtitles') return subtitles
      if (name === 'child_process') return { spawn: options.spawn, execFile: options.execFile }
      return localRequire(name)
    },
  }, { filename: file })
  return { player: module.exports, root }
}

test('subtitle parser keeps fractional/overlapping cues and rejects invalid times and WebVTT comments', (t) => {
  const { player } = fixture(t)
  const cues = player.parseCues('\uFEFFWEBVTT\n\nNOTE comment\n00:00.000 --> 00:03.000\nnot a subtitle\n\n1\n00:00:01,125 --> 00:00:05,250\nLong line\n\n2\n00:02.000 --> 00:03.000 align:start\nShort line\n\n3\n00:99:01,000 --> 00:99:02,000\ninvalid minute\n\n4\ntext 00:01.000 --> 00:02.000\ninvalid timestamp')
  assert.equal(cues.length, 2)
  assert.equal(cues[0].start, 1.125)
  assert.equal(cues[0].end, 5.25)
  const index = Core.cueIndex(cues)
  assert.deepEqual(Core.activeCues(index, 2.5).map((cue) => cue.text), ['Long line', 'Short line'])
  assert.deepEqual(Core.activeCues(index, 4).map((cue) => cue.text), ['Long line'])
  assert.equal(Core.activeCues(index, 5.25).length, 0)
})

test('cue lookup handles nested intervals whose end times are not sorted', () => {
  const index = Core.cueIndex([{ start: 1, end: 100, text: 'long' }, { start: 2, end: 3, text: 'short' }, { start: 4, end: 5, text: 'last' }, { start: 0, end: Infinity, text: 'bad' }])
  assert.deepEqual(Core.activeCues(index, 50).map((cue) => cue.text), ['long'])
  assert.deepEqual(Core.activeCues(index, 4.5).map((cue) => cue.text), ['long', 'last'])
  assert.equal(Core.activeCues(index, -1).length, 0)
})

test('seeking clamps finite media and leaves live/invalid durations alone', () => {
  assert.equal(Core.seekTime(-10, 90), 0)
  assert.equal(Core.seekTime(150, 90), 90)
  assert.equal(Core.seekTime(15.25, 90), 15.25)
  assert.equal(Core.seekTime(15, Infinity), null)
  assert.equal(Core.seekTime(NaN, 90), null)
  assert.equal(Core.seekTime(15, 0), null)
})

test('automatic next episodes require a confirmed neighbour and respect cancellation', () => {
  assert.equal(Core.autoAdvance({ sure: true }, true, false), true)
  assert.equal(Core.autoAdvance({ sure: false }, true, false), false)
  assert.equal(Core.autoAdvance({ sure: true }, false, false), false)
  assert.equal(Core.autoAdvance({ sure: true }, true, true), false)
  assert.equal(Core.autoAdvance(null, true, false), false)
  assert.equal(Core.errorInfo(2).remux, false)
  assert.equal(Core.errorInfo(4).remux, true)
})

test('private media ranges reject malformed, unsafe and multi-range requests', (t) => {
  const { player } = fixture(t)
  assert.equal(player.rangeOf(null, 100), null)
  assert.equal(JSON.stringify(player.rangeOf('bytes=10-19', 100)), '[10,19]')
  assert.equal(JSON.stringify(player.rangeOf('bytes=-10', 100)), '[90,99]')
  assert.equal(JSON.stringify(player.rangeOf('bytes=90-', 100)), '[90,99]')
  assert.equal(JSON.stringify(player.rangeOf('bytes=0-1000', 100)), '[0,99]')
  for (const value of ['bytes=-', 'bytes=-0', 'bytes=100-', 'bytes=20-10', 'bytes=0-1,4-5', 'not bytes=0-1', 'bytes=0-9007199254740992']) assert.equal(player.rangeOf(value, 100), 'bad', value)
  assert.equal(player.rangeOf('bytes=0-', 0), 'bad')
})

test('media probe preserves subtitle stream ordinals, audio labels and sorted valid chapters', async (t) => {
  const { player } = fixture(t, { execFile: (_bin, _args, _options, done) => done(null, JSON.stringify({
    streams: [null, { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '24000/1001', pix_fmt: 'yuv420p' }, { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' }, { codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'tur' }, disposition: { forced: 1 } }, { index: 3, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', tags: { language: 'eng' }, disposition: { default: 1 } }, { codec_type: 'audio', tags: { language: 'tur' } }],
    chapters: [null, { start_time: '10', tags: { title: 'Second' } }, { start_time: '-2' }, { start_time: 'bad' }, { start_time: '0', tags: { title: 'First' } }],
  })) })
  const media = await player.probeMedia('/synthetic/file')
  assert.equal(media.subs.length, 1)
  assert.equal(media.subs[0].streamIndex, 1)
  assert.equal(media.subs[0].forced, true)
  assert.equal(media.audio[0].default, true)
  assert.equal(media.audio[1].label, 'Türkçe')
  assert.equal(media.audio[0].streamIndex, 3)
  assert.equal(media.audio[0].sampleRate, 48000)
  assert.equal(media.video.codec, 'h264')
  assert.equal(media.video.frameRate, 24000 / 1001)
  assert.equal(player._internals.frameRateOf('1/0'), null)
  assert.equal(player._internals.frameRateOf('99999/1'), null)
  assert.equal(JSON.stringify(media.chapters.map((chapter) => chapter.start)), '[0,10]')
})

test('malformed ffprobe structures produce no tracks instead of crashing the main process', async (t) => {
  for (const json of ['null', '{"streams":{},"chapters":{}}', 'not JSON']) {
    const { player } = fixture(t, { execFile: (_bin, _args, _options, done) => done(null, json) })
    const media = await player.probeMedia('/synthetic/file')
    assert.equal(media.audio.length, 0)
    assert.equal(media.subs.length, 0)
  }
})

test('closing a session cancels an in-flight track scan and cannot publish stale tracks', async (t) => {
  let reply
  const { player } = fixture(t, { execFile: (_bin, _args, _options, done) => { reply = done } })
  const session = { file: '/synthetic/file', vault: false, controller: new AbortController(), tracks: [], tokens: [], toolTokens: [], temps: [] }
  const pending = player._internals.listTracks(session)
  player._internals.releaseSession(session)
  reply(null, '{"streams":[]}')
  await assert.rejects(pending, /Video değişti/)
  assert.equal(session.controller.signal.aborted, true)
})

test('a completed conversion cannot revive a closed player session', async (t) => {
  let child, out
  const { player, root } = fixture(t, { spawn: (_bin, args) => {
    out = args.at(-1)
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}
    return child
  } })
  const session = { file: path.join(root, 'synthetic.mp4'), controller: new AbortController(), tokens: [], toolTokens: [], temps: [] }
  const pending = player._internals.remux(session)
  assert.equal(fs.statSync(path.dirname(out)).mode & 0o777, process.platform === 'win32' ? fs.statSync(path.dirname(out)).mode & 0o777 : 0o700)
  fs.writeFileSync(out, 'synthetic output')
  player._internals.releaseSession(session)
  child.emit('close', 0)
  await assert.rejects(pending, /dönüştürülemedi/)
  assert.equal(session.tokens.length, 0)
  assert.equal(fs.existsSync(path.dirname(out)), false)
})

test('season-zero neighbours stay in the same series and are identified as adjacent episodes', (t) => {
  const { player, root } = fixture(t)
  for (const name of ['Show.S00E01.mp4', 'Show.S00E02.mp4', 'Other.S00E02.mp4']) fs.writeFileSync(path.join(root, name), '')
  const next = player.neighbour({ file: path.join(root, 'Show.S00E01.mp4'), vault: false }, 1)
  assert.equal(path.basename(next.path), 'Show.S00E02.mp4')
  assert.equal(next.sure, true)
})

test('playback watchdog distinguishes stalls while ignoring pause, seek, hidden and low-frame-rate media', () => {
  const sample = { playing: true, visible: true, ready: true, readyState: 4, fps: 24, positionIdleMs: 100, frameIdleMs: 100 }
  assert.equal(Core.playbackIssue(sample), null)
  assert.equal(Core.playbackIssue({ ...sample, positionIdleMs: 6100 }), 'stalled')
  assert.equal(Core.playbackIssue({ ...sample, positionIdleMs: 6100, readyState: 2 }), 'buffering')
  assert.equal(Core.playbackIssue({ ...sample, frameIdleMs: 6100 }), 'video-stalled')
  for (const ignore of [{ playing: false }, { visible: false }, { ready: false }, { seeking: true }, { error: true }]) {
    assert.equal(Core.playbackIssue({ ...sample, positionIdleMs: 20000, frameIdleMs: 20000, ...ignore }), null)
  }
  assert.equal(Core.playbackIssue({ ...sample, fps: 1, frameIdleMs: 10000 }), null)
  assert.equal(Core.playbackIssue({ ...sample, audioOnly: true, frameIdleMs: 10000 }), null)
})

const { createTimingAnalyzer } = require('../electron/player/timing')
const timingMedia = { video: { streamIndex: 0, frameRate: 24 }, audio: [{ streamIndex: 1, codec: 'aac', sampleRate: 48000 }] }
const packet = (index, at, duration) => `stream_index=${index}|pts_time=${at}|dts_time=${at}|duration_time=${duration}`

test('packet timing correlates stretched video samples with actual AAC timestamp gaps', () => {
  const analyzer = createTimingAnalyzer(timingMedia)
  for (const at of [60, 110, 185]) {
    analyzer.push(packet(0, at, 5.041667))
    analyzer.push(packet(1, at + 0.01, 5.021333))
    analyzer.push(packet(1, at + 5.031333, 0.021333))
  }
  const report = analyzer.finish()
  assert.equal(report.kind, 'matching-audio-video-gaps')
  assert.equal(report.videoLongFrames, 3)
  assert.equal(report.audioLongPackets, 3)
  assert.equal(report.correlatedGaps, 3)
  assert.equal(report.firstCorrelatedGaps[0].at, 60)
  assert.ok(Math.abs(report.extraVideoHold - 15) < 0.00001)
})

test('VFR video alone and unrelated audio gaps cannot be reported as matching missing media', () => {
  const analyzer = createTimingAnalyzer(timingMedia)
  analyzer.push(packet(0, 0, 5))
  for (let at = 0; at < 6; at += 0.02) analyzer.push(packet(1, at, 0.02))
  analyzer.push(packet(1, 100, 0.02))
  const report = analyzer.finish()
  assert.equal(report.kind, 'timing-variation')
  assert.equal(report.correlatedGaps, 0)
  const lowFps = createTimingAnalyzer({ ...timingMedia, video: { streamIndex: 0, frameRate: 1 } })
  lowFps.push(packet(0, 0, 1))
  assert.equal(lowFps.finish().videoLongFrames, 0)
})

test('packet timing rejects malformed numbers and bounds anomaly memory and returned examples', () => {
  const analyzer = createTimingAnalyzer(timingMedia)
  for (const line of ['not packet data', packet(0, 'Infinity', 5), packet(0, 'N/A', 5), packet(0, 0, 'Infinity'), packet(0, 0, -2), packet(99, 0, 10)]) analyzer.push(line)
  assert.equal(analyzer.finish().videoLongFrames, 0)
  for (let index = 0; index < 10000; index++) analyzer.push(packet(0, index * 10, 5))
  assert.equal(analyzer.finish().firstVideoHolds.length, 8)
  assert.throws(() => analyzer.push(packet(0, 100000, 5)), /sınır/)
})

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kills = 0
  child.kill = () => { child.kills++ }
  return child
}

test('explicit packet scans share work, accept chunk boundaries, cache summaries and never alter the input', async (t) => {
  let child, calls = 0, args, signal
  const { player } = fixture(t, { execFile: () => {}, spawn: (_bin, input, options) => {
    calls++; args = input; signal = options.signal; child = fakeChild(); return child
  } })
  const session = { file: '/synthetic/read-only.mp4', media: timingMedia, controller: new AbortController() }
  const first = player._internals.probeTiming(session)
  const second = player._internals.probeTiming(session)
  assert.equal(first, second)
  assert.equal(calls, 1)
  assert.equal(signal, session.controller.signal)
  assert.equal(args.at(-1), session.file)
  assert.equal(args.includes('-show_entries'), true)
  const line = packet(0, 0, 0.041667) + '\n' + packet(1, 0, 0.021333)
  child.stdout.emit('data', Buffer.from(line.slice(0, 30)))
  child.stdout.emit('data', Buffer.from(line.slice(30)))
  child.emit('close', 0)
  const report = await first
  assert.equal(report.kind, 'regular')
  assert.equal(report.packetCount, 2)
  assert.equal(await player._internals.probeTiming(session), report)
  assert.equal(calls, 1)
})

test('closing the player invalidates a completed packet scan and malformed huge lines terminate the helper', async (t) => {
  let child
  const { player } = fixture(t, { execFile: () => {}, spawn: () => { child = fakeChild(); return child } })
  const session = { file: '/synthetic/file.mp4', media: timingMedia, controller: new AbortController() }
  const pending = player._internals.probeTiming(session)
  child.stdout.emit('data', Buffer.from(packet(0, 0, 0.04) + '\n'))
  player._internals.releaseSession(session)
  child.emit('close', 0)
  await assert.rejects(pending, /iptal/)
  assert.equal(session.timing, null)
  assert.equal(session.controller.signal.aborted, true)
  const other = { file: '/synthetic/other.mp4', media: timingMedia, controller: new AbortController() }
  const huge = player._internals.probeTiming(other)
  child.stdout.emit('data', Buffer.alloc(65537, 65))
  await assert.rejects(huge, /okunamadı/)
  assert.equal(child.kills, 1)
})
