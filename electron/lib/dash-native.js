'use strict'

// Clear, finite DASH is downloaded with the same scoped HTTP transport as HLS.
// FFmpeg receives generated local files only; it never sees remote URLs/cookies.
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { spawn, execFile } = require('child_process')
const { parseDashTree, parseDash } = require('./mediainfo')
const { requestBytes, transferHls } = require('./hls-native')
const { ffmpegPath, ffprobePath, toolEnv } = require('./binaries')
const { languageCode, pickAudioTrack } = require('./media-preferences')
const { atomicWrite } = require('./util')

const MAX_SEGMENTS = 50000
const unsupported = (message) => Object.assign(new Error(message), { code: 'DASH_UNSUPPORTED' })
const stopped = () => Object.assign(new Error('Aktarım durduruldu.'), { code: 'ABORTED' })
const children = (node, name) => (node?.children || []).filter((child) => child.name === name)
function integer(raw, fallback, minimum = 0) {
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(Number(raw)) || Number(raw) < minimum) throw unsupported('DASH zaman veya sıra değeri geçersiz.')
  return Number(raw)
}
function absolute(raw, base) {
  let url
  try { url = new URL(String(raw || '').trim(), base) } catch { throw unsupported('DASH parça adresi geçersiz.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw unsupported('DASH parçaları kimlik bilgisi içermeyen HTTP/HTTPS adresleri kullanmalı.')
  return url.href
}
function baseFor(chain, manifestUrl) {
  let base = manifestUrl
  for (const node of chain) {
    if (node.attrs['xml:base']) base = absolute(node.attrs['xml:base'], base)
    const baseNode = children(node, 'baseurl')[0]
    if (baseNode?.text?.trim()) base = absolute(baseNode.text, base)
  }
  return base
}
function templateUrl(pattern, representation, number, time) {
  const escaped = '\u0000'
  const result = String(pattern || '').replace(/\$\$/g, escaped).replace(/\$([^$]+)\$/g, (_all, token) => {
    const match = token.match(/^(RepresentationID|Number|Time|Bandwidth)(?:%0(\d{1,2})d)?$/)
    if (!match) throw unsupported('DASH adres şablonu desteklenmiyor.')
    const value = { RepresentationID: representation.id, Number: number, Time: time, Bandwidth: representation.bandwidth }[match[1]]
    if (value === undefined || value === null || value === '') throw unsupported('DASH adres şablonunda gerekli değer eksik.')
    if (match[2] && (match[1] === 'RepresentationID' || Number(match[2]) > 20)) throw unsupported('DASH adres biçimi desteklenmiyor.')
    return match[2] ? String(value).padStart(Number(match[2]), '0') : String(value)
  })
  if (result.includes('$')) throw unsupported('DASH adres şablonu tamamlanmadı.')
  return result.replaceAll(escaped, '$')
}
function rangeFor(raw) {
  if (raw === undefined) return null
  const match = String(raw).match(/^(\d+)-(\d+)$/)
  if (!match) throw unsupported('DASH bayt aralığı geçersiz.')
  const start = integer(match[1], null), end = integer(match[2], null)
  if (end < start || end - start + 1 > 64 * 1024 * 1024) throw unsupported('DASH bayt aralığı boyut sınırını aştı.')
  return { start, end }
}
function addressing(chain) {
  let kind = null, attrs = {}, timeline = null, list = null, initialization = null
  for (const node of chain) {
    const nodes = (node.children || []).filter((child) => ['segmenttemplate', 'segmentlist', 'segmentbase'].includes(child.name))
    if (nodes.length > 1) throw unsupported('Bir DASH temsilinde birden fazla adresleme yöntemi var.')
    if (!nodes.length) continue
    const current = nodes[0]
    if (current.name !== kind) { attrs = {}; timeline = null; list = null; initialization = null }
    kind = current.name
    Object.assign(attrs, current.attrs)
    timeline = children(current, 'segmenttimeline')[0] || timeline
    initialization = children(current, 'initialization')[0] || initialization
    if (children(current, 'segmenturl').length) list = children(current, 'segmenturl')
  }
  return { kind, attrs, timeline, list, initialization }
}
function timelineFor(address, duration) {
  const scale = integer(address.attrs.timescale, 1, 1)
  const offset = integer(address.attrs.presentationtimeoffset, 0)
  const end = offset + duration * scale
  if (!Number.isFinite(end) || end > Number.MAX_SAFE_INTEGER) throw unsupported('DASH zaman çizelgesi sınırı aştı.')
  const entries = children(address.timeline, 's')
  const result = []
  let time = 0, number = integer(address.attrs.startnumber, 1), generated = 0
  function append(start, length) {
    if (++generated > MAX_SEGMENTS || !Number.isSafeInteger(start + length)) throw unsupported('DASH parça sayısı veya zaman sınırı aşıldı.')
    if (start + length > offset && start < end) {
      if (start < offset) throw unsupported('DASH dönem başlangıcı bir parçanın ortasında; güvenli kesim desteklenmiyor.')
      result.push({ time: start, number, duration: Math.min(length, end - start) / scale })
    }
    number += 1
    if (!Number.isSafeInteger(number)) throw unsupported('DASH parça sırası sınırı aştı.')
  }
  if (entries.length) {
    for (let i = 0; i < entries.length; i += 1) {
      const a = entries[i].attrs
      const start = integer(a.t, time), d = integer(a.d, null, 1)
      if (d === null) throw unsupported('DASH parça süresi eksik.')
      if (i && start !== time) throw unsupported('DASH zaman çizelgesinde boşluk veya çakışma var.')
      const repeat = a.r === '-1' ? -1 : integer(a.r, 0)
      const bound = repeat === -1 ? integer(entries[i + 1]?.attrs.t, end) : null
      const count = repeat === -1 ? Math.ceil((bound - start) / d) : repeat + 1
      if (!(count > 0) || count > MAX_SEGMENTS || repeat === -1 && i + 1 < entries.length && start + count * d !== bound) throw unsupported('DASH açık tekrarının sonu geçersiz.')
      for (let j = 0; j < count; j += 1) append(start + j * d, d)
      time = start + count * d
    }
  } else {
    if (offset) throw unsupported('Zaman çizelgesi olmayan DASH zaman kaydırması desteklenmiyor.')
    const d = integer(address.attrs.duration, null, 1)
    if (!d) throw unsupported('DASH parça süresi veya zaman çizelgesi gerekli.')
    const count = address.list?.length || Math.ceil(end / d)
    if (count > MAX_SEGMENTS) throw unsupported('DASH parça sayısı sınırı aşıldı.')
    for (let i = 0; i < count; i += 1) append(i * d, d)
    time = count * d
  }
  if (!result.length || result[0].time !== offset || time + 0.000001 < end) throw unsupported('DASH zaman çizelgesi dönemin tamamını kapsamıyor.')
  return result
}
function buildTrack(representation, duration, manifestUrl) {
  const address = addressing(representation.chain)
  if (!['segmenttemplate', 'segmentlist'].includes(address.kind)) throw unsupported('Bu DASH adresleme yöntemi henüz yerel aktarımda desteklenmiyor.')
  const base = baseFor(representation.chain, manifestUrl)
  const times = timelineFor(address, duration)
  let map = null
  if (address.attrs.initialization) map = { url: absolute(templateUrl(address.attrs.initialization, representation, 0, 0), base), init: true }
  else if (address.initialization) map = { url: absolute(address.initialization.attrs.sourceurl || base, base), range: rangeFor(address.initialization.attrs.range), init: true }
  if (!map) throw unsupported('DASH başlangıç parçası gerekli.')
  let segments
  if (address.kind === 'segmenttemplate') {
    if (!address.attrs.media) throw unsupported('DASH parça şablonu eksik.')
    segments = times.map((entry) => ({ url: absolute(templateUrl(address.attrs.media, representation, entry.number, entry.time), base), duration: entry.duration, map }))
  } else {
    if (!address.list || address.list.length !== times.length) throw unsupported('DASH parça listesi ve zaman çizelgesi eşleşmiyor.')
    segments = address.list.map((entry, index) => {
      if (entry.attrs.index || entry.attrs.indexrange) throw unsupported('DASH dış parça indeksi desteklenmiyor.')
      if (!entry.attrs.media && !entry.attrs.mediarange) throw unsupported('DASH parça adresi eksik.')
      return { url: absolute(entry.attrs.media || base, base), range: rangeFor(entry.attrs.mediarange), duration: times[index].duration, map }
    })
  }
  return { segments, duration, type: representation.type, language: representation.lang,
    codecs: representation.attrs.codecs || '', height: Number(representation.attrs.height) || null }
}

function parseManifest(text, manifestUrl, { quality = 0, audioOnly = false, preferredAudioLanguage = 'en' } = {}) {
  const tree = parseDashTree(text), info = parseDash(text)
  if (info.drm) throw Object.assign(new Error('Bu DASH akışı DRM korumalı; yerel aktarım desteklenmiyor.'), { code: 'DRM' })
  if (!tree || !info.valid) throw unsupported('DASH manifesti geçersiz.')
  if (info.live !== false || tree.attrs.type && tree.attrs.type !== 'static') throw unsupported('Yerel DASH aktarımı yalnızca sonlu VOD videolarını destekler.')
  const periodNodes = children(tree, 'period')
  if (!periodNodes.length || periodNodes.length > 64) throw unsupported('DASH dönem sayısı desteklenmiyor.')
  const periods = []
  let expectedStart = 0, totalSegments = 0
  const preferred = languageCode(preferredAudioLanguage)
  for (let index = 0; index < periodNodes.length; index += 1) {
    const periodNode = periodNodes[index], bound = info.periods[index]
    if (!(bound?.duration > 0) || Math.abs(bound.start - expectedStart) > 0.001) throw unsupported('DASH dönemleri sonlu ve kesintisiz olmalı.')
    const representations = []
    for (const set of children(periodNode, 'adaptationset')) for (const node of children(set, 'representation')) {
      const attrs = { ...set.attrs, ...node.attrs }
      const kind = `${attrs.contenttype || ''} ${attrs.mimetype || ''} ${attrs.codecs || ''}`
      const type = /audio|(?:^|\s)(?:mp4a|opus|vorbis|ac-3|ec-3)/i.test(kind) ? 'audio'
        : /video|(?:^|\s)(?:avc|hvc|hev|vp0?9|av01)/i.test(kind) || Number(attrs.height) > 0 ? 'video' : null
      if (!type) continue
      if (!/mp4/i.test(attrs.mimetype || '') && attrs.mimetype) throw unsupported('Yerel DASH aktarımı MP4 başlangıç/parçalarını destekler.')
      representations.push({ type, attrs, id: node.attrs.id || '', lang: attrs.lang || '',
        bandwidth: integer(attrs.bandwidth, 0), chain: [tree, periodNode, set, node] })
    }
    let video = null, audio = null
    if (!audioOnly) {
      const videos = representations.filter((r) => r.type === 'video')
      const cap = Math.max(0, Number(quality) || 0)
      const choices = videos.filter((r) => !cap || Number(r.attrs.height) > 0 && Number(r.attrs.height) <= cap)
      choices.sort((a, b) => (Number(b.attrs.height) || 0) - (Number(a.attrs.height) || 0) || b.bandwidth - a.bandwidth)
      video = choices[0] || null
      if (videos.length && !video) throw unsupported('DASH manifestinde seçilen kalite sınırına uygun temsil yok.')
    }
    const audios = representations.filter((r) => r.type === 'audio')
    const score = (r) => !preferred || preferred === 'auto' ? 0 : languageCode(r.lang) === preferred ? 2 : !r.lang || r.lang === 'und' ? 1 : 0
    audios.sort((a, b) => score(b) - score(a) || b.bandwidth - a.bandwidth)
    audio = pickAudioTrack(audios, preferredAudioLanguage)
    if ((!video && !audio) || audioOnly && !audio) throw unsupported('DASH manifestinde istenen medya izi bulunamadı.')
    const tracks = [video, audio].filter(Boolean).map((r) => buildTrack(r, bound.duration, manifestUrl))
    totalSegments += tracks.reduce((sum, track) => sum + track.segments.length, 0)
    if (totalSegments > MAX_SEGMENTS) throw unsupported('DASH toplam parça sayısı sınırı aşıldı.')
    periods.push({ duration: bound.duration, tracks, audioLanguage: audio?.lang || null })
    expectedStart += bound.duration
  }
  return { periods, duration: expectedStart }
}

function cleanCache(destPath) {
  const dir = `${destPath}.dash`
  try { if (JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'))).magic === 'AIO_DASH1') fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}
async function hashFile(file, signal) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) { if (signal?.aborted) throw stopped(); hash.update(chunk) }
  return hash.digest('hex')
}
async function signature(file, signal) {
  const bin = ffprobePath()
  if (!bin) throw unsupported('Çok dönemli DASH birleştirmesini doğrulamak için ffprobe gerekli.')
  const output = await new Promise((resolve, reject) => {
    execFile(bin, ['-v', 'error', '-show_streams', '-show_data', '-of', 'json', file],
      { env: toolEnv(), signal, timeout: 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, out) => err ? reject(err) : resolve(out))
  })
  const streams = JSON.parse(output).streams || []
  if (!streams.length) throw unsupported('DASH döneminde okunabilir medya izi yok.')
  const fields = ['codec_type', 'codec_name', 'profile', 'width', 'height', 'pix_fmt', 'sample_aspect_ratio', 'sample_rate', 'channels', 'channel_layout', 'time_base', 'extradata']
  return JSON.stringify(streams.map((stream) => Object.fromEntries(fields.map((key) => [key, stream[key] ?? null]))))
}

function periodProgress(progress, { elapsed, periodDuration, totalDuration, savedBytes, expectedSize }) {
  const downloaded = savedBytes + Math.max(0, Number(progress.downloaded) || 0)
  const currentTotal = Number(progress.total)
  const estimate = Number(expectedSize) > 0 ? Number(expectedSize)
    : currentTotal > 0 && periodDuration > 0 ? savedBytes + currentTotal * (totalDuration - elapsed) / periodDuration : null
  const total = estimate ? Math.max(downloaded, Math.round(estimate)) : null
  const speed = Number(progress.speed)
  // A period's ETA stops at that period, not at the end of the recording.
  // Keep the child's warm-up/idle confidence, then include all future bytes.
  const eta = progress.eta !== null && progress.eta !== undefined && speed > 0 && total > downloaded
    ? Math.ceil((total - downloaded) / speed) : null
  return { ...progress, downloaded, total, totalExact: false, eta,
    percent: Math.min(0.999, (elapsed + periodDuration * (Number(progress.percent) || 0)) / totalDuration) }
}

async function transferDash({ url, resolved, destPath, download, settings, proxy = '', signal,
  onProgress, onHandle, onNote, onStage, limit = null }) {
  const controller = new AbortController()
  let muxer = null
  const abort = () => { controller.abort(); muxer?.kill('SIGTERM') }
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  onHandle?.({ kill: abort })
  const dir = `${destPath}.dash`, journal = path.join(dir, 'plan.json')
  try {
    let finalUrl = url
    const bytes = await requestBytes(url, resolved, { proxy, signal: controller.signal, maxBytes: 2 * 1024 * 1024, maximum: settings.connections,
      onResponse: (response) => { finalUrl = response.finalUrl || url } })
    const manifest = parseManifest(bytes.toString('utf8'), finalUrl, { quality: download.quality,
      audioOnly: download.audioOnly, preferredAudioLanguage: download.preferredAudioLanguage || settings.preferredAudioLanguage || 'en' })
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
    let plan = null
    try { plan = JSON.parse(await fsp.readFile(journal, 'utf8')) } catch {}
    if (fs.existsSync(dir) && plan?.magic !== 'AIO_DASH1') throw unsupported('DASH geçici klasörü başka dosyalara ait; üzerine yazılmadı.')
    if (!plan || plan.fingerprint !== fingerprint) {
      cleanCache(destPath)
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
      plan = { magic: 'AIO_DASH1', fingerprint, completed: {} }
      atomicWrite(journal, JSON.stringify(plan))
    }
    if (!plan.completed || typeof plan.completed !== 'object' || Array.isArray(plan.completed)) throw unsupported('DASH devam günlüğü geçersiz.')
    const files = []
    let elapsed = 0, savedBytes = 0, firstSignature = null
    for (const [index, period] of manifest.periods.entries()) {
      if (controller.signal.aborted) throw stopped()
      const file = path.join(dir, `period-${index}.mkv`)
      const record = plan.completed[index]
      let cached = false
      if (record?.hash && Number.isSafeInteger(record.size) && record.size > 0) {
        try { cached = (await fsp.stat(file)).size === record.size && await hashFile(file, controller.signal) === record.hash } catch {}
      }
      if (!cached) {
        // This is a generated path in a validated owned cache; failed/stale
        // period output cannot be confused with a user file.
        await fsp.rm(file, { force: true })
        onNote?.(`DASH dönemi ${index + 1}/${manifest.periods.length} alınıyor`)
        await transferHls({ preparedTracks: period.tracks, mediaLabel: 'DASH',
          audioUrl: period.tracks.length > 1 ? 'prepared-audio' : null, audioLanguage: period.audioLanguage,
          resolved, destPath: file, download: { ...download, audioOnly: false }, settings, proxy,
          signal: controller.signal, onHandle, onNote, onStage, limit, outputDuration: period.duration,
          onProgress: (progress) => onProgress?.(periodProgress(progress, { elapsed, savedBytes,
            periodDuration: period.duration, totalDuration: manifest.duration, expectedSize: download.expectedSize })) })
        plan.completed[index] = { size: (await fsp.stat(file)).size, hash: await hashFile(file, controller.signal) }
        atomicWrite(journal, JSON.stringify(plan))
      }
      if (manifest.periods.length > 1) {
        const currentSignature = await signature(file, controller.signal)
        if (firstSignature && firstSignature !== currentSignature) throw unsupported('DASH dönemlerinin codec veya medya özellikleri farklı; kayıpsız yerel birleştirme güvenli değil.')
        firstSignature = currentSignature
      }
      files.push(file)
      elapsed += period.duration
      savedBytes += plan.completed[index].size
    }
    if (controller.signal.aborted) throw stopped()
    require('./disk-space').assertSpace(path.dirname(destPath), { requiredBytes: savedBytes, reserveBytes: 64 * 1024 * 1024 })
    const bin = ffmpegPath()
    if (!bin) throw new Error('DASH parçalarını birleştirmek için ffmpeg bulunamadı.')
    const list = path.join(dir, 'periods.ffconcat')
    await fsp.writeFile(list, 'ffconcat version 1.0\n' + files.map((_file, index) => `file 'period-${index}.mkv'\nduration ${manifest.periods[index].duration}\n`).join(''))
    const args = ['-hide_banner', '-v', 'warning', '-nostdin', '-y', '-protocol_whitelist', 'file',
      '-format_whitelist', 'concat,matroska,webm', '-f', 'concat', '-safe', '1', '-i', list]
    if (download.audioOnly) {
      args.push('-map', '0:a:0', '-vn', '-c:a', ...({ mp3: ['libmp3lame', '-q:a', '2'], m4a: ['aac', '-b:a', '192k'],
        opus: ['libopus', '-b:a', '160k'], flac: ['flac'], wav: ['pcm_s16le'] }[settings.audioFormat] || ['libmp3lame', '-q:a', '2']))
    } else args.push('-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy')
    // Concat inherits the first file's language metadata. Mixed/unknown period
    // languages must not make the entire output look like that first language.
    const audioLanguages = manifest.periods.map((period) => languageCode(period.audioLanguage || 'und'))
    const audioLanguage = audioLanguages.every((language) => language === audioLanguages[0]) ? audioLanguages[0] : 'und'
    if (audioLanguage) args.push('-metadata:s:a:0', `language=${({ en: 'eng', tr: 'tur' })[languageCode(audioLanguage)] || audioLanguage}`)
    const ext = path.extname(destPath).slice(1).toLowerCase()
    const mux = { mkv: 'matroska', mp4: 'mp4', m4a: 'ipod', mp3: 'mp3', opus: 'opus', flac: 'flac', wav: 'wav' }[ext] || 'mp4'
    if (mux === 'mp4') args.push('-movflags', '+faststart')
    args.push('-t', String(manifest.duration), '-f', mux, `${destPath}.part`)
    onStage?.('processing'); onNote?.('DASH dönemleri yerel olarak birleştiriliyor')
    await new Promise((resolve, reject) => {
      let stderr = '', integrityError = null
      muxer = spawn(bin, args, { env: toolEnv(), windowsHide: true })
      onHandle?.(muxer)
      const timeout = setTimeout(() => muxer.kill('SIGKILL'), 900000)
      muxer.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-3000); integrityError ||= require('./ownengine').muxIntegrityIssue(stderr) })
      muxer.once('error', (error) => { clearTimeout(timeout); reject(error) })
      muxer.once('close', (code) => { clearTimeout(timeout); controller.signal.aborted ? reject(stopped()) : integrityError ? reject(integrityError) : code === 0 ? resolve() : reject(new Error(stderr.trim() || 'DASH birleştirme başarısız.')) })
    })
    if (controller.signal.aborted) throw stopped()
    if (!(await fsp.stat(`${destPath}.part`)).size) throw new Error('DASH çıktısı boş.')
    await fsp.rename(`${destPath}.part`, destPath)
    cleanCache(destPath)
    return { filePath: destPath }
  } catch (error) {
    if (signal?.aborted || controller.signal.aborted && ['ABORT_ERR', 'ABORTED'].includes(error.code)) throw stopped()
    throw error
  } finally { signal?.removeEventListener('abort', abort) }
}

module.exports = { parseManifest, transferDash, cleanCache, periodProgress }
