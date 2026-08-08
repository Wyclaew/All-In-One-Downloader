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

/**
 * Ad endpoints that must be allowed through even though they are adverts.
 *
 * This is counter-intuitive and it cost real debugging to find: players with an
 * integrated ad SDK (Google IMA, Connatix and friends) only release the content
 * stream after their ad lifecycle completes. Cancel those requests and the SDK
 * never fires its "ad finished" event, so the feature is never loaded — the
 * player just sits there, even if the viewer clicks skip themselves.
 *
 * So we let the advert load, skip it, and refuse to treat it as downloadable.
 * Blocking it would be the intuitive move and it is the wrong one.
 *
 * The same reasoning keeps the viewability and fraud-verification services
 * (adsafeprotected, moatads, doubleverify) out of the block list: an SDK that is
 * waiting on a verification callback which never arrives is an SDK that never
 * finishes. They are still refused as *media*, which is what matters.
 */
const AD_SDK_ALLOW = [
  'imasdk.googleapis.com',
  'pubads.g.doubleclick.net',
  'securepubads.g.doubleclick.net',
  'static.doubleclick.net',
  's0.2mdn.net',
  'connatix.com',
  'cds.connatix.com',
  'capi.connatix.com',
  'springserve.com',
  'spotx.tv',
  'spotxchange.com',
  'aniview.com',
  'primis.tech',
  'teads.tv',
  'vidazoo.com',
  'ex.co',
  'onnetwork.tv',
  'playwire.com',
  'freewheel.tv',
  'fwmrm.net',
]

/**
 * Trackers, pop-under networks and ad exchanges: cancelled outright.
 *
 * Curated rather than imported. A general-purpose filter list is written for a
 * browser you are reading in, and this is a browser we are scraping with — the
 * two want opposite things. Half of a list like EasyList is cosmetic rules we
 * cannot apply, and the half we could apply includes the ad SDKs above, which
 * this app must let run or players never hand over the video. So: the networks
 * that actually appear in front of streams, grouped by what they are.
 */
const TRACKERS = [
  // ---- Google's ad stack ----
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'google-analytics.com',
  'googletagservices.com',
  'googletagmanager.com',
  'adservice.google',
  'app-measurement.com',

  // ---- pop-under and "click" networks: the ones that open new windows ----
  'popads.net',
  'popcash.net',
  'popunder.net',
  'poptm.com',
  'propellerads.com',
  'propellerclick.com',
  'propu.sh',
  'onclickads.net',
  'onclasrv.com',
  'onclickalgo.com',
  'onclicksuper.com',
  'adsterra.com',
  'adsterratech.com',
  'highperformanceformat.com',
  'profitabledisplaynetwork.com',
  'profitablegatecpm.com',
  'displayvertising.com',
  'exoclick.com',
  'exosrv.com',
  'exdynsrv.com',
  'realsrv.com',
  'juicyads.com',
  'hilltopads.net',
  'hilltopads.com',
  'clickadu.com',
  'clicksgear.com',
  'clickaine.com',
  'adcash.com',
  'adkernel.com',
  'admaven.com',
  'ad-maven.com',
  'adnium.com',
  'adspyglass.com',
  'adprofex.com',
  'trafficstars.com',
  'tsyndicate.com',
  'trafficfactory.biz',
  'trafficjunky.net',
  'trafficshop.com',
  'zeropark.com',
  'mybestadnetwork.com',
  'monetizer.click',
  'galaksion.com',
  'kadam.net',
  'bodelen.com',
  'stpd.cloud',
  'stpanel.io',

  // ---- content-recommendation widgets ----
  'mgid.com',
  'dt07.net',
  'servicer.mgid.com',
  'taboola.com',
  'taboolasyndication.com',
  'outbrain.com',
  'zemanta.com',
  'revcontent.com',
  'zedo.com',
  'plista.com',
  'ligatus.com',
  'adnow.com',
  'engageya.com',

  // ---- ad exchanges and header bidding ----
  'bidswitch.net',
  'smartadserver.com',
  'sascdn.com',
  'criteo.com',
  'criteo.net',
  'adnxs.com',
  'adnxs-simple.com',
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
  'lijit.com',
  'districtm.io',
  'indexww.com',
  'contextweb.com',
  'pulsepoint.com',
  'improvedigital.com',
  'appnexus.com',
  'emxdgt.com',
  'gammaplatform.com',
  'onetag-sys.com',
  'adlightning.com',
  'rtbhouse.com',
  'themoneytizer.com',
  'adpushup.com',
  'adthrive.com',
  'mediavine.com',
  'ezoic.net',
  'ezoic.com',
  'raptive.com',
  'snigelweb.com',
  'ad-delivery.net',

  // ---- identity graphs and data brokers ----
  'id5-sync.com',
  'crwdcntrl.net',
  'demdex.net',
  'everesttech.net',
  'bluekai.com',
  'agkn.com',
  'tapad.com',
  'adform.net',
  'adsrvr.org',
  'liadm.com',
  'rlcdn.com',
  'exelator.com',
  'eyeota.net',
  'mathtag.com',
  'bidr.io',
  'creativecdn.com',
  'krxd.net',
  'omnitagjs.com',
  'advolve.io',
  'yellowblue.io',
  'ingage.tech',
  'connatix.com',
  'cootlogix.com',

  // ---- analytics and session recording ----
  'luckyorange.com',
  'hotjar.com',
  'mouseflow.com',
  'fullstory.com',
  'inspectlet.com',
  'clarity.ms',
  'smartlook.com',
  'scorecardresearch.com',
  'quantserve.com',
  'quantcount.com',
  'chartbeat.com',
  'parsely.com',
  'newrelic.com',
  'nr-data.net',
  'mc.yandex.ru',
  'segment.io',
  'segment.com',
  'amplitude.com',
  'mixpanel.com',
  'heap.io',
  'histats.com',
  'statcounter.com',
  'matomo.cloud',
  'gemius.pl',
  'hs-analytics.net',
  'branch.io',
  'adjust.com',
  'appsflyer.com',
  'kochava.com',

  // ---- Turkish market ----
  'admatic.com.tr',
  'adhood.com',
  'reklamstore.com',
  'motionads.com.tr',
  'adparlor.com',
  'gnetwork.com.tr',

  // ---- browser push-notification spam: the "allow notifications" trap ----
  'onesignal.com',
  'os.tc',
  'pushwoosh.com',
  'notix.io',
  'push-sdk.net',
  'pushnews.eu',
  'pushengage.com',
  'webpushr.com',
  'sendpulse.com',
  'pushprofit.ru',
  'subscribers.com',
  'pushdom.net',
  'push-sdc.com',

  // ---- crypto miners and malvertising staging ----
  'coinhive.com',
  'coin-hive.com',
  'jsecoin.com',
  'crypto-loot.com',
  'webminepool.com',
  'browsermine.com',
]

/**
 * Networks that deliver ad *video*. Kept apart from TRACKERS: a stream from one
 * of these is an advert, and mistaking it for the feature is the bug this list
 * exists to prevent.
 */
const AD_MEDIA = [
  'moatads.com',
  'doubleverify.com',
  'imrworldwide.com',
  'innovid.com',
  'serving-sys.com',
  'flashtalking.com',
  'celtra.com',
  'adcolony.com',
  'smartclip.tv',
  'stickyadstv.com',
  'contextual.media.net',
  'videoo.tv',
  'nativery.com',
  'dable.io',
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
      // The ad SDK has to run or the player never hands over the content.
      if (matchesAny(host, AD_SDK_ALLOW)) return false
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

module.exports = { createBlocker, TRACKERS, AD_MEDIA, AD_SDK_ALLOW, AD_PATH }
