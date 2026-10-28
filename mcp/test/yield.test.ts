// The Hello `yield` flag (protocol 1.22.0, engine PR #262): the bridge sends it by default and gives way to people. The
// fake host models the engine's arbiter rules (FakeHostOptions.arbiter); a "person" is a plain EngineClient that does not
// yield. Nothing here ran against a real N2EditorHost.
import { test, describe, after } from "node:test"
import * as assert from "node:assert/strict"
import { EngineClient } from "../../src/protocol/engine-client"
import { parseArgs } from "../src/cli"
import { connectConnector, tokensFileText } from "../src/host"
import { FakeHost, Silence } from "./fake-host"
import { TestToken, closeAllHarnesses, plainConnector, startHarness, textOf } from "./harness"

after(closeAllHarnesses)

/** A person's editor: a session of its own that does not yield, as the Electron editor's */
async function person(host: FakeHost, user = "alice"): Promise<EngineClient> {
  const client = new EngineClient()
  await client.connect("127.0.0.1", host.port, { token: TestToken, user, clientName: "N2Engine Electron editor" })
  return client
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))

describe("the bridge says yield", () => {
  test("Hello carries yield: true by default, and a --no-yield connector leaves it out", async () => {
    const h = await startHarness()
    assert.ok(!(await h.call("n2_status")).isError)
    assert.deepEqual(h.host.helloYields, [true])
    await h.close()

    const host = await new FakeHost({ token: TestToken }).start()
    const off = await startHarness({ existingHost: host, bridge: { connector: plainConnector(host, TestToken, "n2-mcp", false) } })
    assert.ok(!(await off.call("n2_status")).isError)
    assert.deepEqual(host.helloYields, [false])
    // Without the flag the payload is the one a 1.21 bridge sent: nothing after the user
    assert.equal(host.helloPayloadLengths[0] + 1, (await sizeWithYield(host)))
    await off.close()
    await host.stop()
  })

  test("the real connectors take the option (connectConnector reports it)", () => {
    const base = { host: "h", port: 1, fingerprint: "a".repeat(64), token: "t" }
    assert.equal(connectConnector(base).yields, true)
    assert.equal(connectConnector({ ...base, yield: false }).yields, false)
  })

  test("--no-yield is an option; the default is to yield", () => {
    const FP = "ab".repeat(32)
    const args = ["--connect", "h:1", "--fingerprint", FP, "--token-env", "T"]
    assert.equal(parseArgs(args, {}).mode === "connect" && (parseArgs(args, {}) as { yield: boolean }).yield, true)
    assert.equal((parseArgs([...args, "--no-yield"], {}) as { yield: boolean }).yield, false)
    assert.ok(tokensFileText("x").includes("editor"))
  })

  test("an older host (before 1.22.0) ignores the trailing byte and serves the bridge as before", async () => {
    const h = await startHarness({ host: { protocolVersion: "1.21.0", ignoresYield: true, arbiter: true } })
    const r = await h.call("n2_status")
    assert.ok(!r.isError, textOf(r))
    assert.deepEqual(h.host.helloYields, [false])
    await h.close()
  })
})

describe("the bridge yields to people", () => {
  test("an idle host serves the bridge (Accept, yielding too)", async () => {
    const h = await startHarness({ host: { arbiter: true } })
    assert.ok(!(await h.call("n2_status")).isError)
    assert.equal(h.host.busyAnswers, 0)
    await h.close()
  })

  test("a host serving a person is Busy, and the bridge says it yields to humans (no takeover, even for a higher role)", async () => {
    const waits: number[] = []
    const h = await startHarness({
      host: { arbiter: true, role: "viewer", roles: { alice: "viewer", "n2-mcp": "admin" } },
      bridge: { busyWaitMs: 100, sleep: async (ms) => void waits.push(ms), allowAdmin: true },
    })
    const human = await person(h.host)
    const r = await h.call("n2_status")
    assert.equal(r.isError, true)
    assert.equal(r._meta?.["n2/errorCode"], "busy")
    assert.match(textOf(r), /serving a human or another session/)
    assert.match(textOf(r), /a viewer session/)
    assert.match(textOf(r), /yields to humans/)
    assert.deepEqual(waits, [100])
    assert.equal(h.host.preemptions, 0)
    assert.equal(human.isConnected, true)
    human.close()
    await h.close()
  })

  test("the wait before a retry grows with each busy answer in a row and the bridge never forces", async () => {
    const waits: number[] = []
    const h = await startHarness({ host: { arbiter: true }, bridge: { busyWaitMs: 100, sleep: async (ms) => void waits.push(ms) } })
    const human = await person(h.host)
    for (let i = 0; i < 3; i++) assert.equal((await h.call("n2_status")).isError, true)
    assert.deepEqual(waits, [100, 400, 1600])
    assert.equal(human.isConnected, true)
    assert.equal(h.host.preemptions, 0)
    // The person leaves: the next call is served, and the streak starts over
    human.close()
    await settle()
    assert.ok(!(await h.call("n2_status")).isError)
    await h.close()
  })

  test("a person who arrives between two calls preempts the bridge; the next call says the host is taken and reconnects only when free", async () => {
    const h = await startHarness({ host: { arbiter: true } })
    assert.ok(!(await h.call("n2_status")).isError)
    const human = await person(h.host)
    await settle()
    assert.equal(h.host.preemptions, 1)
    const busy = await h.call("n2_status")
    assert.equal(busy.isError, true)
    assert.equal(busy._meta?.["n2/errorCode"], "busy")
    assert.match(textOf(busy), /yields to humans/)
    assert.match(textOf(busy), /ended the bridge's earlier session/)
    human.close()
    await settle()
    const again = await h.call("n2_status")
    assert.ok(!again.isError, textOf(again))
    await h.close()
  })

  test("a person who arrives in the middle of a call: the error says so plainly, not 'connection dropped'", async () => {
    const h = await startHarness({ host: { arbiter: true } })
    assert.ok(!(await h.call("n2_status")).isError)
    let human: EngineClient | null = null
    h.host.on("GetHierarchy", () => {
      // The person's editor connects while the call is in flight, and the host never answers it
      void person(h.host).then((c) => (human = c))
      return Silence
    })
    const r = await h.call("n2_get_hierarchy")
    assert.equal(r.isError, true)
    assert.equal(r._meta?.["n2/errorCode"], "busy")
    assert.match(textOf(r), /ended the bridge's session/)
    assert.match(textOf(r), /yields to people/)
    assert.ok(!/connection to the host dropped/.test(textOf(r)))
    await settle()
    ;(human as EngineClient | null)?.close()
    await h.close()
  })

  test("a bridge that does not yield (--no-yield) does what the host's usual rules say: it can preempt a lower role", async () => {
    const host = await new FakeHost({ token: TestToken, arbiter: true, roles: { alice: "viewer", "n2-mcp": "editor" } }).start()
    const human = await person(host)
    const h = await startHarness({ existingHost: host, bridge: { connector: plainConnector(host, TestToken, "n2-mcp", false) } })
    const r = await h.call("n2_status")
    assert.ok(!r.isError, textOf(r))
    assert.equal(host.preemptions, 1)
    assert.equal(human.isConnected, false)
    await h.close()
    await host.stop()
  })
})

/** The size Hello's payload has with the yield byte (the host recorded one without it) */
async function sizeWithYield(host: FakeHost): Promise<number> {
  // Send a yielding Hello of the same shape and read what the host recorded
  const client = new EngineClient()
  await client.connect("127.0.0.1", host.port, { token: TestToken, user: "n2-mcp", clientName: (await import("../src/host")).ClientName, yield: true })
  client.close()
  return host.helloPayloadLengths[host.helloPayloadLengths.length - 1]
}
