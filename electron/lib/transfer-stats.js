'use strict'

// Rolling throughput ignores bytes present before resume. Long stalls age out
// old samples instead of leaving a stale high speed and a fictional short ETA.
class TransferStats {
  constructor(bytes = 0, now = Date.now()) {
    this.samples = [{ at: now, bytes }]
  }

  update(bytes, total, now = Date.now()) {
    if (bytes < this.samples[this.samples.length - 1].bytes) this.samples = [{ at: now, bytes }]
    this.samples.push({ at: now, bytes })
    while (this.samples.length > 2 && this.samples[1].at < now - 8000) this.samples.shift()
    const first = this.samples[0]
    const span = (now - first.at) / 1000
    const speed = span >= 0.5 ? Math.max(0, (bytes - first.bytes) / span) : null
    const eta = span >= 2 && speed > 0 && total > bytes ? Math.ceil((total - bytes) / speed) : null
    return { speed, eta }
  }
}

module.exports = { TransferStats }
