'use strict'

// Request blocking for the resolver's browser.
//
// A note on uBlock Origin, since it's the obvious question: it can't be loaded
// here. Electron's extension support doesn't include the blocking webRequest or
// declarativeNetRequest APIs uBlock is built on, so the extension would load and
// block nothing. More importantly it wouldn't help with the case that actually
// bit us — a pre-roll served from the site's own domain by its own player is
// first-party video, which no filter list blocks.
//
// So: our own blocker. Domain-level rules, which is the part that matters for
// killing pop-unders and trackers, plus a user-editable list for anything this
// misses. Video-ad networks are tracked separately because those requests must
// never be mistaken for the feature.

/** Trackers, pop-under networks and ad exchanges: cancelled outright. */
const TRACKERS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'google-analytics.com',
  'adservice.google',
  'popads.net',
  'popcash.net',
  'propellerads.com',
  'propellerclick.com',
  'onclickads.net',
  'onclasrv.com',
  'adsterra.com',
  'exoclick.com',
  'exosrv.com',
  'juicyads.com',
  'hilltopads.net',
  'clickadu.com',
  'clicksgear.com',
  'mgid.com',
  'taboola.com',
  'outbrain.com',
  'zedo.com',
  'revcontent.com',
  'trafficjunky.net',
  'adsco.re',
  'luckyorange.com',
  'hotjar.com',
  'scorecardresearch.com',
  'quantserve.com',
  'bidswitch.net',
  'smartadserver.com',
  'criteo.com',
  'criteo.net',
  'adnxs.com',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'casalemedia.com',
  'sharethrough.com',
  'yieldmo.com',
  '33across.com',
  'sonobi.com',
  'gumgum.com',
  'sovrn.com',
  'districtm.io',
  'id5-sync.com',
  'crwdcntrl.net',
  'demdex.net',
  'everesttech.net',
  'bluekai.com',
  'agkn.com',
  'tapad.com',
  'adform.net',
  'advolve.io',
  'yellowblue.io',
  'ingage.tech',
  'connatix.com',
  'cootlogix.com',
  'histats.com',
  'statcounter.com',
  'admatic.com.tr',
  'adhood.com',
  'reklamstore.com',
  'gemius.pl',
  'onesignal.com',
  'pushwoosh.com',
  'notix.io',
  'push-sdk.net',
]

/**
 * Networks that deliver ad *video*. Kept apart from TRACKERS: a stream from one
 * of these is an advert, and mistaking it for the feature is the bug this list
 * exists to prevent.
 */
const AD_MEDIA = [
  'connatix.com',
  'imasdk.googleapis.com',
  'securepubads.g.doubleclick.net',
  'pubads.g.doubleclick.net',
  'springserve.com',
  'spotx.tv',
  'spotxchange.com',
  'teads.tv',
  'adsafeprotected.com',
  'aniview.com',
  'unrulymedia.com',
  'vidoomy.com',
  'primis.tech',
  'viralize.tv',
  'onnetwork.tv',
  'smartclip.net',
  'videoplaza.tv',
  'tremorhub.com',
  'telaria.com',
  'beachfront.com',
  'sekindo.com',
  'playwire.com',
  'freewheel.tv',
  'fwmrm.net',
  'minutemedia.com',
  'vidazoo.com',
  'ex.co',
  'adplayer.pro',
]

/** Ad paths, delimiter-anchored: a bare "ads" also matches /uploads/. */
const AD_PATH =
  /(\/ads?\/|(?:^|[/_.-])(?:vast|vmap|preroll|pre-roll|midroll|postroll|advert|adserver|adserve|adbreak|adframe)(?:[/_.-]|$))/i

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function pathOf(url) {
  try {
    return new URL(url).pathname
  } catch {
    return String(url)
  }
}

/** True when `host` is the domain itself or a subdomain of it. */
function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`)
}

function matchesAny(host, domains) {
  for (const domain of domains) {
    if (hostMatches(host, domain)) return true
  }
  return false
}

/** Extra domains the user added in settings, one per line or comma separated. */
function parseExtra(text) {
  return String(text || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase().replace(/^\*?\.?/, '').replace(/^https?:\/\//, ''))
    .filter((s) => s && s.includes('.'))
}

/**
 * Compile a matcher once per resolve, so the per-request hot path is a couple of
 * string comparisons rather than a regex over the whole URL.
 */
function createBlocker({ extraBlocked = '', allowTrackers = false } = {}) {
  const extra = parseExtra(extraBlocked)
  const blocked = allowTrackers ? extra : [...TRACKERS, ...extra]

  return {
    /** Cancel this request entirely. */
    shouldBlock(url) {
      const host = hostOf(url)
      if (!host) return false
      return matchesAny(host, blocked)
    },

    /** This is ad video: never offer it as the page's media. */
    isAdMedia(url) {
      const host = hostOf(url)
      if (host && matchesAny(host, AD_MEDIA)) return true
      return AD_PATH.test(pathOf(url))
    },
  }
}

module.exports = { createBlocker, TRACKERS, AD_MEDIA, AD_PATH }
