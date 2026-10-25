'use strict'

// VOD fragments are fetched by our own HTTP engine. FFmpeg only remuxes local,
// verified pieces at the end; it never opens remote manifests or key URLs here.
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { spawn, execFile } = require('child_process')
const { fetchHeaders } = require('./mediainfo')
const { ffmpegPath, toolEnv } = require('./binaries')
const { atomicWrite, settingNumber } = require('./util')
const { httpError, failureKind, retryDelay, sleep } = require('./recovery')
const { TransferStats } = require('./transfer-stats')
const { languageCode } = require('./media-preferences')

const MAX_FRAGMENT = 64 * 1024 * 1024
const capabilities = new Map()
function pickyOption(bin) {
  if (!capabilities.has(bin)) capabilities.set(bin, new Promise((resolve) => {
    execFile(bin, ['-hide_banner', '-h', 'demuxer=hls'], { env: toolEnv(), timeout: 5000, windowsHide: true }, (_err, out, stderr) => resolve(/extension_picky/.test(String(out) + stderr)))
  }))
  return capabilities.get(bin)
}
const unsupported = (message) => Object.assign(new Error(message), { code: 'HLS_UNSUPPORTED' })
const stopped = () => Object.assign(new Error('Aktarım durduruldu.'), { code: 'ABORTED' })
const attrs = (line) => Object.fromEntries([...line.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,\s]+))/gi)].map((m) => [m[1].toUpperCase(), m[2] ?? m[3]]))

function parseMediaPlaylist(text, baseUrl) {
  if (!/^\s*#EXTM3U/.test(text) || /#EXT-X-STREAM-INF:/i.test(text)) throw unsupported('Önce bir medya varyantı seçilmeli.')
  if (!/#EXT-X-ENDLIST/.test(text)) throw unsupported('Canlı HLS akışı FFmpeg ile aktarılır.')
  if (/#EXT-X-GAP|#EXT-X-PART:|#EXT-X-SKIP:/.test(text)) throw unsupported('Bu HLS türü henüz yerel parça aktarımında desteklenmiyor.')
  const absolute = (raw) => {
    const url = new URL(raw, baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw unsupported('HLS kaynağı HTTP/HTTPS olmalı.')
    return url.href
  }
  let key = null, map = null, duration = null, range = null, previous = null, discontinuity = false
  let sequence = 0n
  const segments = []
  const parseRange = (value, url) => {
    if (!value) return null
    const match = value.match(/^(\d+)(?:@(\d+))?$/)
    if (!match) throw unsupported('HLS bayt aralığı okunamadı.')
    const size = Number(match[1])
    const start = match[2] !== undefined ? Number(match[2]) : previous?.url === url && previous.range ? previous.range.end + 1 : NaN
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || size <= 0 || start < 0 || size > MAX_FRAGMENT) throw unsupported('HLS bayt aralığı geçersiz.')
    if (!Number.isSafeInteger(start + size - 1)) throw unsupported('HLS bayt aralığı çok büyük.')
    return { start, end: start + size - 1 }
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = BigInt(line.split(':')[1].trim())
    else if (line.startsWith('#EXT-X-KEY:')) {
      const a = attrs(line)
      if (a.METHOD === 'NONE') key = null
      else if (a.METHOD !== 'AES-128' || a.KEYFORMAT && a.KEYFORMAT !== 'identity') throw new Error('Bu HLS akışı DRM korumalı veya desteklenmeyen bir şifreleme kullanıyor.')
      else {
        if (!a.URI) throw unsupported('AES-128 anahtar adresi eksik.')
        if (a.IV && !/^0x[0-9a-f]{1,32}$/i.test(a.IV)) throw unsupported('AES-128 IV geçersiz.')
        key = { url: absolute(a.URI), iv: a.IV ? a.IV.slice(2).padStart(32, '0') : null }
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = attrs(line)
      if (key && !key.iv) throw unsupported('Şifreli HLS init parçasında açık IV gerekli.')
      const url = absolute(a.URI)
      map = { url, range: parseRange(a.BYTERANGE, url), key: key ? { ...key } : null, init: true }
    } else if (line.startsWith('#EXTINF:')) duration = parseFloat(line.slice(8))
    else if (line.startsWith('#EXT-X-BYTERANGE:')) range = line.slice(17).trim()
    else if (line === '#EXT-X-DISCONTINUITY') discontinuity = true
    else if (line && !line.startsWith('#')) {
      if (!(duration > 0) || !Number.isFinite(duration)) throw unsupported('HLS parça süresi eksik.')
      const url = absolute(line)
      const segment = { url, range: parseRange(range, url), duration, discontinuity,
        key: key ? { ...key, iv: key.iv || sequence.toString(16).padStart(32, '0') } : null,
        map, sequence: sequence.toString() }
      segments.push(segment); previous = segment
      if (segments.length > 50000) throw unsupported('HLS parça sınırı aşıldı.')
      sequence += 1n; duration = null; range = null; discontinuity = false
    }
  }
  if (!segments.length) throw unsupported('HLS parçası bulunamadı.')
  return { segments, duration: segments.reduce((sum, s) => sum + s.duration, 0) }
}

async function requestBytes(url, resolved, { proxy, signal, range, maxBytes = MAX_FRAGMENT, onBytes, onResponse, limit, maximum = 8 } = {}) {
  const { openStream } = require('./ownengine')
  const headers = { ...fetchHeaders(url, resolved), 'Accept-Encoding': 'identity' }
  if (range) headers.Range = `bytes=${range.start}-${range.end}`
  const permit = await require('./host-budget').acquire(url, { proxy, signal, maximum })
  let res, failure = null
  try {
    res = await openStream(url, headers, { proxy, signal, resolved })
    onResponse?.(res)
    if (res.status !== 200 && res.status !== 206) throw httpError(res.status, res.headers)
    if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') throw unsupported('Parça yanıtı beklenmeyen içerik kodlaması kullandı.')
    const returned = String(res.headers['content-range'] || '').match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i)
    if (range) {
      if (res.status !== 206 || !returned || Number(returned[1]) !== range.start || Number(returned[2]) !== range.end) throw unsupported('HLS sunucusu yanlış bayt aralığı döndürdü.')
    } else if (res.status === 206 && (!returned || Number(returned[1]) !== 0 || !Number.isSafeInteger(Number(returned[3])) || Number(returned[2]) + 1 !== Number(returned[3]))) {
      throw unsupported('Sunucu tam parça yerine eksik bayt aralığı döndürdü.')
    }
    const declared = Number(res.headers['content-length']) || 0
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) throw unsupported('Parça boyut sınırını aştı.')
    let size = 0
    const chunks = []
    for await (const chunk of res.stream) {
      if (signal?.aborted) throw stopped()
      size += chunk.length
      if (size > maxBytes) throw unsupported('Parça boyut sınırını aştı.')
      if (limit) await limit(chunk.length)
      chunks.push(chunk); onBytes?.(size, declared)
    }
    if (!size || declared && size !== declared || range && size !== range.end - range.start + 1) throw Object.assign(new Error('Parça eksik indi.'), { code: 'ECONNRESET' })
    return Buffer.concat(chunks)
  } catch (error) { failure = error; throw error }
  finally { res?.request.destroy(); permit.release(failure) }
}

function decryptSegment(bytes, key) {
  if (!key) return bytes
  if (key.bytes.length !== 16) throw new Error('HLS AES-128 anahtarı 16 bayt olmalı.')
  const decipher = crypto.createDecipheriv('aes-128-cbc', key.bytes, Buffer.from(key.iv, 'hex'))
  return Buffer.concat([decipher.update(bytes), decipher.final()])
}

function mediaBytes(bytes) {
  // Some CDNs prefix a TS fragment with a small image-like marker. Only trim a
  // prefix after finding three correctly spaced transport sync bytes.
  for (let offset = 0; offset < Math.min(4096, bytes.length - 376); offset += 1) {
    if (bytes[offset] === 0x47 && bytes[offset + 188] === 0x47 && bytes[offset + 376] === 0x47) return bytes.subarray(offset)
  }
  if (bytes.length >= 8 && /^(ftyp|styp|moof|moov|mdat|sidx)$/.test(bytes.subarray(4, 8).toString('ascii'))) return bytes
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0 || bytes[0] === 0x0b && bytes[1] === 0x77) return bytes
  throw unsupported('HLS parçasının içeriği desteklenen TS/MP4/AAC biçiminde değil.')
}

function cleanCache(destPath) {
  const dir = `${destPath}.segments`
  try {
    if (JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'))).magic === 'AIO_HLS1') fs.rmSync(dir, { recursive: true, force: true })
  } catch {}
}

async function transferHls({ url, audioUrl = null, audioLanguage = null, resolved, destPath, download, settings,
  proxy = '', signal, onProgress, onHandle, onNote, onStage, limit = null, sampleSegments = 0, preparedTracks = null, mediaLabel = 'HLS', outputDuration = null }) {
  const controller = new AbortController()
  let muxer = null
  const abort = () => { controller.abort(); muxer?.kill('SIGTERM') }
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  onHandle?.({ kill: abort })
  const dir = `${destPath}.segments`
  const journalPath = path.join(dir, 'plan.json')
  let ticker = null
  const keys = new Map()
  const connections = Math.floor(settingNumber(settings.connections, 8, { min: 1, max: 16 }))
  const save = (plan) => atomicWrite(journalPath, JSON.stringify(plan))
  try {
    let tracks = preparedTracks
    if (!tracks) {
    const trackUrls = [url, ...(audioUrl ? [audioUrl] : [])]
    let manifestError = null
    const trackResults = await Promise.allSettled(trackUrls.map(async (trackUrl) => {
      try {
      let finalUrl = trackUrl
      const bytes = await requestBytes(trackUrl, resolved, { proxy, signal: controller.signal, maxBytes: 2 * 1024 * 1024, maximum: connections, onResponse: (r) => { finalUrl = r.finalUrl || trackUrl } })
      const track = parseMediaPlaylist(bytes.toString('utf8'), finalUrl)
      if (sampleSegments > 0) { track.segments = track.segments.slice(0, Math.min(3, sampleSegments)); track.duration = track.segments.reduce((sum, s) => sum + s.duration, 0) }
      return track
      } catch (err) { manifestError ||= err; controller.abort(); throw err }
    }))
    if (manifestError) throw manifestError
    tracks = trackResults.map((r) => r.value)
    }
    if (!tracks.length || tracks.some((track) => !track.segments?.length || !(track.duration > 0))) throw unsupported('Parça listesi boş veya süresi geçersiz.')
    const tasks = []
    tracks.forEach((track, trackIndex) => {
      const maps = new Map()
      for (const segment of track.segments) {
        if (segment.map) {
          const id = JSON.stringify(segment.map)
          if (!maps.has(id)) {
            const task = { ...segment.map, trackIndex, index: tasks.length }
            tasks.push(task); maps.set(id, task.index)
          }
          segment.mapIndex = maps.get(id)
        }
        segment.taskIndex = tasks.length
        tasks.push({ ...segment, trackIndex, index: tasks.length })
      }
    })
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(tasks)).digest('hex')
    let plan = null
    try { plan = JSON.parse(await fsp.readFile(journalPath, 'utf8')) } catch {}
    if (fs.existsSync(dir) && !plan) throw unsupported('HLS geçici klasörü başka bir dosyaya ait; üzerine yazılmadı.')
    if (!plan || plan.magic !== 'AIO_HLS1' || plan.fingerprint !== fingerprint || !plan.completed || typeof plan.completed !== 'object') {
      if (plan?.magic === 'AIO_HLS1') cleanCache(destPath)
      else if (plan) throw unsupported('HLS geçici klasörü tanınmıyor.')
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
      plan = { magic: 'AIO_HLS1', fingerprint, completed: {} }; save(plan)
    }
    let completedBytes = 0
    for (const [id, record] of Object.entries(plan.completed)) {
      if (!/^\d+$/.test(id) || !tasks[Number(id)] || !record || !Number.isSafeInteger(record.size) || record.size <= 0 || record.size > MAX_FRAGMENT) { delete plan.completed[id]; continue }
      try {
        const data = await fsp.readFile(path.join(dir, `${id}.bin`))
        if (data.length !== record.size || crypto.createHash('sha256').update(data).digest('hex') !== record.hash) throw new Error('bad cached fragment')
        completedBytes += data.length
      } catch { delete plan.completed[id] }
      if (controller.signal.aborted) throw stopped()
    }
    save(plan)
    const stats = new TransferStats(0)
    let wireBytes = 0
    const active = new Map()
    let lastReport = 0, lastSave = Date.now()
    const report = (force = false) => {
      const now = Date.now()
      if (!force && now - lastReport < 400) return
      lastReport = now
      const downloaded = completedBytes + [...active.values()].reduce((sum, p) => sum + p.done, 0)
      const doneDuration = tracks.map((track) => track.segments.filter((s) => plan.completed[s.taskIndex]).reduce((sum, s) => sum + s.duration, 0))
      const fraction = tracks.reduce((sum, track, i) => sum + doneDuration[i] / track.duration * (i ? 0.08 : 1), 0) / (audioUrl ? 1.08 : 1)
      let estimate = 0
      let confident = true
      tracks.forEach((track, i) => {
        const records = track.segments.filter((s) => plan.completed[s.taskIndex])
        const bytes = records.reduce((sum, s) => sum + plan.completed[s.taskIndex].size, 0)
        if (records.length < Math.min(3, track.segments.length)) confident = false
        estimate += doneDuration[i] > 0 ? bytes / doneDuration[i] * track.duration : 0
      })
      const total = confident ? Math.max(downloaded, Math.round(estimate)) : download.expectedSize || null
      // AES padding and CDN prefixes disappear after decoding; keep throughput
      // monotonic by counting actual network bytes separately from saved bytes.
      const target = total ? wireBytes + Math.max(0, total - downloaded) : null
      onProgress?.({ downloaded, total, totalExact: false, ...stats.update(wireBytes, target),
        percent: Math.min(0.999, fraction), parts: [...active.values()] })
      if (now - lastSave > 1000) { save(plan); lastSave = now }
    }
    ticker = setInterval(() => report(), 500)
    const remaining = tasks.filter((task) => !plan.completed[task.index])
    onNote?.(`${remaining.length}/${tasks.length} ${mediaLabel} parçası alınacak; tamamlanan parçalar korunuyor`)
    let cursor = 0, firstError = null
    const loadKey = (key) => {
      if (!keys.has(key.url)) keys.set(key.url, requestBytes(key.url, resolved, { proxy, signal: controller.signal, maxBytes: 16, maximum: connections }).then((bytes) => {
        if (bytes.length !== 16) throw new Error('HLS anahtarı geçersiz.')
        return bytes
      }).catch((err) => { keys.delete(key.url); throw err }))
      return keys.get(key.url)
    }
    const worker = async () => {
      while (cursor < remaining.length && !controller.signal.aborted) {
        const task = remaining[cursor++]
        for (let attempt = 0; ; attempt += 1) {
          try {
            let received = 0
            const bytes = await requestBytes(task.url, resolved, { proxy, signal: controller.signal, range: task.range, limit, maximum: connections,
              onBytes: (done, size) => { wireBytes += done - received; received = done; active.set(task.index, { done, size: size || done }); report() } })
            let data = decryptSegment(bytes, task.key ? { ...task.key, bytes: await loadKey(task.key) } : null)
            if (/^\s*(?:<!doctype|<html|\{\s*"(?:error|message)")/i.test(data.subarray(0, 200).toString('utf8'))) throw Object.assign(new Error('Akış adresi geçmiş; HLS sunucusu video yerine hata sayfası döndürdü.'), { status: 403 })
            data = mediaBytes(data)
            const file = path.join(dir, `${task.index}.bin`)
            await fsp.writeFile(file + '.tmp', data)
            await fsp.rename(file + '.tmp', file)
            plan.completed[task.index] = { size: data.length, hash: crypto.createHash('sha256').update(data).digest('hex') }
            completedBytes += data.length; active.delete(task.index); report()
            break
          } catch (err) {
            active.delete(task.index)
            if (controller.signal.aborted) throw stopped()
            const kind = failureKind(err)
            if (!['network', 'busy'].includes(kind) || attempt >= 3) throw err
            onNote?.(`${mediaLabel} parçası yeniden deneniyor (${attempt + 1}/3)`)
            await sleep(retryDelay(attempt, kind, err.retryAfter), controller.signal)
          }
        }
      }
    }
    await Promise.allSettled(Array.from({ length: Math.min(connections, Math.max(1, remaining.length)) }, () => worker().catch((err) => { firstError ||= err; controller.abort() })))
    save(plan)
    if (firstError) throw firstError
    if (controller.signal.aborted) throw stopped()
    if (tasks.some((task) => !plan.completed[task.index])) throw new Error('Video parçaları eksik indi; yerel birleştirme yapılmadı.')
    report(true)
    clearInterval(ticker); ticker = null
    // The locally generated playlists contain no remote/key URI. FFmpeg is
    // deliberately restricted to the file protocol during this final step.
    const localTracks = []
    for (const [trackIndex, track] of tracks.entries()) {
      const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...track.segments.map((s) => s.duration)))}`, '#EXT-X-MEDIA-SEQUENCE:0']
      let lastMap = null
      for (const segment of track.segments) {
        if (segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY')
        if (segment.mapIndex !== undefined && lastMap !== segment.mapIndex) { lines.push(`#EXT-X-MAP:URI="${segment.mapIndex}.bin"`); lastMap = segment.mapIndex }
        lines.push(`#EXTINF:${segment.duration},`, `${segment.taskIndex}.bin`)
      }
      lines.push('#EXT-X-ENDLIST')
      const local = path.join(dir, `track-${trackIndex}.m3u8`)
      await fsp.writeFile(local, lines.join('\n') + '\n'); localTracks.push(local)
    }
    onStage?.('processing'); onNote?.(`${mediaLabel} parçaları yerel olarak birleştiriliyor`)
    const bin = ffmpegPath()
    if (!bin) throw new Error('Parçaları birleştirmek için ffmpeg bulunamadı.')
    const inputBytes = Object.values(plan.completed).reduce((sum, record) => sum + record.size, 0)
    require('./disk-space').assertSpace(path.dirname(destPath), { requiredBytes: inputBytes, reserveBytes: 64 * 1024 * 1024 })
    const extraHls = await pickyOption(bin) ? ['-extension_picky', '0'] : []
    const args = ['-hide_banner', '-v', 'warning', '-nostdin', '-y']
    // bin is a generated local filename; whitelist the media demuxer formats as
    // well as file access, never accept arbitrary remote manifest protocols.
    for (const local of localTracks) args.push('-protocol_whitelist', 'file', '-format_whitelist', 'hls,mov,mpegts,aac,ac3,eac3', '-allowed_extensions', 'bin', ...extraHls, '-i', local)
    if (download.audioOnly) {
      args.push('-map', audioUrl ? '1:a:0' : '0:a:0', '-vn')
      const codecs = { mp3: ['libmp3lame', '-q:a', '2'], m4a: ['aac', '-b:a', '192k'], opus: ['libopus', '-b:a', '160k'], flac: ['flac'], wav: ['pcm_s16le'] }
      args.push('-c:a', ...(codecs[settings.audioFormat] || codecs.mp3))
    } else {
      args.push('-map', '0:v:0?', '-map', audioUrl ? '1:a:0' : '0:a?', '-c', 'copy')
      if (audioLanguage) args.push('-metadata:s:a:0', `language=${({ en: 'eng', tr: 'tur' })[languageCode(audioLanguage)] || audioLanguage}`)
    }
    const ext = path.extname(destPath).slice(1).toLowerCase()
    const mux = { mkv: 'matroska', mp4: 'mp4', m4a: 'ipod', mp3: 'mp3', opus: 'opus', flac: 'flac', wav: 'wav' }[ext] || 'mp4'
    if (mux === 'mp4') args.push('-movflags', '+faststart')
    const work = `${destPath}.part`
    if (outputDuration > 0) args.push('-t', String(outputDuration))
    args.push('-f', mux, work)
    if (controller.signal.aborted) throw stopped()
    await new Promise((resolve, reject) => {
      let stderr = '', integrityError = null
      muxer = spawn(bin, args, { env: toolEnv(), windowsHide: true })
      onHandle?.(muxer)
      const timeout = setTimeout(() => muxer.kill('SIGKILL'), 900000)
      muxer.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-3000); integrityError ||= require('./ownengine').muxIntegrityIssue(stderr) })
      muxer.on('error', (err) => { clearTimeout(timeout); reject(err) })
      muxer.on('close', (code) => { clearTimeout(timeout); controller.signal.aborted ? reject(stopped()) : integrityError ? reject(integrityError) : code === 0 ? resolve() : reject(new Error(stderr.trim() || 'HLS birleştirme başarısız.')) })
    })
    if (controller.signal.aborted || signal?.aborted) throw stopped()
    if (!(await fsp.stat(work)).size) throw new Error('HLS çıktısı boş.')
    await fsp.rename(work, destPath)
    cleanCache(destPath)
    return { filePath: destPath }
  } catch (err) {
    if (signal?.aborted || err.code === 'ABORT_ERR') throw stopped()
    throw err
  } finally {
    clearInterval(ticker)
    signal?.removeEventListener('abort', abort)
    for (const pending of keys.values()) pending.then((bytes) => bytes.fill(0)).catch(() => {})
  }
}

module.exports = { parseMediaPlaylist, decryptSegment, mediaBytes, requestBytes, transferHls, cleanCache }
