// n2build from the main process (build targets stage 3): finding n2build, checking what the page asks for, the argument
// array (never a shell string), reading --json events, and running a fake n2build as a real child process: a build that
// succeeds, one that fails, one that dies, a cancel that ends its children too, and list and doctor.
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ChildProcess, SpawnOptions } from "node:child_process"
import type { BuildUpdate, HostState } from "../shared/api"
import {
  MaxLogLineLength,
  N2BuildPathEnv,
  N2BuildRelative,
  N2BuildRunner,
  buildArguments,
  checkRequest,
  listTargets,
  locateN2Build,
  parseEvent,
} from "../main/n2build-runner"
import { NoProjectReason, RemoteBuildReason, UpdateBatcher, buildableProject } from "../main/build-ipc"

const tmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

describe("finding n2build", () => {
  const exists = (files: string[]) => (file: string) => files.includes(path.resolve(file))

  test("the setting wins, then N2BUILD_PATH, then the engine checkout above the host", () => {
    const engine = path.resolve("/eng")
    const script = path.join(engine, N2BuildRelative)
    const host = path.join(engine, "build", "editor-server", "Release", "N2EditorHost.exe")
    assert.deepEqual(locateN2Build({ setting: script, env: {}, hostPath: null, exists: exists([script]) }), { path: script, source: "setting", problem: null })
    assert.deepEqual(locateN2Build({ env: { [N2BuildPathEnv]: script }, hostPath: null, exists: exists([script]) }), { path: script, source: "env", problem: null })
    assert.deepEqual(locateN2Build({ env: {}, hostPath: host, exists: exists([script]) }), { path: script, source: "host", problem: null })
  })

  test("a set path that is not there says so; nothing found says how to set it", () => {
    const missing = locateN2Build({ setting: "/nowhere/n2build.mjs", env: {}, hostPath: null, exists: () => false })
    assert.match(missing.problem ?? "", /Not found/)
    const none = locateN2Build({ env: {}, hostPath: path.resolve("/a/b/host.exe"), exists: () => false })
    assert.equal(none.path, null)
    assert.match(none.problem ?? "", /n2buildPath.*N2BUILD_PATH/)
  })
})

describe("what the page may ask for", () => {
  test("a request is checked field by field", () => {
    assert.deepEqual(checkRequest({ target: "web", run: false }), { target: "web", run: false })
    assert.deepEqual(checkRequest({ target: "android", run: false, config: "debug", archive: "7z" }), { target: "android", run: false, config: "debug", archive: "7z" })
    for (const bad of [
      null,
      [],
      "web",
      { target: "Web", run: false },
      { target: "web; rm -rf /", run: false },
      { target: "--project", run: false },
      { target: "web", run: "yes" },
      { target: "web", run: false, config: "Release" },
      { target: "web", run: false, config: "-x" },
      { target: "web", run: false, archive: "rar" },
      { target: "web", run: true, archive: "zip" },
    ]) {
      assert.throws(() => checkRequest(bad), Error, JSON.stringify(bad))
    }
  })

  test("n2build's arguments are an array: a project path with spaces and quotes stays one argument", () => {
    const dir = 'C:\\My Games\\Tri "Like"'
    assert.deepEqual(buildArguments({ target: "windows", run: false }, dir), ["build", "--target", "windows", "--project", dir, "--json"])
    assert.deepEqual(buildArguments({ target: "web", run: true, config: "debug" }, dir), ["run", "--target", "web", "--project", dir, "--json", "--config", "debug"])
    assert.deepEqual(buildArguments({ target: "linux", run: false, archive: "zip" }, dir).slice(-2), ["--archive", "zip"])
  })

  test("builds need the project on this machine: a remote host or no project is refused with the reason", () => {
    const host = (over: Partial<HostState>): HostState => ({ status: "running", mode: "local", launch: 1, projectPath: "/p", message: null, ...over })
    assert.deepEqual(buildableProject(host({})), { projectDir: "/p" })
    assert.deepEqual(buildableProject(host({ mode: "remote", projectPath: "me@cloud:22" })), { reason: RemoteBuildReason })
    assert.deepEqual(buildableProject(host({ projectPath: null })), { reason: NoProjectReason })
  })
})

describe("n2build's --json events", () => {
  test("each kind is read and checked", () => {
    assert.deepEqual(parseEvent('{"type":"step","id":"compile","title":"Building n2player"}'), { type: "step", id: "compile", title: "Building n2player" })
    assert.deepEqual(parseEvent('{"type":"log","stream":"stderr","text":"warning C4100"}'), { type: "log", stream: "stderr", text: "warning C4100" })
    assert.deepEqual(parseEvent('{"type":"warning","text":"no Vulkan SDK"}'), { type: "warning", text: "no Vulkan SDK" })
    assert.deepEqual(parseEvent('{"type":"result","ok":true,"output":"/out/Tri","entry":"Tri.exe","extra":1}'), { type: "result", ok: true, output: "/out/Tri", entry: "Tri.exe" })
    const doctor = parseEvent(JSON.stringify({ type: "doctor", target: "web", displayName: "Web", ok: false, checks: [{ id: "emsdk", title: "emsdk", required: true, ok: false, version: null, detail: "not found", fix: "install it" }] }))
    assert.equal(doctor?.type, "doctor")
    const targets = parseEvent(JSON.stringify({ type: "targets", targets: [{ name: "web", displayName: "Web", hostSystems: ["win32"], buildableHere: true, source: "targets/" }, { name: "BAD" }] }))
    assert.deepEqual(targets, { type: "targets", targets: [{ name: "web", displayName: "Web", hostSystems: ["win32"], buildableHere: true, source: "targets/" }] })
  })

  test("anything else is not an event", () => {
    for (const line of ["", "plain text", "[1,2]", "null", '{"type":"step"}', '{"type":"log","stream":"x","text":"a"}', '{"type":"unknown"}', '{"type":"result","ok":"yes"}']) {
      assert.equal(parseEvent(line), null, line)
    }
  })

  test("a very long log line is cut", () => {
    const event = parseEvent(JSON.stringify({ type: "log", stream: "stdout", text: "x".repeat(MaxLogLineLength * 2) }))
    assert.equal(event?.type === "log" && event.text.length, MaxLogLineLength)
  })
})

/**
 * A fake n2build.mjs: prints the events its mode asks for (FAKE_MODE in its environment), the way the real one does, and
 * records its arguments next to itself
 */
function fakeN2Build(): { script: string; argsFile: string } {
  const dir = tmp("fake-n2build-")
  const script = path.join(dir, "n2build.mjs")
  const argsFile = path.join(dir, "args.json")
  fs.writeFileSync(
    script,
    `import fs from "node:fs";
import { spawn } from "node:child_process";
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ argv: process.argv.slice(2), electronAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null }));
const out = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
const mode = process.env.FAKE_MODE;
const cmd = process.argv[2];
if (cmd === "list") { out({ type: "targets", targets: [{ name: "linux", displayName: "Linux", hostSystems: ["linux"], buildableHere: true, source: "targets/" }] }); out({ type: "result", ok: true }); process.exit(0); }
if (cmd === "doctor") { out({ type: "doctor", target: process.argv[4], displayName: "Web", ok: false, checks: [{ id: "emsdk", title: "Emscripten", required: true, ok: false, version: null, detail: "not found", fix: "emsdk install 4.0.10" }] }); out({ type: "result", ok: false, error: "Not ready" }); process.exit(1); }
if (mode === "ok") {
  out({ type: "step", id: "configure", title: "Configuring" });
  process.stdout.write("not json at all\\n");
  process.stderr.write("a compiler warning\\r\\n");
  out({ type: "log", stream: "stdout", text: "[1/2] cc a.cpp" });
  out({ type: "step", id: "package", title: "Packaging" });
  out({ type: "result", ok: true, output: "/out/Game", entry: "Game.exe" });
} else if (mode === "fail") {
  out({ type: "step", id: "compile", title: "Building" });
  out({ type: "result", ok: false, error: "The linux build failed (exit code 2; see the log above)" });
  process.exit(1);
} else if (mode === "die") {
  process.stderr.write("TypeError: boom\\n");
  process.exit(3);
} else if (mode === "serve") {
  out({ type: "step", id: "serve", title: "Serving" });
  out({ type: "result", ok: true, output: "/out/web", url: "http://127.0.0.1:8080/", serving: true });
  setInterval(() => {}, 1000);
} else if (mode === "hang") {
  // A child of its own (the compiler), which Cancel must end too: it writes its pid, then waits
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(${JSON.stringify(path.join(dir, "grandchild.pid"))}, String(child.pid));
  out({ type: "step", id: "compile", title: "Building" });
  setInterval(() => {}, 1000);
}
`
  )
  return { script, argsFile }
}

/** A runner over the fake, its updates collected; resolves when a build ends */
function runner(mode: string) {
  const updates: BuildUpdate[] = []
  let ended: (() => void) | null = null
  const done = new Promise<void>((resolve) => (ended = resolve))
  const r = new N2BuildRunner({
    nodePath: process.execPath,
    env: { ...process.env, FAKE_MODE: mode },
    onUpdate: (u) => {
      updates.push(u)
      if (u.state.status !== "running" && u.state.status !== "idle") ended?.()
    },
    queryTimeoutMs: 20000,
  })
  return { r, updates, done, events: () => updates.flatMap((u) => u.events) }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("running n2build", () => {
  test("a build that succeeds: its steps, its log (stdout lines that are not events, stderr) and its result", async () => {
    const { script, argsFile } = fakeN2Build()
    const { r, done, events } = runner("ok")
    const started = r.start(script, { target: "linux", run: false }, "/projects/My Game")
    assert.equal(started.status, "running")
    assert.equal(started.id, 1)
    await done
    assert.equal(r.state.status, "succeeded")
    assert.equal(r.state.step?.id, "package")
    assert.deepEqual(r.state.result, { type: "result", ok: true, output: "/out/Game", entry: "Game.exe" })
    const logs = events().filter((e) => e.type === "log").map((e) => (e.type === "log" ? `${e.stream}:${e.text}` : ""))
    assert.ok(logs.includes("stdout:not json at all"), logs.join("\n"))
    assert.ok(logs.includes("stderr:a compiler warning"), "the \\r of a Windows line ending is dropped")
    assert.ok(logs.includes("stdout:[1/2] cc a.cpp"))
    const recorded = JSON.parse(fs.readFileSync(argsFile, "utf8"))
    assert.deepEqual(recorded.argv, ["build", "--target", "linux", "--project", "/projects/My Game", "--json"])
    assert.equal(recorded.electronAsNode, "1", "Electron's executable runs n2build as Node")
  })

  test("a build that fails keeps its error; one that dies without a result says how it ended", async () => {
    const { script } = fakeN2Build()
    const fail = runner("fail")
    fail.r.start(script, { target: "linux", run: false }, "/p")
    await fail.done
    assert.equal(fail.r.state.status, "failed")
    assert.match(fail.r.state.message ?? "", /build failed/)

    const die = runner("die")
    die.r.start(script, { target: "linux", run: false }, "/p")
    await die.done
    assert.equal(die.r.state.status, "failed")
    assert.equal(die.r.state.result, null)
    assert.match(die.r.state.message ?? "", /exited with code 3/)
    assert.ok(die.events().some((e) => e.type === "log" && e.text === "TypeError: boom"))
  })

  test("one build at a time; Cancel ends n2build and what it started", async () => {
    const { script } = fakeN2Build()
    const { r, done } = runner("hang")
    r.start(script, { target: "linux", run: false }, "/p")
    assert.throws(() => r.start(script, { target: "linux", run: false }, "/p"), /already running/)
    // Wait until the fake has started its own child
    const pidFile = path.join(path.dirname(script), "grandchild.pid")
    for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 25))
    const grandchild = Number(fs.readFileSync(pidFile, "utf8"))
    assert.ok(isAlive(grandchild))
    r.cancel()
    await done
    assert.equal(r.state.status, "cancelled")
    for (let i = 0; i < 200 && isAlive(grandchild); i++) await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(isAlive(grandchild), false, "the build's own child process was ended too")
    // A new build can start once it ended, with a higher id
    assert.equal(r.start(script, { target: "linux", run: false }, "/p").id, 2)
    r.cancel()
  })

  test("a web run's address is shown while it serves, and Cancel stops the server", async () => {
    const { script } = fakeN2Build()
    const { r, done, updates } = runner("serve")
    r.start(script, { target: "web", run: true }, "/p")
    for (let i = 0; i < 200 && !r.state.result; i++) await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(r.state.status, "running")
    assert.equal(r.state.result?.url, "http://127.0.0.1:8080/")
    assert.ok(updates.some((u) => u.state.result?.serving === true))
    r.cancel()
    await done
    assert.equal(r.state.status, "cancelled")
  })

  test("a refused request starts nothing", () => {
    let spawned = 0
    const r = new N2BuildRunner({
      spawn: (() => {
        spawned++
        throw new Error("no")
      }) as unknown as (c: string, a: readonly string[], o: SpawnOptions) => ChildProcess,
    })
    assert.throws(() => r.start("/n2build.mjs", { target: "web && calc", run: false }, "/p"))
    assert.equal(spawned, 0)
    assert.equal(r.state.status, "idle")
  })

  test("list and doctor read their events; a not-ready doctor report is an answer", async () => {
    const { script, argsFile } = fakeN2Build()
    const { r } = runner("")
    const list = await listTargets(r, { path: script, source: "setting", problem: null })
    assert.deepEqual(list.targets.map((t) => t.name), ["linux"])
    const report = await r.doctor(script, "web", "/projects/G")
    assert.equal(report.ok, false)
    assert.equal(report.checks[0].fix, "emsdk install 4.0.10")
    assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, "utf8")).argv, ["doctor", "--target", "web", "--project", "/projects/G", "--json"])
    await assert.rejects(() => r.doctor(script, "../x", "/p"), /lowercase name/)
    const none = await listTargets(r, { path: null, source: null, problem: "n2build was not found" })
    assert.deepEqual(none.targets, [])
  })
})

describe("updates to the page", () => {
  test("running updates are batched; a start or an end is sent at once with what came before it", async () => {
    const sent: BuildUpdate[] = []
    const batcher = new UpdateBatcher((u) => sent.push(u), 20)
    const state = (status: BuildUpdate["state"]["status"], id = 1) => ({ status, id, request: null, step: null, result: null, message: null })
    batcher.push({ state: state("running"), events: [] })
    assert.equal(sent.length, 1, "a build starting is sent at once")
    batcher.push({ state: state("running"), events: [{ type: "log", stream: "stdout", text: "a" }] })
    batcher.push({ state: state("running"), events: [{ type: "log", stream: "stdout", text: "b" }] })
    assert.equal(sent.length, 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(sent.length, 2)
    assert.deepEqual(sent[1].events.map((e) => (e.type === "log" ? e.text : "")), ["a", "b"])
    batcher.push({ state: state("running"), events: [{ type: "log", stream: "stdout", text: "c" }] })
    batcher.push({ state: state("succeeded"), events: [{ type: "result", ok: true }] })
    assert.equal(sent.length, 3)
    assert.equal(sent[2].state.status, "succeeded")
    assert.deepEqual(sent[2].events.map((e) => e.type), ["log", "result"])
  })
})
