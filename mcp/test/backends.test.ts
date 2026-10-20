// The two backends. --connect: TLS with the REQUIRED pinned fingerprint, against a fake host over TLS (the repo's test-only
// identities). --launch: the bridge's own host, with a fake child process standing in for N2EditorHost (a real host
// needs the engine, which CI does not have: see the README's "not verified" list).
import { test, describe, after } from "node:test"
import * as assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"
import { TestIdentityA, TestIdentityB } from "../../src/test/test-tls-identity"
import { TokenEnvVariable, type SpawnFunction } from "../../src/main/host-launcher"
import { connectConnector, launchConnector, tokensFileText, LaunchUser } from "../src/host"
import { Scrubber } from "../src/scrub"
import { FakeHost } from "./fake-host"
import { TestToken, closeAllHarnesses, everything, startHarness, textOf } from "./harness"

after(closeAllHarnesses)

describe("--connect: TLS with a pinned fingerprint", () => {
  test("the right fingerprint connects, and the token goes in Hello only", async () => {
    const host = await new FakeHost({ token: TestToken, tls: TestIdentityA }).start()
    const h = await startHarness({
      existingHost: host,
      bridge: { connector: connectConnector({ host: "127.0.0.1", port: host.port, fingerprint: TestIdentityA.fingerprint, token: TestToken, user: "agent-claude" }) },
    })
    const r = await h.call("n2_status")
    assert.ok(!r.isError, textOf(r))
    assert.equal(r.structuredContent.data.bridge.backend, "connect")
    assert.deepEqual(host.helloUsers, ["agent-claude"])
    assert.deepEqual([...new Set(host.helloTokens)], [TestToken])
    assert.ok(!JSON.stringify(host.received).includes(TestToken))
    assert.ok(!everything(r).includes(TestToken))
    await h.close()
    await host.stop()
  })

  test("another certificate is fingerprint_mismatch, and no Hello (so no token) is ever sent to it", async () => {
    const host = await new FakeHost({ token: TestToken, tls: TestIdentityB }).start()
    const h = await startHarness({
      existingHost: host,
      bridge: { connector: connectConnector({ host: "127.0.0.1", port: host.port, fingerprint: TestIdentityA.fingerprint, token: TestToken }) },
    })
    const r = await h.call("n2_status")
    assert.equal(r.isError, true)
    assert.equal(r._meta?.["n2/errorCode"], "fingerprint_mismatch")
    assert.deepEqual(host.helloTokens, [], "the host never saw a Hello")
    assert.ok(!everything(r).includes(TestIdentityB.fingerprint), "the host's actual fingerprint is not echoed")
    await h.close()
    await host.stop()
  })

  test("plaintext to a host that is not this computer's loopback is refused before any socket is opened", async () => {
    const connector = connectConnector({ host: "203.0.113.7", port: 9999, fingerprint: "not-a-fingerprint", token: TestToken })
    await assert.rejects(connector.connect(), /fingerprint/)
    // The EngineClient's own rule, for the case that a fingerprint were missing
    const { EngineClient } = await import("../../src/protocol/engine-client")
    await assert.rejects(new EngineClient().connect("203.0.113.7", 9999, { token: TestToken }), /Refusing a plaintext connection/)
  })

  test("a host that is not listening is host_unavailable, with no address in the message", async () => {
    const host = await new FakeHost({ tls: TestIdentityA }).start()
    const port = host.port
    await host.stop()
    const h = await startHarness({
      existingHost: host,
      bridge: { connector: connectConnector({ host: "127.0.0.1", port, fingerprint: TestIdentityA.fingerprint, token: TestToken }) },
    })
    const r = await h.call("n2_status")
    assert.equal(r._meta?.["n2/errorCode"], "host_unavailable")
    assert.ok(!textOf(r).includes(String(port)))
    await h.close()
  })
})

/** A child process whose output and exit the test controls (see src/test/host-launcher.test.ts) */
class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = 4243
  killed = false
  private closed = false

  kill(): boolean {
    this.killed = true
    setImmediate(() => this.exit(null, "SIGTERM"))
    return true
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return
    this.closed = true
    this.stdout.end()
    this.stderr.end()
    this.emit("exit", code, signal)
    setImmediate(() => this.emit("close", code, signal))
  }
}

describe("--launch: the bridge's own host", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "n2-mcp-test-"))
  after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

  function fakeSpawn(host: FakeHost | null, onSpawn?: (child: FakeChild) => void) {
    const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv; file: string | null; fileMode: number | null; child: FakeChild }> = []
    const spawn: SpawnFunction = (command, args, options) => {
      const child = new FakeChild()
      const at = args.indexOf("--tokens-file")
      const file = at >= 0 ? args[at + 1] : null
      calls.push({
        command,
        args,
        env: options.env ?? {},
        file: file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null,
        fileMode: file && fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : null,
        child,
      })
      if (onSpawn) onSpawn(child)
      else if (host) setImmediate(() => child.stdout.write(`N2EditorHost ready port=${host.port}\r\n`))
      return child as unknown as ChildProcess
    }
    return { calls, spawn }
  }

  const tempDirs = (): string[] => fs.readdirSync(tempRoot).filter((n) => n.startsWith("n2-mcp-"))

  test("starts N2EditorHost with a tokens file for ONE editor user, and no token anywhere else", async () => {
    const host = await new FakeHost({ role: "editor" }).start()
    const { calls, spawn } = fakeSpawn(host)
    const scrubber = new Scrubber()
    const connector = launchConnector({ hostPath: "C:\\host\\N2EditorHost.exe", projectPath: "C:\\proj", renderer: "software", scrubber, spawn, tempRoot })
    const h = await startHarness({ existingHost: host, bridge: { connector, scrubber } })
    const r = await h.call("n2_status")
    assert.ok(!r.isError, textOf(r))
    assert.equal(calls.length, 1)
    const call = calls[0]
    assert.equal(call.command, "C:\\host\\N2EditorHost.exe")
    assert.deepEqual(call.args.slice(0, 5), ["--project", "C:\\proj", "--renderer", "software", "--port"])
    assert.ok(call.args.includes("--tokens-file"))
    assert.ok(!call.args.includes("--token-env"), "no single admin token")
    assert.ok(!call.args.includes("--exit-on-disconnect"), "the host outlives an idle disconnect")
    assert.ok(call.args.includes("--exit-on-stdin-eof"), "and ends when the bridge's pipe closes")
    // The file holds the hash of the token Hello carried, for the editor user
    const token = host.helloTokens[0]
    assert.equal(token.length, 64)
    const entries = JSON.parse(call.file!) as Array<{ user: string; role: string; hash: string }>
    assert.deepEqual(entries, [{ user: LaunchUser, role: "editor", hash: `sha256:${createHash("sha256").update(token).digest("hex")}` }])
    assert.equal(call.file, tokensFileText(token))
    assert.deepEqual(host.helloUsers, [LaunchUser])
    // The token is not in the arguments or the child's environment, and the env variable of --token-env is not set
    assert.ok(!JSON.stringify(call.args).includes(token))
    assert.ok(!JSON.stringify(call.env).includes(token))
    assert.equal(call.env[TokenEnvVariable], undefined)
    if (process.platform !== "win32") assert.equal(call.fileMode, 0o600)
    assert.ok(!everything(r).includes(token))
    assert.ok(!h.logs.join("\n").includes(token))
    await h.close()
    await host.stop()
  })

  test("dispose ends the host, removes the token file, and is safe twice", async () => {
    const host = await new FakeHost().start()
    const { calls, spawn } = fakeSpawn(host)
    const connector = launchConnector({ hostPath: "host", projectPath: "proj", scrubber: new Scrubber(), spawn, tempRoot })
    await connector.connect()
    assert.equal(tempDirs().length, 1)
    connector.dispose()
    assert.equal(calls[0].child.killed, true)
    assert.equal(tempDirs().length, 0, "the tokens file's folder is gone")
    connector.dispose()
    await host.stop()
  })

  test("the bridge's dispose (stdio closed, signal, exit) is what ends the host", async () => {
    const host = await new FakeHost().start()
    const { calls, spawn } = fakeSpawn(host)
    const scrubber = new Scrubber()
    const h = await startHarness({ existingHost: host, bridge: { scrubber, connector: launchConnector({ hostPath: "host", projectPath: "proj", scrubber, spawn, tempRoot }) } })
    await h.call("n2_status")
    h.bridge.dispose()
    assert.equal(calls[0].child.killed, true)
    assert.equal(tempDirs().length, 0)
    await h.close()
    await host.stop()
  })

  test("a host that dies is started again by the next call, with a new token and a new file", async () => {
    const host = await new FakeHost().start()
    const { calls, spawn } = fakeSpawn(host)
    const scrubber = new Scrubber()
    const h = await startHarness({ existingHost: host, bridge: { scrubber, connector: launchConnector({ hostPath: "host", projectPath: "proj", scrubber, spawn, tempRoot }) } })
    assert.ok(!(await h.call("n2_status")).isError)
    calls[0].child.exit(1)
    host.dropConnections()
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(!(await h.call("n2_status")).isError)
    assert.equal(calls.length, 2)
    assert.notEqual(host.helloTokens[0], host.helloTokens[1])
    assert.equal(tempDirs().length, 1, "only the new file is left")
    await h.close()
    assert.equal(tempDirs().length, 0)
    await host.stop()
  })

  test("a host that fails to start is host_unavailable, with its own words scrubbed and the token file removed", async () => {
    const { spawn } = fakeSpawn(null, (child) => {
      setImmediate(() => {
        child.stderr.write("N2EditorHost: cannot open C:\\secret\\proj\\project.n2proj\n")
        child.exit(1)
      })
    })
    const scrubber = new Scrubber()
    const h = await startHarness({ bridge: { scrubber, connector: launchConnector({ hostPath: "host", projectPath: "proj", scrubber, spawn, tempRoot }) } })
    const r = await h.call("n2_status")
    assert.equal(r.isError, true)
    assert.equal(r._meta?.["n2/errorCode"], "host_unavailable")
    assert.match(textOf(r), /could not start N2EditorHost/)
    assert.ok(!everything(r).includes("C:\\\\secret"))
    assert.equal(tempDirs().length, 0)
    await h.close()
  })

  test("a host that was started is not asked again to start while it is starting (two calls, one process)", async () => {
    const host = await new FakeHost().start()
    const { calls, spawn } = fakeSpawn(host)
    const connector = launchConnector({ hostPath: "host", projectPath: "proj", scrubber: new Scrubber(), spawn, tempRoot })
    await Promise.all([connector.connect(), connector.connect()])
    assert.equal(calls.length, 1)
    connector.dispose()
    await host.stop()
  })
})
