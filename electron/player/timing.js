'use strict'

// Packet timing only: no frame decoding, image extraction or retained media.
// A long video frame alone can be valid VFR. Corroborating a matching jump in a
// fixed-frame AAC stream is much stronger evidence of an incomplete recording.
const MAX_ANOMALIES = 10000
const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null
const timestamp = (value) => /^-?\d+(?:\.\d+)?$/.test(String(value)) && Number.isFinite(Number(value)) ? Number(value) : null

function createTimingAnalyzer(media) {
  const video = media?.video || null
  const audio = (media?.audio || []).filter((track) => Number.isInteger(track.streamIndex))
  const fps = positive(video?.frameRate)
  const nominalVideo = fps ? 1 / fps : null
  const videoThreshold = Math.max(0.5, nominalVideo ? nominalVideo * 5 : 1)
  const audioByIndex = new Map(audio.map((track) => [track.streamIndex, track]))
  const previous = new Map()
  const videoLong = [], audioLong = [], audioJumps = []
  let packets = 0, durationKnown = 0, priorVideo = null
  const add = (list, value) => {
    if (list.length >= MAX_ANOMALIES) throw new Error('Dosyada çok fazla zamanlama sapması var; kontrol sınırına ulaşıldı.')
    list.push(value)
  }
  return {
    push(line) {
      const fields = Object.fromEntries(line.trim().split('|').map((field) => {
        const at = field.indexOf('=')
        return [field.slice(0, at), field.slice(at + 1)]
      }).filter(([key]) => ['stream_index', 'pts_time', 'dts_time', 'duration_time'].includes(key)))
      if (!/^\d+$/.test(fields.stream_index || '')) return
      const index = Number(fields.stream_index)
      const isVideo = video && index === video.streamIndex
      const track = audioByIndex.get(index)
      if (!isVideo && !track) return
      packets += 1
      const dts = timestamp(fields.dts_time)
      const at = dts ?? timestamp(fields.pts_time)
      const clock = dts !== null ? 'dts' : 'pts'
      const duration = positive(fields.duration_time)
      if (duration) durationKnown += 1
      if (isVideo && at !== null) {
        // Matroska often keeps a normal packet duration across a missing span.
        // Decode timestamps avoid mistaking ordinary B-frame PTS reordering for
        // missing content. Do not compare two different timestamp clocks.
        if (priorVideo && priorVideo.clock === clock && !priorVideo.long && at - priorVideo.at > videoThreshold) {
          add(videoLong, { at: priorVideo.at, duration: at - priorVideo.at })
        }
        const long = !!(duration && duration > videoThreshold)
        if (long) add(videoLong, { at, duration })
        priorVideo = { at, clock, long }
      }
      if (track) {
        // AAC-LC's 1024-sample cadence gives an independent expectation even
        // when the MP4 demuxer stretched a packet's declared duration over a gap.
        const nominal = track.codec === 'aac' && positive(track.sampleRate) ? 1024 / track.sampleRate : null
        const threshold = Math.max(0.5, nominal ? nominal * 5 : 1)
        if (duration && duration > threshold && at !== null) add(audioLong, { at, duration, streamIndex: index })
        const prior = previous.get(index)
        if (at !== null && prior !== undefined && at - prior > threshold) {
          add(audioJumps, { at: prior, duration: at - prior, streamIndex: index, fixedCadence: !!nominal, nominal })
        }
      }
      if (at !== null) previous.set(index, at)
    },
    finish() {
      // Binary search keeps completion bounded even for a corrupt recording
      // with thousands of gaps. Several language tracks count one video gap.
      videoLong.sort((a, b) => a.at - b.at)
      const matched = new Set()
      for (const gap of audioJumps) {
        if (!gap.fixedCadence) continue
        let low = 0, high = videoLong.length
        while (low < high) {
          const mid = (low + high) >> 1
          if (videoLong[mid].at < gap.at) low = mid + 1
          else high = mid
        }
        for (const index of [low - 1, low]) {
          const frame = videoLong[index]
          if (!frame || Math.abs(frame.at - gap.at) >= 0.3) continue
          const overlap = Math.min(frame.at + frame.duration, gap.at + gap.duration) - Math.max(frame.at, gap.at)
          if (overlap > Math.min(frame.duration, gap.duration) * 0.7) matched.add(index)
        }
      }
      const matches = [...matched].sort((a, b) => a - b).map((index) => videoLong[index])
      return {
        packetCount: packets,
        durationKnown,
        videoLongFrames: videoLong.length,
        audioLongPackets: audioLong.length,
        audioTimestampGaps: audioJumps.length,
        correlatedGaps: matches.length,
        longestVideoHold: videoLong.reduce((max, frame) => Math.max(max, frame.duration), 0),
        extraVideoHold: nominalVideo ? videoLong.reduce((sum, frame) => sum + Math.max(0, frame.duration - nominalVideo), 0) : null,
        firstVideoHolds: videoLong.slice(0, 8).map((frame) => ({ at: Math.max(0, frame.at), duration: frame.duration })),
        firstCorrelatedGaps: matches.slice(0, 8).map((frame) => ({ at: Math.max(0, frame.at), duration: frame.duration })),
        // This is packet evidence, not proof that every frame can be decoded.
        kind: matches.length ? 'matching-audio-video-gaps' : videoLong.length || audioJumps.length || audioLong.length ? 'timing-variation' : 'regular',
      }
    },
  }
}

module.exports = { createTimingAnalyzer }
