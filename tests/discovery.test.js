'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { discoverSources } = require('../electron/lib/source-discovery')
const base = 'https://player.example.test/episode/'

test('nested JSON and Next state expose typed extensionless sources with language', () => {
  const data = { props: { pageProps: { playback: { sources: [
    { url: '/signed/stream?token=one', type: 'application/x-mpegURL', language: 'en', label: 'Original' },
  ] } } }, ads: { sources: [{ file: '/advert.mp4' }] }, poster: '/poster.jpg' }
  const result = discoverSources(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`, base)
  assert.equal(result.sources.length, 1)
  assert.deepEqual(result.sources[0], { url: 'https://player.example.test/signed/stream?token=one', kind: 'hls', language: 'en', label: 'Original', needsCheck: true })
})
test('bounded data decoders expose nested JSON and base64 player documents without executing JS', () => {
  const encoded = Buffer.from(JSON.stringify({ sources: [{ file: '../stream.m3u8' }], embedUrl: 'https://embed.example.test/one' })).toString('base64')
  const result = discoverSources(`atob('${encoded}'); throw new Error('must not execute')`, base)
  assert.ok(result.sources.some((s) => s.url === 'https://player.example.test/stream.m3u8'))
  assert.deepEqual(result.frames, ['https://embed.example.test/one'])
  assert.equal(discoverSources(JSON.stringify({ menu: { url: '/account' }, image: '/cover.png' }), base).sources.length, 0)
})
test('relative inline configs, escaped URLs and media MIME overrides are kept', () => {
  const result = discoverSources(`player.setup({file: '/watch.m3u8?x=1&amp;y=2'});`, base)
  assert.equal(result.sources[0].url, 'https://player.example.test/watch.m3u8?x=1&y=2')
  assert.equal(discoverSources({ sources: [{ url: '/image.png', type: 'application/vnd.apple.mpegurl' }] }, base).sources[0].kind, 'hls')
  assert.equal(discoverSources('<img src="/avatar?id=123"><script src="https://metrics.example.test/collect"></script><iframe src="/player"></iframe>', base).sources.length, 0)
  assert.equal(discoverSources({ sources: ['video/main.m3u8'] }, base).sources[0].url, base + 'video/main.m3u8')
  assert.equal(discoverSources("player.setup({file: 'main.m3u8'});", base).sources[0].url, base + 'main.m3u8')
})

test('typed HTML sources, base URLs and player data attributes retain their protocols', () => {
  const result = discoverSources(`<head><base href="https://media.example.test/assets/"></head>
    <video><source src="play.php?id=1&#38;token=two" type="application/dash+xml"></video>
    <audio data-setup='{&quot;sources&quot;:[{&quot;src&quot;:&quot;audio&quot;,&quot;type&quot;:&quot;audio/mp4&quot;}]}'></audio>
    <iframe src="about:blank" data-src="player/one"></iframe>`, base)
  assert.deepEqual(result.sources.map((s) => [s.url, s.kind]), [
    ['https://media.example.test/assets/play.php?id=1&token=two', 'dash'],
    ['https://media.example.test/assets/audio', 'file'],
  ])
  assert.deepEqual(result.frames, ['https://media.example.test/assets/player/one'])
})
test('JSON-LD graph media and common DASH configuration keys expose explicit sources only', () => {
  const result = discoverSources({ '@graph': [{ '@type': 'VideoObject', contentUrl: '/movie', encodingFormat: 'video/mp4',
    embedUrl: '/embed/player', author: { url: '/author' }, license: { src: '/license-server' } }],
    playback: { manifestUri: '/dash/stream', type: 'application/dash+xml' },
    source: { dash: '/manifest-token', hls: '/hls-token', progressive: [{ url: '/file-token', mimeType: 'video/mp4' }] },
    menu: { url: '/navigation.mp4' }, ads: { sources: [{ file: '/advert.mp4' }] } }, base)
  assert.equal(result.sources.find((s) => s.url.endsWith('/movie')).kind, 'file')
  assert.equal(result.sources.find((s) => s.url.endsWith('/dash/stream')).kind, 'dash')
  assert.equal(result.sources.find((s) => s.url.endsWith('/manifest-token')).kind, 'dash')
  assert.equal(result.sources.find((s) => s.url.endsWith('/hls-token')).kind, 'hls')
  assert.equal(result.sources.find((s) => s.url.endsWith('/file-token')).kind, 'file')
  assert.equal(result.sources.length, 5)
  assert.deepEqual(result.frames, ['https://player.example.test/embed/player'])
})
test('later typed declarations improve an existing unknown source without duplicate offers', () => {
  const result = discoverSources({ sources: ['/opaque', { url: '/opaque', type: 'application/dash+xml', language: 'en', label: 'Original' }] }, base)
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].kind, 'dash')
  assert.equal(result.sources[0].language, 'en')
  assert.equal(result.sources[0].label, 'Original')
})
test('discovery refuses non-HTTP protocols, credentials, control characters and unbounded offers', () => {
  const sources = ['file:///private/movie.mp4', 'javascript:alert(1)', 'https://user:secret@example.test/movie.mp4', 'https://example.test/a\n.mp4', ...Array.from({ length: 500 }, (_, i) => `/video-${i}.mp4`)]
  const result = discoverSources({ sources }, base)
  assert.equal(result.sources.length, 120)
  assert.ok(result.sources.every((s) => !/private|user:|secret|alert|a%0A/.test(s.url)))
  assert.equal(discoverSources({ file: 'https://example.test/a\\u000A.mp4' }, base).sources.length, 0)
})
