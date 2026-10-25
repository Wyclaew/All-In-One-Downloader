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
const Core = window.PlayerCore

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
  cueIndex: Core.cueIndex([]),
  subtitleEpoch: 0,
  lastTrackId: null,
  rate: 1,
  audioDelay: 0,
  autoNextCanceled: false,
  src: '',
  mediaEpoch: 0,
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
  // This is a per-open rule, independent of preferred language, forced/default
  // track flags and any settings left by an older version.
  await selectTrack(null)
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
  state.mediaInfo = info.mediaInfo || null
  paintDiagnostics()
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

  await loadMedia(info.src, { at: Number(info.resumeAt) || 0, resumeNotice: true })
}

function disableNativeSubtitles() {
  for (const media of [video, $('probe')]) {
    for (const track of Array.from(media.textTracks || [])) if (track.mode !== 'disabled') track.mode = 'disabled'
  }
}

function loadMedia(src, { at = 0, autoplay = true, resumeNotice = false } = {}) {
  state.mediaCleanup?.()
  const epoch = ++state.mediaEpoch
  state.ready = false
  state.src = src
  state.playingIntent = autoplay
  resetPreview(true)
  resetPlaybackWatch()
  $('recovery').hidden = true
  $('fault').hidden = true
  app.classList.add('busy')
  return new Promise((resolve) => {
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', loaded)
      video.removeEventListener('error', failed)
      if (state.mediaCleanup === cancel) state.mediaCleanup = null
    }
    const cancel = () => { cleanup(); resolve(false) }
    const failed = () => { cleanup(); resolve(false) }
    const loaded = () => {
      cleanup()
      if (state.mediaEpoch !== epoch) return resolve(false)
      disableNativeSubtitles()
      state.duration = Core.finiteDuration(video.duration) || 0
      state.audioOnly = !video.videoWidth
      state.ready = true
      $('pip').disabled = state.audioOnly || !document.pictureInPictureEnabled || typeof video.requestPictureInPicture !== 'function'
      video.playbackRate = state.rate
      paintChapters(); paintAudio(); paintProgress()
      if (state.boost > 1 || state.audioDelay > 0) setBoost(state.boost, { save: false })
      const target = Core.seekTime(at, video.duration)
      if (target !== null && target > 0 && (!resumeNotice || (target > 20 && target < video.duration - 10))) {
        video.currentTime = target
        if (resumeNotice) {
          $('resume-text').textContent = `${clock(target)} — kaldığın yerden`
          $('resume').hidden = false
          setTimeout(() => { $('resume').hidden = true }, 6000)
        }
      }
      if (autoplay) playSafely()
      else { video.pause(); app.classList.remove('busy') }
      resolve(true)
    }
    state.mediaCleanup = cancel
    video.addEventListener('loadedmetadata', loaded)
    video.addEventListener('error', failed)
    video.src = src
    disableNativeSubtitles()
    video.load()
  })
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
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code) => {
      const names = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }
      if (code[0] !== '#') return names[code.toLowerCase()] || entity
      const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity
    })
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<(?!\/?[ibu]>)[^>]*>/gi, '')
  const escaped = cleaned
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
  return escaped.replace(/&lt;(\/?)([ibu])&gt;/gi, '<$1$2>')
}

let lastCueIndex = ''

function drawSubtitle() {
  if (!state.cues.length) {
    if (subsBox.firstChild) subsBox.textContent = ''
    return
  }
  const at = video.currentTime - state.delay
  const active = Core.activeCues(state.cueIndex, at)
  const key = active.map((cue) => cue.index).join(',')
  if (key === lastCueIndex) return
  lastCueIndex = key
  subsBox.innerHTML = active.map((cue) => `<span>${cueHtml(cue.text)}</span>`).join('<br>')
}

async function selectTrack(id) {
  if (id && !state.tracks.some((track) => track.id === id)) return
  const epoch = ++state.subtitleEpoch
  state.trackId = id
  if (id) state.lastTrackId = id
  lastCueIndex = ''
  subsBox.textContent = ''
  state.cues = []
  state.cueIndex = Core.cueIndex([])
  paintTracks()
  if (!id) return
  $('subtitle-state').textContent = 'Altyazı yükleniyor…'
  try {
    const cues = await window.aioPlayer.cues(id)
    if (epoch !== state.subtitleEpoch || state.trackId !== id) return
    state.cueIndex = Core.cueIndex(cues)
    state.cues = state.cueIndex.cues
    if (!state.cues.length) { state.trackId = null; flash('Bu altyazı okunamadı. Başka bir parça seçebilirsin.') }
  } catch {
    if (epoch !== state.subtitleEpoch) return
    state.trackId = null
    flash('Altyazı yüklenemedi. Yeniden deneyebilirsin.')
  }
  paintTracks()
  drawSubtitle()
}

function paintTracks() {
  const list = $('track-list')
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.trackId : null
  list.innerHTML = ''

  const add = (id, label) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `track${state.trackId === id ? ' on' : ''}`
    button.setAttribute('aria-pressed', String(state.trackId === id))
    button.dataset.trackId = id || ''
    button.innerHTML = '<span class="dot"></span>'
    button.appendChild(document.createTextNode(label))
    button.addEventListener('click', () => selectTrack(id))
    list.appendChild(button)
  }

  add(null, 'Kapalı')
  for (const track of state.tracks) add(track.id, `${track.label}${track.forced ? ' · zorunlu parça' : ''}`)
  const selected = state.tracks.find((track) => track.id === state.trackId)
  $('subtitle-state').textContent = selected ? selected.label : 'Altyazı kapalı · her video kapalı başlar'
  $('cc').classList.toggle('on', !!selected && state.cues.length > 0)
  $('cc').setAttribute('aria-pressed', String(!!selected && state.cues.length > 0))
  if (!state.tracks.length) {
    const note = document.createElement('p')
    note.className = 'note'
    note.textContent = 'Bu videonun yanında altyazı yok. Aşağıdan dil seçip arayabilirsin.'
    list.appendChild(note)
  }
  if (focused !== null) [...list.querySelectorAll('button')].find((button) => button.dataset.trackId === focused)?.focus()
}

function paintSizes() {
  for (const button of $('size-row').querySelectorAll('button')) {
    button.classList.toggle('on', button.dataset.size === state.size)
  }
}

function setDelay(seconds, { save = true } = {}) {
  const value = Number(seconds)
  if (!Number.isFinite(value)) return
  state.delay = Math.round(Math.max(-120, Math.min(120, value)) * 10) / 10
  lastCueIndex = ''
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

  let result
  try { result = await window.aioPlayer.searchSubtitles(language) }
  catch { result = { ok: false, message: 'Arama tamamlanamadı. Yeniden deneyebilirsin.' } }
  finally { button.disabled = false }
  if ($('lang').value !== language) return

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

  const selection = state.subtitleEpoch
  let result
  try { result = await window.aioPlayer.takeSubtitle(fileId) }
  catch { result = { ok: false, message: 'Altyazı indirilemedi. Yeniden deneyebilirsin.' } }
  finally { button.disabled = false }

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
  if (selection === state.subtitleEpoch) {
    setDelay(0)
    await selectTrack(result.track.id)
  } else paintTracks()
  flash('Altyazı eklendi')
}

/* ---- next episode ------------------------------------------------------- */

async function goNext() {
  if (!state.next || state.switching) return
  stopCountdown()
  $('upnext').hidden = true

  // Bank this episode's position first, and stop reporting after that. Switching
  // reloads the page, and the reload fires `beforeunload` — by which time the
  // main process is already pointing at the next episode, so a late report would
  // file this episode's position under the next one's name.
  remember()
  state.switching = true
  video.pause()

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
  stopCountdown()
  remember()
  state.switching = true
  video.pause()
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
  if (state.autoNextCanceled) return
  stopCountdown()
  $('upnext').hidden = false
  if (!Core.autoAdvance(state.next, state.autoNext, state.autoNextCanceled)) {
    $('upnext-label').textContent = state.next.sure ? 'Sonraki bölüm' : 'Klasördeki sonraki video'
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
    if (!video.ended || state.switching || state.autoNextCanceled || !state.autoNext) return stopCountdown()
    $('upnext-label').textContent = `Sonraki bölüm ${left} sn içinde`
    bar.firstChild.style.width = `${((8 - left) / 8) * 100}%`
    if (left <= 0) {
      stopCountdown()
      goNext()
      return
    }
    left -= 1
  }
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
  if (!state.src || !$('fault').hidden) return
  if (video.paused) {
    playSafely()
    pulse('play')
  } else {
    state.playingIntent = false
    video.pause()
    pulse('pause')
  }
}

function skip(seconds) {
  if (!state.ready) return
  if (!seekTo(video.currentTime + seconds)) return
  flash(`${seconds > 0 ? '+' : ''}${seconds} sn`)
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

function setRate(rate, { save = true, quiet = false } = {}) {
  const next = RATES.includes(Number(rate)) ? Number(rate) : 1
  video.playbackRate = next
  state.rate = next
  // The probe decodes nothing audible, but keep it in step so seeking matches.
  $('rate').textContent = `${String(next).replace('.', ',')}×`
  if (!quiet) flash(`Hız ${String(next).replace('.', ',')}×`)
  for (const b of $('q-rate').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.rate) === next)
  if (save) window.aioPlayer.prefs({ rate: next })
}

function playSafely() {
  return video.play().catch((error) => {
    app.classList.remove('busy')
    if (error?.name !== 'AbortError') flash('Oynatmak için Oynat düğmesine bas.')
  })
}

function seekTo(seconds) {
  const at = Core.seekTime(seconds, video.duration)
  if (!state.ready || at === null) return false
  stopCountdown()
  $('upnext').hidden = true
  try { video.currentTime = at; paintProgress(); return true } catch { return false }
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
const preview = { busy: false, want: null, epoch: 0, last: 0, timer: null, watchdog: null }
function resetPreview(release = false) {
  preview.epoch += 1
  preview.busy = false; preview.want = null
  clearTimeout(preview.timer); clearTimeout(preview.watchdog)
  preview.timer = null; preview.watchdog = null
  if (release) { $('probe').removeAttribute('src'); $('probe').load(); $('seek-frame').hidden = true }
}
function previewAt(seconds) {
  const probe = $('probe')
  if (state.audioOnly || state.seeking || video.seeking || !state.src || !Number.isFinite(seconds)) return
  preview.want = seconds
  // The second decoder is opened lazily, then limited to four previews/second.
  // Scrubbing the actual video never launches competing preview seeks.
  if (probe.getAttribute('src') !== state.src) { probe.src = state.src; probe.load(); return }
  drainPreview()
}
function drainPreview() {
  const probe = $('probe')
  if (preview.busy || preview.want === null || probe.readyState < 1 || state.seeking || video.seeking) return
  clearTimeout(preview.timer)
  const wait = 250 - (performance.now() - preview.last)
  if (wait > 0) { preview.timer = setTimeout(drainPreview, wait); return }
  preview.busy = true
  const at = preview.want, epoch = ++preview.epoch
  preview.last = performance.now()
  preview.want = null
  try {
    if (Math.abs(probe.currentTime - at) < 0.05) { finishPreview(); return }
    probe.currentTime = at
    preview.watchdog = setTimeout(() => {
      if (preview.epoch !== epoch) return
      preview.busy = false; drainPreview()
    }, 1500)
  } catch { preview.busy = false }
}
function finishPreview() {
  if (!preview.busy) return
  clearTimeout(preview.watchdog)
  const canvas = $('seek-frame')
  if (!$('seek-tip').hidden) {
    try { canvas.getContext('2d').drawImage($('probe'), 0, 0, canvas.width, canvas.height); canvas.hidden = false }
    catch { canvas.hidden = true }
  }
  preview.busy = false
  drainPreview()
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
function ensureAudioGraph() {
  if (!audioGraph) {
    try {
      const ctx = new AudioContext()
      const source = ctx.createMediaElementSource(video)
      const gain = ctx.createGain()
      const delay = ctx.createDelay(2)
      // A limiter after the gain, so 200% means louder, not clipped.
      const limiter = ctx.createDynamicsCompressor()
      limiter.threshold.value = -2
      limiter.ratio.value = 20
      source.connect(delay).connect(gain).connect(limiter).connect(ctx.destination)
      audioGraph = { ctx, gain, delay }
    } catch {
      flash('Ses işleme bu dosyada kullanılamıyor.')
      return false
    }
  }
  if (audioGraph.ctx.state === 'suspended') audioGraph.ctx.resume().catch(() => {})
  return true
}

function setBoost(boost, { save = true } = {}) {
  state.boost = [1, 1.5, 2].includes(Number(boost)) ? Number(boost) : 1
  if ((state.boost > 1 || state.audioDelay > 0) && !ensureAudioGraph()) { state.boost = 1; state.audioDelay = 0 }
  for (const b of $('q-boost').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.boost) === state.boost)
  if (audioGraph) {
    audioGraph.gain.gain.value = state.boost
    audioGraph.delay.delayTime.value = state.audioDelay
    if (audioGraph.ctx.state === 'suspended') audioGraph.ctx.resume().catch(() => {})
  }
  if (save) {
    window.aioPlayer.prefs({ boost: state.boost })
    flash(`Ses yükseltme %${Math.round(state.boost * 100)}`)
  }
}

function setAudioDelay(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value)) return
  state.audioDelay = Math.round(Math.max(0, Math.min(2, value)) * 100) / 100
  if (state.audioDelay > 0 && !ensureAudioGraph()) state.audioDelay = 0
  if (audioGraph) audioGraph.delay.delayTime.value = state.audioDelay
  $('q-audio-delay').value = String(state.audioDelay)
  $('audio-delay-value').textContent = `${state.audioDelay.toFixed(2).replace('.', ',')} sn`
}

/** The file's own audio tracks, when it has more than one. */
function paintAudio() {
  const tracks = video.audioTracks
  const list = $('audio-list')
  list.innerHTML = ''
  if (!tracks || !tracks.length) {
    $('audio').hidden = !state.audio.length
    $('audio-note').hidden = !state.audio.length
    $('audio-note').textContent = 'Bu kapsayıcıda ses seçimi kullanılamıyor. Sistem oynatıcısını deneyebilirsin.'
    return
  }
  $('audio').hidden = false
  $('audio-note').hidden = state.audio.length <= tracks.length
  $('audio-note').textContent = 'Bu kapsayıcıdaki bazı ses parçaları desteklenmiyor.'
  for (let i = 0; i < tracks.length; i += 1) {
    const track = tracks[i]
    const known = state.audio[i]
    const button = document.createElement('button')
    button.type = 'button'
    button.className = track.enabled ? 'on' : ''
    button.setAttribute('aria-pressed', String(track.enabled))
    button.textContent = (known && known.label) || track.label || track.language || `Ses ${i + 1}`
    button.addEventListener('click', () => selectAudio(i))
    list.appendChild(button)
    if (track.enabled) $('audio').title = `Ses: ${button.textContent} (A)`
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
  $('audio-list').children[index]?.focus()
  flash(`Ses: ${$('audio-list').children[index].textContent}`)
}

function cycleAudio() {
  const tracks = video.audioTracks
  if (!tracks || tracks.length < 2) return flash(state.audio.length > 1 ? 'Bu kapsayıcıda ses seçimi desteklenmiyor.' : 'Bu videoda tek ses parçası var.')
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
  try {
    const on = await window.aioPlayer.onTop(want)
    $('q-ontop').checked = !!on
    flash(on ? 'Her zaman üstte' : 'Üstte tutma kapalı')
  } catch { $('q-ontop').checked = !want; flash('Pencere tercihi uygulanamadı.') }
}

function togglePopover(id) {
  for (const other of ['quick', 'audio-menu']) if (other !== id) $(other).hidden = true
  $(id).hidden = !$(id).hidden
  $('gear').setAttribute('aria-expanded', String(!$('quick').hidden))
  $('rate').setAttribute('aria-expanded', String(!$('quick').hidden))
  $('audio').setAttribute('aria-expanded', String(!$('audio-menu').hidden))
  if (!$(id).hidden) { wake(); $(id).querySelector('button:not(:disabled),input,select')?.focus() }
}

function setPanel(open) {
  panel.hidden = !open
  $('cc').setAttribute('aria-expanded', String(open))
  if (open) { wake(); $('panel-close').focus() }
  else $('cc').focus()
}

function closePopovers() {
  $('quick').hidden = true; $('audio-menu').hidden = true
  for (const id of ['gear', 'rate', 'audio']) $(id).setAttribute('aria-expanded', 'false')
}

let helpReturnFocus = null
function setHelp(open) {
  if (open) { helpReturnFocus = document.activeElement; $('help').hidden = false; $('help-close').focus(); wake() }
  else { $('help').hidden = true; helpReturnFocus?.focus() }
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
    const interactive = document.activeElement?.closest('#controls, #panel, .popover, #help, #fault, #upnext, #recovery')
    if (!video.paused && panel.hidden && $('quick').hidden && $('audio-menu').hidden && $('help').hidden && $('recovery').hidden && !state.seeking && !interactive) app.classList.add('idle')
  }, 2600)
}

/* ---- seek bar ----------------------------------------------------------- */

function seekRatio(event) {
  const rect = $('seek').getBoundingClientRect()
  return rect.width ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0
}

function paintProgress() {
  const duration = Core.finiteDuration(video.duration) || 0
  const ratio = duration ? Math.max(0, Math.min(1, video.currentTime / duration)) : 0
  $('seek-played').style.width = `${ratio * 100}%`
  $('seek-knob').style.left = `${ratio * 100}%`
  $('time').textContent = `${clock(video.currentTime)} / ${clock(duration)}`
  $('seek').setAttribute('aria-valuemin', '0')
  $('seek').setAttribute('aria-valuemax', String(duration))
  $('seek').setAttribute('aria-valuenow', String(Math.max(0, Math.min(duration, video.currentTime || 0))))
  $('seek').setAttribute('aria-valuetext', `${clock(video.currentTime)} / ${clock(duration)}`)
  $('seek').setAttribute('aria-disabled', String(!duration || !state.ready))
  if (state.chapters.length) {
    const chapter = chapterAt(video.currentTime)
    const name = chapter && chapter.title ? chapter.title : ''
    if ($('chapter-name').textContent !== name) $('chapter-name').textContent = name
  }

  let buffered = 0
  for (let i = 0; i < video.buffered.length; i += 1) {
    if (video.buffered.start(i) <= video.currentTime) buffered = video.buffered.end(i)
  }
  $('seek-buffer').style.width = duration ? `${Math.max(0, Math.min(1, buffered / duration)) * 100}%` : '0%'
}

/* ---- wiring ------------------------------------------------------------- */

const playbackWatch = { at: 0, position: 0, positionAt: 0, frameAt: 0, frameSupported: false, dismissed: null }
function resetPlaybackWatch() {
  const now = performance.now()
  playbackWatch.at = now; playbackWatch.position = video.currentTime
  playbackWatch.positionAt = now; playbackWatch.frameAt = now; playbackWatch.dismissed = null
}
function playbackStats() {
  let bufferAhead = 0
  for (let i = 0; i < video.buffered.length; i += 1) {
    if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) bufferAhead = video.buffered.end(i) - video.currentTime
  }
  const quality = video.getVideoPlaybackQuality?.()
  return { position: video.currentTime || 0, duration: state.duration, bufferAhead,
    decodedFrames: quality?.totalVideoFrames || 0, droppedFrames: quality?.droppedVideoFrames || 0,
    readyState: video.readyState, rate: video.playbackRate }
}
function paintDiagnostics() {
  const info = state.mediaInfo, stats = playbackStats()
  const picture = info ? [info.codec?.toUpperCase(), info.width && info.height ? `${info.width} × ${info.height}` : '',
    info.frameRate ? `${info.frameRate.toFixed(2).replace('.', ',')} kare/sn` : '', info.pixelFormat].filter(Boolean).join(' · ') : 'Görüntü akışı bilgisi yok'
  $('media-info').textContent = picture
  $('playback-info').textContent = `${stats.decodedFrames} kare · ${stats.droppedFrames} atlanan · ${stats.bufferAhead.toFixed(1).replace('.', ',')} sn hazır`
}
function pollPlayback() {
  const now = performance.now()
  if (video.paused || video.ended || video.seeking || state.seeking || document.hidden || !state.ready) {
    resetPlaybackWatch()
    $('recovery').hidden = true
  } else {
    if (Math.abs(video.currentTime - playbackWatch.position) > 0.02) {
      playbackWatch.position = video.currentTime; playbackWatch.positionAt = now
      if (playbackWatch.dismissed !== 'video-stalled') playbackWatch.dismissed = null
    }
    const issue = Core.playbackIssue({ playing: !video.paused, visible: !document.hidden, seeking: video.seeking || state.seeking,
      ready: state.ready, error: !!video.error, readyState: video.readyState, audioOnly: state.audioOnly,
      fps: state.mediaInfo?.frameRate || 0, positionIdleMs: now - playbackWatch.positionAt,
      frameIdleMs: playbackWatch.frameSupported ? now - playbackWatch.frameAt : 0 })
    if (issue && issue !== playbackWatch.dismissed) {
      $('recovery-text').textContent = issue === 'video-stalled' ? 'Ses ilerliyor, görüntü yenilenmiyor. Dosya zamanlaması da buna neden olabilir.'
        : issue === 'buffering' ? 'Dosyadan yeni veri bekleniyor. Harici disk veya dosya erişimini kontrol edebilirsin.' : 'Oynatma ilerlemiyor. Aynı konumdan yeniden deneyebilirsin.'
      $('recovery').dataset.issue = issue
      $('recovery').hidden = false
      wake()
    } else $('recovery').hidden = true
  }
  if (!$('quick').hidden && $('diagnostics').open) paintDiagnostics()
}

async function checkTiming() {
  const button = $('timing-check')
  button.disabled = true
  $('timing-result').textContent = 'Görüntü ve ses zamanlaması kontrol ediliyor… Oynatıcıyı kapatmak kontrolü durdurur.'
  try {
    const report = await window.aioPlayer.timing()
    state.timing = report
    const times = (report.firstCorrelatedGaps.length ? report.firstCorrelatedGaps : report.firstVideoHolds).map((hold) => clock(hold.at)).join(', ')
    if (report.kind === 'matching-audio-video-gaps') {
      $('timing-result').textContent = `${report.correlatedGaps} noktada görüntü ve ses zamanlamasında birlikte boşluk var. Dosyada eksik kayıt olabilir; yeniden indirmek gerekir. Aynı konumdan denemek veya kapsayıcıyı değiştirmek eksik içeriği geri getirmez. İlk noktalar: ${times}.`
    } else if (report.kind === 'timing-variation') {
      $('timing-result').textContent = `${report.videoLongFrames} uzun görüntü karesi, ${report.audioTimestampGaps} ses zamanlaması aralığı bulundu. Değişken kare hızı buna neden olabilir; tek başına bozulma kanıtı değildir.${times ? ` İlk noktalar: ${times}.` : ''}`
    } else {
      $('timing-result').textContent = `${report.packetCount.toLocaleString('tr-TR')} pakette uzun zamanlama aralığı bulunmadı. Bu kontrol görüntü çözme hatalarını veya diskin anlık yavaşlamasını dışlamaz.`
    }
  } catch (error) { $('timing-result').textContent = error?.message || 'Dosya zamanlaması kontrol edilemedi.' }
  finally { button.disabled = false }
}

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
    if (!state.autoNext) stopCountdown()
    window.aioPlayer.prefs({ autoNext: state.autoNext })
  })
  $('q-ontop').addEventListener('change', (e) => toggleOnTop(e.target.checked))
  $('q-shot').addEventListener('click', screenshot)
  $('q-audio-delay').addEventListener('input', (event) => setAudioDelay(event.target.value))
  $('audio-delay-reset').addEventListener('click', () => setAudioDelay(0))
  $('timing-check').addEventListener('click', checkTiming)
  $('diagnostics').addEventListener('toggle', paintDiagnostics)
  $('diagnostics-copy').addEventListener('click', async () => {
    try { await window.aioPlayer.copyDiagnostics(playbackStats()); flash('Tanı bilgisi kopyalandı; dosya adı ve konumu eklenmedi.') }
    catch { flash('Tanı bilgisi kopyalanamadı.') }
  })
  $('recovery-retry').addEventListener('click', () => loadMedia(state.src, { at: video.currentTime || state.lastGoodTime || 0, autoplay: !!state.playingIntent }))
  $('recovery-dismiss').addEventListener('click', () => { playbackWatch.dismissed = $('recovery').dataset.issue; $('recovery').hidden = true; $('play').focus() })
  $('gear').addEventListener('click', () => togglePopover('quick'))
  $('audio').addEventListener('click', () => togglePopover('audio-menu'))
  $('prev').addEventListener('click', goPrev)
  // Tracks can appear after metadata in some containers.
  if (video.audioTracks) {
    video.audioTracks.addEventListener('addtrack', paintAudio)
    video.audioTracks.addEventListener('change', paintAudio)
  }
  for (const media of [video, $('probe')]) {
    media.textTracks?.addEventListener('addtrack', disableNativeSubtitles)
    media.textTracks?.addEventListener('change', disableNativeSubtitles)
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

  $('cc').addEventListener('click', () => setPanel(panel.hidden))
  $('panel-close').addEventListener('click', () => setPanel(false))

  $('fetch').addEventListener('click', searchSubtitles)
  $('delay-down').addEventListener('click', () => setDelay(state.delay - 0.5))
  $('delay-up').addEventListener('click', () => setDelay(state.delay + 0.5))
  $('delay-reset').addEventListener('click', () => setDelay(0))
  $('tracks-refresh').addEventListener('click', async () => {
    $('tracks-refresh').disabled = true
    try {
      state.tracks = await window.aioPlayer.tracks()
      if (state.trackId && !state.tracks.some((track) => track.id === state.trackId)) await selectTrack(null)
      else paintTracks()
    } catch { flash('Altyazı listesi yenilenemedi.') }
    finally { $('tracks-refresh').disabled = false }
  })

  $('next').addEventListener('click', goNext)
  $('upnext-go').addEventListener('click', goNext)
  $('upnext-stay').addEventListener('click', () => {
    stopCountdown()
    state.autoNextCanceled = true
    $('upnext').hidden = true
  })

  for (const button of $('size-row').querySelectorAll('button')) {
    button.addEventListener('click', async () => {
      try {
        state.size = await window.aioPlayer.subtitleSize(button.dataset.size)
        subsBox.dataset.size = state.size
        paintSizes()
      } catch { flash('Yazı boyutu kaydedilemedi.') }
    })
  }

  $('resume-restart').addEventListener('click', () => {
    seekTo(0)
    $('resume').hidden = true
  })

  $('fault-external').addEventListener('click', async () => {
    try { await window.aioPlayer.openExternally() } catch { flash('Sistem oynatıcısı açılamadı.') }
  })
  $('fault-retry').addEventListener('click', () => loadMedia(state.src, { at: state.lastGoodTime || 0 }))
  $('fault-remux').addEventListener('click', async () => {
    if (state.remuxing) return
    state.remuxing = true
    $('fault-remux').disabled = true
    $('fault').hidden = true
    app.classList.add('busy')
    flash('Dönüştürülüyor…')
    const at = state.lastGoodTime || video.currentTime || 0
    const autoplay = !!state.playingIntent
    try {
      const { src } = await window.aioPlayer.remux()
      await loadMedia(src, { at, autoplay })
    } catch (err) {
      $('fault-text').textContent = err && err.message ? err.message : String(err)
      $('fault').hidden = false
    } finally {
      app.classList.remove('busy')
      state.remuxing = false
      $('fault-remux').disabled = false
    }
  })

  $('help-close').addEventListener('click', () => setHelp(false))

  /* video events */
  video.addEventListener('play', () => {
    resetPlaybackWatch()
    state.playingIntent = true
    setIcon($('play'), 'pause')
    $('play').setAttribute('aria-label', 'Duraklat')
    if (countdownTimer) { state.autoNextCanceled = true; stopCountdown(); $('upnext').hidden = true }
    wake()
  })
  video.addEventListener('pause', () => {
    if (!video.error && !state.seeking) state.playingIntent = false
    setIcon($('play'), 'play')
    $('play').setAttribute('aria-label', 'Oynat')
    app.classList.remove('idle')
    remember()
  })
  video.addEventListener('waiting', () => app.classList.add('busy'))
  video.addEventListener('seeking', resetPlaybackWatch)
  video.addEventListener('playing', () => { app.classList.remove('busy'); $('fault').hidden = true })
  video.addEventListener('canplay', () => { if (video.paused) app.classList.remove('busy') })
  video.addEventListener('timeupdate', () => {
    if (state.ready && !video.error && Number.isFinite(video.currentTime)) state.lastGoodTime = video.currentTime
    if (video.paused) { paintProgress(); drawSubtitle() }
  })
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
    state.duration = Core.finiteDuration(video.duration) || 0
    paintChapters(); paintProgress()
  })
  video.addEventListener('error', () => {
    app.classList.remove('busy')
    state.ready = false
    stopCountdown()
    const code = video.error ? video.error.code : 0
    const fault = Core.errorInfo(code)
    $('fault-remux').hidden = state.vault || !fault.remux
    $('fault-text').textContent = fault.message
    $('fault').hidden = false
    $('fault-retry').focus()
  })

  /* clicking the picture */
  const onSurface = (event) =>
    !event.target.closest('#controls, #resume, #fault, #upnext, #recovery, .popover, #panel, #help')
  let clickTimer = null
  $('stage').addEventListener('click', (event) => {
    if (!onSurface(event)) return
    // Any open popover closes on a click elsewhere, without also pausing.
    if (!$('quick').hidden || !$('audio-menu').hidden) {
      closePopovers()
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
    const duration = Core.finiteDuration(video.duration)
    if (!duration) return
    seekTo(seekRatio(event) * duration)
  }
  seek.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !state.ready || !Core.finiteDuration(video.duration)) return
    event.preventDefault()
    seek.focus()
    try { seek.setPointerCapture(event.pointerId) } catch { /* unavailable pointer */ }
    seek.classList.add('dragging')
    state.seeking = true
    state.resumeAfterSeek = !video.paused
    video.pause()
    applySeek(event)
  })
  seek.addEventListener('pointermove', (event) => {
    const duration = Core.finiteDuration(video.duration)
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
    preview.want = null
    clearTimeout(preview.timer)
  })

  const probe = $('probe')
  probe.addEventListener('seeked', finishPreview)
  probe.addEventListener('loadedmetadata', () => { disableNativeSubtitles(); drainPreview() })
  const finishSeek = (event) => {
    if (!state.seeking) return
    state.seeking = false
    seek.classList.remove('dragging')
    try {
      seek.releasePointerCapture(event.pointerId)
    } catch {
      /* pointer already released */
    }
    if (state.resumeAfterSeek) playSafely()
    state.resumeAfterSeek = false
    remember()
  }
  seek.addEventListener('pointerup', finishSeek)
  seek.addEventListener('pointercancel', finishSeek)
  seek.addEventListener('lostpointercapture', finishSeek)
  seek.addEventListener('keydown', (event) => {
    const duration = Core.finiteDuration(video.duration)
    if (!duration || !state.ready) return
    const step = event.shiftKey ? 30 : 5
    const targets = { ArrowLeft: video.currentTime - step, ArrowRight: video.currentTime + step,
      ArrowUp: video.currentTime + step, ArrowDown: video.currentTime - step,
      Home: 0, End: duration, PageUp: video.currentTime - 60, PageDown: video.currentTime + 60 }
    if (!(event.key in targets)) return
    event.preventDefault(); event.stopPropagation()
    seekTo(targets[event.key]); remember()
  })

  /* idle */
  document.addEventListener('mousemove', wake)
  document.addEventListener('keydown', wake)
  document.addEventListener('focusin', wake)
  document.addEventListener('fullscreenchange', () => {
    app.classList.toggle('full', !!document.fullscreenElement)
    setIcon($('full'), document.fullscreenElement ? 'exitFull' : 'full')
    $('full').setAttribute('aria-pressed', String(!!document.fullscreenElement))
  })

  document.addEventListener('keydown', onKey)
  for (const button of document.querySelectorAll('button[title]')) {
    if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', button.title)
  }
  $('probe').addEventListener('error', () => { resetPreview(); $('seek-frame').hidden = true })
  document.addEventListener('visibilitychange', resetPlaybackWatch)
  if (typeof video.requestVideoFrameCallback === 'function') {
    playbackWatch.frameSupported = true
    const frameSeen = () => {
      playbackWatch.frameAt = performance.now()
      if (playbackWatch.dismissed === 'video-stalled') playbackWatch.dismissed = null
      video.requestVideoFrameCallback(frameSeen)
    }
    video.requestVideoFrameCallback(frameSeen)
  }
  setInterval(pollPlayback, 1000)
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
  ['G / H', 'Altyazıyı 0,5 sn öne al, geciktir'],
  ['Shift + G / H', 'Altyazıyı 0,1 sn ince ayarla'],
  ['Home / End', 'Zaman çubuğunda başa / sona git'],
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
  if (!$('help').hidden) {
    if (event.key === 'Escape') { event.preventDefault(); setHelp(false) }
    else if (event.key === 'Tab') { event.preventDefault(); $('help-close').focus() }
    return
  }
  if (!$('fault').hidden) {
    if (event.key === 'Tab') {
      const buttons = [...$('fault').querySelectorAll('button:not(:disabled)')].filter((button) => !button.hidden)
      const at = buttons.indexOf(document.activeElement)
      event.preventDefault()
      buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
    }
    return
  }
  if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return
  if (tag === 'BUTTON' && (event.key === ' ' || event.key === 'Enter')) return
  if (event.defaultPrevented) return
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
    v: () => (state.trackId ? selectTrack(null) : selectTrack(state.lastTrackId && state.tracks.some((track) => track.id === state.lastTrackId) ? state.lastTrackId : state.tracks[0]?.id || null)),
    b: cycleTrack,
    c: () => {
      setPanel(panel.hidden)
    },
    g: () => setDelay(state.delay - (event.shiftKey ? 0.1 : 0.5)),
    h: () => setDelay(state.delay + (event.shiftKey ? 0.1 : 0.5)),
    n: goNext,
    '<': () => cycleRate(-1),
    '>': () => cycleRate(1),
    ',': () => cycleRate(-1),
    '.': () => cycleRate(1),
    '?': () => {
      setHelp($('help').hidden)
    },
  }

  const lower = key.length === 1 ? key.toLowerCase() : key
  const run = handlers[key] || handlers[lower]
  if (run) {
    event.preventDefault()
    run()
    return
  }

  if (/^[0-9]$/.test(key) && Core.finiteDuration(video.duration)) {
    event.preventDefault()
    seekTo((Number(key) / 10) * video.duration)
  } else if (key === 'Escape') {
    if (!$('quick').hidden || !$('audio-menu').hidden) {
      const trigger = !$('audio-menu').hidden ? $('audio') : $('gear')
      closePopovers(); trigger.focus()
    } else if (!panel.hidden) setPanel(false)
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  }
}

/* ---- position ----------------------------------------------------------- */

function remember() {
  if (!state.ready || state.switching) return
  if (!Number.isFinite(video.currentTime) || !Number.isFinite(video.duration)) return
  window.aioPlayer.remember(video.currentTime, video.duration)
}

/* ---- run ---------------------------------------------------------------- */

let lastPaint = 0
function frame(now) {
  if (!video.paused && now - lastPaint >= 1000 / 30) {
    lastPaint = now
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
  if (video.paused || video.readyState >= 3) app.classList.remove('busy')
  paintProgress()
  lastCueIndex = ''
  if (Core.finiteDuration(video.duration) && video.duration - video.currentTime > 45) state.upNextShown = false
  drawSubtitle()
})
setInterval(() => {
  if (!video.paused) remember()
}, 5000)
