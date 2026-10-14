import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ConnectionState, HostState } from "../shared/api"
import { FingerprintMismatchError } from "../protocol/tls-pin"
import { describeMismatch, parseDirectRemoteSettings, requiredFingerprint } from "../main/direct-remote"
import type { EngineTarget } from "../main/engine-ipc"
import { PinStore } from "../main/pin-store"
import { EngineConnection, ProjectSession } from "../main/project-session"

const A = "a".repeat(64)
const B = "b".repeat(64)

describe("parseDirectRemoteSettings", () => {
  test("a TLS host: the address is lower-cased and the fingerprint normalised", () => {
    assert.deepEqual(
      parseDirectRemoteSettings({ host: " Cloud.Example.com ", port: 7000, tls: true, fingerprint: A.toUpperCase(), extra: 1 }),
      { host: "cloud.example.com", port: 7000, tls: true, fingerprint: A }
    )
    assert.deepEqual(parseDirectRemoteSettings({ host: "10.0.0.5", port: 1, tls: true, fingerprint: "" }), {
      host: "10.0.0.5",
      port: 1,
      tls: true,
    })
    assert.equal(parseDirectRemoteSettings({ host: "2001:db8::1", port: 1, tls: true }).host, "2001:db8::1")
  })

  test("the optional user is kept trimmed, dropped when blank and refused when it can't be a user name", () => {
    assert.equal(parseDirectRemoteSettings({ host: "h", port: 1, tls: true, user: " alice " }).user, "alice")
    assert.ok(!("user" in parseDirectRemoteSettings({ host: "h", port: 1, tls: true, user: "" })))
    assert.ok(!("user" in parseDirectRemoteSettings({ host: "h", port: 1, tls: true, user: null })))
    assert.throws(() => parseDirectRemoteSettings({ host: "h", port: 1, tls: true, user: "a b" }), /user name/)
    assert.throws(() => parseDirectRemoteSettings({ host: "h", port: 1, tls: true, user: "a".repeat(65) }), /too long/)
    assert.throws(() => parseDirectRemoteSettings({ host: "h", port: 1, tls: true, user: 5 }), /must be text/)
  })

  test("plaintext is for this computer's loopback only", () => {
    for (const host of ["localhost", "127.0.0.1", "::1"]) {
      assert.equal(parseDirectRemoteSettings({ host, port: 7000, tls: false }).tls, false, host)
    }
    for (const host of ["example.com", "10.0.0.5", "192.168.0.2", "127.0.0.1.example.com"]) {
      assert.throws(() => parseDirectRemoteSettings({ host, port: 7000, tls: false }), /TLS is required/, host)
    }
  })

  test("bad hosts, ports, flags and fingerprints are refused", () => {
    const base = { host: "h", port: 7000, tls: true }
    assert.throws(() => parseDirectRemoteSettings(null), /Invalid remote settings/)
    assert.throws(() => parseDirectRemoteSettings([]), /Invalid remote settings/)
    for (const host of ["", "  ", "a b", "h:7000", "[::1]", "-x", "h/x", "h@h", "a".repeat(300), 5, undefined]) {
      assert.throws(() => parseDirectRemoteSettings({ ...base, host }), /address/, String(host))
    }
    for (const port of [0, 65536, 1.5, "7000", NaN, undefined, -1]) {
      assert.throws(() => parseDirectRemoteSettings({ ...base, port }), /port/, String(port))
    }
    assert.throws(() => parseDirectRemoteSettings({ ...base, tls: undefined }), /Invalid remote settings/)
    assert.throws(() => parseDirectRemoteSettings({ ...base, tls: "true" }), /Invalid remote settings/)
    assert.throws(() => parseDirectRemoteSettings({ ...base, fingerprint: "abc" }), /fingerprint/)
    assert.throws(() => parseDirectRemoteSettings({ ...base, fingerprint: 5 }), /fingerprint/)
    assert.throws(() => parseDirectRemoteSettings({ host: "localhost", port: 1, tls: false, fingerprint: A }), /needs TLS/)
  })
})

describe("requiredFingerprint", () => {
  const settings = { host: "h", port: 7000, tls: true }
  const pin = { fingerprint: A, firstSeen: "2026-01-01T00:00:00.000Z" }

  test("the typed or confirmed fingerprint, else the pinned one", () => {
    assert.equal(requiredFingerprint({ ...settings, fingerprint: A }, undefined), A)
    assert.equal(requiredFingerprint({ ...settings, fingerprint: A }, pin), A)
    assert.equal(requiredFingerprint(settings, pin), A)
  })

  test("never whatever the host presents: with neither, it is refused", () => {
    assert.throws(() => requiredFingerprint(settings, undefined), /hasn't been confirmed/)
  })

  test("a typed fingerprint that differs from the pin is refused, naming both and how to reset", () => {
    assert.throws(
      () => requiredFingerprint({ ...settings, fingerprint: B }, pin),
      (e: Error) => e.message.includes(A) && e.message.includes(B) && /Forget pin/.test(e.message)
    )
  })
})

describe("describeMismatch", () => {
  test("names the old and new values and how to reset a pin", () => {
    const message = describeMismatch("h:7000", A, B, true)
    assert.ok(message.includes(A) && message.includes(B) && message.includes("Forget pin"))
    assert.ok(!describeMismatch("h:7000", A, B, false).includes("Forget pin"))
    assert.match(describeMismatch("h:7000", A, null, true), /no certificate/)
  })
})

class FakeEngine implements EngineConnection {
  connections: Array<{ port: number; token: string; target?: EngineTarget }> = []
  closes = 0
  fail: Error | null = null
  async connectTo(port: number, token: string, target?: EngineTarget): Promise<ConnectionState> {
    this.connections.push({ port, token, target })
    if (this.fail) throw this.fail
    return { connected: true, epoch: 1, serverInfo: null }
  }
  disconnect(): void {}
  close(): void {
    this.closes++
  }
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n2-direct-"))
  const pins = new PinStore(path.join(dir, "pins.json"))
  const engine = new FakeEngine()
  const states: HostState[] = []
  const logs: string[] = []
  const session = new ProjectSession({
    files: { open: (d: string) => d, close: () => undefined, rootPath: null },
    recent: { add: () => undefined },
    settings: { require: () => "host.exe", readyTimeoutMs: () => 1000 },
    engine,
    pins,
    publish: (state) => states.push(state),
    log: (message) => logs.push(message),
  })
  return { session, engine, pins, states, logs, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

describe("ProjectSession direct-address remote", () => {
  test("a host that isn't pinned or confirmed is refused before the engine is touched", async () => {
    const t = setup()
    try {
      await assert.rejects(t.session.connectDirect({ host: "h", port: 7000, tls: true }, "tok"), /hasn't been confirmed/)
      assert.equal(t.engine.connections.length, 0)
      assert.equal(t.engine.closes, 0)
      assert.equal(t.pins.get("h", 7000), undefined, "nothing is trusted silently")
    } finally {
      t.cleanup()
    }
  })

  test("a confirmed fingerprint connects with TLS pinned to it, then pins it; the token goes to the engine only", async () => {
    const t = setup()
    try {
      const name = await t.session.connectDirect({ host: "H", port: 7000, tls: true, fingerprint: A }, "s3cret-token")
      assert.equal(name, "h:7000")
      assert.deepEqual(t.engine.connections, [
        { port: 7000, token: "s3cret-token", target: { host: "h", tlsFingerprint: A } },
      ])
      assert.equal(t.pins.get("h", 7000)?.fingerprint, A)
      assert.equal(t.session.state.mode, "remote")
      assert.equal(t.session.state.status, "running")
      assert.equal(t.session.isRemote, true)
      assert.ok(!JSON.stringify(t.states).includes("s3cret-token"))
      assert.ok(!t.logs.join("\n").includes("s3cret-token"))
    } finally {
      t.cleanup()
    }
  })

  test("a user is passed to the engine with the token, and no user is no key at all", async () => {
    const t = setup()
    try {
      await t.session.connectDirect({ host: "h", port: 7000, tls: true, fingerprint: A, user: " alice " }, "tok")
      await t.session.connectDirect({ host: "h", port: 7000, tls: true, fingerprint: A, user: "  " }, "tok")
      assert.deepEqual(t.engine.connections, [
        { port: 7000, token: "tok", target: { host: "h", tlsFingerprint: A, user: "alice" } },
        { port: 7000, token: "tok", target: { host: "h", tlsFingerprint: A } },
      ])
    } finally {
      t.cleanup()
    }
  })

  test("a pinned host connects with its pin when no fingerprint is given", async () => {
    const t = setup()
    try {
      t.pins.pin("h", 7000, A)
      await t.session.connectDirect({ host: "h", port: 7000, tls: true }, "tok")
      assert.equal(t.engine.connections[0].target?.tlsFingerprint, A)
    } finally {
      t.cleanup()
    }
  })

  test("a typed fingerprint that differs from the pin is refused before the engine is touched", async () => {
    const t = setup()
    try {
      t.pins.pin("h", 7000, A)
      await assert.rejects(t.session.connectDirect({ host: "h", port: 7000, tls: true, fingerprint: B }, "tok"), /Forget pin/)
      assert.equal(t.engine.connections.length, 0)
      assert.equal(t.pins.get("h", 7000)?.fingerprint, A, "the pin is unchanged")
    } finally {
      t.cleanup()
    }
  })

  test("a certificate that isn't the pinned one fails naming both fingerprints and Forget pin, and pins nothing new", async () => {
    const t = setup()
    try {
      t.pins.pin("h", 7000, A)
      t.engine.fail = new FingerprintMismatchError(A, B)
      await assert.rejects(
        t.session.connectDirect({ host: "h", port: 7000, tls: true }, "tok"),
        (e: Error) => e.message.includes(A) && e.message.includes(B) && /Forget pin/.test(e.message) && !e.message.includes("tok")
      )
      assert.equal(t.pins.get("h", 7000)?.fingerprint, A)
      assert.equal(t.session.state.status, "failed")
      assert.equal(t.engine.closes > 0, true, "nothing is left open")
    } finally {
      t.cleanup()
    }
  })

  test("a failed connect doesn't pin the fingerprint, and the token isn't in the message", async () => {
    const t = setup()
    try {
      t.engine.fail = new Error("Hello was refused")
      await assert.rejects(
        t.session.connectDirect({ host: "h", port: 7000, tls: true, fingerprint: A }, "s3cret-token"),
        (e: Error) => /Hello was refused/.test(e.message) && !e.message.includes("s3cret-token")
      )
      assert.equal(t.pins.get("h", 7000), undefined)
    } finally {
      t.cleanup()
    }
  })

  test("plaintext is for loopback only, and carries no fingerprint", async () => {
    const t = setup()
    try {
      await assert.rejects(t.session.connectDirect({ host: "example.com", port: 7000, tls: false }, "tok"), /TLS is required/)
      assert.equal(t.engine.connections.length, 0)
      await t.session.connectDirect({ host: "localhost", port: 7000, tls: false }, "tok")
      assert.deepEqual(t.engine.connections, [{ port: 7000, token: "tok", target: { host: "localhost", tlsFingerprint: undefined } }])
      assert.equal(t.pins.get("localhost", 7000), undefined)
    } finally {
      t.cleanup()
    }
  })

  test("the token is checked before anything is stopped", async () => {
    const t = setup()
    try {
      await assert.rejects(t.session.connectDirect({ host: "h", port: 7000, tls: true, fingerprint: A }, ""), /access token/)
      await assert.rejects(t.session.connectDirect({ host: "h", port: 7000, tls: true, fingerprint: A }, 5), /access token/)
      assert.equal(t.engine.closes, 0)
    } finally {
      t.cleanup()
    }
  })
})
