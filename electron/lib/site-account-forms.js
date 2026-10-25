'use strict'

// The only credential use is a standard, visible, same-origin POST form in the
// main frame. There is no generic page agent, cross-frame filling or CAPTCHA
// interaction. Extra requirements are reported for the person to complete.
const { normaliseOrigin } = require('./site-accounts')

function inspectDocument(expectedOrigin) {
  if (location.origin !== expectedOrigin || window.top !== window) return { state: 'origin-changed' }
  const visible = (element) => {
    const style = getComputedStyle(element), box = element.getBoundingClientRect()
    return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
  }
  const captcha = [...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="challenges.cloudflare"],[class*="captcha"],[id*="captcha"]')].some(visible)
  if (captcha) return { state: 'needs-user', reason: 'captcha' }
  const links = []
  for (const anchor of [...document.querySelectorAll('a[href]')].slice(0, 200)) {
    if (!visible(anchor)) continue
    let url
    try { url = new URL(anchor.getAttribute('href'), location.href) } catch { continue }
    if (url.origin !== expectedOrigin || url.username || url.password || url.href.split('#')[0] === location.href.split('#')[0]) continue
    const text = String(anchor.textContent || anchor.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ')
    const registrationPath = /\/(?:register|signup|sign-up|kayit|kayit-ol|uye-ol)(?:[/.]|$)/i.test(url.pathname) || /\/wp-login\.php$/i.test(url.pathname) && url.searchParams.get('action') === 'register'
    const loginPath = /\/(?:login|signin|sign-in|giris|uye-girisi|oturum-ac)(?:[/.]|$)/i.test(url.pathname) || /\/wp-login\.php$/i.test(url.pathname) && !url.searchParams.get('action')
    const mode = registrationPath && /^(?:register|sign\s?up|create\s+(?:an?\s+)?account|kayıt(?:\s+ol)?|üye\s+ol|hesap\s+(?:aç|oluştur))$/i.test(text) ? 'registration'
      : loginPath && /^(?:log\s?in|sign\s?in|giriş(?:\s+yap)?|üye\s+girişi|oturum\s+aç)$/i.test(text) ? 'login' : null
    if (mode && links.filter((link) => link.mode === mode).length < 2) links.push({ mode, url: url.href, text })
  }
  const accountMissing = /(?:account|user|e-?mail).{0,40}(?:not found|does not exist|not registered)|(?:hesap|kullanıcı|e-posta).{0,40}(?:bulunamadı|kayıtlı değil)/i.test(String(document.body?.innerText || '').slice(0, 16000))
  const forms = [...document.forms].slice(0, 30)
  for (const form of forms) {
    const fields = [...form.querySelectorAll('input')].slice(0, 100).filter((field) => !field.disabled && field.type !== 'hidden' && visible(field))
    const passwords = fields.filter((field) => field.type === 'password')
    if (!passwords.length) continue
    let action
    try { action = new URL(form.getAttribute('action') || location.href, location.href) } catch { continue }
    if (action.origin !== expectedOrigin || action.username || action.password || String(form.method).toLowerCase() !== 'post' || form.target && form.target !== '_self') return { state: 'needs-user', reason: 'unsafe-form' }
    const submit = [...form.querySelectorAll('button,input[type="submit"]')].find((button) => !button.disabled && visible(button) && (button.type === 'submit' || button.tagName === 'BUTTON' && !button.getAttribute('type')))
    if (!submit || submit.formAction && new URL(submit.formAction, location.href).origin !== expectedOrigin || submit.formMethod && submit.formMethod.toLowerCase() !== 'post' || submit.formTarget && submit.formTarget !== '_self') return { state: 'needs-user', reason: 'unsafe-form' }
    const effectiveAction = submit.hasAttribute('formaction') ? new URL(submit.getAttribute('formaction'), location.href) : action
    const submitText = String(submit.textContent || submit.value || '').slice(0, 300).toLowerCase()
    const inputName = (input) => [input.name, input.id, input.autocomplete, input.getAttribute('aria-label')].join(' ').toLowerCase()
    if (fields.some((input) => /(?:^|\W)(?:cc-|credit.?card|card.?number|card.?security|billing|iban|cvv|cvc)/i.test(inputName(input))) ||
        /(?:^|\W)(?:pay|payment|checkout|purchase|buy|subscribe|ödeme|satın\s?al|abone\s?ol)(?:\W|$)/i.test(submitText) || /\/(?:pay|payment|checkout|purchase)(?:\b|\/)/i.test(effectiveAction.pathname)) return { state: 'needs-user', reason: 'payment' }
    // A normal login form often contains "forgot password" and "register"
    // links. Only the actual submission destination/button defines its mode.
    if (/reset|recover|forgot|lostpassword|change.?password|parola.{0,12}(?:sıfırla|değiş)|şifre.{0,12}(?:sıfırla|değiş)/i.test(effectiveAction.pathname + effectiveAction.search + ' ' + submitText)) return { state: 'needs-user', reason: 'password-reset' }
    if (passwords.some((input) => input.autocomplete === 'current-password') && passwords.some((input) => input.autocomplete === 'new-password')) return { state: 'needs-user', reason: 'password-reset' }
    if (passwords.length > 2 || fields.some((input) => /one-time-code|(?:^|\W)(?:otp|totp|verification|verify|doğrulama)(?:\W|$)/i.test(inputName(input)))) return { state: 'needs-user', reason: 'verification' }
    const emails = fields.filter((input) => input.type === 'email' || /^(?:email|e-mail|eposta|e-posta|user_email|user_login|login_email)$/i.test(input.name || '') || input.autocomplete === 'email')
    const username = fields.find((input) => ['text', 'email'].includes(input.type) && /username|user_login|login|kullanici/i.test(inputName(input)))
    const email = emails[0] || username
    if (!email) return { state: 'needs-user', reason: 'extra-fields' }
    const allowed = new Set([email, ...passwords])
    const extra = fields.filter((input) => input.required && !allowed.has(input) && !['submit', 'button', 'reset'].includes(input.type))
    if (extra.length || form.querySelector('select[required],textarea[required]')) return { state: 'needs-user', reason: 'extra-fields' }
    const terms = fields.some((input) => input.type === 'checkbox' && /terms|agree|consent|privacy|koşul|şart|sözleşme|gizlilik|kvkk/i.test(inputName(input) + ' ' + (input.closest('label')?.textContent || '')))
    if (terms) return { state: 'needs-user', reason: 'terms' }
    const mode = passwords.length === 2 || passwords.some((input) => input.autocomplete === 'new-password') || /(?:^|\W)(?:register|sign\s?up|create account|kayıt ol|üye ol)(?:\W|$)/i.test(submitText) || /\/(?:register|signup|sign-up)(?:\b|\/)/i.test(effectiveAction.pathname) ? 'registration' : 'login'
    const marker = 'aio-account-' + Math.random().toString(36).slice(2)
    form.dataset.aioAccountForm = marker
    submit.dataset.aioAccountSubmit = marker
    email.dataset.aioAccountField = marker + '-email'
    passwords.forEach((input, index) => { input.dataset.aioAccountField = marker + '-password-' + index })
    return { state: 'ready', mode, marker, passwordCount: passwords.length, action: effectiveAction.href, links, accountMissing }
  }
  return { state: 'no-form', links }
}
function inspectionScript(origin) { return '(' + inspectDocument.toString() + ')(' + JSON.stringify(origin) + ')' }

const REASONS = {
  captcha: 'İnsan doğrulamasını tarayıcıda tamamlaman gerekiyor.',
  verification: 'Site doğrulama kodu veya ek kimlik doğrulaması istiyor.',
  'extra-fields': 'Site e-posta ve parola dışında bilgi istiyor.',
  terms: 'Sitenin üyelik koşullarını tarayıcıda incelemen gerekiyor.',
  'unsafe-form': 'Giriş formu güvenli ve aynı siteye gönderilen standart bir form değil.',
  'password-reset': 'Bu sayfa giriş yerine parola değiştirme veya kurtarma istiyor.',
  payment: 'Bu form ödeme veya abonelik işlemi içeriyor; tarayıcıda incelemen gerekiyor.',
}
function createAuthentication({ accounts = require('./site-accounts'), now = Date.now } = {}) {
  const attempts = new WeakMap()
  async function attemptAuthentication(win, { signal, onProgress, onState, allowNavigation = false } = {}) {
    const contents = win?.webContents
    const stopped = () => signal?.aborted || !contents || contents.isDestroyed()
    const report = (value) => { if (!stopped()) { onState?.(value); if (value.message) onProgress?.(value.message) }; return value }
    if (stopped()) return { state: 'aborted' }
    let origin
    try { origin = normaliseOrigin(new URL(contents.getURL()).origin) } catch { return { state: 'unavailable' } }
    let profile
    try { profile = accounts.secretForOrigin(origin) } catch { return report({ state: 'needs-user', message: 'Hesap bilgilerine ulaşılamadı. Ayarlardaki site hesaplarını kontrol et.' }) }
    if (!profile) return { state: 'disabled' }
    let descriptor
    try { descriptor = await contents.mainFrame.executeJavaScript(inspectionScript(origin)) } catch { return { state: 'no-form' } }
    try { if (stopped() || new URL(contents.getURL()).origin !== origin) return { state: 'aborted' } } catch { return { state: 'aborted' } }
    if (!descriptor || typeof descriptor !== 'object') return { state: 'no-form' }
    const history = attempts.get(contents) || new Map()
    const navigate = async (preferred = null) => {
      if (!allowNavigation || !Array.isArray(descriptor.links) || stopped()) return null
      const order = preferred ? [preferred] : ['login', 'registration']
      for (const mode of order) {
        if (!profile.policy[mode]) continue
        const key = origin + '|navigation-' + mode
        if (history.has(key) && now() - history.get(key) < 5 * 60000) continue
        for (const link of descriptor.links.slice(0, 4)) {
          if (link?.mode !== mode || !safeDestination(link, origin, contents.getURL())) continue
          history.set(key, now()); attempts.set(contents, history)
          const outcome = report({ state: 'navigating', mode, message: mode === 'registration' ? 'İzin verilen sitenin kayıt sayfası açılıyor.' : 'İzin verilen sitenin giriş sayfası açılıyor.' })
          try {
            await contents.loadURL(link.url)
            if (stopped()) return { state: 'aborted' }
            if (new URL(contents.getURL()).origin !== origin) return report({ state: 'needs-user', reason: 'origin-changed', message: 'Giriş başka bir siteye yönlendirildi; hesap bilgileri gönderilmedi.' })
            return outcome
          } catch { return { state: stopped() ? 'aborted' : 'needs-user', reason: 'navigation' } }
        }
      }
      return null
    }
    if (descriptor.state === 'needs-user') return report({ state: 'needs-user', reason: descriptor.reason, message: REASONS[descriptor.reason] || 'Site ek işlem istiyor.' })
    if (descriptor.state === 'no-form') return await navigate() || { state: 'no-form' }
    if (descriptor.state !== 'ready') return { state: descriptor.state }
    // A page result is untrusted data even though the inspector is ours.
    try {
      const action = new URL(descriptor.action)
      if (action.origin !== origin || action.username || action.password || !['login', 'registration'].includes(descriptor.mode) ||
          !/^aio-account-[a-z0-9]+$/.test(descriptor.marker) || ![1, 2].includes(descriptor.passwordCount)) return { state: 'needs-user', reason: 'unsafe-form', message: REASONS['unsafe-form'] }
    } catch { return { state: 'needs-user', reason: 'unsafe-form', message: REASONS['unsafe-form'] } }
    if (!profile.policy[descriptor.mode]) return await navigate('login') || report({ state: 'needs-user', reason: 'registration-disabled', message: 'Site kayıt istiyor. Bu site için otomatik kaydı Ayarlar → Site hesapları bölümünden açabilirsin.' })
    const key = origin + '|' + descriptor.mode
    if (history.has(key) && now() - history.get(key) < 5 * 60000) {
      if (descriptor.mode === 'login' && descriptor.accountMissing) { const next = await navigate('registration'); if (next) return next }
      return report({ state: 'needs-user', reason: 'already-attempted', message: 'Otomatik giriş bir kez denendi. Sonucu tarayıcıda kontrol et.' })
    }
    history.set(key, now()); attempts.set(contents, history)
    // Fill through a DOM operation scoped to the previously inspected
    // main-frame form. The page is intentionally receiving these credentials;
    // they are not interpolated into a URL, log, command or renderer IPC reply.
    const payload = { origin, marker: descriptor.marker, action: descriptor.action, mode: descriptor.mode,
      email: profile.email, password: profile.password, passwordCount: descriptor.passwordCount }
    const script = '(' + submitDocument.toString() + ')(' + JSON.stringify(payload) + ')'
    try {
      const outcome = await contents.mainFrame.executeJavaScript(script)
      if (stopped()) return { state: 'aborted' }
      return report(outcome?.submitted ? { state: 'submitted', mode: descriptor.mode, message: descriptor.mode === 'registration' ? 'İzin verilen siteye kayıt formu gönderildi; sonuç kontrol ediliyor.' : 'İzin verilen siteye giriş formu gönderildi; sonuç kontrol ediliyor.' }
        : { state: 'needs-user', reason: 'form-changed', message: 'Giriş formu değişti. Tarayıcıda kontrol et.' })
    } catch { return { state: 'needs-user', reason: 'navigation', message: 'Giriş sonucu sayfada kontrol ediliyor.' } }
    finally { payload.password = ''; profile.password = '' }
  }
  return { attemptAuthentication }
}
function safeDestination(link, origin, currentUrl) {
  try {
    const url = new URL(link.url)
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || url.href.split('#')[0] === currentUrl.split('#')[0]) return false
    const text = String(link.text || '').trim().replace(/\s+/g, ' ')
    if (link.mode === 'registration') return (/\/(?:register|signup|sign-up|kayit|kayit-ol|uye-ol)(?:[/.]|$)/i.test(url.pathname) || /\/wp-login\.php$/i.test(url.pathname) && url.searchParams.get('action') === 'register') && /^(?:register|sign\s?up|create\s+(?:an?\s+)?account|kayıt(?:\s+ol)?|üye\s+ol|hesap\s+(?:aç|oluştur))$/i.test(text)
    if (link.mode === 'login') return (/\/(?:login|signin|sign-in|giris|uye-girisi|oturum-ac)(?:[/.]|$)/i.test(url.pathname) || /\/wp-login\.php$/i.test(url.pathname) && !url.searchParams.get('action')) && /^(?:log\s?in|sign\s?in|giriş(?:\s+yap)?|üye\s+girişi|oturum\s+aç)$/i.test(text)
  } catch {}
  return false
}
function submitDocument(value) {
  if (location.origin !== value.origin || window.top !== window) return { submitted: false }
  const form = [...document.forms].find((entry) => entry.dataset.aioAccountForm === value.marker)
  if (!form || String(form.method).toLowerCase() !== 'post') return { submitted: false }
  const submit = form.querySelector('[data-aio-account-submit="' + value.marker + '"]')
  const destination = () => new URL(submit?.hasAttribute('formaction') ? submit.getAttribute('formaction') : form.action, location.href)
  if (!submit || submit.disabled || destination().href !== value.action || destination().origin !== value.origin ||
      submit.formMethod && submit.formMethod.toLowerCase() !== 'post' || submit.formTarget && submit.formTarget !== '_self') return { submitted: false }
  const email = form.querySelector('[data-aio-account-field="' + value.marker + '-email"]')
  const passwords = Array.from({ length: value.passwordCount }, (_, index) => form.querySelector('[data-aio-account-field="' + value.marker + '-password-' + index + '"]'))
  if (!email || passwords.some((input) => !input || input.type !== 'password')) return { submitted: false }
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  for (const [input, text] of [[email, value.email], ...passwords.map((input) => [input, value.password])]) {
    set.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  // Native validation is respected; no unchecked checkbox is clicked and no
  // verification, payment or arbitrary extra field is fabricated.
  if (!form.reportValidity() || location.origin !== value.origin || destination().href !== value.action) return { submitted: false }
  form.requestSubmit(submit)
  return { submitted: true }
}
module.exports = { ...createAuthentication(), createAuthentication, inspectionScript, inspectDocument, submitDocument, safeDestination }
