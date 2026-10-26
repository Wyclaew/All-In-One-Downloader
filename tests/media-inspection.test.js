'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto')
const { execFileSync } = require('child_process')
const { createMediaInspection } = require('../electron/lib/media-inspection')
const { root, load } = require('./helpers.cjs')
const player = load('electron/lib/player.js')
const binaries = load('electron/lib/binaries.js')
function fixture() {
  const records = [{ id: 'one', status: 'done', filePath: '/synthetic/one.mp4' }, { id: 'two', status: 'done', filePath: '/synthetic/two.mp4' }, { id: 'three', status: 'done', filePath: '/synthetic/three.mp4' }]
  const pending = []
  const manager = createMediaInspection({ getDownload: (id) => records.find((d) => d.id === id), resolvePath: (d) => d.filePath,
    commit: (fn) => fn(), inspect: (file, { signal }) => new Promise((resolve, reject) => { pending.push({ file, signal, resolve, reject }); signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }) }) })
  return { records, pending, manager }
}
test('inspections share work, use only completed library records and bound concurrent disk scans', async () => {
  const { records, pending, manager } = fixture()
  await assert.rejects(manager.check('/arbitrary/file'), /Önce/)
  records[2].status = 'running'; await assert.rejects(manager.check('three'), /Önce/); records[2].status = 'done'
  const first = manager.check('one'), second = manager.check('two')
  assert.equal(manager.check('one'), first)
  await assert.rejects(manager.check('three'), /İki video/)
  await Promise.resolve()
  assert.equal(pending[0].file, records[0].filePath)
  const report = { kind: 'regular', checkedAt: 100 }; pending[0].resolve(report); pending[1].resolve(report)
  assert.equal(await first, report); await second
  assert.equal(records[0].mediaInspection, report)
})
test('cancel, removal and path changes cannot publish stale inspection data', async () => {
  for (const action of ['cancel', 'remove', 'move']) {
    const { records, pending, manager } = fixture()
    const first = manager.check('one'); await Promise.resolve()
    if (action === 'cancel') manager.cancel('one')
    else if (action === 'remove') records.shift()
    else records[0].filePath = '/synthetic/changed.mp4'
    pending[0].resolve({ kind: 'regular' })
    await assert.rejects(first, { code: 'ABORTED' })
    assert.ok(records.every((d) => !d.mediaInspection))
  }
})
test('a closed application aborts every outstanding inspection', async () => {
  const { pending, manager } = fixture()
  const first = manager.check('one'); const second = manager.check('two'); await Promise.resolve()
  manager.shutdown()
  await Promise.all([assert.rejects(first, { code: 'ABORTED' }), assert.rejects(second, { code: 'ABORTED' })])
  assert.ok(pending.every((job) => job.signal.aborted))
})
const ffmpeg = binaries.ffmpegPath(), ffprobe = binaries.ffprobePath()
test('actual local inspection detects matched missing media without rewriting or network access', { skip: !ffmpeg || !ffprobe }, async () => {
  const file = path.join(root, 'gap.mp4')
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=24:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
    '-vf', "select='not(between(t,2,4))'", '-af', "aselect='not(between(t,2,4))'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-metadata:s:a:0', 'language=eng', file], { env: binaries.toolEnv() })
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const before = hash(), report = await player.inspectFileTiming(file)
  assert.equal(report.kind, 'matching-audio-video-gaps'); assert.ok(report.correlatedGaps >= 1)
  assert.equal(report.audio[0].language, 'eng'); assert.equal(report.video.codec, 'h264')
  assert.equal(hash(), before)
  const mkv = path.join(root, 'gap.mkv')
  execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-c', 'copy', mkv], { env: binaries.toolEnv() })
  const mkvReport = await player.inspectFileTiming(mkv)
  assert.equal(mkvReport.kind, 'matching-audio-video-gaps')
  assert.ok(mkvReport.correlatedGaps >= 1)
  let requested = 0
  const server = http.createServer((_req, res) => { requested++; res.end('foreign media') })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const disguised = path.join(root, 'not-a-video.mp4')
    fs.writeFileSync(disguised, '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttp://127.0.0.1:' + server.address().port + '/foreign.ts\n#EXT-X-ENDLIST\n')
    await assert.rejects(player.inspectFileTiming(disguised), /akışı bulunamadı/)
    assert.equal(requested, 0)
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
})
test.after(() => fs.rmSync(root, { recursive: true, force: true }))
