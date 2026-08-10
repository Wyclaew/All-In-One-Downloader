'use strict'

// Site recipes: small scripts that run inside the page while the resolver works.
//
// The idea comes from Tampermonkey, but Tampermonkey itself cannot be loaded
// here. Electron's extension support covers a fraction of the Chrome API, and the
// parts a userscript manager is built on — storage, tabs, scripting,
// declarativeNetRequest, MV3 service workers — are mostly not among them. The same
// reason uBlock Origin cannot be loaded. So the concept is implemented natively
// instead, and aimed at what this app actually needs.
//
// The difference from a browser userscript manager is the point of it. There, a
// script changes what you see. Here, a script can *hand the resolver a stream*:
//
//     AIO.found('https://cdn.site/real/master.m3u8')
//
// Which means a site nobody has written an extractor for can be taught in fifteen
// lines, in a text file, without touching the app.
//
// Scripts run in the page world, so they can read the player's own variables —
// which is the whole point, since that is where obfuscated players keep the
// address. They cannot reach Node: context isolation stays on, and the only way
// back is the same array the network sniffer already drains, so everything a
// script offers goes through the same verification, ad filtering and duration
// checks as anything else. A script is a suggestion, not an answer.

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const HEADER_RE = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/i

function dir() {
  return path.join(app.getPath('userData'), 'userscripts')
}

/* -------------------------------------------------------------------------- */
/* metadata                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A Tampermonkey-style match pattern as a regex.
 *
 * Kept compatible on purpose: `*://*.example.com/*` means the same here as it
 * does there, so a pattern copied from an existing script behaves the way its
 * author expected.
 */
function patternToRegex(pattern) {
  const text = String(pattern || '').trim()
  if (!text) return null
  if (text === '*' || text === '<all_urls>') return /^https?:\/\//i

  // Split into scheme / host / path first. Escaping the whole pattern and then
  // trying to find the pieces inside the escaped text is how this went wrong the
  // first time: after escaping there is no telling a literal from a wildcard.
  const parts = text.match(/^([a-z*]+):\/\/([^/]*)(\/.*)?$/i)
  const scheme = parts ? parts[1] : '*'
  const host = parts ? parts[2] : ''
  const rest = parts ? parts[3] || '/*' : text

  const escape = (value) => value.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')

  const schemePart = scheme === '*' ? 'https?' : escape(scheme)
  // `*.host` matches the bare host too. Anything else would make the commonest
  // hand-written pattern miss the very site it names.
  const hostPart = !host
    ? '[^/]*'
    : host.startsWith('*.')
      ? `(?:[^/]+\\.)?${escape(host.slice(2))}`
      : escape(host)

  try {
    return new RegExp(`^${schemePart}://${hostPart}${escape(rest)}$`, 'i')
  } catch {
    return null
  }
}

function parseHeader(source, file) {
  const block = String(source).match(HEADER_RE)
  const meta = {
    name: path.basename(file, '.user.js'),
    description: '',
    matches: [],
    excludes: [],
    runAt: 'document-end',
    enabled: true,
  }
  if (!block) return meta

  for (const raw of block[1].split('\n')) {
    const line = raw.replace(/^\s*\/\/\s*/, '').trim()
    const at = line.match(/^@([a-zA-Z-]+)\s*(.*)$/)
    if (!at) continue
    const key = at[1].toLowerCase()
    const value = at[2].trim()
    if (key === 'name') meta.name = value || meta.name
    else if (key === 'description') meta.description = value
    else if (key === 'match' || key === 'include') meta.matches.push(value)
    else if (key === 'exclude' || key === 'exclude-match') meta.excludes.push(value)
    else if (key === 'run-at') meta.runAt = value || meta.runAt
    else if (key === 'enabled') meta.enabled = !/^(false|0|no)$/i.test(value)
  }
  return meta
}

/* -------------------------------------------------------------------------- */
/* loading                                                                     */
/* -------------------------------------------------------------------------- */

function load() {
  let files = []
  try {
    files = fs.readdirSync(dir()).filter((f) => f.endsWith('.user.js'))
  } catch {
    return []
  }

  const out = []
  for (const file of files.sort()) {
    const full = path.join(dir(), file)
    let source = ''
    try {
      source = fs.readFileSync(full, 'utf8')
    } catch {
      continue
    }
    if (!source.trim()) continue
    const meta = parseHeader(source, file)
    out.push({ ...meta, file, path: full, source, bytes: source.length })
  }
  return out
}

/** Scripts whose patterns match this page, in file order. */
function forUrl(url) {
  const target = String(url || '')
  if (!/^https?:\/\//i.test(target)) return []

  return load().filter((script) => {
    if (!script.enabled) return false
    const excluded = script.excludes
      .map(patternToRegex)
      .filter(Boolean)
      .some((re) => re.test(target))
    if (excluded) return false
    // No @match at all means every page: the same default a userscript manager
    // uses, and the useful one for a general-purpose player recipe.
    if (!script.matches.length) return true
    return script.matches
      .map(patternToRegex)
      .filter(Boolean)
      .some((re) => re.test(target))
  })
}

/**
 * What a script is given.
 *
 * Deliberately tiny, and deliberately one-way. `found` pushes onto the array the
 * network sniffer already drains, so a script's answer takes exactly the same
 * road as a sniffed request — verified, duration-checked and ad-filtered like
 * everything else. There is no path from here to the filesystem or to Node.
 */
const API = `(() => {
  if (window.AIO) return;
  var push = function (item) {
    try {
      if (!window.__aioSeen) window.__aioSeen = [];
      if (window.__aioSeen.length < 400) window.__aioSeen.push(item);
    } catch (e) {}
  };
  window.AIO = {
    found: function (url, meta) {
      if (typeof url !== 'string' || !url) return false;
      var item = { url: url, from: 'userscript' };
      if (meta && typeof meta === 'object') {
        if (typeof meta.kind === 'string') item.kind = meta.kind;
        if (typeof meta.title === 'string') item.title = meta.title;
        if (typeof meta.duration === 'number') item.duration = meta.duration;
      }
      push(item);
      return true;
    },
    title: function (text) {
      if (typeof text === 'string' && text) push({ title: text, from: 'userscript' });
    },
    duration: function (seconds) {
      if (typeof seconds === 'number' && seconds > 0) push({ duration: seconds, from: 'userscript' });
    },
    note: function (text) {
      if (typeof text === 'string' && text) push({ note: String(text).slice(0, 120), from: 'userscript' });
    },
    click: function (selector) {
      try {
        var el = document.querySelector(selector);
        if (el) { el.click(); return true; }
      } catch (e) {}
      return false;
    },
    every: function (ms, fn) {
      try {
        var id = setInterval(function () { try { fn(); } catch (e) {} }, ms);
        setTimeout(function () { clearInterval(id); }, 60000);
        return id;
      } catch (e) { return null; }
    },
  };
})()`

/**
 * One script, wrapped so a syntax error or a throw inside it cannot take the
 * page — or the resolve — down with it.
 */
function wrap(script) {
  return `${API};
(function () {
  try {
${script.source}
  } catch (err) {
    try { console.warn('[userscript] ' + ${JSON.stringify(script.name)} + ': ' + err); } catch (e) {}
  }
})()`
}

/* -------------------------------------------------------------------------- */
/* the one that ships                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Ask the player, instead of watching the network.
 *
 * Every technique in the resolver so far watches what a page *does*: the requests
 * it makes, the text it ships, the frames it nests. A player fed through Media
 * Source Extensions defeats all of that — the video element's src is a `blob:`
 * URL, the segments arrive as opaque XHRs, and the real address may never appear
 * in a form worth matching.
 *
 * But the player object is right there in the page, holding its own playlist,
 * because it needs it. JW Player, Video.js, Clappr, Plyr, hls.js, Shaka, DPlayer
 * and Playerjs all keep the source somewhere reachable. This asks each of them
 * directly — which is exactly what a userscript is good for, and a good
 * demonstration of the API.
 */
const BUILTIN_PLAYER_PROBE = `// ==UserScript==
// @name         Oynatıcıya sor
// @description  Sayfadaki oynatıcı nesnelerinin kendi kaynak listesini okur (JW, Video.js, Clappr, Plyr, hls.js, Shaka, DPlayer, Playerjs). MSE/blob ile beslenen oynatıcılarda ağı izlemek işe yaramaz; oynatıcının kendisi adresi bilir.
// @match        *
// @run-at       document-end
// ==/UserScript==

var seen = {};

function offer(url, why) {
  if (typeof url !== 'string') return;
  if (url.indexOf('blob:') === 0 || url.indexOf('data:') === 0) return;
  if (!/^https?:/i.test(url)) return;
  if (seen[url]) return;
  seen[url] = 1;
  AIO.found(url);
  AIO.note('oynatıcıdan: ' + why);
}

function fromSources(list, why) {
  if (!list) return;
  var items = list.length !== undefined ? list : [list];
  for (var i = 0; i < items.length; i += 1) {
    var s = items[i];
    if (!s) continue;
    if (typeof s === 'string') offer(s, why);
    else offer(s.file || s.src || s.url || s.source, why);
  }
}

function sweep() {
  // JW Player: the classic, and the one most sites still wrap.
  try {
    if (window.jwplayer) {
      var jw = window.jwplayer();
      if (jw && jw.getPlaylist) {
        var pl = jw.getPlaylist() || [];
        for (var i = 0; i < pl.length; i += 1) {
          fromSources(pl[i].sources, 'jwplayer');
          offer(pl[i].file, 'jwplayer');
        }
      }
    }
  } catch (e) {}

  // Video.js keeps every player it made in a registry.
  try {
    if (window.videojs && window.videojs.getPlayers) {
      var players = window.videojs.getPlayers();
      for (var id in players) {
        var p = players[id];
        if (!p) continue;
        try { offer(p.currentSrc && p.currentSrc(), 'video.js'); } catch (e) {}
        try { fromSources(p.currentSources && p.currentSources(), 'video.js'); } catch (e) {}
      }
    }
  } catch (e) {}

  // hls.js and Shaka hold the manifest they loaded.
  try {
    if (window.hls && window.hls.url) offer(window.hls.url, 'hls.js');
    if (window.Hls && window.Hls.instances) {
      for (var h = 0; h < window.Hls.instances.length; h += 1) {
        offer(window.Hls.instances[h].url, 'hls.js');
      }
    }
  } catch (e) {}
  try {
    if (window.player && window.player.getAssetUri) offer(window.player.getAssetUri(), 'shaka');
  } catch (e) {}

  // Clappr, Plyr, DPlayer, Playerjs: same idea, different property.
  try { if (window.player && window.player.options) fromSources(window.player.options.source, 'clappr'); } catch (e) {}
  try { if (window.plyr && window.plyr.source) fromSources(window.plyr.source, 'plyr'); } catch (e) {}
  try { if (window.dp && window.dp.options) fromSources(window.dp.options.video, 'dplayer'); } catch (e) {}
  try { if (window.player && window.player.api) offer(window.player.api('src'), 'playerjs'); } catch (e) {}

  // Anything a page left lying around under an obvious name.
  try {
    var names = ['videoUrl', 'video_url', 'streamUrl', 'stream_url', 'sourceUrl', 'hlsUrl', 'file', 'src'];
    for (var n = 0; n < names.length; n += 1) {
      var v = window[names[n]];
      if (typeof v === 'string' && /\\.(m3u8|mpd|mp4)/i.test(v)) offer(v, 'window.' + names[n]);
    }
  } catch (e) {}

  // A <video> whose src is real rather than a blob.
  try {
    var vids = document.querySelectorAll('video, video source');
    for (var v2 = 0; v2 < vids.length; v2 += 1) {
      offer(vids[v2].src || vids[v2].getAttribute('src'), 'video etiketi');
    }
  } catch (e) {}
}

sweep();
// Players build themselves late; keep asking for a while.
AIO.every(1500, sweep);
`

/**
 * Written once, then left alone. If the user edits or deletes it, that decision
 * stands — rewriting their file on every launch would make the folder useless as
 * a place to keep your own work.
 */
function ensureBuiltins() {
  const target = path.join(dir(), '00-oynaticiya-sor.user.js')
  const stamp = path.join(dir(), '.builtins')
  try {
    fs.mkdirSync(dir(), { recursive: true })
    if (fs.existsSync(stamp)) return
    if (!fs.existsSync(target)) fs.writeFileSync(target, BUILTIN_PLAYER_PROBE, 'utf8')
    fs.writeFileSync(stamp, 'v1\n', 'utf8')
  } catch (err) {
    console.error('[userscripts] hazır script yazılamadı', err)
  }
}

module.exports = { dir, load, forUrl, wrap, ensureBuiltins, parseHeader, patternToRegex }
