// The play tools (MCP3): only a --launch bridge has them; start and stop go through src/main/play-session.ts (a snapshot
// on the edit host, a fake child process, a second fake host as the game); control, input, observe and play_script with
// progress notifications, cancellation between ops, budgets and error mapping.
import { test, describe, after } from "node:test"
import * as assert from "node:assert/strict"
import Ajv2020 from "ajv/dist/2020"
import { PlayTools } from "../src/play"
import { ReadTools } from "../src/tools"
import { WriteTools } from "../src/tools-write"
import * as limits from "../src/limits"
import { TokenEnvVariable } from "../../src/main/host-launcher"
import { FakeHost, Refusal } from "./fake-host"
import { TestToken, closeAllHarnesses, everything, plainConnector, startHarness, textOf } from "./harness"
import { SnapshotFile, installSnapshot, startPlayHarness, type PlayHarness } from "./play-host"

after(closeAllHarnesses)

const playNames = PlayTools.map((t) => t.name)
const code = (r: { _meta?: Record<string, unknown> }): unknown => r._meta?.["n2/errorCode"]
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await wait(5)
  }
}

async function started(h: PlayHarness): Promise<void> {
  const r = await h.call("n2_play_start")
  assert.ok(!r.isError, textOf(r))
  assert.equal(r.structuredContent.data.play.status, "playing")
}

describe("play tools exist only with --launch", () => {
  test("a --connect bridge lists no play tool, even when given play options, and a call to one is an unknown tool", async () => {
    const host = await new FakeHost({ token: TestToken }).start()
    installSnapshot(host)
    const h = await startHarness({
      existingHost: host,
      bridge: { connector: plainConnector(host), play: { hostPath: "N2EditorHost", projectPath: "proj" } },
    })
    const { tools } = await h.client.listTools()
    assert.deepEqual(tools.map((t) => t.name), [...ReadTools, ...WriteTools].map((t) => t.name))
    assert.ok(tools.every((t) => !t.name.startsWith("n2_play_")))
    assert.equal(h.bridge.play, null)
    let outcome: unknown
    try {
      outcome = await h.client.callTool({ name: "n2_play_start", arguments: {} })
    } catch (e) {
      outcome = e
    }
    assert.ok(outcome instanceof Error || (outcome as { isError?: boolean }).isError === true)
    assert.equal(host.count("WritePlaySnapshot"), 0, "nothing was played")
    assert.doesNotMatch(h.client.getInstructions() ?? "", /n2_play_start/)
    const prompts = await h.client.listPrompts()
    assert.ok(!prompts.prompts.some((p) => p.name === "n2_playtest"), "no playtest prompt without the play tools")
    await h.close()
    await host.stop()
  })

  test("a --launch bridge with an editor token lists the play tools after the write tools, and the playtest prompt", async () => {
    const h = await startPlayHarness()
    const { tools } = await h.client.listTools()
    assert.deepEqual(tools.map((t) => t.name), [...ReadTools, ...WriteTools, ...PlayTools].map((t) => t.name))
    assert.match(h.client.getInstructions() ?? "", /n2_play_start/)
    const prompts = await h.client.listPrompts()
    assert.ok(prompts.prompts.some((p) => p.name === "n2_playtest"))
    await h.close()
  })

  test("a viewer token gets no play tool (a viewer may not play), and the operator's flags hide them", async () => {
    const viewer = await startPlayHarness({ host: { role: "viewer" } })
    const listed = (await viewer.client.listTools()).tools.map((t) => t.name)
    assert.ok(listed.every((n) => !playNames.includes(n)))
    assert.ok(listed.includes("n2_status"))
    await viewer.close()
    const flagged = await startPlayHarness({ bridge: { policy: { readOnly: false, allowIrreversible: false, maxWrites: 2000, writeTools: null, disabledTools: new Set(["n2_play_script"]), keepJournal: false } } })
    const names = (await flagged.client.listTools()).tools.map((t) => t.name)
    assert.ok(names.includes("n2_play_start") && !names.includes("n2_play_script"))
    await flagged.close()
  })
})

describe("start and stop through play-session.ts", () => {
  test("start writes a snapshot of the open scene, starts N2EditorHost --play with a token in its environment only, and connects", async () => {
    const h = await startPlayHarness()
    const r = await h.call("n2_play_start")
    assert.ok(!r.isError, textOf(r))
    assert.equal(r.structuredContent.data.play.status, "playing")
    assert.equal(r.structuredContent.data.play.launch, 1)
    assert.equal(h.host.count("WritePlaySnapshot"), 1)
    assert.equal(h.spawned.length, 1)
    const { args, env } = h.spawned[0]
    assert.equal(args[args.indexOf("--play") + 1], SnapshotFile)
    assert.equal(args[args.indexOf("--renderer") + 1], "software")
    assert.ok(args.includes("--exit-on-disconnect") && args.includes("--exit-on-stdin-eof"))
    const token = env[TokenEnvVariable]
    assert.ok(typeof token === "string" && token.length === 64)
    assert.ok(!JSON.stringify(args).includes(token!), "the game's token is not an argument")
    assert.ok(!everything(r).includes(token!) && !everything(r).includes("Main-1a2b"), "neither the token nor the snapshot path reach the model")
    assert.ok(h.game.helloTokens.includes(token!))
    // A second start answers the running game
    const again = await h.call("n2_play_start")
    assert.ok(!again.isError)
    assert.equal(h.spawned.length, 1)
    assert.match(textOf(again), /already running/)
    const stop = await h.call("n2_play_stop")
    assert.ok(!stop.isError, textOf(stop))
    assert.equal(stop.structuredContent.data.play.status, "stopped")
    await until("the game to end", () => h.spawned[0].child.killed || h.game.open === 0)
    const none = await h.call("n2_play_stop")
    assert.match(textOf(none), /No game was running/)
    await h.close()
  })

  test("a game that can't start is play_failed with its own words scrubbed, and no game is left", async () => {
    const h = await startPlayHarness({
      onSpawn: (child) =>
        setImmediate(() => {
          child.stderr.write("N2EditorHost --play: cannot load C:\\Users\\agent\\Games\\Demo\\.n2\\play\\Main-1a2b.scene\n")
          child.exit(1)
        }),
    })
    const r = await h.call("n2_play_start")
    assert.equal(r.isError, true)
    assert.equal(code(r), "play_failed")
    assert.match(textOf(r), /cannot load/)
    assert.ok(!textOf(r).includes("C:\\\\Users") && !textOf(r).includes("C:\\Users"), textOf(r))
    const o = await h.call("n2_play_observe")
    assert.ok(!o.isError)
    assert.equal(o.structuredContent.data.play.status, "failed")
    await h.close()
  })

  test("without a game, control, input and a picture are play_not_running", async () => {
    const h = await startPlayHarness()
    for (const [name, args] of [
      ["n2_play_control", { action: "pause" }],
      ["n2_play_input", { events: [{ type: "releaseAll" }] }],
      ["n2_play_script", { ops: [{ step: { frames: 1 } }] }],
      ["n2_play_observe", { screenshot: true }],
    ] as const) {
      const r = await h.call(name, args)
      assert.equal(r.isError, true, name)
      assert.equal(code(r), "play_not_running", name)
    }
    const o = await h.call("n2_play_observe")
    assert.equal(o.structuredContent.data.play.status, "stopped")
    await h.close()
  })

  test("a game that quits by itself is exited, and the bridge's dispose kills a running game", async () => {
    const h = await startPlayHarness()
    await started(h)
    h.spawned[0].child.exit(0)
    await until("the exit to be seen", () => h.bridge.play!.view().status === "exited")
    const o = await h.call("n2_play_observe")
    assert.equal(o.structuredContent.data.play.status, "exited")
    assert.equal(code(await h.call("n2_play_control", { action: "pause" })), "play_not_running")
    await started(h)
    assert.equal(h.spawned.length, 2)
    h.bridge.dispose()
    assert.equal(h.spawned[1].child.killed, true)
    await h.close()
  })
})

describe("control, input and observe", () => {
  test("pause, then step in chunks with progress notifications; resume", async () => {
    const h = await startPlayHarness()
    await started(h)
    const paused = await h.call("n2_play_control", { action: "pause" })
    assert.equal(paused.structuredContent.data.play.status, "paused")
    const progress: Array<{ progress: number; total?: number }> = []
    const r = (await h.client.callTool({ name: "n2_play_control", arguments: { action: "step", frames: 250 } }, { onprogress: (p) => progress.push(p) })) as any
    assert.ok(!r.isError, textOf(r))
    assert.deepEqual(h.state.steps, [100, 100, 50])
    assert.equal(r.structuredContent.data.framesStepped, 250)
    assert.equal(r.structuredContent.data.play.frame, 250)
    assert.equal(r.structuredContent.data.play.status, "paused")
    assert.deepEqual(progress.map((p) => p.progress), [100, 200, 250])
    assert.ok(progress.every((p) => p.total === 250))
    const resumed = await h.call("n2_play_control", { action: "resume" })
    assert.equal(resumed.structuredContent.data.play.status, "playing")
    await h.close()
  })

  test("a step of a running game, too many frames, or frames with pause are refused before anything runs", async () => {
    const h = await startPlayHarness()
    await started(h)
    const running = await h.call("n2_play_control", { action: "step", frames: 5 })
    assert.equal(code(running), "invalid_argument")
    assert.match(textOf(running), /paused/)
    const big = await h.call("n2_play_control", { action: "step", frames: limits.MaxStepFramesPerCall + 1 })
    assert.equal(big.isError, true)
    const mixed = await h.call("n2_play_control", { action: "pause", frames: 3 })
    assert.equal(code(mixed), "invalid_argument")
    assert.deepEqual(h.state.steps, [])
    await h.close()
  })

  test("input goes to the game whole; a bad event is refused by the schema, and the host's refusal is a host_error", async () => {
    const h = await startPlayHarness()
    await started(h)
    const events = [
      { type: "key", key: "W", down: true },
      { type: "mouseButton", button: "Left", down: true },
      { type: "pointer", x: 10, y: 20 },
      { type: "scroll", x: 0, y: -1 },
      { type: "releaseAll" },
    ]
    const r = await h.call("n2_play_input", { events })
    assert.ok(!r.isError, textOf(r))
    assert.deepEqual(h.state.inputs, [events])
    const bad = await h.call("n2_play_input", { events: [{ type: "key", key: "W; rm -rf", down: true }] })
    assert.equal(bad.isError, true)
    const extra = await h.call("n2_play_input", { events: [{ type: "releaseAll", sneaky: 1 }] })
    assert.equal(extra.isError, true)
    const refused = await h.call("n2_play_input", { events: [{ type: "key", key: "NoSuchKey", down: true }] })
    assert.equal(code(refused), "host_error")
    assert.equal(h.state.inputs.length, 1)
    await h.close()
  })

  test("observe: state, the game's log since the last observe (scrubbed, audit lines dropped), live entities as data, a picture", async () => {
    const h = await startPlayHarness()
    await started(h)
    h.game.addLogEvents(["info", "spawned at C:\\Users\\agent\\Games\\Demo\\assets\\x.lua"], ["error", "audit: Hello user=bob peer=10.0.0.1:5"], ["warn", "low fps \u202e peer=10.0.0.2:9"])
    const r = await h.call("n2_play_observe", { entityIds: ["11111111-0000-0000-0000-000000000002", "11111111-0000-0000-0000-00000000dead"], screenshot: true, width: 64, height: 36 })
    assert.ok(!r.isError, textOf(r))
    const d = r.structuredContent.data
    assert.equal(d.play.status, "playing")
    assert.deepEqual(d.log.lines.map((l: { level: string }) => l.level), ["info", "warn"])
    assert.ok(!JSON.stringify(d.log).includes("C:\\\\Users"), "host paths are removed")
    assert.ok(!JSON.stringify(d.log).includes("peer="))
    assert.ok(JSON.stringify(d.log).includes("\\\\u{202e}"), "bidi characters are shown as escapes")
    assert.equal(d.entities[0].found, true)
    assert.equal(d.entities[0].name, "Player")
    assert.deepEqual(d.entities[0].worldTransform.position, { x: 1, y: 2, z: 3 })
    assert.equal(d.entities[1].found, false)
    assert.ok(JSON.stringify(d.entities[0].components).includes("\\\\u{202e}"))
    assert.equal(r.structuredContent.untrusted, true)
    assert.match(textOf(r), /<n2-data source="game" untrusted>/)
    const image = r.content.find((c) => c.type === "image")
    assert.equal(image?.mimeType, "image/png")
    assert.deepEqual(d.picture, { width: 64, height: 36, pngBytes: Buffer.from(image!.data!, "base64").length, scaledDown: false })
    // The next observe has only what is new
    const next = await h.call("n2_play_observe", { logLines: 10 })
    assert.deepEqual(next.structuredContent.data.log.lines, [])
    await h.close()
  })

  test("every play result validates against its tool's outputSchema", async () => {
    const h = await startPlayHarness()
    const ajv = new Ajv2020({ strict: false, validateFormats: false })
    const { tools } = await h.client.listTools()
    const calls: Array<[string, Record<string, unknown>]> = [
      ["n2_play_start", {}],
      ["n2_play_control", { action: "pause" }],
      ["n2_play_input", { events: [{ type: "releaseAll" }] }],
      ["n2_play_observe", { screenshot: true, width: 32, height: 32, entityIds: ["11111111-0000-0000-0000-000000000002"] }],
      ["n2_play_script", { ops: [{ step: { frames: 2 } }, { screenshot: { width: 32, height: 32 } }, { expectLog: { contains: "x", absent: true } }] }],
      ["n2_play_stop", {}],
    ]
    assert.equal(calls.length, PlayTools.length, "every play tool is exercised")
    for (const [name, args] of calls) {
      const r = await h.call(name, args)
      assert.ok(!r.isError, `${name}: ${textOf(r)}`)
      const validate = ajv.compile(tools.find((t) => t.name === name)!.outputSchema as object)
      assert.ok(validate(r.structuredContent), `${name}: ${JSON.stringify((validate as unknown as { errors?: unknown }).errors)}`)
    }
    await h.close()
  })
})

describe("n2_play_script", () => {
  test("runs ops in order on a paused game, with a progress notification per op, pictures in op order and log checks", async () => {
    const h = await startPlayHarness()
    await started(h)
    h.game.on("Step", (r) => {
      if (!h.state.paused) throw new Error("not paused")
      h.state.steps.push(r.frames)
      h.state.frame += r.frames
      if (h.state.frame >= 30) h.game.addLogEvents(["info", "Player reached the door"])
    })
    const progress: Array<{ progress: number; total?: number; message?: string }> = []
    const r = (await h.client.callTool(
      {
        name: "n2_play_script",
        arguments: {
          ops: [
            { screenshot: { width: 48, height: 32 } },
            { input: { events: [{ type: "key", key: "D", down: true }] } },
            { step: { frames: 30 } },
            { input: { events: [{ type: "key", key: "D", down: false }] } },
            { expectLog: { contains: "reached the DOOR" } },
            { expectLog: { contains: "error", level: "error", absent: true } },
            { screenshot: {} },
          ],
        },
      },
      { onprogress: (p) => progress.push(p) }
    )) as any
    assert.ok(!r.isError, textOf(r))
    const d = r.structuredContent.data
    assert.equal(d.completed, true)
    assert.equal(d.passed, true)
    assert.deepEqual(d.results.map((x: { kind: string; ok: boolean }) => `${x.kind}:${x.ok}`), ["screenshot:true", "input:true", "step:true", "input:true", "expectLog:true", "expectLog:true", "screenshot:true"])
    assert.equal(d.play.status, "paused", "the script pauses the game and leaves it paused")
    assert.equal(d.play.frame, 30)
    assert.deepEqual(progress.map((p) => p.progress), [1, 2, 3, 4, 5, 6, 7])
    assert.ok(progress.every((p) => p.total === 7 && !/door/i.test(p.message ?? "")), "progress carries no project text")
    const images = r.content.filter((c: { type: string }) => c.type === "image")
    assert.equal(images.length, 2)
    assert.deepEqual(d.pictures.map((p: { op: number }) => p.op), [0, 6])
    assert.equal(d.pictures[0].width, 48)
    assert.ok(d.log.some((l: { message: string }) => l.message.includes("reached the door")))
    await h.close()
  })

  test("a failed expectLog stops the script (or not, with continueOnFailure)", async () => {
    const h = await startPlayHarness()
    await started(h)
    const r = await h.call("n2_play_script", { ops: [{ expectLog: { contains: "never logged" } }, { step: { frames: 5 } }] })
    assert.ok(!r.isError, textOf(r))
    assert.equal(r.structuredContent.data.passed, false)
    assert.equal(r.structuredContent.data.completed, false)
    assert.equal(r.structuredContent.data.results.length, 1)
    assert.deepEqual(h.state.steps, [])
    const go = await h.call("n2_play_script", { ops: [{ expectLog: { contains: "never logged" } }, { step: { frames: 5 } }], continueOnFailure: true })
    assert.equal(go.structuredContent.data.results.length, 2)
    assert.deepEqual(h.state.steps, [5])
    await h.close()
  })

  test("cancellation between ops: the script stops, releases every key and button, and leaves the game paused and usable", async () => {
    const h = await startPlayHarness()
    await started(h)
    const controller = new AbortController()
    const call = h.client.callTool(
      {
        name: "n2_play_script",
        arguments: {
          ops: [
            { input: { events: [{ type: "key", key: "Space", down: true }] } },
            { step: { frames: 10 } },
            { step: { frames: 10 } },
            { step: { frames: 10 } },
            { step: { frames: 10 } },
          ],
        },
      },
      {
        signal: controller.signal,
        onprogress: (p) => {
          if (p.progress === 1) controller.abort()
        },
      }
    )
    await assert.rejects(call)
    await until("the release", () => h.state.inputs.some((batch) => JSON.stringify(batch) === JSON.stringify([{ type: "releaseAll" }])))
    assert.ok(h.state.steps.length < 4, `the script stopped early (${h.state.steps.length} steps ran)`)
    assert.equal(h.state.paused, true)
    // The game is still there and answers the next call
    const o = await h.call("n2_play_observe", { logLines: 0 })
    assert.ok(!o.isError, textOf(o))
    assert.equal(o.structuredContent.data.play.status, "paused")
    assert.ok(!(await h.call("n2_play_control", { action: "step", frames: 1 })).isError)
    await h.close()
  })

  test("a step that fails midway releases the input too, and the error is the host's, mapped", async () => {
    const h = await startPlayHarness()
    await started(h)
    h.game.on("Step", () => {
      throw new Refusal("Lua error in C:\\Users\\agent\\Games\\Demo\\assets\\door.lua:3")
    })
    const r = await h.call("n2_play_script", { ops: [{ input: { events: [{ type: "key", key: "W", down: true }] } }, { step: { frames: 3 } }] })
    assert.equal(code(r), "host_error")
    assert.ok(!textOf(r).includes("C:\\\\Users"))
    await until("the release", () => h.state.inputs.some((batch) => JSON.stringify(batch) === JSON.stringify([{ type: "releaseAll" }])))
    await h.close()
  })

  test("budgets: frames and pictures per script are checked before the game is touched, and per session across calls", async () => {
    const h = await startPlayHarness()
    await started(h)
    const tooMany = await h.call("n2_play_script", { ops: Array.from({ length: 6 }, () => ({ step: { frames: limits.MaxStepFramesPerCall } })) })
    assert.equal(code(tooMany), "invalid_argument")
    const pictures = await h.call("n2_play_script", { ops: Array.from({ length: limits.MaxScriptScreenshots + 1 }, () => ({ screenshot: { width: 16, height: 16 } })) })
    assert.equal(code(pictures), "invalid_argument")
    const longScript = await h.call("n2_play_script", { ops: Array.from({ length: limits.MaxScriptOps + 1 }, () => ({ step: { frames: 1 } })) })
    assert.equal(longScript.isError, true)
    assert.deepEqual(h.state.steps, [], "nothing ran")
    // 20000 frames per session: six scripts of 3000 pass, the seventh is refused whole
    const full = Array.from({ length: 5 }, () => ({ step: { frames: limits.MaxStepFramesPerCall } }))
    for (let i = 0; i < Math.floor(limits.MaxPlayFramesPerSession / limits.MaxScriptFrames); i++) {
      const ok = await h.call("n2_play_script", { ops: full })
      assert.ok(!ok.isError, textOf(ok))
    }
    const before = h.state.steps.length
    const over = await h.call("n2_play_script", { ops: full })
    assert.equal(code(over), "budget_exceeded")
    assert.equal(h.state.steps.length, before)
    // A new agent session has a budget of its own
    const begun = await h.call("n2_begin_session", { label: "second" })
    const again = await h.call("n2_play_script", { ops: full, sessionId: begun.structuredContent.data.sessionId })
    assert.ok(!again.isError, textOf(again))
    await h.close()
  })
})
