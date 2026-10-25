'use strict'

// Run with Electron, never node: electron tests/manual/player-smoke.js [--keep]
// Generates its own media/subtitles, stubs app data, blocks remote browser
// requests and mutes the entire test window. No user library or vault is read.
const { app, BrowserWindow, session: electronSession } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-player-smoke-'))
app.setPath('userData', path.join(fixtureRoot, 'profile'))
app.on('window-all-closed', () => {})
app.on('browser-window-created', (_event, window) => window.webContents.setAudioMuted(true))
const settings = { playerVolume: 0.4, playerRate: 1, playerBoost: 1, playerFit: 'contain', playerAutoNext: true,
  subtitleLangs: 'tr', playerSubtitleSize: 'normal', playerSubtitleStyle: 'box', playerSubtitlesEnabled: true }
const positions = []
let copiedDiagnostics = ''
const store = {
  getState: () => ({ settings, downloads: [] }),
  positionOf: (key) => key.includes('S01E01') ? 35 : 0,
  delayOf: () => 0,
  rememberPosition: (key, seconds, duration) => positions.push({ key, seconds, duration }),
  rememberDelay: () => {}, commit: (change) => change({ settings, downloads: [] }),
}
const playerFile = path.resolve(__dirname, '../../electron/lib/player.js')
const load = Module._load
Module._load = function (name, parent, isMain) {
  if (name === './store' && parent?.filename === playerFile) return store
  if (name === 'electron' && parent?.filename === playerFile) {
    const real = load.apply(this, arguments)
    return new Proxy(real, { get: (target, key) => key === 'clipboard' ? { writeText: (text) => { copiedDiagnostics = text } } : target[key] })
  }
  return load.apply(this, arguments)
}
const player = require(playerFile)
const binaries = require('../../electron/lib/binaries')
player.registerScheme()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, message, timeout = 12000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try { if (await check()) return } catch {}
    await sleep(80)
  }
  throw new Error('Timed out: ' + message)
}
let win
const evaluate = (code) => win.webContents.executeJavaScript(code)

async function main() {
  const ffmpeg = binaries.ffmpegPath()
  assert.ok(ffmpeg, 'ffmpeg is required for generated fixtures')
  const first = path.join(fixtureRoot, 'Show.S01E01.mp4')
  const second = path.join(fixtureRoot, 'Show.S01E02.mp4')
  const gapDir = path.join(fixtureRoot, 'gap-fixture')
  fs.mkdirSync(gapDir)
  const gapFile = path.join(gapDir, 'missing-interval.mp4')
  const embedded = path.join(fixtureRoot, 'embedded.srt')
  fs.writeFileSync(embedded, '1\n00:00:00,500 --> 00:01:15,000\nForced embedded fixture\n')
  fs.writeFileSync(path.join(fixtureRoot, 'Show.S01E01.tr.srt'), '1\n00:00:00,500 --> 00:01:15,000\nLong &amp; <i>safe</i> line\n\n2\n00:00:01,000 --> 00:00:03,000\nOverlapping line\n')
  fs.writeFileSync(path.join(fixtureRoot, 'Show.S01E02.en.srt'), '1\n00:00:00,500 --> 00:01:15,000\nSecond episode subtitle\n')
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x233747:s=640x360:r=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
    '-i', embedded, '-t', '90', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'mov_text',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=tur', '-metadata:s:s:0', 'language=tur', '-disposition:s:0', 'default+forced', first],
  { timeout: 30000, stdio: 'pipe' })
  fs.copyFileSync(first, second)
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x233747:s=640x360:r=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8',
    '-vf', "select='not(between(t,2,4))'", '-af', "aselect='not(between(t,2,4))'", '-fps_mode', 'vfr',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', gapFile], { timeout: 30000, stdio: 'pipe' })
  await app.whenReady()
  const remoteRequests = []
  electronSession.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    remoteRequests.push(details.url); callback({ cancel: true })
  })
  player.registerProtocol(); player.registerIpc()
  await player.open({ file: first, title: 'Generated player fixture', key: 'file:' + first })
  win = BrowserWindow.getAllWindows()[0]
  const errors = []
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  await until(() => evaluate('state.ready && !video.paused && video.currentTime >= 35'), 'first playback and resume')
  assert.equal(await evaluate('state.trackId'), null)
  assert.equal(await evaluate('state.cues.length'), 0)
  assert.equal(await evaluate('Array.from(video.textTracks).every(track => track.mode === "disabled")'), true)
  assert.equal(await evaluate('video.audioTracks.length'), 2)
  assert.equal(await evaluate('state.tracks.some(track => track.forced)'), true)
  assert.equal(await evaluate('document.getElementById("probe").hasAttribute("src")'), false, 'hover decoder must stay closed during normal opening')
  const normalTiming = await evaluate('window.aioPlayer.timing()')
  assert.equal(normalTiming.kind, 'regular')

  await evaluate('video.pause(); seekTo(1.25); selectTrack(state.tracks.find(track => track.kind === "file").id)')
  await until(() => evaluate('document.getElementById("subs").textContent.includes("Overlapping line")'), 'overlapping subtitle drawing')
  assert.match(await evaluate('document.getElementById("subs").textContent'), /Long & safe line/)
  await evaluate('setDelay(0.5)')
  assert.equal(await evaluate('state.delay'), 0.5)
  await evaluate('document.getElementById("delay-reset").click()')
  assert.equal(await evaluate('state.delay'), 0)
  await evaluate('(async()=>{const loading=selectTrack(state.tracks.find(track=>track.kind==="embedded").id);await selectTrack(null);await loading;})()')
  assert.equal(await evaluate('state.trackId'), null)
  assert.equal(await evaluate('document.getElementById("subs").textContent'), '')
  await until(() => evaluate('!video.seeking'), 'main seek completes before hover preview')
  await evaluate('document.getElementById("seek-tip").hidden=false;previewAt(10);previewAt(11);previewAt(12);')
  await until(() => evaluate('!document.getElementById("seek-frame").hidden && !preview.busy'), 'lazy hover preview')
  await evaluate('document.getElementById("seek-tip").hidden=true;resetPreview();')

  await evaluate('document.getElementById("seek").focus();document.getElementById("seek").dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true}));')
  assert.ok(await evaluate('video.currentTime > 89.8'))
  await evaluate('document.getElementById("seek").dispatchEvent(new KeyboardEvent("keydown",{key:"Home",bubbles:true}));')
  assert.ok(await evaluate('video.currentTime < 0.2'))
  await evaluate('document.getElementById("q-autonext").focus();')
  const pausedBefore = await evaluate('video.paused')
  await evaluate('document.getElementById("q-autonext").dispatchEvent(new KeyboardEvent("keydown",{key:" ",bubbles:true}));')
  assert.equal(await evaluate('video.paused'), pausedBefore)

  await evaluate('seekTo(10);setAudioDelay(0.15);playSafely();')
  await sleep(600)
  const frequencies = []
  for (const index of [0, 1]) {
    await evaluate('selectAudio(' + index + ')')
    await sleep(450)
    frequencies.push(await evaluate(`(async()=>{const analyser=audioGraph.ctx.createAnalyser();analyser.fftSize=4096;audioGraph.gain.connect(analyser);await new Promise(r=>setTimeout(r,150));const data=new Uint8Array(analyser.frequencyBinCount);analyser.getByteFrequencyData(data);let peak=0;for(let i=1;i<data.length;i++)if(data[i]>data[peak])peak=i;audioGraph.gain.disconnect(analyser);return peak*audioGraph.ctx.sampleRate/analyser.fftSize;})()`))
  }
  assert.ok(Math.abs(frequencies[0] - 440) < 35, 'first native audio track must carry 440 Hz: ' + frequencies[0])
  assert.ok(Math.abs(frequencies[1] - 880) < 35, 'second native audio track must carry 880 Hz: ' + frequencies[1])
  assert.equal(await evaluate('state.audioDelay'), 0.15)
  await evaluate('playbackWatch.position=video.currentTime;playbackWatch.positionAt=performance.now()-7000;pollPlayback();')
  assert.equal(await evaluate('document.getElementById("recovery").hidden'), false)
  await evaluate('document.getElementById("recovery-retry").click()')
  await until(() => evaluate('state.ready && !video.paused'), 'same-position recovery reload')
  assert.equal(await evaluate('document.getElementById("recovery").hidden'), true)
  await evaluate('document.getElementById("audio-delay-reset").click();video.pause();setRate(1.25,{quiet:true});seekTo(12.5);')
  await sleep(200)
  await evaluate('document.getElementById("fault-remux").click()')
  await until(() => evaluate('state.ready && !state.remuxing && video.currentTime >= 12.4'), 'container conversion preserves position')
  assert.equal(await evaluate('video.playbackRate'), 1.25)
  assert.equal(await evaluate('video.paused'), true)

  await evaluate('setPanel(true)')
  await sleep(200)
  fs.writeFileSync(path.join(fixtureRoot, 'subtitles.png'), (await win.webContents.capturePage()).toPNG())
  await evaluate('setPanel(false);togglePopover("quick")')
  await evaluate('document.getElementById("diagnostics").open=true;paintDiagnostics();document.getElementById("diagnostics-copy").click()')
  await until(() => !!copiedDiagnostics, 'sanitized diagnostics copy')
  assert.ok(!copiedDiagnostics.includes(fixtureRoot))
  assert.ok(!copiedDiagnostics.includes('aiomedia:'))
  assert.equal(JSON.parse(copiedDiagnostics).timing.kind, 'regular')
  await sleep(200)
  fs.writeFileSync(path.join(fixtureRoot, 'quick.png'), (await win.webContents.capturePage()).toPNG())
  await evaluate('closePopovers();goNext()')
  await until(() => evaluate('state.ready && document.title.includes("Show.S01E02")'), 'next episode playback')
  assert.equal(await evaluate('state.trackId'), null)
  assert.equal(await evaluate('state.cues.length'), 0)
  assert.equal(await evaluate('Array.from(video.textTracks).every(track => track.mode === "disabled")'), true)
  win.setSize(480, 360)
  await evaluate('wake()')
  await sleep(200)
  const fit = await evaluate('document.getElementById("row").scrollWidth <= document.getElementById("row").clientWidth')
  assert.equal(fit, true, 'controls must fit the minimum window width')
  fs.writeFileSync(path.join(fixtureRoot, 'minimum.png'), (await win.webContents.capturePage()).toPNG())
  win.destroy()
  await player.open({ file: gapFile, title: 'Generated missing-interval fixture' })
  win = BrowserWindow.getAllWindows()[0]
  await until(() => evaluate('state.ready'), 'gap fixture opens')
  const gapTiming = await evaluate('window.aioPlayer.timing()')
  assert.equal(gapTiming.kind, 'matching-audio-video-gaps')
  assert.equal(gapTiming.correlatedGaps, 1)
  await evaluate('video.pause();togglePopover("quick");document.getElementById("diagnostics").open=true;checkTiming()')
  assert.match(await evaluate('document.getElementById("timing-result").textContent'), /1 noktada görüntü ve ses/)
  await evaluate('document.getElementById("diagnostics").scrollIntoView({block:"end"})')
  await sleep(200)
  fs.writeFileSync(path.join(fixtureRoot, 'timing-gap.png'), (await win.webContents.capturePage()).toPNG())
  assert.equal(remoteRequests.length, 0)
  assert.deepEqual(errors, [], 'player renderer must not log runtime errors')
  console.log(JSON.stringify({ ok: true, frequencies, gapTiming, screenshots: fixtureRoot, savedPositions: positions.length, rendererErrors: errors }, null, 2))
}
main().then(() => {
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  if (!process.argv.includes('--keep')) fs.rmSync(fixtureRoot, { recursive: true, force: true })
  app.quit()
}).catch((error) => {
  console.error(error)
  console.error('Synthetic fixture retained:', fixtureRoot)
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  app.exit(1)
})
