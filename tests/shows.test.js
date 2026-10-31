'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { createShows, parseShow } = require('../electron/lib/shows')
const { createShowTrackerBridge, reportTitle } = require('../electron/lib/show-tracker')

const NOW = new Date(2026, 9, 30, 12).getTime()
const payload = {
  id: 7, name: 'Mentalist', status: 'Ended',
  _embedded: { episodes: [
    { season: 1, number: 1, name: 'Pilot', airdate: '2026-01-01' },
    { season: 1, number: 2, name: 'İki', airdate: '2026-01-08' },
    { season: 1, number: 3, name: 'Yeni', airdate: '2026-10-29' },
    { season: 1, number: 4, name: 'Gelecek', airdate: '2026-11-05' },
    { season: 1, number: null, name: 'Özel', airdate: '2026-02-01' },
  ] },
}
function fixture({ status = 200, body = payload, downloads } = {}) {
  const cache = {}, notes = [], calls = []
  let time = NOW
  const shows = createShows({
    getDownloads: () => downloads || [
      { series: 'Mentalist', season: 1, episode: 1, status: 'done' },
      { series: 'mentalist ', season: 1, episode: 2, status: 'done', missing: true },
      { series: 'Mentalist', status: 'done' },
      { series: 'Mentalist', season: 1, episode: 3, status: 'failed' },
    ],
    getCache: () => cache,
    updateCache: (key, value) => { cache[key] = value },
    fetchImpl: async (url) => { calls.push(url); return { status, ok: status < 400, json: async () => body } },
    now: () => time,
    notify: (...args) => notes.push(args),
  })
  return { shows, cache, notes, calls, advance: (ms) => { time += ms } }
}

test('reports missing aired episodes and the next one, counting only files on disk', async () => {
  const { shows } = fixture()
  const { shows: [show], failures } = await shows.refresh()
  assert.deepEqual(failures, [])
  assert.equal(show.matched, true)
  assert.deepEqual(show.seasons[0].missing.map((e) => e.episode), [2, 3])
  assert.equal(show.seasons[0].have, 1)
  assert.equal(show.seasons[0].total, 3)
  assert.equal(show.next.episode, 4)
  assert.equal(show.unnumbered, 1)
})

test('does not refetch a fresh show, and force does', async () => {
  const { shows, calls } = fixture()
  await shows.refresh(); await shows.refresh()
  assert.equal(calls.length, 1)
  await shows.refresh({ force: true })
  assert.equal(calls.length, 2)
})

test('first look sets a baseline; only later airings notify', async () => {
  const { shows, notes, cache, advance } = fixture()
  await shows.refresh()
  assert.equal(notes.length, 0)
  cache.mentalist.seenThrough = '2026-10-01'
  advance(13 * 60 * 60 * 1000)
  await shows.refresh()
  assert.deepEqual(notes, [['Mentalist', 'Yeni bölüm: S01B03']])
  advance(13 * 60 * 60 * 1000)
  await shows.refresh()
  assert.equal(notes.length, 1)
})

test('an unmatched series is kept, reported and retried with a user query', async () => {
  const { shows, cache } = fixture({ status: 404 })
  const { shows: [show] } = await shows.refresh()
  assert.equal(show.matched, false)
  assert.equal(show.checked, true)
  assert.equal(cache.mentalist.show, null)
  await assert.rejects(shows.rematch({ name: 'Mentalist', query: 'x' }), /bulunamadı/)
  await assert.rejects(shows.rematch({ name: 'Yok', query: 'x' }), /kitaplıkta/)
})

test('a TVmaze failure is reported without losing the cache', async () => {
  const { shows } = fixture({ status: 500 })
  const { failures } = await shows.refresh()
  assert.match(failures[0], /500/)
})

test('malformed network data is rejected', () => {
  assert.equal(parseShow({ id: 'x' }), null)
  assert.deepEqual(parseShow({ id: 1, _embedded: { episodes: [{ season: 1, number: 1, airdate: 'bad' }] } }).episodes[0].airdate, null)
})

function bridge(on = true) {
  const sent = []
  let time = 0
  const { report } = createShowTrackerBridge({
    enabled: () => on,
    fetchImpl: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }) },
    now: () => time,
  })
  return { report, sent, tick: (ms) => { time += ms } }
}

test('Show Tracker reports use its protocol, throttled, with pause sent at once', () => {
  const { report, sent, tick } = bridge()
  const session = {}
  tick(20000)
  report(session, { title: 'Dizi S01E02', seconds: 100, duration: 2000, playing: true })
  report(session, { title: 'Dizi S01E02', seconds: 101, duration: 2000, playing: true })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, 'http://127.0.0.1:7423/progress')
  assert.deepEqual(Object.keys(sent[0].body).sort(), ['durationSeconds', 'playing', 'positionSeconds', 'title', 'url'])
  report(session, { title: 'Dizi S01E02', seconds: 102, duration: 2000, playing: false })
  assert.equal(sent.length, 2)
  tick(15000)
  report(session, { title: 'Dizi S01E02', seconds: 120, duration: 0, playing: true })
  assert.equal(sent[2].body.durationSeconds, null)
})

test('vault playback and a disabled bridge never report', () => {
  const vault = bridge()
  vault.report({ vault: true }, { title: 'Gizli', seconds: 10, playing: false })
  assert.equal(vault.sent.length, 0)
  const off = bridge(false)
  off.report({}, { title: 'x', seconds: 10, playing: false })
  assert.equal(off.sent.length, 0)
})

test('titles prefer library episode data and drop the extension', () => {
  assert.equal(reportTitle({ series: 'Dizi', season: 1, episode: 2, fileName: 'a.mp4' }), 'Dizi S01E02')
  assert.equal(reportTitle({ fileName: 'Mr. Robot S01E02.mkv' }), 'Mr. Robot S01E02')
})
