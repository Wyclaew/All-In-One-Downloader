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
