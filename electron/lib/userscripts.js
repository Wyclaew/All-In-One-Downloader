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
 * Watch the decoders, not the network.
 *
 * Obfuscated players nearly all share one shape: the address arrives encoded, and
 * the page decodes it in JavaScript moments before use. Whatever the wrapping —
 * base64, a JSON blob, a packed script — it passes through `atob` or `JSON.parse`
 * on the way. Standing at those two doors catches an address that never appears in
 * the page source and never appears in a request we can recognise.
 */
const BUILTIN_DECODER_WATCH = `// ==UserScript==
// @name         Kod çözücüleri dinle
// @description  atob() ve JSON.parse() çıktılarını izler. Şifreli oynatıcılar adresi kullanmadan hemen önce çözer; bu iki kapıda beklemek, sayfa kaynağında hiç görünmeyen adresi yakalar.
// @match        *
// @run-at       document-end
// ==/UserScript==

var seen = {};
// Built from a string rather than written as a literal: this file embeds recipes
// in template literals, which eat single backslashes — a regex literal in here
// silently loses its escapes and either matches the wrong thing or fails to
// parse. RegExp from a string keeps the escaping in one obvious place.
var RE = new RegExp('https?:(?:\\\\\\\\?/){2}[^\\\\s"\\'<>]+\\\\.(?:m3u8|mpd|mp4|webm|m4v|mkv)[^\\\\s"\\'<>]*', 'gi');

function scan(text, why) {
  if (typeof text !== 'string' || text.length < 12 || text.length > 400000) return;
  var found = text.replace(/\\\//g, '/').match(RE);
  if (!found) return;
  for (var i = 0; i < found.length && i < 8; i += 1) {
    var url = found[i].replace(/[",';)\]}]+$/, '');
    if (seen[url]) continue;
    seen[url] = 1;
    AIO.found(url);
    AIO.note('çözücüden: ' + why);
  }
}

try {
  var realAtob = window.atob;
  window.atob = function (input) {
    var out = realAtob.apply(this, arguments);
    try { scan(out, 'atob'); } catch (e) {}
    return out;
  };
} catch (e) {}

try {
  var realParse = JSON.parse;
  JSON.parse = function (text) {
    var out = realParse.apply(this, arguments);
    try {
      scan(typeof text === 'string' ? text : '', 'JSON.parse');
    } catch (e) {}
    return out;
  };
} catch (e) {}
`

/**
 * Get past the thing standing in front of the player.
 *
 * A surprising share of "it found nothing" is a page that has not started yet: an
 * age gate, a cookie banner, a "continue to video" interstitial. The player is
 * never constructed, so there is nothing to sniff and nothing to read. Clicking by
 * *visible words* rather than by class name is what makes this portable — class
 * names are per-site, "Kabul Et" is not.
 */
const BUILTIN_GATE_CLICKER = `// ==UserScript==
// @name         Kapıyı aç
// @description  Yaş doğrulaması ve çerez bildirimi gibi ÜSTTE DURAN katmanları görünen yazısına göre kapatır. Sayfadan ayrılabilecek hiçbir şeye dokunmaz: form içindekiler, gerçek bağlantılar ve submit düğmeleri atlanır. Bir kapıyı kaçırmak tek bir sayfaya mal olur; sayfayı gezdirmek çözümlemenin tamamına mal olur.
// @match        *
// @run-at       document-end
// ==/UserScript==

/*
 * Narrowed after this recipe drove a page to a 500.
 *
 * The first version clicked anything whose words looked encouraging, and that is
 * how it hit something that navigated or submitted. A gate we want to dismiss is
 * an overlay: it sits above the page, it does not leave it. So the rules now are
 * about *behaviour*, not just wording — never a form, never a real link, never a
 * submit. Missing a gate costs one unresolved page; navigating away costs the
 * whole resolve, and on some sites an error the user then has to wonder about.
 */
var WORDS = [
  'kabul et', 'kabul ediyorum', 'onayla', 'anladım',
  'accept', 'i accept', 'accept all', 'agree', 'i agree', 'got it',
  'yes i am over', '18+', 'reklamı geç', 'skip ad'
];

var clicked = {};

function inOverlay(el) {
  // Walk up looking for the fixed or absolutely positioned container a consent
  // banner or age gate always lives in. A button in normal page flow is part of
  // the site, not a gate over it.
  var node = el;
  for (var depth = 0; node && depth < 6; depth += 1) {
    var style = getComputedStyle(node);
    if (style.position === 'fixed' || style.position === 'absolute') {
      if (Number(style.zIndex || 0) >= 10 || style.position === 'fixed') return true;
    }
    node = node.parentElement;
  }
  return false;
}

function safeToClick(el) {
  // Anything that can leave the page is out, whatever it says.
  if (el.closest && el.closest('form')) return false;
  if (el.tagName === 'INPUT' && /submit|image/i.test(el.type || '')) return false;
  if (el.tagName === 'A') {
    var href = el.getAttribute('href') || '';
    if (href && href !== '#' && !/^javascript:/i.test(href)) return false;
    if (el.target && el.target !== '_self') return false;
  }
  if (el.getAttribute && el.getAttribute('formaction')) return false;
  return inOverlay(el);
}

function looksClickable(el) {
  if (!el || clicked[el.__aioId]) return false;
  var box = el.getBoundingClientRect();
  if (box.width < 24 || box.height < 12) return false;
  var style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
}

var counter = 0;

function sweep() {
  var nodes = document.querySelectorAll('button, a, [role=button], input[type=button], input[type=submit], .btn');
  for (var i = 0; i < nodes.length && i < 400; i += 1) {
    var el = nodes[i];
    var text = (el.innerText || el.value || '').trim().toLowerCase();
    if (!text || text.length > 40) continue;
    for (var w = 0; w < WORDS.length; w += 1) {
      if (text !== WORDS[w] && text.indexOf(WORDS[w]) === -1) continue;
      if (!looksClickable(el) || !safeToClick(el)) break;
      el.__aioId = el.__aioId || ++counter;
      clicked[el.__aioId] = 1;
      try { el.click(); AIO.note('kapı geçildi: ' + text.slice(0, 24)); } catch (e) {}
      break;
    }
  }
}

sweep();
AIO.every(1200, sweep);
`

/**
 * Walk the page's own variables.
 *
 * A player that builds its source in JavaScript leaves it somewhere on the way:
 * a config object, a data attribute, a property on the element it is about to
 * hand to the video tag. Walking the object graph a couple of levels deep finds
 * addresses that never touched the network and never touched a decoder — the
 * cases the other two recipes miss.
 */
const BUILTIN_VARIABLE_WALK = `// ==UserScript==
// @name         Sayfa değişkenlerini gez
// @description  window ve oynatıcı kaplarındaki nesneleri iki kat gezip akış adresi arar. Kaynağını JavaScript'te kuran oynatıcılar adresi bir yerde bırakır; ne ağa ne kod çözücüye uğramayan durumlar burada yakalanır.
// @match        *
// @run-at       document-idle
// ==/UserScript==

var seen = {};
// Same reason as above: this lives inside a template literal, so the escapes are
// written for the string, not for the regex.
var MEDIA = new RegExp('\\\\.(m3u8|mpd|mp4|webm|m4v|mkv)([?#]|$)', 'i');
var SKIP = /^(document|location|history|navigator|localStorage|sessionStorage|parent|top|self|window|frames|external|clientInformation)$/;

function offer(url) {
  if (typeof url !== 'string' || !/^https?:/i.test(url) || !MEDIA.test(url)) return;
  if (seen[url]) return;
  seen[url] = 1;
  AIO.found(url);
  AIO.note('değişkenden bulundu');
}

function walk(obj, depth) {
  if (!obj || depth > 2) return;
  var keys;
  try { keys = Object.keys(obj); } catch (e) { return; }
  for (var i = 0; i < keys.length && i < 120; i += 1) {
    var key = keys[i];
    if (SKIP.test(key)) continue;
    var value;
    try { value = obj[key]; } catch (e) { continue; }
    if (typeof value === 'string') offer(value);
    else if (value && typeof value === 'object' && !(value instanceof Node)) walk(value, depth + 1);
  }
}

function sweep() {
  walk(window, 0);
  try {
    var holders = document.querySelectorAll('[data-src],[data-file],[data-hls],[data-video],[id*=player],[class*=player]');
    for (var i = 0; i < holders.length && i < 60; i += 1) {
      var el = holders[i];
      for (var a = 0; a < el.attributes.length; a += 1) offer(el.attributes[a].value);
      walk(el.dataset || {}, 1);
    }
  } catch (e) {}
}

sweep();
AIO.every(2000, sweep);
`

/**
 * Read what the embed page decrypts for itself.
 *
 * A whole family of embed hosts ships one line of markup — an AES blob and a call
 * to CryptoJS — and builds the player out of the plaintext. Nothing about the
 * address is in the page source, in an XHR, or in any variable we could walk to:
 * it exists for the moment between the decrypt returning and the player being
 * handed it.
 *
 * So we stand at that one door. This reads the same plaintext the page's own
 * player is about to receive, at the same moment, and takes the media URL out of
 * it. There is no key here and nothing is broken open: the page decrypts its own
 * payload with its own key, exactly as it would with nobody watching.
 */
const BUILTIN_CRYPTO_WATCH = `// ==UserScript==
// @name         Şifreli gömüleri oku
// @description  CryptoJS ile kendi içeriğini çözen gömülü oynatıcılarda, çözülen metinden video adresini alır. Anahtara dokunmaz: sayfa kendi payını kendi anahtarıyla çözer, biz sadece çıkan metne bakarız.
// @match        *
// @run-at       document-end
// ==/UserScript==

var seen = {};
// Built from a string, not written as a literal: this file keeps its recipes in
// template literals, which eat single backslashes.
var RE = new RegExp('https?:(?:\\\\\\\\?/){2}[^\\\\s"\\'<>]+\\\\.(?:m3u8|mpd|mp4|webm|m4v)[^\\\\s"\\'<>]*', 'gi');

function scan(text) {
  if (typeof text !== 'string' || text.length < 12 || text.length > 400000) return;
  var found = text.replace(/\\\\\\//g, '/').match(RE);
  if (!found) return;
  for (var i = 0; i < found.length && i < 8; i += 1) {
    var url = found[i].replace(/[",';)\\]}]+$/, '');
    if (seen[url]) continue;
    seen[url] = 1;
    AIO.found(url);
    AIO.note('şifreli gömüden çözüldü');
  }
}

// The library may not be there yet when we run, so watch for it rather than
// giving up: these pages load CryptoJS from a CDN and decrypt on the next line.
function hook() {
  var C = window.CryptoJS;
  if (!C || !C.AES || C.AES.__aio) return false;
  var real = C.AES.decrypt;
  C.AES.decrypt = function () {
    var out = real.apply(this, arguments);
    try {
      // A WordArray only becomes text when someone asks for it, and asking twice
      // is free — so read it the same way the page is about to.
      scan(out && out.toString ? out.toString(C.enc.Utf8) : '');
    } catch (e) {}
    return out;
  };
  C.AES.__aio = 1;
  return true;
}

if (!hook()) {
  var tries = 0;
  var timer = AIO.every(250, function () {
    tries += 1;
    if (hook() || tries > 40) clearInterval(timer);
  });
}
`

/**
 * Try the other players a page offers.
 *
 * Streaming sites routinely list two to six "servers" for the same episode, and
 * the first one is often dead, geo-blocked or an ad wall. A person tries the next
 * one; this does the same — but only tab-like switches that stay on the page
 * (no real links, no forms), one every few seconds, and stops after a handful.
 */
const BUILTIN_ALT_PLAYERS = `// ==UserScript==
// @name         Alternatif oynatıcıları dene
// @description  "Alternatif 2", "Sunucu 3", "Player 2" gibi sayfa içi oynatıcı sekmelerini sırayla dener. İlk oynatıcı ölü ya da reklam duvarıysa sonrakinden video bulunur. Sayfadan ayrılan hiçbir şeye tıklamaz.
// @match        *
// @run-at       document-idle
// ==/UserScript==

var LABEL = new RegExp('^(?:alternatif|alt\\\\.?|kaynak|sunucu|server|player|oynatıcı|oynatici|part|kısım|link|mirror|source|dil|altyazılı|dublaj|tr dublaj)\\\\s*[#:-]?\\\\s*\\\\d{0,2}$|^(?:vidmoly|filemoon|voe|dood|streamtape|mixdrop|okru|ok\\\\.ru|vk|sibnet|fembed|upstream|streamwish|vidhide|mail\\\\.ru|youtube|vimeo|dailymotion|pixeldrain|gdrive|drive)\\\\b', 'i');

var tried = {};
var counter = 0;
var rounds = 0;

function staysOnPage(el) {
  if (el.closest && el.closest('form')) return false;
  if (el.tagName === 'A') {
    var href = el.getAttribute('href') || '';
    if (href && href !== '#' && href.charAt(0) !== '#' && !/^javascript:/i.test(href)) return false;
    if (el.target && el.target !== '_self') return false;
  }
  if (el.tagName === 'INPUT' && /submit|image/i.test(el.type || '')) return false;
  return true;
}

function visible(el) {
  var box = el.getBoundingClientRect();
  if (box.width < 16 || box.height < 10) return false;
  var style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

function candidates() {
  var out = [];
  var nodes = document.querySelectorAll('button, a, li, span, div[role=tab], [role=tab], [data-id], [data-link], [data-embed], [data-src]');
  for (var i = 0; i < nodes.length && i < 800; i += 1) {
    var el = nodes[i];
    // Leaf-ish elements only: a container's text is all its children's text.
    if (el.children.length > 3) continue;
    var text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!text || text.length > 28 || !LABEL.test(text)) continue;
    if (!visible(el) || !staysOnPage(el)) continue;
    el.__aioAlt = el.__aioAlt || ++counter;
    if (tried[el.__aioAlt]) continue;
    out.push({ el: el, text: text });
  }
  return out;
}

function step() {
  rounds += 1;
  if (rounds > 6) return;
  var list = candidates();
  // The first entry is usually the one already showing; begin with the second.
  var pick = list.length > 1 && rounds === 1 ? list[1] : list[0];
  if (!pick) return;
  tried[pick.el.__aioAlt] = 1;
  try {
    pick.el.click();
    AIO.note('alternatif oynatıcı: ' + pick.text);
  } catch (e) {}
}

// Give the default player a fair chance first.
setTimeout(function () {
  step();
  AIO.every(7000, step);
}, 9000);
`

/**
 * Written once, then left alone. If the user edits or deletes it, that decision
 * stands — rewriting their file on every launch would make the folder useless as
 * a place to keep your own work.
 */
const BUILTINS = [
  ['00-oynaticiya-sor.user.js', BUILTIN_PLAYER_PROBE],
  ['01-kod-cozuculeri-dinle.user.js', BUILTIN_DECODER_WATCH],
  ['02-kapiyi-ac.user.js', BUILTIN_GATE_CLICKER],
  ['03-degiskenleri-gez.user.js', BUILTIN_VARIABLE_WALK],
  ['04-sifreli-gomuleri-oku.user.js', BUILTIN_CRYPTO_WATCH],
  ['05-alternatif-oynaticilar.user.js', BUILTIN_ALT_PLAYERS],
]

/**
 * Written once per version, then left alone. If the user edits or deletes one,
 * that decision stands — rewriting their files on every launch would make the
 * folder useless as a place to keep your own work. The stamp carries a version so
 * a later release can add a recipe without overwriting anything.
 */
function ensureBuiltins() {
  const stamp = path.join(dir(), '.builtins')
  try {
    fs.mkdirSync(dir(), { recursive: true })
    let seen = ''
    try {
      seen = fs.readFileSync(stamp, 'utf8').trim()
    } catch {
      /* first run */
    }
    if (seen === 'v4') return
    for (const [name, source] of BUILTINS) {
      const target = path.join(dir(), name)
      if (!fs.existsSync(target)) fs.writeFileSync(target, source, 'utf8')
    }
    fs.writeFileSync(stamp, 'v4\n', 'utf8')
  } catch (err) {
    console.error('[userscripts] hazır script yazılamadı', err)
  }
}

module.exports = { dir, load, forUrl, wrap, ensureBuiltins, parseHeader, patternToRegex }
