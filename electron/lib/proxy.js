'use strict'

// Routing a single download through a proxy, without routing the machine.
//
// The ask was "a VPN button per link". A VPN is a system-wide tunnel — one
// setting for the whole computer, which is the opposite of choosing per link. A
// proxy is the per-connection version of the same idea, and it is what every
// tool here already understands: yt-dlp takes --proxy, Electron's session takes
// proxyRules, ffmpeg reads http_proxy. So one link can go through Cloudflare's
// WARP while the next goes straight out, in the same window, at the same time.
//
// Cloudflare WARP is the intended companion: `warp-cli mode proxy` puts a SOCKS5
// listener on 127.0.0.1:40000 and sends what goes through it over Cloudflare's
// network. We do not install or drive it — that is the user's machine to change —
// we just point at it.
//
// This module is the part the others cannot do for themselves: opening a socket
// through the proxy for our own HTTP client.

const http = require('http')
const https = require('https')
const net = require('net')
const tls = require('tls')

/** { protocol, host, port, username, password } or null. */
function parseProxy(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  let url
  try {
    url = new URL(/^[a-z0-9+.-]+:\/\//i.test(text) ? text : `http://${text}`)
  } catch {
    return null
  }
  const protocol = url.protocol.replace(':', '').toLowerCase()
  if (!['http', 'https', 'socks', 'socks5', 'socks5h', 'socks4'].includes(protocol)) return null
  const port = Number(url.port) || (protocol === 'https' ? 443 : protocol === 'http' ? 8080 : 1080)
  let username, password
  try {
    username = decodeURIComponent(url.username || '')
    password = decodeURIComponent(url.password || '')
  } catch { return null }
  return {
    protocol: protocol === 'socks' || protocol === 'socks5h' ? 'socks5' : protocol,
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    username,
    password,
    href: `${protocol}://${url.host}`,
  }
}

const isSocks = (proxy) => proxy && proxy.protocol.startsWith('socks')

/* -------------------------------------------------------------------------- */
/* SOCKS5                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Exactly `length` bytes, leaving everything after them untouched.
 *
 * Deliberately the paused-mode API. Reading the handshake with 'data' events puts
 * the socket in flowing mode, and then anything that arrives past the bytes we
 * wanted has to be pushed back — which a flowing stream with no listener throws
 * away. That loses the front of the tunnelled response and surfaces, much later
 * and much further away, as an unexplained hang-up. `read(n)` takes what it needs
 * and lets the rest sit in the socket's own buffer for whoever comes next.
 */
function readExactly(socket, length) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const chunk = socket.read(length)
      if (chunk === null) return
      cleanup()
      resolve(chunk)
    }
    const onError = (err) => {
      cleanup()
      reject(err)
    }
    const onEnd = () => onError(new Error('Vekil sunucu bağlantıyı kapattı.'))
    const cleanup = () => {
      socket.removeListener('readable', attempt)
      socket.removeListener('error', onError)
      socket.removeListener('end', onEnd)
      socket.removeListener('close', onEnd)
    }
    socket.on('readable', attempt)
    socket.once('error', onError)
    socket.once('end', onEnd)
    socket.once('close', onEnd)
    if (socket.destroyed || socket.readableEnded) return onEnd()
    attempt() // bytes may already be buffered
  })
}

/**
 * SOCKS5 CONNECT, hostname form.
 *
 * The hostname is deliberately sent to the proxy rather than resolved here: with
 * a privacy proxy, resolving locally would leak the very lookup the proxy exists
 * to hide, and would break hosts that only resolve on the far side.
 */
async function socks5Connect(proxy, host, port, { signal, timeoutMs = 20000, onSocket } = {}) {
  if (signal?.aborted) throw Object.assign(new Error('İşlem iptal edildi.'), { code: 'ABORTED' })
  const socket = net.connect({ host: proxy.host, port: proxy.port })
  onSocket?.(socket)
  const abort = () => socket.destroy(Object.assign(new Error('İşlem iptal edildi.'), { code: 'ABORTED' }))
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => socket.destroy(Object.assign(new Error('SOCKS bağlantısı zaman aşımına uğradı.'), { code: 'ETIMEDOUT' })), timeoutMs)
  // Keep an error handler during the tiny gaps between handshake reads.
  const ignoreError = () => {}
  socket.on('error', ignoreError)
  socket.setNoDelay(true)
  try {
    await new Promise((resolve, reject) => {
      const done = (err) => { socket.removeListener('connect', connected); socket.removeListener('error', done); err ? reject(err) : resolve() }
      const connected = () => done()
      socket.once('connect', connected)
      socket.once('error', done)
    })
    const wantsAuth = !!(proxy.username || proxy.password)
    // Authentication also carries Tor's isolation identity. A no-auth fallback
    // would silently merge identities when the upstream ignores credentials.
    socket.write(wantsAuth ? Buffer.from([5, 1, 2]) : Buffer.from([5, 1, 0]))
    const greeting = await readExactly(socket, 2)
    if (greeting[0] !== 5) throw new Error('Vekil sunucu SOCKS5 konuşmuyor.')

    if (greeting[1] === 2) {
      if (!wantsAuth) throw new Error('Vekil sunucu kullanıcı adı/parola istiyor.')
      const user = Buffer.from(proxy.username, 'utf8')
      const pass = Buffer.from(proxy.password, 'utf8')
      if (user.length > 255 || pass.length > 255) throw new Error('SOCKS kimlik bilgileri çok uzun.')
      socket.write(
        Buffer.concat([
          Buffer.from([1, user.length]),
          user,
          Buffer.from([pass.length]),
          pass,
        ])
      )
      const auth = await readExactly(socket, 2)
      if (auth[0] !== 1 || auth[1] !== 0) throw new Error('Vekil sunucu kimlik bilgilerini kabul etmedi.')
    } else if (greeting[1] !== 0 || wantsAuth) {
      throw new Error('Vekil sunucu desteklenen bir kimlik yöntemi sunmadı.')
    }

    const name = Buffer.from(host, 'utf8')
    if (!name.length || name.length > 255) throw new Error('SOCKS hedef adı geçersiz.')
    const request = Buffer.concat([
      Buffer.from([5, 1, 0, 3, name.length]),
      name,
      Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    ])
    socket.write(request)

    const reply = await readExactly(socket, 4)
    if (reply[0] !== 5 || reply[2] !== 0) throw new Error('Vekil sunucu geçersiz SOCKS yanıtı verdi.')
    if (reply[1] !== 0) {
      const reasons = {
        1: 'genel hata',
        2: 'kural izin vermedi',
        3: 'ağa ulaşılamıyor',
        4: 'sunucuya ulaşılamıyor',
        5: 'bağlantı reddedildi',
        6: 'TTL doldu',
        7: 'komut desteklenmiyor',
        8: 'adres türü desteklenmiyor',
      }
      throw new Error(`Vekil sunucu bağlanmadı: ${reasons[reply[1]] || `hata ${reply[1]}`}`)
    }
    // Drain the bound address so the socket starts clean at the tunnelled bytes.
    if (reply[3] === 1) await readExactly(socket, 4 + 2)
    else if (reply[3] === 3) {
      const len = await readExactly(socket, 1)
      await readExactly(socket, len[0] + 2)
    } else if (reply[3] === 4) await readExactly(socket, 16 + 2)
    else throw new Error('Vekil sunucu geçersiz adres türü döndürdü.')

    return socket
  } catch (err) {
    socket.destroy()
    throw err
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    socket.removeListener('error', ignoreError)
  }
}

/* -------------------------------------------------------------------------- */
/* HTTP CONNECT                                                                */
/* -------------------------------------------------------------------------- */

function httpConnect(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${host}:${port}` }
    if (proxy.username) {
      const token = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')
      headers['Proxy-Authorization'] = `Basic ${token}`
    }
    const mod = proxy.protocol === 'https' ? https : http
    const req = mod.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      agent: false,
      rejectUnauthorized: false,
    })
    req.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        return reject(new Error(`Vekil sunucu tüneli açmadı (${res.statusCode}).`))
      }
      socket.setNoDelay(true)
      // Anything the proxy sent along with the 200 belongs to the tunnelled
      // conversation; dropping it would lose the first bytes of the response.
      if (head && head.length) socket.unshift(head)
      socket.pause()
      resolve(socket)
    })
    req.once('error', reject)
    req.setTimeout(20000, () => req.destroy(new Error('Vekil sunucu yanıt vermedi.')))
    req.end()
  })
}

/* -------------------------------------------------------------------------- */
/* agents                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * An agent whose sockets come out of the proxy. Everything above it — redirects,
 * ranges, keep-alive — carries on unaware that it is tunnelled.
 */
function makeAgent(proxy, secure) {
  const Base = secure ? https.Agent : http.Agent
  class ProxiedAgent extends Base {
    createConnection(options, callback) {
      const host = options.host || options.hostname
      const port = Number(options.port) || (secure ? 443 : 80)
      const open = isSocks(proxy) ? socks5Connect(proxy, host, port) : httpConnect(proxy, host, port)
      open
        .then((socket) => {
          if (!secure) return callback(null, socket)
          const wrapped = tls.connect({ socket, servername: host })
          wrapped.once('secureConnect', () => callback(null, wrapped))
          wrapped.once('error', (err) => callback(err))
        })
        .catch((err) => callback(err))
    }
  }
  return new ProxiedAgent({ keepAlive: true, maxSockets: 32 })
}

/** One agent pair per proxy string, so sockets are pooled rather than rebuilt. */
const cache = new Map()

function agentsFor(raw) {
  const proxy = parseProxy(raw)
  if (!proxy) return null
  const key = JSON.stringify([proxy.protocol, proxy.host, proxy.port, proxy.username, proxy.password])
  if (!cache.has(key)) {
    cache.set(key, {
      proxy,
      'http:': makeAgent(proxy, false),
      'https:': makeAgent(proxy, true),
    })
  }
  return cache.get(key)
}

/** Retire a source's pools along with its local bridge. */
function releaseAgents(raw) {
  const proxy = parseProxy(raw)
  if (!proxy) return
  const key = JSON.stringify([proxy.protocol, proxy.host, proxy.port, proxy.username, proxy.password])
  const pair = cache.get(key)
  if (!pair) return
  pair['http:'].destroy()
  pair['https:'].destroy()
  cache.delete(key)
}

/** Electron's session takes its own format, and understands socks natively. */
function electronRules(raw) {
  const proxy = parseProxy(raw)
  if (!proxy) return null
  const scheme = isSocks(proxy) ? 'socks5' : proxy.protocol
  const host = proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host
  return `${scheme}://${host}:${proxy.port}`
}

/**
 * ffmpeg speaks http_proxy and nothing else — it has no SOCKS support at all.
 * Returning null for a SOCKS proxy is the honest answer, and the caller says so
 * out loud rather than downloading unproxied while the interface claims otherwise.
 */
function ffmpegEnv(raw) {
  const proxy = parseProxy(raw)
  if (!proxy || isSocks(proxy)) return null
  const host = proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host
  const value = `${proxy.protocol}://${proxy.username ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@` : ''}${host}:${proxy.port}`
  return { http_proxy: value, https_proxy: value, HTTP_PROXY: value, HTTPS_PROXY: value }
}


/**
 * Where the usual local privacy proxies listen.
 *
 * The proxy service and destination decide throughput. Tor isolation prevents
 * different sources sharing circuits; it does not promise more bandwidth or a
 * different exit address for every source.
 */
const PRESETS = [
  { id: 'tor-managed', label: 'Uygulama Tor', url: 'socks5://127.0.0.1:9061', note: 'Gerektiğinde otomatik başlar' },
  { id: 'tor', label: 'Tor', url: 'socks5://127.0.0.1:9050', note: 'Tor Browser açıkken 9150' },
  { id: 'tor-browser', label: 'Tor Browser', url: 'socks5://127.0.0.1:9150', note: '' },
  { id: 'warp', label: 'Cloudflare WARP', url: 'socks5://127.0.0.1:40000', note: 'warp-cli mode proxy' },
]

/** Which of them is actually listening right now. */
function probePresets(timeoutMs = 700) {
  return Promise.all(
    PRESETS.map(
      (preset) =>
        new Promise((resolve) => {
          const parsed = parseProxy(preset.url)
          const socket = net.connect({ host: parsed.host, port: parsed.port })
          const done = (up) => {
            socket.destroy()
            resolve({ ...preset, up })
          }
          socket.setTimeout(timeoutMs, () => done(false))
          socket.once('connect', () => done(true))
          socket.once('error', () => done(false))
        })
    )
  )
}

/**
 * Legacy call-site compatibility. Isolation belongs to the source context,
 * including its resolver and all media requests; changing identity per worker
 * can invalidate signed, IP-bound media URLs.
 */
// Recognized conventional ports are a UI hint; isolation is supplied explicitly
// by network-context.js and is never inferred for an arbitrary external proxy.
const TOR_PORTS = new Set([9050, 9150, 9061, 9062, 9063, 9064, 9065])

function looksLikeTor(proxy) {
  if (!proxy || !isSocks(proxy) || proxy.username) return false
  const local = proxy.host === '127.0.0.1' || proxy.host === 'localhost' || proxy.host === '::1'
  return local && TOR_PORTS.has(proxy.port)
}

function circuitFor(raw, lane) {
  return raw
}

/**
 * Prove the proxy works, and say what the far end looks like.
 *
 * "Is my VPN on?" deserves a real answer rather than a hopeful one, so this goes
 * through the tunnel and asks Cloudflare's own trace endpoint which address it
 * sees. If that address is not the user's, the tunnel is doing its job. Only ever
 * run when the user presses the button.
 */
function checkProxy(raw, timeoutMs = 12000) {
  const agents = agentsFor(raw)
  if (!agents) return Promise.reject(new Error('Vekil adresi anlaşılamadı.'))

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: 'www.cloudflare.com',
        path: '/cdn-cgi/trace',
        method: 'GET',
        agent: agents['https:'],
        headers: { 'User-Agent': 'All-in-One-Downloader' },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
          if (body.length > 4096) req.destroy()
        })
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`Beklenmeyen yanıt: ${res.statusCode}`))
          const ip = (body.match(/^ip=(.+)$/m) || [])[1] || ''
          const loc = (body.match(/^loc=(.+)$/m) || [])[1] || ''
          resolve(loc ? `${ip} (${loc})` : ip)
        })
      }
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Vekil sunucu zaman aşımına uğradı.')))
    req.once('error', (err) => reject(new Error(err.message)))
    req.end()
  })
}

/**
 * A text fetch that honours the proxy.
 *
 * `fetch` cannot be given an agent, so anything built on it goes around the
 * tunnel no matter what the interface says. Every request the resolver makes on
 * behalf of a proxied link has to come through here instead — otherwise the page
 * is fetched from the real address while only the download is tunnelled, which
 * both leaks and fails: a geo-blocked site answers the scan with a block page and
 * the resolve dies before the proxy is ever used.
 */
const zlib = require('zlib')
const { failureKind, retryDelay, sleep } = require('./recovery')
const TEXT_AGENTS = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 24 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 24 }),
}

async function fetchVia(url, options = {}) {
  const { retries = 2 } = options
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await fetchTextOnce(url, options)
      if ([408, 425, 429, 500, 502, 503, 504].includes(result.status) && attempt < retries) {
        await sleep(retryDelay(attempt, result.status === 429 ? 'busy' : 'network', result.headers['retry-after']), options.signal)
        continue
      }
      return result
    } catch (err) {
      if (attempt >= retries || failureKind(err) !== 'network') throw err
      await sleep(retryDelay(attempt), options.signal)
    }
  }
}

function fetchTextOnce(url, {
  headers = {}, proxy = '', timeoutMs = 12000, maxBytes = 3 * 1024 * 1024,
  redirects = 5, headersFor = null, signal = null, allowBinaryText = false,
} = {}) {
  const agents = proxy ? agentsFor(proxy) : null
  if (proxy && !agents) return Promise.reject(new Error('Vekil adresi anlaşılamadı.'))
  return new Promise((resolve, reject) => {
    let target
    try { target = new URL(url) } catch (err) { return reject(err) }
    if (!['http:', 'https:'].includes(target.protocol)) return reject(new Error('Yalnızca HTTP/HTTPS adresleri destekleniyor.'))
    const requestHeaders = { 'Accept-Encoding': 'gzip, deflate, br', ...headers, ...(headersFor?.(url) || {}) }
    const mod = target.protocol === 'http:' ? http : https
    const req = mod.request(target, {
      headers: requestHeaders, agent: agents ? agents[target.protocol] : TEXT_AGENTS[target.protocol],
      autoSelectFamily: !proxy, signal,
    }, (res) => {
      const location = res.headers.location
      if (location && res.statusCode >= 300 && res.statusCode < 400 && redirects > 0) {
        res.resume()
        let next
        try { next = new URL(location, target) } catch (err) { return reject(err) }
        const redirected = { ...headers }
        // Recompute scoped cookies on each hop. Never forward credentials to a
        // different origin just because a page returned a redirect.
        if (next.origin !== target.origin) {
          for (const key of Object.keys(redirected)) if (/^(cookie|authorization|origin)$/i.test(key)) delete redirected[key]
        }
        return resolve(fetchTextOnce(next.href, { headers: redirected, proxy, timeoutMs, maxBytes, redirects: redirects - 1, headersFor, signal, allowBinaryText }))
      }
      const type = String(res.headers['content-type'] || '')
      if (type && !/text|html|json|javascript|xml|mpegurl|dash|octet-stream/i.test(type) && (!allowBinaryText || /^(?:video|audio)\//i.test(type))) {
        res.destroy()
        return resolve({ status: res.statusCode, headers: res.headers, text: '', finalUrl: target.href })
      }
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase()
      const decoder = encoding === 'br' ? zlib.createBrotliDecompress()
        : encoding === 'gzip' ? zlib.createGunzip() : encoding === 'deflate' ? zlib.createInflate() : null
      const body = decoder ? res.pipe(decoder) : res
      const chunks = []
      let size = 0
      let finished = false
      const timer = setTimeout(() => req.destroy(Object.assign(new Error('Sunucu zaman aşımına uğradı.'), { code: 'ETIMEDOUT' })), timeoutMs)
      const finish = (error) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        if (error) { req.destroy(); reject(error); return }
        resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), finalUrl: target.href })
      }
      body.on('data', (chunk) => {
        size += chunk.length
        if (size > maxBytes) {
          finish(Object.assign(new Error('Yanıt boyut sınırını aştı.'), { code: 'RESPONSE_TOO_LARGE' }))
          body.destroy()
          return
        }
        chunks.push(chunk)
      })
      body.once('end', () => finish())
      body.once('error', finish)
      res.once('aborted', () => finish(Object.assign(new Error('Sunucu yanıtı yarıda kesildi.'), { code: 'ECONNRESET' })))
      res.once('error', finish)
    })
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('Sunucu yanıt vermedi.'), { code: 'ETIMEDOUT' })))
    req.once('error', reject)
    req.end()
  })
}

module.exports = {
  PRESETS,
  probePresets,
  circuitFor,
  looksLikeTor,
  parseProxy,
  agentsFor,
  releaseAgents,
  socks5Connect,
  readExactly,
  electronRules,
  ffmpegEnv,
  isSocks,
  checkProxy,
  fetchVia,
}
