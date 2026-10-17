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
  prev: null,
  upNextShown: false,
  switching: false,
  vault: false,
  chapters: [],
  audio: [],
  boost: 1,
  fit: 'contain',
  autoNext: true,
  subtitleStyle: 'box',
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
  next: svg('<polygon points="5 5 15 12 5 19 5 5" fill="currentColor" stroke="none"/><path d="M19 5v14"/>'),
  prev: svg('<polygon points="19 5 9 12 19 19 19 5" fill="currentColor" stroke="none"/><path d="M5 5v14"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
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
  state.prev = info.prev || null
  state.vault = !!info.vault
  state.chapters = Array.isArray(info.chapters) ? info.chapters : []
  state.audio = Array.isArray(info.audio) ? info.audio : []
  state.autoNext = info.autoNext !== false
  subsBox.dataset.size = state.size
  setRate(info.rate || 1, { save: false, quiet: true })
  setFit(info.fit || 'contain', { save: false })
  setSubtitleStyle(info.subtitleStyle || 'box', { save: false })
  state.boost = Number(info.boost) || 1
  $('prev').hidden = !state.prev
  $('q-autonext').checked = state.autoNext
  $('q-autonext-row').hidden = !state.next
  // A screenshot of a vaulted film would be a plaintext picture of it.
  $('q-shot').hidden = state.vault
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
  $('probe').src = info.src

  // Resume once the duration is known: a seek issued before then is discarded.
  video.addEventListener(
    'loadedmetadata',
    () => {
      state.duration = video.duration
      state.ready = true
      paintChapters()
      paintAudio()
      // Boost needs Web Audio, which is only wired up when it is actually used.
      if (state.boost > 1) setBoost(state.boost, { save: false })
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

/**
 * Cue text may carry <i>, <b> and <u>; those survive. Every other tag — <font
 * color=…>, the {\\an8} positioning codes of converted ASS files — is removed
 * rather than escaped, because escaped it showed up on screen as literal markup.
 * Whatever is left is text, and is escaped before it touches innerHTML.
 */
function cueHtml(text) {
  const cleaned = String(text)
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<(?!\/?[ibu]>)[^>]*>/gi, '')
  const escaped = cleaned
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

async function goPrev() {
  if (!state.prev || state.switching) return
  remember()
  state.switching = true
  app.classList.add('busy')
  try {
    await window.aioPlayer.prev()
  } catch (err) {
    state.switching = false
    app.classList.remove('busy')
    flash(err && err.message ? err.message : 'Önceki bölüm açılamadı.')
  }
}

/** Offered near the end, so it is on screen while the closing credits run. */
function maybeOfferNext() {
  if (!state.next || state.upNextShown) return
  const duration = video.duration
  if (!Number.isFinite(duration) || duration < 120) return
  if (duration - video.currentTime > 45) return
  state.upNextShown = true
  $('upnext-label').textContent = 'Sonraki bölüm'
  $('upnext').hidden = false
}

/**
 * When the episode ends: count down and move on, the way a video site does —
 * with the countdown on screen and one click to stop it. Off in the settings
 * popover for anyone who would rather choose.
 */
let countdownTimer = null
function startCountdown() {
  if (!state.next) return
  $('upnext').hidden = false
  if (!state.autoNext) {
    $('upnext-label').textContent = 'Sonraki bölüm'
    return
  }
  let left = 8
  const card = document.querySelector('.upnext-card')
  let bar = card.querySelector('.countdown')
  if (!bar) {
    bar = document.createElement('div')
    bar.className = 'countdown'
    bar.innerHTML = '<span></span>'
    card.appendChild(bar)
  }
  const tick = () => {
    $('upnext-label').textContent = `Sonraki bölüm ${left} sn içinde`
    bar.firstChild.style.width = `${((8 - left) / 8) * 100}%`
    if (left <= 0) {
      stopCountdown()
      goNext()
      return
    }
    left -= 1
  }
  stopCountdown()
  tick()
  countdownTimer = setInterval(tick, 1000)
}

function stopCountdown() {
  clearInterval(countdownTimer)
  countdownTimer = null
  const bar = document.querySelector('.upnext-card .countdown')
  if (bar) bar.remove()
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

function setRate(rate, { save = true, quiet = false } = {}) {
  const next = RATES.includes(Number(rate)) ? Number(rate) : 1
  video.playbackRate = next
  // The probe decodes nothing audible, but keep it in step so seeking matches.
  $('rate').textContent = `${String(next).replace('.', ',')}×`
  if (!quiet) flash(`Hız ${String(next).replace('.', ',')}×`)
  for (const b of $('q-rate').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.rate) === next)
  if (save) window.aioPlayer.prefs({ rate: next })
}

function cycleRate(step) {
  const index = RATES.indexOf(video.playbackRate)
  setRate(RATES[Math.min(RATES.length - 1, Math.max(0, (index < 0 ? 2 : index) + step))])
}

/* ---- picture, sound, extras --------------------------------------------- */

/**
 * The frame under the pointer on the scrub bar. A second decoder does the
 * seeking, one request at a time; while it is busy only the latest position is
 * remembered, so dragging fast never queues up a backlog of stale frames.
 */
const preview = { busy: false, want: null }
function previewAt(seconds) {
  const probe = $('probe')
  if (state.audioOnly || !probe.src) return
  preview.want = seconds
  if (preview.busy || probe.readyState < 1) return
  preview.busy = true
  preview.want = null
  probe.currentTime = seconds
  setTimeout(() => {
    preview.busy = false
  }, 1500)
}

function toggleMute() {
  // Muting is not a volume of zero: the level the user chose comes back intact.
  video.muted = !video.muted
  setIcon($('mute'), video.muted || video.volume === 0 ? 'muted' : 'volume')
  flash(video.muted ? 'Ses kapalı' : `Ses %${Math.round(video.volume * 100)}`)
}


const FITS = ['contain', 'cover', 'fill']
const FIT_NAMES = { contain: 'Sığdır', cover: 'Doldur', fill: 'Uzat' }

function setFit(fit, { save = true } = {}) {
  state.fit = FITS.includes(fit) ? fit : 'contain'
  video.dataset.fit = state.fit
  for (const b of $('q-fit').querySelectorAll('button')) b.classList.toggle('on', b.dataset.fit === state.fit)
  if (save) {
    window.aioPlayer.prefs({ fit: state.fit })
    flash(`Görüntü: ${FIT_NAMES[state.fit]}`)
  }
}

function setSubtitleStyle(style, { save = true } = {}) {
  state.subtitleStyle = style === 'outline' ? 'outline' : 'box'
  subsBox.dataset.style = state.subtitleStyle
  for (const b of $('q-style').querySelectorAll('button')) b.classList.toggle('on', b.dataset.style === state.subtitleStyle)
  if (save) window.aioPlayer.prefs({ subtitleStyle: state.subtitleStyle })
}

/**
 * Louder than the file allows. The element tops out at 100%, so quiet rips go
 * through a Web Audio gain node instead — created on first use only, because
 * once an element is routed through an audio graph it stays there.
 */
let audioGraph = null
function setBoost(boost, { save = true } = {}) {
  state.boost = [1, 1.5, 2].includes(Number(boost)) ? Number(boost) : 1
  for (const b of $('q-boost').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.boost) === state.boost)
  if (state.boost > 1 && !audioGraph) {
    try {
      const ctx = new AudioContext()
      const source = ctx.createMediaElementSource(video)
      const gain = ctx.createGain()
      // A limiter after the gain, so 200% means louder, not clipped.
      const limiter = ctx.createDynamicsCompressor()
      limiter.threshold.value = -2
      limiter.ratio.value = 20
      source.connect(gain).connect(limiter).connect(ctx.destination)
      audioGraph = { ctx, gain }
    } catch {
      flash('Ses yükseltme bu dosyada çalışmadı.')
      state.boost = 1
    }
  }
  if (audioGraph) {
    audioGraph.gain.gain.value = state.boost
    if (audioGraph.ctx.state === 'suspended') audioGraph.ctx.resume().catch(() => {})
  }
  if (save) {
    window.aioPlayer.prefs({ boost: state.boost })
    flash(`Ses yükseltme %${Math.round(state.boost * 100)}`)
  }
}

/** The file's own audio tracks, when it has more than one. */
function paintAudio() {
  const tracks = video.audioTracks
  const list = $('audio-list')
  list.innerHTML = ''
  if (!tracks || tracks.length < 2) {
    $('audio').hidden = true
    return
  }
  $('audio').hidden = false
  for (let i = 0; i < tracks.length; i += 1) {
    const track = tracks[i]
    const known = state.audio[i]
    const button = document.createElement('button')
    button.type = 'button'
    button.className = track.enabled ? 'on' : ''
    button.textContent = (known && known.label) || track.label || track.language || `Ses ${i + 1}`
    button.addEventListener('click', () => selectAudio(i))
    list.appendChild(button)
  }
}

function selectAudio(index) {
  const tracks = video.audioTracks
  if (!tracks || !tracks[index]) return
  const at = video.currentTime
  for (let i = 0; i < tracks.length; i += 1) tracks[i].enabled = i === index
  // Some files only switch cleanly after a nudge of the clock.
  video.currentTime = at
  paintAudio()
  flash(`Ses: ${$('audio-list').children[index].textContent}`)
}

function cycleAudio() {
  const tracks = video.audioTracks
  if (!tracks || tracks.length < 2) return flash('Bu videoda tek ses parçası var.')
  let current = 0
  for (let i = 0; i < tracks.length; i += 1) if (tracks[i].enabled) current = i
  selectAudio((current + 1) % tracks.length)
}

/** Chapter marks on the scrub bar, and the current chapter's name beside the clock. */
function paintChapters() {
  const box = $('chapters')
  box.innerHTML = ''
  const duration = video.duration
  if (!state.chapters.length || !Number.isFinite(duration) || duration <= 0) return
  for (const chapter of state.chapters) {
    if (chapter.start <= 0.5 || chapter.start >= duration) continue
    const tick = document.createElement('span')
    tick.style.left = `${(chapter.start / duration) * 100}%`
    box.appendChild(tick)
  }
}

function chapterAt(seconds) {
  let found = null
  for (const chapter of state.chapters) if (chapter.start <= seconds) found = chapter
  return found
}

function jumpChapter(step) {
  if (!state.chapters.length) return skip(step * 60)
  const now = video.currentTime
  const starts = state.chapters.map((c) => c.start)
  const target =
    step > 0 ? starts.find((t) => t > now + 1) : [...starts].reverse().find((t) => t < now - 3)
  if (target === undefined) return
  video.currentTime = target
  const chapter = chapterAt(target)
  flash(chapter && chapter.title ? chapter.title : clock(target))
}

async function screenshot() {
  if (state.vault) return flash('Kasadaki videolardan ekran görüntüsü alınmaz.')
  if (!video.videoWidth) return
  try {
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0)
    const saved = await window.aioPlayer.screenshot(canvas.toDataURL('image/png'), video.currentTime)
    flash('Ekran görüntüsü Resimler klasörüne kaydedildi')
    state.lastShot = saved && saved.path
  } catch (err) {
    flash(err && err.message ? err.message.replace(/^Error invoking remote method[^:]*: (Error: )?/, '') : 'Kaydedilemedi.')
  }
}

async function toggleOnTop(force) {
  const want = typeof force === 'boolean' ? force : !$('q-ontop').checked
  const on = await window.aioPlayer.onTop(want)
  $('q-ontop').checked = !!on
  flash(on ? 'Her zaman üstte' : 'Üstte tutma kapalı')
}

function togglePopover(id) {
  for (const other of ['quick', 'audio-menu']) if (other !== id) $(other).hidden = true
  $(id).hidden = !$(id).hidden
  if (!$(id).hidden) wake()
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  else document.documentElement.requestFullscreen().catch(() => {})
}

function setVolume(value, { save = true } = {}) {
  video.volume = Math.max(0, Math.min(1, Number(value) || 0))
  if (video.volume > 0) video.muted = false
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
  if (state.chapters.length) {
    const chapter = chapterAt(video.currentTime)
    const name = chapter && chapter.title ? chapter.title : ''
    if ($('chapter-name').textContent !== name) $('chapter-name').textContent = name
  }

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
  setIcon($('next'), 'next')
  setIcon($('prev'), 'prev')
  setIcon($('gear'), 'gear')

  for (const rate of RATES) {
    const b = document.createElement('button')
    b.type = 'button'
    b.dataset.rate = String(rate)
    b.textContent = `${String(rate).replace('.', ',')}×`
    b.addEventListener('click', () => setRate(rate))
    $('q-rate').appendChild(b)
  }
  for (const b of $('q-fit').querySelectorAll('button')) b.addEventListener('click', () => setFit(b.dataset.fit))
  for (const b of $('q-boost').querySelectorAll('button')) b.addEventListener('click', () => setBoost(b.dataset.boost))
  for (const b of $('q-style').querySelectorAll('button')) b.addEventListener('click', () => setSubtitleStyle(b.dataset.style))
  $('q-autonext').addEventListener('change', (e) => {
    state.autoNext = e.target.checked
    window.aioPlayer.prefs({ autoNext: state.autoNext })
  })
  $('q-ontop').addEventListener('change', (e) => toggleOnTop(e.target.checked))
  $('q-shot').addEventListener('click', screenshot)
  $('gear').addEventListener('click', () => togglePopover('quick'))
  $('audio').addEventListener('click', () => togglePopover('audio-menu'))
  $('prev').addEventListener('click', goPrev)
  // Tracks can appear after metadata in some containers.
  if (video.audioTracks) {
    video.audioTracks.addEventListener('addtrack', paintAudio)
    video.audioTracks.addEventListener('change', paintAudio)
  }

  $('play').addEventListener('click', togglePlay)
  $('back').addEventListener('click', () => skip(-10))
  $('fwd').addEventListener('click', () => skip(10))
  $('mute').addEventListener('click', toggleMute)
  $('volume').addEventListener('input', (e) => setVolume(Number(e.target.value)))
  $('rate').addEventListener('click', () => togglePopover('quick'))
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
    stopCountdown()
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
      startCountdown()
    }
  })
  video.addEventListener('durationchange', () => {
    state.duration = video.duration
  })
  video.addEventListener('error', () => {
    app.classList.remove('busy')
    const code = video.error ? video.error.code : 0
    $('fault-remux').hidden = state.vault
    $('fault-text').textContent =
      code === 4
        ? 'Bu videonun biçimini pencere içinde açamadık — genelde MKV içindeki H.264 sesi/görüntüsü olur. Hızlı dönüştürme akışlara dokunmaz, sadece kabı değiştirir.'
        : 'Dosya okunamadı. Taşınmış ya da bozulmuş olabilir.'
    $('fault').hidden = false
  })

  /* clicking the picture */
  const onSurface = (event) =>
    !event.target.closest('#controls, #resume, #fault, #upnext, .popover, #panel, #help')
  let clickTimer = null
  $('stage').addEventListener('click', (event) => {
    if (!onSurface(event)) return
    // Any open popover closes on a click elsewhere, without also pausing.
    if (!$('quick').hidden || !$('audio-menu').hidden) {
      $('quick').hidden = true
      $('audio-menu').hidden = true
      return
    }
    // Wait a moment: the first click of a double-click must not toggle play.
    clearTimeout(clickTimer)
    clickTimer = setTimeout(togglePlay, 220)
  })
  $('stage').addEventListener('dblclick', (event) => {
    if (!onSurface(event)) return
    clearTimeout(clickTimer)
    // Like a phone player: the outer thirds skip, the middle goes full screen.
    const rect = $('stage').getBoundingClientRect()
    const x = (event.clientX - rect.left) / rect.width
    if (x < 0.3) skip(-10)
    else if (x > 0.7) skip(10)
    else toggleFullscreen()
  })
  // The wheel over the picture is volume, as in VLC.
  $('stage').addEventListener(
    'wheel',
    (event) => {
      if (!onSurface(event)) return
      event.preventDefault()
      setVolume(video.volume + (event.deltaY < 0 ? 0.05 : -0.05))
      flash(`Ses %${Math.round(video.volume * 100)}`)
    },
    { passive: false }
  )

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
      const at = seekRatio(event) * duration
      tip.hidden = false
      $('seek-time').textContent = clock(at)
      const chapter = chapterAt(at)
      $('seek-chapter').textContent = chapter && chapter.title ? chapter.title : ''
      // Keep the preview inside the window at both ends of the bar.
      const rect = seek.getBoundingClientRect()
      const half = 100
      const x = Math.min(rect.width - half, Math.max(half, event.clientX - rect.left))
      tip.style.left = `${x}px`
      previewAt(at)
    }
    if (state.seeking) applySeek(event)
  })
  seek.addEventListener('pointerleave', () => {
    $('seek-tip').hidden = true
  })

  const probe = $('probe')
  probe.addEventListener('seeked', () => {
    const canvas = $('seek-frame')
    try {
      canvas.getContext('2d').drawImage(probe, 0, 0, canvas.width, canvas.height)
      canvas.hidden = false
    } catch {
      canvas.hidden = true
    }
    preview.busy = false
    if (preview.want !== null && Math.abs(preview.want - probe.currentTime) > 1) previewAt(preview.want)
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
  ['N / P', 'Sonraki, önceki bölüm'],
  ['Page Up / Down', 'Önceki, sonraki bölüm işareti (chapter)'],
  ['A', 'Ses dilini değiştir'],
  ['Z', 'Görüntü: sığdır, doldur, uzat'],
  ['S', 'Ekran görüntüsü'],
  ['T', 'Her zaman üstte'],
  ['Çift tık', 'Kenarlarda ±10 sn, ortada tam ekran'],
  ['Tekerlek', 'Ses'],
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
    m: toggleMute,
    a: cycleAudio,
    p: goPrev,
    s: screenshot,
    t: () => toggleOnTop(),
    z: () => setFit(FITS[(FITS.indexOf(state.fit) + 1) % FITS.length]),
    PageUp: () => jumpChapter(-1),
    PageDown: () => jumpChapter(1),
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
    if (!$('quick').hidden || !$('audio-menu').hidden) {
      $('quick').hidden = true
      $('audio-menu').hidden = true
    } else if (!$('help').hidden) $('help').hidden = true
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
