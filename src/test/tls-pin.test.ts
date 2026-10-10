import { test, describe, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import * as net from "node:net"
import * as tls from "node:tls"
import { EngineClient } from "../protocol/engine-client"
import {
  FingerprintMismatchError,
  connectPinnedTls,
  fetchPeerFingerprint,
  formatFingerprint,
  isLoopbackHost,
  normaliseFingerprint,
} from "../protocol/tls-pin"
import { TestIdentity, TestIdentityA, TestIdentityB } from "./test-tls-identity"

const Hex = "0123456789abcdef".repeat(4)

describe("normaliseFingerprint", () => {
  test("lowercase hex is returned as it is", () => {
    assert.equal(normaliseFingerprint(Hex), Hex)
  })

  test("node's form (upper-case pairs joined by colons) becomes lowercase hex without colons", () => {
    const colons = Hex.toUpperCase().match(/../g)!.join(":")
    assert.equal(normaliseFingerprint(colons), Hex)
    assert.equal(normaliseFingerprint(colons.toLowerCase()), Hex)
  })

  test("upper-case hex and surrounding spaces are accepted", () => {
    assert.equal(normaliseFingerprint(`  ${Hex.toUpperCase()}\n`), Hex)
  })

  test("anything that isn't exactly 32 bytes of hex is refused", () => {
    const colons = Hex.match(/../g)!.join(":")
    for (const value of [
      "",
      "abc",
      Hex.slice(1),
      Hex + "0",
      Hex.slice(0, 62) + "zz",
      colons.slice(0, -3), // 31 pairs
      colons + ":00", // 33 pairs
      colons.replace(":", "::"),
      colons.replace(/:/g, "-"),
      Hex.slice(0, 32) + ":" + Hex.slice(32), // a lone colon in hex
      "sha256:" + Hex,
      `${Hex} ${Hex}`,
      undefined,
      null,
      5,
      {},
    ]) {
      assert.equal(normaliseFingerprint(value), null, JSON.stringify(value))
    }
  })
})

describe("formatFingerprint and isLoopbackHost", () => {
  test("a fingerprint is shown in groups of four", () => {
    assert.equal(formatFingerprint("0123456789abcdef"), "0123 4567 89ab cdef")
  })

  test("only this computer's loopback is loopback", () => {
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "0:0:0:0:0:0:0:1"]) {
      assert.equal(isLoopbackHost(host), true, host)
    }
    for (const host of ["example.com", "10.0.0.1", "192.168.1.5", "localhost.example.com", "127.0.0.1.evil.com", "::2", "0.0.0.0"]) {
      assert.equal(isLoopbackHost(host), false, host)
    }
  })
})

interface TestServer {
  port: number
  /** Application bytes the server received over its TLS connections */
  received: Buffer[]
  handshakes: number
  close(): Promise<void>
}

const servers: TestServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

function startTlsServer(identity: TestIdentity): Promise<TestServer> {
  return new Promise((resolve) => {
    const received: Buffer[] = []
    const sockets = new Set<net.Socket>()
    const server = tls.createServer({ key: identity.key, cert: identity.cert }, (socket) => {
      state.handshakes++
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
      socket.on("error", () => undefined)
      socket.on("data", (chunk: Buffer) => received.push(chunk))
    })
    server.on("tlsClientError", () => undefined)
    const state: TestServer = {
      port: 0,
      received,
      handshakes: 0,
      close: () =>
        new Promise((done) => {
          sockets.forEach((s) => s.destroy())
          server.close(() => done())
        }),
    }
    server.listen(0, "127.0.0.1", () => {
      state.port = (server.address() as net.AddressInfo).port
      servers.push(state)
      resolve(state)
    })
  })
}

/** Resolves with what happens to the socket: "connected" (onConnect ran) or the error it was destroyed with */
function attempt(port: number, fingerprint: string): Promise<{ socket: net.Socket; result: "connected" | Error }> {
  return new Promise((resolve) => {
    const socket = connectPinnedTls({ host: "127.0.0.1", port, fingerprint }, () => resolve({ socket, result: "connected" }))
    socket.once("error", (error) => resolve({ socket, result: error }))
  })
}

const settle = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe("the test identities", () => {
  test("have different, well-formed fingerprints", () => {
    assert.match(TestIdentityA.fingerprint, /^[0-9a-f]{64}$/)
    assert.match(TestIdentityB.fingerprint, /^[0-9a-f]{64}$/)
    assert.notEqual(TestIdentityA.fingerprint, TestIdentityB.fingerprint)
  })
})

describe("connectPinnedTls", () => {
  test("connects to a host whose self-signed certificate has the pinned fingerprint, and data flows", async () => {
    const server = await startTlsServer(TestIdentityA)
    const { socket, result } = await attempt(server.port, TestIdentityA.fingerprint)
    assert.equal(result, "connected")
    socket.write("hello")
    await settle()
    assert.equal(Buffer.concat(server.received).toString(), "hello")
    socket.destroy()
  })

  test("accepts the pinned fingerprint in node's colon form and in upper case", async () => {
    const server = await startTlsServer(TestIdentityA)
    const colons = TestIdentityA.fingerprint.toUpperCase().match(/../g)!.join(":")
    const { socket, result } = await attempt(server.port, colons)
    assert.equal(result, "connected")
    socket.destroy()
  })

  test("a host with a different certificate is refused: onConnect never runs and nothing is received", async () => {
    const server = await startTlsServer(TestIdentityB)
    let connected = false
    const socket = connectPinnedTls({ host: "127.0.0.1", port: server.port, fingerprint: TestIdentityA.fingerprint }, () => {
      connected = true
      socket.write("the-token")
    })
    const error = await new Promise<Error>((resolve) => socket.once("error", resolve))
    assert.ok(error instanceof FingerprintMismatchError)
    assert.equal(error.expected, TestIdentityA.fingerprint)
    assert.equal(error.actual, TestIdentityB.fingerprint)
    assert.match(error.message, new RegExp(TestIdentityB.fingerprint))
    await settle()
    assert.equal(connected, false)
    assert.equal(socket.destroyed, true)
    assert.equal(server.received.length, 0, "no application bytes reached the host")
  })

  test("a fingerprint that is only almost right is refused", async () => {
    const server = await startTlsServer(TestIdentityA)
    const flipped = TestIdentityA.fingerprint.replace(/.$/, (c) => (c === "0" ? "1" : "0"))
    const { result } = await attempt(server.port, flipped)
    assert.ok(result instanceof FingerprintMismatchError)
  })

  test("a fingerprint that isn't a SHA-256 fingerprint throws before connecting", () => {
    assert.throws(() => connectPinnedTls({ host: "127.0.0.1", port: 1, fingerprint: "abc" }, () => undefined), /SHA-256/)
  })

  test("a host that doesn't speak TLS fails the connect", async () => {
    const plain = await new Promise<net.Server>((resolve) => {
      const server = net.createServer((s) => {
        s.on("error", () => undefined)
        s.end("HTTP/1.1 400 Bad Request\r\n\r\n")
      })
      server.listen(0, "127.0.0.1", () => resolve(server))
    })
    try {
      const port = (plain.address() as net.AddressInfo).port
      const { result } = await attempt(port, TestIdentityA.fingerprint)
      assert.ok(result instanceof Error && !(result instanceof FingerprintMismatchError))
    } finally {
      plain.close()
    }
  })

  test("a handshake that never finishes times out", async () => {
    const silent = await new Promise<net.Server>((resolve) => {
      const server = net.createServer(() => undefined)
      server.listen(0, "127.0.0.1", () => resolve(server))
    })
    try {
      const port = (silent.address() as net.AddressInfo).port
      const socket = connectPinnedTls(
        { host: "127.0.0.1", port, fingerprint: TestIdentityA.fingerprint, handshakeTimeoutMs: 50 },
        () => assert.fail("connected")
      )
      const error = await new Promise<Error>((resolve) => socket.once("error", resolve))
      assert.match(error.message, /timed out/)
    } finally {
      silent.close()
    }
  })
})

describe("fetchPeerFingerprint", () => {
  test("reads the fingerprint the host presents, sending nothing", async () => {
    const server = await startTlsServer(TestIdentityA)
    assert.equal(await fetchPeerFingerprint("127.0.0.1", server.port), TestIdentityA.fingerprint)
    await settle()
    assert.equal(server.received.length, 0)
  })

  test("a different host presents a different fingerprint", async () => {
    const server = await startTlsServer(TestIdentityB)
    assert.equal(await fetchPeerFingerprint("127.0.0.1", server.port), TestIdentityB.fingerprint)
  })

  test("a host that can't be reached rejects", async () => {
    const closed = await new Promise<number>((resolve) => {
      const server = net.createServer()
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as net.AddressInfo).port
        server.close(() => resolve(port))
      })
    })
    await assert.rejects(fetchPeerFingerprint("127.0.0.1", closed, 2000))
  })
})

describe("EngineClient with a pinned TLS host", () => {
  test("a different certificate fails the connect before anything, the token included, is sent", async () => {
    const server = await startTlsServer(TestIdentityB)
    const client = new EngineClient()
    await assert.rejects(
      client.connect("127.0.0.1", server.port, { token: "s3cret-token", tlsFingerprint: TestIdentityA.fingerprint }),
      FingerprintMismatchError
    )
    await settle()
    assert.equal(server.received.length, 0, "the host received no bytes at all")
    assert.equal(client.isConnected, false)
  })

  test("the matching certificate lets Hello through, with the token", async () => {
    const server = await startTlsServer(TestIdentityA)
    const client = new EngineClient()
    // The test host never answers: Hello is sent, and the attempt is closed
    const connecting = client.connect("127.0.0.1", server.port, { token: "s3cret-token", tlsFingerprint: TestIdentityA.fingerprint })
    connecting.catch(() => undefined)
    await settle(200)
    assert.ok(Buffer.concat(server.received).includes("s3cret-token"), "Hello reached the pinned host")
    client.close()
    await assert.rejects(connecting)
  })

  test("a malformed pinned fingerprint is refused before a socket is opened", async () => {
    const client = new EngineClient(() => assert.fail("opened a plaintext socket"), () => assert.fail("opened a TLS socket"))
    await assert.rejects(client.connect("127.0.0.1", 1, { tlsFingerprint: "abc" }), /SHA-256/)
  })

  test("plaintext to a host that isn't loopback is refused before a socket is opened", async () => {
    const client = new EngineClient(() => assert.fail("opened a plaintext socket"), () => assert.fail("opened a TLS socket"))
    await assert.rejects(client.connect("example.com", 7000, { token: "t" }), /TLS is required/)
    await assert.rejects(client.connect("10.1.2.3", 7000, {}), /TLS is required/)
  })
})
