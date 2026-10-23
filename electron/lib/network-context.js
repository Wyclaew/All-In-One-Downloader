'use strict'

// Chromium cannot authenticate to SOCKS5. A small loopback bridge per source
// injects that source's Tor identity for every client (browser, Node or yt-dlp).
// Credentials never enter persisted settings, IPC payloads or process arguments.
const net = require('net')
const crypto = require('crypto')
const tor = require('./tor')
const { parseProxy, socks5Connect, readExactly, releaseAgents } = require('./proxy')

const MANAGED_PORTS = new Set([9061, 9062, 9063, 9064, 9065])
const MAX_CONTEXTS = 64
const MAX_SOCKETS_PER_SOURCE = 128
const MAX_SOCKETS = 512
const aborted = () => Object.assign(new Error('İşlem iptal edildi.'), { code: 'ABORTED' })

function isManagedProxy(raw) {
  if (!String(raw || '').trim()) return true
  const proxy = parseProxy(raw)
  return !!proxy && proxy.protocol === 'socks5' && !proxy.username && !proxy.password &&
    ['127.0.0.1', 'localhost', '::1'].includes(proxy.host) && MANAGED_PORTS.has(proxy.port)
}

function waitFor(promise, signal) {
  if (signal?.aborted) return Promise.reject(aborted())
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(aborted()) }
    const cleanup = () => signal.removeEventListener('abort', cancel)
    signal.addEventListener('abort', cancel, { once: true })
    promise.then((value) => { cleanup(); resolve(value) }, (error) => { cleanup(); reject(error) })
  })
}

function createNetworkContextManager({ torManager = tor, maxContexts = MAX_CONTEXTS } = {}) {
  const contexts = new Map()
  const routes = new Map()
  const pending = new Map()
  let socketCount = 0
  let generation = 0

  function closeContext(context) {
    if (!context || context.closed) return
    context.closed = true
    context.server?.close()
    for (const socket of context.sockets) socket.destroy()
    if (context.proxy) releaseAgents(context.proxy)
  }

  async function serve(context, client) {
    if (context.closed || context.clients >= MAX_SOCKETS_PER_SOURCE || socketCount >= MAX_SOCKETS) {
      client.destroy()
      return
    }
    context.clients += 1
    socketCount += 1
    const track = (socket) => {
      context.sockets.add(socket)
      // Keep errors handled even between handshake operations / while piping.
      socket.on('error', () => {})
      socket.once('close', () => context.sockets.delete(socket))
      return socket
    }
    track(client)
    const controller = new AbortController()
    let upstream
    const timer = setTimeout(() => { controller.abort(); client.destroy() }, 20000)
    client.once('close', () => {
      context.clients -= 1
      socketCount -= 1
      clearTimeout(timer)
      controller.abort()
      upstream?.destroy()
    })
    try {
      const greeting = await readExactly(client, 2)
      if (greeting[0] !== 5 || !greeting[1]) throw new Error('SOCKS5 gerekli.')
      const methods = await readExactly(client, greeting[1])
      if (!methods.includes(0)) { client.end(Buffer.from([5, 255])); return }
      client.write(Buffer.from([5, 0]))
      const request = await readExactly(client, 4)
      if (request[0] !== 5 || request[1] !== 1 || request[2] !== 0) {
        client.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return
      }
      let host
      if (request[3] === 3) {
        const length = (await readExactly(client, 1))[0]
        if (!length) throw new Error('SOCKS hedefi boş.')
        host = (await readExactly(client, length)).toString('utf8')
      } else if (request[3] === 1) host = [...await readExactly(client, 4)].join('.')
      else if (request[3] === 4) {
        const address = await readExactly(client, 16)
        host = Array.from({ length: 8 }, (_, index) => address.readUInt16BE(index * 2).toString(16)).join(':')
      } else throw new Error('SOCKS hedef adres türü desteklenmiyor.')
      const port = (await readExactly(client, 2)).readUInt16BE(0)
      const ready = torManager.getStatus()
      if (ready.state !== 'on' || !ready.port || context.closed) throw new Error('Tor bağlantısı kapalı.')
      upstream = await socks5Connect({
        host: '127.0.0.1', port: ready.port,
        username: context.username, password: context.password,
      }, host, port, { signal: controller.signal, onSocket: track })
      if (context.closed || client.destroyed) { upstream.destroy(); return }
      clearTimeout(timer)
      client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
      upstream.once('error', () => client.destroy())
      upstream.once('close', () => { if (!upstream.readableEnded) client.destroy() })
      client.once('error', () => upstream.destroy())
      client.pipe(upstream).pipe(client)
    } catch {
      upstream?.destroy()
      if (!client.destroyed) client.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]))
    }
  }

  function createContext(sourceId) {
    const context = {
      sourceId, closed: false, proxy: '', clients: 0, sockets: new Set(),
      username: `aio-${crypto.randomBytes(18).toString('hex')}`,
      password: crypto.randomBytes(18).toString('hex'),
      server: null, promise: null,
    }
    context.promise = new Promise((resolve, reject) => {
      const server = net.createServer((socket) => { serve(context, socket).catch(() => socket.destroy()) })
      context.server = server
      const failed = (error) => { closeContext(context); reject(error) }
      server.once('error', failed)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', failed)
        server.on('error', () => closeContext(context))
        if (context.closed) { server.close(); reject(aborted()); return }
        context.proxy = `socks5://127.0.0.1:${server.address().port}`
        resolve(context.proxy)
      })
    })
    context.promise.catch(() => { if (contexts.get(sourceId) === context) contexts.delete(sourceId) })
    contexts.set(sourceId, context)
    return context
  }

  async function ensureRoute(sourceId, { settings = {}, signal, onProgress } = {}) {
    if (!sourceId) throw new Error('Vekil oturumu için kaynak kimliği gerekli.')
    if (signal?.aborted) throw aborted()
    const raw = String(settings.proxyUrl ?? settings.proxy ?? '').trim()
    if (!isManagedProxy(raw)) {
      if (!parseProxy(raw)) throw new Error('Vekil adresi anlaşılamadı. Ayarlardan geçerli bir vekil seç.')
      routes.set(sourceId, { kind: 'proxy', isolated: false, label: 'Özel vekil' })
      return raw
    }
    const before = generation
    const ready = settings.autoStartTor === false
      ? torManager.getStatus()
      : await torManager.ensureStarted({ settings, signal, onProgress })
    if (before !== generation || signal?.aborted) throw aborted()
    if (ready.state !== 'on' || !ready.port) throw new Error('Tor kapalı. Tor’u başlat veya otomatik başlatmayı aç.')
    if (settings.isolateTorSources === false) {
      routes.set(sourceId, { kind: 'tor', isolated: false, label: 'Tor' })
      return `socks5://127.0.0.1:${ready.port}`
    }
    let context = contexts.get(sourceId)
    if (!context || context.closed) {
      if (contexts.size >= maxContexts) throw new Error('Tor kaynak oturumu sınırına ulaşıldı. Kullanılmayan bağlantıları kaldır.')
      context = createContext(sourceId)
    }
    const proxy = await waitFor(context.promise, signal)
    if (context.closed || before !== generation || signal?.aborted) throw aborted()
    routes.set(sourceId, { kind: 'tor', isolated: true, label: 'Tor · ayrı kaynak oturumu' })
    return proxy
  }

  async function ensureForSource(sourceId, options = {}) {
    const controller = new AbortController()
    const waiters = pending.get(sourceId) || new Set()
    waiters.add(controller)
    pending.set(sourceId, waiters)
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    try { return await ensureRoute(sourceId, { ...options, signal }) }
    finally {
      waiters.delete(controller)
      if (!waiters.size) pending.delete(sourceId)
    }
  }

  function releaseSource(sourceId) {
    for (const controller of pending.get(sourceId) || []) controller.abort()
    const context = contexts.get(sourceId)
    contexts.delete(sourceId)
    routes.delete(sourceId)
    closeContext(context)
  }
  function shutdown() {
    generation += 1
    for (const sourceId of pending.keys()) releaseSource(sourceId)
    for (const sourceId of contexts.keys()) releaseSource(sourceId)
    routes.clear()
  }
  function getContext(sourceId) { return routes.has(sourceId) ? { ...routes.get(sourceId) } : null }
  return { ensureForSource, releaseSource, shutdown, getContext }
}

module.exports = { ...createNetworkContextManager(), isManagedProxy, createNetworkContextManager }
