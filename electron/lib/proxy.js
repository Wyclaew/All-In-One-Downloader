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
  return {
    protocol: protocol === 'socks' || protocol === 'socks5h' ? 'socks5' : protocol,
    host: url.hostname,
    port,
    username: decodeURIComponent(url.username || ''),
    password: decodeURIComponent(url.password || ''),
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
    }
    socket.on('readable', attempt)
    socket.once('error', onError)
    socket.once('end', onEnd)
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
async function socks5Connect(proxy, host, port) {
  const socket = net.connect({ host: proxy.host, port: proxy.port })
  socket.setNoDelay(true)
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })

  try {
    const wantsAuth = !!proxy.username
    socket.write(wantsAuth ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]))
    const greeting = await readExactly(socket, 2)
    if (greeting[0] !== 5) throw new Error('Vekil sunucu SOCKS5 konuşmuyor.')

    if (greeting[1] === 2) {
      if (!wantsAuth) throw new Error('Vekil sunucu kullanıcı adı/parola istiyor.')
      const user = Buffer.from(proxy.username, 'utf8')
      const pass = Buffer.from(proxy.password, 'utf8')
      socket.write(
        Buffer.concat([
          Buffer.from([1, user.length]),
          user,
          Buffer.from([pass.length]),
          pass,
        ])
      )
      const auth = await readExactly(socket, 2)
      if (auth[1] !== 0) throw new Error('Vekil sunucu kimlik bilgilerini kabul etmedi.')
    } else if (greeting[1] !== 0) {
      throw new Error('Vekil sunucu desteklenen bir kimlik yöntemi sunmadı.')
    }

    const name = Buffer.from(host, 'utf8')
    const request = Buffer.concat([
      Buffer.from([5, 1, 0, 3, name.length]),
      name,
      Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    ])
    socket.write(request)

    const reply = await readExactly(socket, 4)
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

    return socket
  } catch (err) {
    socket.destroy()
    throw err
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
  const key = `${proxy.protocol}://${proxy.username}@${proxy.host}:${proxy.port}`
  if (!cache.has(key)) {
    cache.set(key, {
      proxy,
      'http:': makeAgent(proxy, false),
      'https:': makeAgent(proxy, true),
    })
  }
  return cache.get(key)
}

/** Electron's session takes its own format, and understands socks natively. */
function electronRules(raw) {
  const proxy = parseProxy(raw)
  if (!proxy) return null
  const scheme = isSocks(proxy) ? 'socks5' : proxy.protocol
  return `${scheme}://${proxy.host}:${proxy.port}`
}

/**
 * ffmpeg speaks http_proxy and nothing else — it has no SOCKS support at all.
 * Returning null for a SOCKS proxy is the honest answer, and the caller says so
 * out loud rather than downloading unproxied while the interface claims otherwise.
 */
function ffmpegEnv(raw) {
  const proxy = parseProxy(raw)
  if (!proxy || isSocks(proxy)) return null
  const value = `${proxy.protocol}://${proxy.username ? `${proxy.username}:${proxy.password}@` : ''}${proxy.host}:${proxy.port}`
  return { http_proxy: value, https_proxy: value, HTTP_PROXY: value, HTTPS_PROXY: value }
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

module.exports = { parseProxy, agentsFor, electronRules, ffmpegEnv, isSocks, checkProxy }
