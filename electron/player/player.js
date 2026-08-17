'use strict'

/* The player's controls.
 *
 * Everything here is local: the cues arrive from the main process already parsed,
 * the file arrives over a private scheme, and the page itself fetches nothing and
 * writes nothing. The only state that outlives the window is the playback
 * position, which is sent out on a timer and once on the way out — a window
 * closed with the mouse never gets another chance to report. */

const $ = (id) => document.getElementById(id)

const app = $('app')
const video = $('video')
const subsBox = $('subs')
const panel = $('panel')

const state = {
  cues: [],
  trackId: null,
  tracks: [],
  delay: 0,
  size: 'normal',
  duration: 0,
  seeking: false,
  ready: false,
  next: null,
  upNextShown: false,
  switching: false,
}

/* ---- icons -------------------------------------------------------------- */

const svg = (body) =>
  `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

const ICON = {
  play: svg('<polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none"/>'),
  pause: svg('<rect x="6" y="4" width="4" height="16" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" fill="currentColor" stroke="none"/>'),
  back: svg('<path d="M11 17l-5-5 5-5"/><path d="M18 17l-5-5 5-5"/>'),
  fwd: svg('<path d="M13 7l5 5-5 5"/><path d="M6 7l5 5-5 5"/>'),
  volume: svg('<polygon points="4 9 8 9 12 5 12 19 8 15 4 15" /><path d="M16 9.5a3.5 3.5 0 0 1 0 5"/><path d="M18.5 7a7 7 0 0 1 0 10"/>'),
  muted: svg('<polygon points="4 9 8 9 12 5 12 19 8 15 4 15" /><path d="M17 10l4 4"/><path d="M21 10l-4 4"/>'),
  cc: svg('<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M10 10.5a2 2 0 1 0 0 3"/><path d="M16.5 10.5a2 2 0 1 0 0 3"/>'),
  pip: svg('<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><rect x="12" y="11" width="8" height="7" rx="1.5" fill="currentColor" stroke="none"/>'),
  full: svg('<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>'),
  exitFull: svg('<path d="M9 4v5H4"/><path d="M15 4v5h5"/><path d="M9 20v-5H4"/><path d="M15 20v-5h5"/>'),
  close: svg('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
}

const setIcon = (el, name) => {
  el.innerHTML = ICON[name]
}

/* ---- formatting --------------------------------------------------------- */

function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => (n < 10 ? `0${n}` : String(n))
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

let flashTimer = null
function flash(message) {
  const box = $('flash')
  box.textContent = message
  box.hidden = false
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    box.hidden = true
  }, 1600)
}

function pulse(name) {
  const el = $('pulse')
  el.innerHTML = ICON[name] || ''
  el.classList.remove('show')
  // Restarting a CSS animation needs the class to actually leave the element.
  void el.offsetWidth
  el.classList.add('show')
}

/* ---- boot --------------------------------------------------------------- */

async function boot() {
  const info = await window.aioPlayer.boot()

  document.title = info.title
  $('title').textContent = info.title
  $('tag').textContent = info.vault ? 'kasa' : 'oynatıcı'
  state.tracks = info.tracks || []
  state.size = info.subtitleSize || 'normal'
  state.next = info.next || null
  subsBox.dataset.size = state.size
  setDelay(Number(info.delay) || 0, { save: false })
  setVolume(Number.isFinite(info.volume) ? info.volume : 1, { save: false })

  // Only offer the next episode when there is one. A "Sonraki" button that does
  // nothing is worse than no button.
  $('next').hidden = !state.next
  if (state.next) $('upnext-title').textContent = state.next.title

  // Say the one thing that will otherwise turn into a failed search: a missing
  // provider key. It is free, but it has to be entered once.
  if (!info.hasKey) {
    const note = $('fetch-note')
    note.className = 'note bad'
    note.textContent = 'Aramak için Ayarlar → Altyazı bölümüne OpenSubtitles anahtarı gerekiyor.'
  }

  const select = $('lang')
  for (const lang of info.languages || []) {
    const option = document.createElement('option')
    option.value = lang.code
    option.textContent = lang.name
    if (lang.code === info.preferredLanguage) option.selected = true
    select.appendChild(option)
  }

  paintTracks()
  paintSizes()

  video.src = info.src
  video.load()

  // Resume once the duration is known: a seek issued before then is discarded.
  video.addEventListener(
    'loadedmetadata',
    () => {
      state.duration = video.duration
      state.ready = true
      const at = Number(info.resumeAt) || 0
      if (at > 20 && Number.isFinite(video.duration) && at < video.duration - 10) {
        video.currentTime = at
        $('resume-text').textContent = `${clock(at)} — kaldığın yerden`
        $('resume').hidden = false
        setTimeout(() => {
          $('resume').hidden = true
        }, 6000)
      }
      // An automatic subtitle: the first track whose language the user asked for,
      // otherwise the first one there is. A file with subtitles beside it should
      // show them without being asked twice.
      const preferred =
        state.tracks.find((t) => (t.language || '').startsWith(info.preferredLanguage)) ||
        state.tracks[0]
      if (preferred) selectTrack(preferred.id)
      video.play().catch(() => {
        /* the window may not be focused yet */
      })
    },
    { once: true }
  )
}

/* ---- subtitles ---------------------------------------------------------- */

/** Cue text may carry <i>, <b> and <u>. Everything else is text, so it is escaped. */
function cueHtml(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
  return escaped.replace(/&lt;(\/?)([ibu])&gt;/gi, '<$1$2>')
}

let lastCueIndex = -1

function drawSubtitle() {
  if (!state.cues.length) {
    if (subsBox.firstChild) subsBox.textContent = ''
    return
  }
  const at = video.currentTime - state.delay
  const cues = state.cues

  // The cues are sorted, so the visible one is found by bisection rather than by
  // walking ten thousand of them on every frame.
  let low = 0
  let high = cues.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (cues[mid].end < at) low = mid + 1
    else if (cues[mid].start > at) high = mid - 1
    else {
      found = mid
      break
    }
  }
  if (found === lastCueIndex) return
  lastCueIndex = found
  subsBox.innerHTML = found < 0 ? '' : `<span>${cueHtml(cues[found].text)}</span>`
}

async function selectTrack(id) {
  state.trackId = id
  lastCueIndex = -1
  subsBox.textContent = ''
  state.cues = id ? await window.aioPlayer.cues(id) : []
  if (id && !state.cues.length) flash('Bu altyazı okunamadı.')
  paintTracks()
  $('cc').classList.toggle('on', !!id && state.cues.length > 0)
  drawSubtitle()
}

function paintTracks() {
  const list = $('track-list')
  list.innerHTML = ''

  const add = (id, label) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `track${state.trackId === id ? ' on' : ''}`
    button.innerHTML = '<span class="dot"></span>'
    button.appendChild(document.createTextNode(label))
    button.addEventListener('click', () => selectTrack(id))
    list.appendChild(button)
  }

  add(null, 'Kapalı')
  for (const track of state.tracks) add(track.id, track.label)
  if (!state.tracks.length) {
    const note = document.createElement('p')
    note.className = 'note'
    note.textContent = 'Bu videonun yanında altyazı yok. Aşağıdan dil seçip arayabilirsin.'
    list.appendChild(note)
  }
}

function paintSizes() {
  for (const button of $('size-row').querySelectorAll('button')) {
    button.classList.toggle('on', button.dataset.size === state.size)
  }
}

function setDelay(seconds, { save = true } = {}) {
  state.delay = Math.round(seconds * 10) / 10
  lastCueIndex = -1
  const shown = state.delay.toFixed(1).replace('.', ',')
  $('delay-value').textContent = `${state.delay > 0 ? '+' : ''}${shown} sn`
  // Remembered against the file: the same subtitle on the same release is off by
  // the same amount tomorrow, and finding the offset again is redoing work.
  if (save) window.aioPlayer.setDelay(state.delay)
  drawSubtitle()
}

/** Search, and show what was found best-first with the reason for the order. */
async function searchSubtitles() {
  const language = $('lang').value
  const note = $('fetch-note')
  const button = $('fetch')
  const list = $('hits')

  button.disabled = true
  list.innerHTML = ''
  note.className = 'note'
  note.textContent = 'Aranıyor…'

  const result = await window.aioPlayer.searchSubtitles(language)
  button.disabled = false

  if (!result || !result.ok) {
    note.className = 'note bad'
    note.textContent = (result && result.message) || 'Altyazı bulunamadı.'
    return
  }

  note.className = 'note'
  note.textContent = `${result.results.length} sürüm bulundu — en üstteki en iyi eşleşme.`

  for (const hit of result.results) {
    const button2 = document.createElement('button')
    button2.type = 'button'
    button2.className = `hit${hit.recommended ? ' best' : ''}`

    const name = document.createElement('span')
    name.className = 'name'
    if (hit.recommended) {
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = 'önerilen'
      name.appendChild(badge)
    }
    name.appendChild(document.createTextNode(hit.release))
    button2.appendChild(name)

    if (hit.why) {
      const why = document.createElement('span')
      why.className = 'why'
      why.textContent = hit.why
      button2.appendChild(why)
    }

    button2.addEventListener('click', () => takeSubtitle(hit.fileId, button2))
    list.appendChild(button2)
  }
}

async function takeSubtitle(fileId, button) {
  const note = $('fetch-note')
  button.disabled = true
  note.className = 'note'
  note.textContent = 'İndiriliyor…'

  const result = await window.aioPlayer.takeSubtitle(fileId)
  button.disabled = false

  if (!result || !result.ok) {
    note.className = 'note bad'
    note.textContent = (result && result.message) || 'Altyazı eklenemedi.'
    return
  }
  note.className = 'note ok'
  note.textContent = result.note || 'Altyazı eklendi.'
  state.tracks = [...state.tracks.filter((t) => t.id !== result.track.id), result.track]
  // A subtitle chosen by hand starts from its own timing, not from the offset the
  // last one needed.
  setDelay(0)
  await selectTrack(result.track.id)
  flash('Altyazı eklendi')
}

/* ---- next episode ------------------------------------------------------- */

async function goNext() {
  if (!state.next || state.switching) return
  $('upnext').hidden = true

  // Bank this episode's position first, and stop reporting after that. Switching
  // reloads the page, and the reload fires `beforeunload` — by which time the
  // main process is already pointing at the next episode, so a late report would
  // file this episode's position under the next one's name.
  remember()
  state.switching = true

  app.classList.add('busy')
  try {
    await window.aioPlayer.next()
  } catch (err) {
    state.switching = false
    app.classList.remove('busy')
    flash(err && err.message ? err.message : 'Sonraki bölüm açılamadı.')
  }
}

/**
 * Offered near the end rather than only after it, so it is on screen while the
 * closing credits run — and never on its own initiative: nothing starts playing
 * without the user saying so.
 */
function maybeOfferNext() {
  if (!state.next || state.upNextShown) return
  const duration = video.duration
  if (!Number.isFinite(duration) || duration < 120) return
  if (duration - video.currentTime > 45) return
  state.upNextShown = true
  $('upnext').hidden = false
}

/* ---- transport ---------------------------------------------------------- */

function togglePlay() {
  if (video.paused) {
    video.play().catch(() => {})
    pulse('play')
  } else {
    video.pause()
    pulse('pause')
  }
}

function skip(seconds) {
  if (!state.ready) return
  video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + seconds))
  flash(`${seconds > 0 ? '+' : ''}${seconds} sn`)
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

function cycleRate(step) {
  const index = RATES.indexOf(video.playbackRate)
  const next = RATES[Math.min(RATES.length - 1, Math.max(0, (index < 0 ? 2 : index) + step))]
  video.playbackRate = next
  $('rate').textContent = `${String(next).replace('.', ',')}×`
  flash(`Hız ${String(next).replace('.', ',')}×`)
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  else document.documentElement.requestFullscreen().catch(() => {})
}

function setVolume(value, { save = true } = {}) {
  video.volume = Math.max(0, Math.min(1, Number(value) || 0))
  video.muted = video.volume === 0
  $('volume').value = String(video.volume)
  setIcon($('mute'), video.muted || video.volume === 0 ? 'muted' : 'volume')
  if (save) window.aioPlayer.setVolume(video.volume)
}

/* ---- idle / auto-hide --------------------------------------------------- */

let idleTimer = null

function wake() {
  app.classList.remove('idle')
  clearTimeout(idleTimer)
  // Only hide while something is actually playing, and never with the subtitle
  // panel open: a paused video with hidden controls looks like a frozen app.
  idleTimer = setTimeout(() => {
    if (!video.paused && panel.hidden) app.classList.add('idle')
  }, 2600)
}

/* ---- seek bar ----------------------------------------------------------- */

function seekRatio(event) {
  const rect = $('seek').getBoundingClientRect()
  return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
}

function paintProgress() {
  const duration = video.duration || state.duration || 0
  const ratio = duration ? video.currentTime / duration : 0
  $('seek-played').style.width = `${ratio * 100}%`
  $('seek-knob').style.left = `${ratio * 100}%`
  $('time').textContent = `${clock(video.currentTime)} / ${clock(duration)}`

  let buffered = 0
  for (let i = 0; i < video.buffered.length; i += 1) {
    if (video.buffered.start(i) <= video.currentTime) buffered = video.buffered.end(i)
  }
  $('seek-buffer').style.width = duration ? `${(buffered / duration) * 100}%` : '0%'
}

/* ---- wiring ------------------------------------------------------------- */

function wire() {
  setIcon($('play'), 'play')
  setIcon($('back'), 'back')
  setIcon($('fwd'), 'fwd')
  setIcon($('mute'), 'volume')
  setIcon($('cc'), 'cc')
  setIcon($('pip'), 'pip')
  setIcon($('full'), 'full')
  setIcon($('panel-close'), 'close')

  $('play').addEventListener('click', togglePlay)
  $('back').addEventListener('click', () => skip(-10))
  $('fwd').addEventListener('click', () => skip(10))
  $('mute').addEventListener('click', () => setVolume(video.volume > 0 ? 0 : 1))
  $('volume').addEventListener('input', (e) => setVolume(Number(e.target.value)))
  $('rate').addEventListener('click', () => cycleRate(1))
  $('full').addEventListener('click', toggleFullscreen)
  $('pip').addEventListener('click', () => {
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {})
    else video.requestPictureInPicture().catch(() => flash('Küçük pencere açılamadı.'))
  })

  $('cc').addEventListener('click', () => {
    panel.hidden = !panel.hidden
    if (!panel.hidden) wake()
  })
  $('panel-close').addEventListener('click', () => {
    panel.hidden = true
  })

  $('fetch').addEventListener('click', searchSubtitles)
  $('delay-down').addEventListener('click', () => setDelay(state.delay - 0.5))
  $('delay-up').addEventListener('click', () => setDelay(state.delay + 0.5))

  $('next').addEventListener('click', goNext)
  $('upnext-go').addEventListener('click', goNext)
  $('upnext-stay').addEventListener('click', () => {
    $('upnext').hidden = true
  })

  for (const button of $('size-row').querySelectorAll('button')) {
    button.addEventListener('click', async () => {
      state.size = await window.aioPlayer.subtitleSize(button.dataset.size)
      subsBox.dataset.size = state.size
      paintSizes()
    })
  }

  $('resume-restart').addEventListener('click', () => {
    video.currentTime = 0
    $('resume').hidden = true
  })

  $('fault-external').addEventListener('click', () => window.aioPlayer.openExternally())
  $('fault-remux').addEventListener('click', async () => {
    $('fault').hidden = true
    app.classList.add('busy')
    flash('Dönüştürülüyor…')
    try {
      const { src } = await window.aioPlayer.remux()
      video.src = src
      video.load()
      video.play().catch(() => {})
    } catch (err) {
      $('fault-text').textContent = err && err.message ? err.message : String(err)
      $('fault').hidden = false
    } finally {
      app.classList.remove('busy')
    }
  })

  $('help-close').addEventListener('click', () => {
    $('help').hidden = true
  })

  /* video events */
  video.addEventListener('play', () => {
    setIcon($('play'), 'pause')
    wake()
  })
  video.addEventListener('pause', () => {
    setIcon($('play'), 'play')
    app.classList.remove('idle')
    remember()
  })
  video.addEventListener('waiting', () => app.classList.add('busy'))
  video.addEventListener('playing', () => app.classList.remove('busy'))
  // Reporting the end is what clears the saved position: a film watched through
  // should open at the beginning next time, not five seconds before the credits.
  video.addEventListener('ended', () => {
    remember()
    if (state.next) {
      state.upNextShown = true
      $('upnext').hidden = false
    }
  })
  video.addEventListener('durationchange', () => {
    state.duration = video.duration
  })
  video.addEventListener('error', () => {
    app.classList.remove('busy')
    const code = video.error ? video.error.code : 0
    $('fault-text').textContent =
      code === 4
        ? 'Bu videonun biçimini pencere içinde açamadık — genelde MKV içindeki H.264 sesi/görüntüsü olur. Hızlı dönüştürme akışlara dokunmaz, sadece kabı değiştirir.'
        : 'Dosya okunamadı. Taşınmış ya da bozulmuş olabilir.'
    $('fault').hidden = false
  })

  /* clicking the picture */
  $('stage').addEventListener('click', (event) => {
    if (event.target.closest('#controls') || event.target.closest('#resume') || event.target.closest('#fault')) return
    togglePlay()
  })
  $('stage').addEventListener('dblclick', (event) => {
    if (event.target.closest('#controls')) return
    toggleFullscreen()
  })

  /* seek bar */
  const seek = $('seek')
  const applySeek = (event) => {
    const duration = video.duration || 0
    if (!duration) return
    video.currentTime = seekRatio(event) * duration
    paintProgress()
  }
  seek.addEventListener('pointerdown', (event) => {
    seek.setPointerCapture(event.pointerId)
    seek.classList.add('dragging')
    state.seeking = true
    applySeek(event)
  })
  seek.addEventListener('pointermove', (event) => {
    const duration = video.duration || 0
    if (duration) {
      const tip = $('seek-tip')
      tip.hidden = false
      tip.textContent = clock(seekRatio(event) * duration)
      tip.style.left = `${seekRatio(event) * 100}%`
    }
    if (state.seeking) applySeek(event)
  })
  seek.addEventListener('pointerleave', () => {
    $('seek-tip').hidden = true
  })
  seek.addEventListener('pointerup', (event) => {
    state.seeking = false
    seek.classList.remove('dragging')
    try {
      seek.releasePointerCapture(event.pointerId)
    } catch {
      /* pointer already released */
    }
  })

  /* idle */
  document.addEventListener('mousemove', wake)
  document.addEventListener('keydown', wake)
  document.addEventListener('fullscreenchange', () => {
    app.classList.toggle('full', !!document.fullscreenElement)
    setIcon($('full'), document.fullscreenElement ? 'exitFull' : 'full')
  })

  document.addEventListener('keydown', onKey)
  window.addEventListener('beforeunload', remember)
}

/* ---- keyboard ----------------------------------------------------------- */

const SHORTCUTS = [
  ['Boşluk / K', 'Oynat, duraklat'],
  ['← / →', '10 saniye geri, ileri'],
  ['J / L', '30 saniye geri, ileri'],
  ['↑ / ↓', 'Ses'],
  ['0 – 9', 'Videonun %0 – %90 noktası'],
  ['F', 'Tam ekran'],
  ['Esc', 'Tam ekrandan çık'],
  ['M', 'Sesi kapat, aç'],
  ['V', 'Altyazıyı aç, kapat'],
  ['B', 'Sonraki altyazı parçası'],
  ['C', 'Altyazı panelini aç'],
  ['G / H', 'Altyazıyı 0,5 sn geciktir, öne al'],
  ['< / >', 'Oynatma hızı'],
  ['N', 'Sonraki bölüm'],
  ['?', 'Bu liste'],
]

function fillHelp() {
  const list = $('help-list')
  for (const [key, what] of SHORTCUTS) {
    const li = document.createElement('li')
    const b = document.createElement('b')
    b.textContent = key
    li.appendChild(document.createTextNode(what))
    li.appendChild(b)
    list.appendChild(li)
  }
}

function cycleTrack() {
  const ids = [null, ...state.tracks.map((t) => t.id)]
  const at = ids.indexOf(state.trackId)
  selectTrack(ids[(at + 1) % ids.length])
}

function onKey(event) {
  // A key pressed inside the language picker belongs to the language picker.
  const tag = event.target && event.target.tagName
  if (tag === 'SELECT' || tag === 'INPUT') return
  if (event.metaKey || event.ctrlKey || event.altKey) return

  const key = event.key
  const handlers = {
    ' ': togglePlay,
    k: togglePlay,
    ArrowLeft: () => skip(-10),
    ArrowRight: () => skip(10),
    j: () => skip(-30),
    l: () => skip(30),
    ArrowUp: () => setVolume(video.volume + 0.1),
    ArrowDown: () => setVolume(video.volume - 0.1),
    f: toggleFullscreen,
    m: () => setVolume(video.volume > 0 ? 0 : 1),
    v: () => (state.trackId ? selectTrack(null) : cycleTrack()),
    b: cycleTrack,
    c: () => {
      panel.hidden = !panel.hidden
    },
    g: () => setDelay(state.delay - 0.5),
    h: () => setDelay(state.delay + 0.5),
    n: goNext,
    '<': () => cycleRate(-1),
    '>': () => cycleRate(1),
    ',': () => cycleRate(-1),
    '.': () => cycleRate(1),
    '?': () => {
      $('help').hidden = !$('help').hidden
    },
  }

  const lower = key.length === 1 ? key.toLowerCase() : key
  const run = handlers[key] || handlers[lower]
  if (run) {
    event.preventDefault()
    run()
    return
  }

  if (/^[0-9]$/.test(key) && video.duration) {
    event.preventDefault()
    video.currentTime = (Number(key) / 10) * video.duration
  } else if (key === 'Escape') {
    if (!$('help').hidden) $('help').hidden = true
    else if (!panel.hidden) panel.hidden = true
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  }
}

/* ---- position ----------------------------------------------------------- */

function remember() {
  if (!state.ready || state.switching) return
  window.aioPlayer.remember(video.currentTime, video.duration)
}

/* ---- run ---------------------------------------------------------------- */

function frame() {
  if (!video.paused) {
    paintProgress()
    drawSubtitle()
    maybeOfferNext()
  }
  requestAnimationFrame(frame)
}

wire()
fillHelp()
wake()
boot().catch((err) => {
  $('fault-text').textContent = err && err.message ? err.message : String(err)
  $('fault').hidden = false
})
requestAnimationFrame(frame)
video.addEventListener('seeked', () => {
  paintProgress()
  lastCueIndex = -1
  drawSubtitle()
})
setInterval(() => {
  if (!video.paused) remember()
}, 5000)
