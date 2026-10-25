'use strict'

// Account secrets live outside library.json and never cross the renderer bridge.
// Chromium receives them only after the exact HTTPS origin was explicitly enabled.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const MAX_BYTES = 256 * 1024
const MAX_SITES = 64
function normaliseOrigin(value) {
  let url
  try { url = new URL(String(value || '').trim()) } catch { throw new Error('Site adresini https:// ile yaz.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Yalnızca HTTPS site adresi ekle; sayfa yolu veya giriş bilgisi kullanma.')
  }
  if (url.hostname === 'localhost' || /^(?:127\.|0\.|169\.254\.|\[?(?:fe80:|::1\]?))/i.test(url.hostname)) throw new Error('Hesap bilgileri için herkese açık bir HTTPS site adresi gerekli.')
  return url.origin
}
function createSiteAccounts({ app, safeStorage, filesystem = fs } = {}) {
  const deps = () => {
    if (!app || !safeStorage) { const electron = require('electron'); app ||= electron.app; safeStorage ||= electron.safeStorage }
    return { app, safeStorage }
  }
  const file = () => path.join(deps().app.getPath('userData'), 'site-accounts.enc')
  function availability() {
    try {
      const storage = deps().safeStorage
      if (!storage?.isEncryptionAvailable?.() || storage.getSelectedStorageBackend?.() === 'basic_text') {
        return { available: false, reason: 'Bu cihazda güvenli parola saklama kullanılamıyor. Sistem anahtarlığını açıp yeniden dene.' }
      }
      return { available: true, reason: null }
    } catch { return { available: false, reason: 'Sistem anahtarlığına ulaşılamadı. Yeniden dene.' } }
  }
  function requireAvailable() { const state = availability(); if (!state.available) throw new Error(state.reason) }
  function read() {
    requireAvailable()
    const target = file()
    if (!filesystem.existsSync(target)) return { email: '', password: '', sites: [] }
    try {
      if (filesystem.statSync(target).size > MAX_BYTES) throw new Error('limit')
      const envelope = JSON.parse(filesystem.readFileSync(target, 'utf8'))
      if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext)) throw new Error('format')
      const value = JSON.parse(deps().safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64')))
      if (value.version !== 1 || typeof value.email !== 'string' || typeof value.password !== 'string' || !Array.isArray(value.sites) || value.sites.length > MAX_SITES) throw new Error('schema')
      if (value.email.length > 254 || value.password.length > 1024) throw new Error('limit')
      return { email: value.email, password: value.password,
        sites: value.sites.map((site) => ({ origin: normaliseOrigin(site.origin), login: !!site.login, registration: !!site.registration })) }
    } catch { throw new Error('Kayıtlı hesap bilgileri bu cihazda açılamadı. Sistem anahtarlığını kontrol et veya bilgileri silip yeniden kaydet.') }
  }
  function write(value) {
    requireAvailable()
    const target = file(), directory = path.dirname(target)
    const ciphertext = deps().safeStorage.encryptString(JSON.stringify({ version: 1, ...value }))
    const content = JSON.stringify({ version: 1, ciphertext: ciphertext.toString('base64') })
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('Hesap kaydı boyut sınırını aştı.')
    filesystem.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = target + '.tmp-' + crypto.randomBytes(8).toString('hex')
    try {
      filesystem.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' })
      filesystem.chmodSync(temporary, 0o600)
      filesystem.renameSync(temporary, target)
      filesystem.chmodSync(target, 0o600)
    } finally { try { filesystem.rmSync(temporary, { force: true }) } catch {} }
  }
  function getStatus() {
    const state = availability()
    if (!state.available) return { ...state, email: '', hasPassword: false, sites: [] }
    try {
      const value = read()
      return { ...state, email: value.email, hasPassword: !!value.password, sites: value.sites.slice().sort((a, b) => a.origin.localeCompare(b.origin)) }
    } catch (error) { return { ...state, reason: error.message, email: '', hasPassword: false, sites: [] } }
  }
  function setProfile({ email, password } = {}) {
    requireAvailable()
    const address = String(email || '').trim()
    if (address.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error('Geçerli bir e-posta adresi yaz.')
    const value = read()
    const secret = password === undefined || password === '' ? (address === value.email ? value.password : '') : String(password)
    if (secret.length < 8 || secret.length > 1024 || /[\u0000\r\n]/.test(secret)) throw new Error('Parola 8–1024 karakter olmalı.')
    write({ ...value, email: address, password: secret })
    return getStatus()
  }
  function clearProfile() {
    // Deleting an inaccessible old profile must still be possible without
    // decrypting it or making another Keychain request.
    filesystem.rmSync(file(), { force: true })
    return getStatus()
  }
  function setSitePolicy({ origin, login = true, registration = false } = {}) {
    const site = normaliseOrigin(origin), value = read()
    if (!value.email || !value.password) throw new Error('Önce e-posta ve parolanı kaydet.')
    const existing = value.sites.find((entry) => entry.origin === site)
    if (!existing && value.sites.length >= MAX_SITES) throw new Error('En çok 64 site eklenebilir.')
    const policy = { origin: site, login: !!login || !!registration, registration: !!registration }
    write({ ...value, sites: [...value.sites.filter((entry) => entry.origin !== site), policy] })
    return getStatus()
  }
  function removeSitePolicy(origin) {
    const site = normaliseOrigin(origin), value = read()
    write({ ...value, sites: value.sites.filter((entry) => entry.origin !== site) })
    return getStatus()
  }
  function secretForOrigin(origin) {
    let site
    try { site = normaliseOrigin(origin) } catch { return null }
    const value = read(), policy = value.sites.find((entry) => entry.origin === site)
    if (!policy || !policy.login || !value.email || !value.password) return null
    return { email: value.email, password: value.password, policy: { ...policy } }
  }
  return { getStatus, setProfile, clearProfile, setSitePolicy, removeSitePolicy, secretForOrigin }
}
module.exports = { ...createSiteAccounts(), createSiteAccounts, normaliseOrigin }
