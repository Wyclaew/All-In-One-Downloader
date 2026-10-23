'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const net = require('net')
const { root, load } = require('./helpers.cjs')
const { parseProxy, socks5Connect, readExactly, agentsFor, releaseAgents, fetchVia, circuitFor } = load('electron/lib/proxy.js')
const { createNetworkContextManager, isManagedProxy } = load('electron/lib/network-context.js')

let server, port
const identities = []
const sockets = new Set()
test.before(async () => {
  server = net.createServer((socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket))
    ;(async () => {
      const hello = await readExactly(socket, 2)
      const methods = await readExactly(socket, hello[1])
      assert.ok(methods.includes(2), 'every bridge connection must require upstream authentication')
      socket.write(Buffer.from([5, 2]))
      const auth = await readExactly(socket, 2)
      const username = (await readExactly(socket, auth[1])).toString()
      const password = (await readExactly(socket, (await readExactly(socket, 1))[0])).toString()
      socket.write(Buffer.from([1, 0]))
      const request = await readExactly(socket, 4)
      assert.equal(request[3], 3)
      const host = (await readExactly(socket, (await readExactly(socket, 1))[0])).toString()
      const destinationPort = (await readExactly(socket, 2)).readUInt16BE(0)
      identities.push({ username, password, host, port: destinationPort })
      socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
      socket.on('data', () => {
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\nthrough-tor')
      })
      socket.resume()
    })().catch(() => socket.destroy())
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})
test.after(async () => {
  for (const socket of sockets) socket.destroy()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(root, { recursive: true, force: true })
})
function fixture(options = {}) {
  let starts = 0
  const torManager = {
    getStatus: () => ({ state: 'on', port }),
    ensureStarted: async () => { starts += 1; return { state: 'on', port } },
    ...options.torManager,
  }
  return { manager: createNetworkContextManager({ ...options, torManager }), starts: () => starts }
}
test('two sources use separate identities, and browser-style no-auth SOCKS and Node HTTP share each source identity', async () => {
  const f = fixture()
  try {
    const [a, b] = await Promise.all([f.manager.ensureForSource('a'), f.manager.ensureForSource('b')])
    assert.notEqual(a, b)
    const browser = await socks5Connect(parseProxy(a), 'browser.invalid', 443)
    browser.destroy()
    const first = identities.at(-1)
    const result = await fetchVia('http://node.invalid/video', { proxy: a, retries: 0 })
    assert.equal(result.text, 'through-tor')
    assert.equal(identities.at(-1).username, first.username)
    assert.equal(identities.at(-1).password, first.password)
    const other = await socks5Connect(parseProxy(b), 'other.invalid', 443)
    other.destroy()
    assert.notEqual(identities.at(-1).username, first.username)
    assert.equal(await f.manager.ensureForSource('a'), a)
    assert.deepEqual(f.manager.getContext('a'), { kind: 'tor', isolated: true, label: 'Tor · ayrı kaynak oturumu' })
    assert.equal(circuitFor(a, 7), a)
    f.manager.releaseSource('a')
    assert.equal(f.manager.getContext('a'), null)
    await assert.rejects(socks5Connect(parseProxy(a), 'closed.invalid', 80), /ECONNREFUSED/)
  } finally { f.manager.shutdown() }
})
test('custom proxies never start Tor, malformed credentials fail cleanly, and disabled auto-start fails closed', async () => {
  const f = fixture({ torManager: { getStatus: () => ({ state: 'off', port: null }) } })
  try {
    for (const proxyUrl of ['socks5://127.0.0.1:40000', 'socks5://127.0.0.1:9050', 'http://user:secret@example.test:8000']) {
      assert.equal(await f.manager.ensureForSource(proxyUrl, { settings: { proxyUrl } }), proxyUrl)
    }
    assert.equal(f.starts(), 0)
    assert.equal(isManagedProxy('socks5://[::1]:9061'), true)
    assert.equal(isManagedProxy('socks5://user:pass@127.0.0.1:9061'), false)
    assert.equal(parseProxy('socks5://%xx:pass@host:1080'), null)
    await assert.rejects(f.manager.ensureForSource('broken', { settings: { proxyUrl: 'ftp://bad.test' } }), /Vekil adresi/)
    await assert.rejects(f.manager.ensureForSource('off', { settings: { autoStartTor: false } }), /Tor kapalı/)
    assert.equal(f.starts(), 0)
  } finally { f.manager.shutdown() }
})
test('source removal cancels pending bootstrap without recreating its network context', async () => {
  const f = fixture({ torManager: { ensureStarted: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })), { once: true })
  }) } })
  const pending = f.manager.ensureForSource('removed')
  f.manager.releaseSource('removed')
  await assert.rejects(pending, { code: 'ABORTED' })
  assert.equal(f.manager.getContext('removed'), null)
  f.manager.shutdown()
})
test('context count is bounded; releasing a source allows a new one', async () => {
  const f = fixture({ maxContexts: 1 })
  try {
    await f.manager.ensureForSource('first')
    await assert.rejects(f.manager.ensureForSource('second'), /sınırına/)
    f.manager.releaseSource('first')
    await f.manager.ensureForSource('second')
    assert.equal(f.manager.getContext('second').isolated, true)
  } finally { f.manager.shutdown() }
})
test('proxy pools include the password in their identity and can be retired', () => {
  const a = 'socks5://same:first@127.0.0.1:9061'
  const b = 'socks5://same:second@127.0.0.1:9061'
  assert.notEqual(agentsFor(a), agentsFor(b))
  const previous = agentsFor(a)
  releaseAgents(a)
  assert.notEqual(agentsFor(a), previous)
  releaseAgents(a); releaseAgents(b)
})
test('upstream SOCKS authentication cannot silently downgrade to no-auth', async () => {
  const downgrade = net.createServer((socket) => {
    socket.on('error', () => {})
    socket.once('data', () => socket.end(Buffer.from([5, 0])))
  })
  await new Promise((resolve) => downgrade.listen(0, '127.0.0.1', resolve))
  try {
    await assert.rejects(socks5Connect({ host: '127.0.0.1', port: downgrade.address().port, username: 'identity', password: 'x' }, 'target.invalid', 80), /kimlik yöntemi/)
  } finally { await new Promise((resolve) => downgrade.close(resolve)) }
})
