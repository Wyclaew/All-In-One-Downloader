'use strict'
// Read-only smoke test. Uses an isolated profile, never the real library/vault.
const { app } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-resolver-smoke-'))
app.setPath('userData', profile)
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const { resolvePage } = require('../../electron/lib/resolver')
  const sample = process.argv.includes('--sample')
  const ownSample = process.argv.includes('--own-sample')
  const urls = process.argv.slice(2).filter((value) => /^https?:/.test(value))
  for (const url of urls) {
    const start = Date.now()
    const result = await resolvePage(url, {
      timeoutMs: 18000, minStreamSeconds: 120,
      preferEngine: process.argv.includes('--prefer-browser') ? 'browser' : null,
      onProgress: (note) => console.log(new URL(url).hostname + ': ' + note),
    })
    let sampleOk = null, sampleBytes = 0, sampleError = null
    let sampleDuration = null
    let subtitleProbe = null
    if (ownSample && result.candidates?.length) {
      const candidate = result.candidates[0]
      const sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-own-sample-'))
      const resolved = { ...candidate, userAgent: candidate.userAgent || result.userAgent }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 45000)
      try {
        const { pickVariant } = require('../../electron/lib/ownengine')
        const chosen = await pickVariant(candidate.url, resolved, 720, null, '', 'en', controller.signal)
        const destPath = path.join(sampleDir, 'sample.mp4')
        await require('../../electron/lib/hls-native').transferHls({ ...chosen, resolved, destPath, download: { audioOnly: false }, settings: { connections: 4 }, sampleSegments: 2, signal: controller.signal })
        sampleOk = true; sampleBytes = fs.statSync(destPath).size
        const { ffprobeMedia } = require('../../electron/lib/mediainfo')
        sampleDuration = (await ffprobeMedia(destPath))?.duration || null
        if (process.argv.includes('--captions')) {
          const tracks = [...(candidate.info?.subtitles || []), ...(candidate.subtitles || [])]
          const track = tracks.find((t) => /^(tr|tur|turkish)$/i.test(t.lang) && t.url && !t.forced)
          if (track) {
            const { fetchHeaders } = require('../../electron/lib/mediainfo')
            const response = await require('../../electron/lib/proxy').fetchVia(track.url, { headers: fetchHeaders(track.url, { ...resolved, referer: track.referer || resolved.referer }), signal: controller.signal, maxBytes: 2 * 1024 * 1024 })
            subtitleProbe = { lang: track.lang, status: response.status, format: /^\s*WEBVTT/.test(response.text) ? 'vtt' : /^\s*#EXTM3U/.test(response.text) ? 'hls' : /\d{2}:\d{2}:\d{2}.*-->/.test(response.text) ? 'srt' : 'unknown', bytes: Buffer.byteLength(response.text) }
          }
        }
      } catch (err) { sampleOk = false; sampleError = String(err.message).replace(/https?:\/\/[^\s"']+/g, '[URL]').slice(-600) }
      finally { clearTimeout(timer); fs.rmSync(sampleDir, { recursive: true, force: true }) }
    }
    if (sample && result.candidates?.length) {
      const { ytdlpPathOrThrow, toolEnv } = require('../../electron/lib/binaries')
      const { resolvedArgs } = require('../../electron/lib/util')
      const candidate = result.candidates[0]
      const sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-stream-sample-'))
      const args = ['--ignore-config', '--no-warnings', '--no-playlist', '--no-progress', '--test', '--fixup', 'never', '--hls-use-mpegts', '--socket-timeout', '10', '-P', sampleDir, '-o', 'sample.%(ext)s',
        ...resolvedArgs({ ...candidate, userAgent: result.userAgent }), '--', candidate.url]
      sampleOk = await new Promise((resolve) => require('child_process').execFile(ytdlpPathOrThrow(), args,
        { env: toolEnv(), timeout: 30000 }, (err, out, stderr) => {
          if (err) sampleError = String(stderr || err.message).replace(/https?:\/\/[^\s"']+/g, '[URL]').slice(-600)
          resolve(!err)
        }))
      sampleBytes = fs.readdirSync(sampleDir).reduce((sum, name) => sum + fs.statSync(path.join(sampleDir, name)).size, 0)
      fs.rmSync(sampleDir, { recursive: true, force: true })
    }
    console.log(JSON.stringify({ url, sampleOk, sampleBytes, sampleDuration, subtitleProbe, sampleError, sampleEngine: ownSample ? 'own HLS HTTP + local FFmpeg mux' : sample ? 'yt-dlp native HLS test' : null, ms: Date.now() - start, engine: result.engine,
      candidates: result.candidates?.map((c) => ({ host: new URL(c.url).hostname, kind: c.kind, duration: c.info?.duration, audioLanguages: (c.info?.audioTracks || []).map((t) => t.lang), subtitles: [...(c.info?.subtitles || []), ...(c.subtitles || [])].map((t) => t.lang) })),
      accessRequired: result.accessRequired, challengeRequired: result.challengeRequired, failure: result.failure, loadError: result.loadError }))
  }
}).catch((err) => { console.error(err); process.exitCode = 1 }).finally(() => {
  fs.rmSync(profile, { recursive: true, force: true })
  app.quit()
})
