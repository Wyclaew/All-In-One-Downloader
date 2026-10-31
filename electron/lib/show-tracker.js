'use strict'

// Reports playback to the Show Tracker desktop app.
//
// Show Tracker listens on loopback for its browser extension and turns a title
// plus a position into a saved episode. We speak the same small protocol, so
// everything watched in our player lands there with no account or key here.
// If the app is not running the report is simply dropped; the next one follows.
// Vault playback is never reported, and neither are file paths.

const ENDPOINT = 'http://127.0.0.1:7423/progress'
const REPORT_INTERVAL_MS = 15000
const SOURCE_URL = 'app://all-in-one-downloader'

/** A name Show Tracker can match: tagged episode data beats a file name. */
function reportTitle({ series, season, episode, fileName }) {
  if (series && Number.isInteger(season) && Number.isInteger(episode)) {
    return `${series} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
  }
  return String(fileName || '').replace(/\.[^.]+$/, '')
}

function createShowTrackerBridge({ enabled, fetchImpl, now = Date.now }) {
  const lastSent = new WeakMap()

  function send(payload) {
    return fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
    }).catch(() => undefined)
  }

  function report(session, { title, seconds, duration, playing }) {
    if (!session || session.vault || !enabled()) return null
    if (!title || !Number.isFinite(seconds) || seconds < 0) return null
    if (playing && now() - (lastSent.get(session) || 0) < REPORT_INTERVAL_MS) return null
    lastSent.set(session, now())
    return send({
      title,
      url: SOURCE_URL,
      positionSeconds: seconds,
      durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
      playing,
    })
  }

  return { report }
}

module.exports = { createShowTrackerBridge, reportTitle }
