import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ChildProcess, SpawnOptions, spawn } from "node:child_process"
import {
  CreateNeedsEngine,
  HostExit,
  HostProcess,
  LineSplitter,
  ReadyLinePrefix,
  SpawnFunction,
  TokenEnvVariable,
  buildChildEnv,
  buildHostArgs,
  createProjectWithHost,
  generateToken,
  parseReadyLine,
} from "../main/host-launcher"

/** A child process whose output, exit and kill the test controls */
class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = 4242
  killed = false

  kill(): boolean {
    this.killed = true
    setImmediate(() => this.exit(null, "SIGTERM"))
    return true
  }

  /** Ends the streams, then reports the exit as Node does ("exit", then "close") */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return
    this.closed = true
    this.stdout.end()
    this.stderr.end()
    this.emit("exit", code, signal)
    setImmediate(() => this.emit("close", code, signal))
  }
  private closed = false
}

/** A spawn that records its calls and hands out FakeChilds */
function fakeSpawn() {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions; child: FakeChild }> = []
  const spawnFn: SpawnFunction = (command, args, options) => {
    const child = new FakeChild()
    calls.push({ command, args, options, child })
    return child as unknown as ChildProcess
  }
  return { calls, spawn: spawnFn }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe("parseReadyLine", () => {
  test("reads the port of a ready line, with or without the \\r of a Windows line ending", () => {
    assert.equal(parseReadyLine("N2EditorHost ready port=51234"), 51234)
    assert.equal(parseReadyLine("N2EditorHost ready port=51234\r"), 51234)
  })

  test("ignores fields it doesn't know, wherever the port is", () => {
    assert.equal(parseReadyLine("N2EditorHost ready protocol=1.2.0 port=9999 renderer=software"), 9999)
    assert.equal(parseReadyLine("N2EditorHost ready port=9999 protocol=1.2.0\r"), 9999)
  })

  test("anything else is not a ready line", () => {
    for (const line of [
      "",
      "[INFO] Engine initialized",
      "[INFO] N2EditorHost ready port=1234", // a log line that mentions it
      " N2EditorHost ready port=1234",
      "N2EditorHost readyport=1234",
      "N2EditorHost ready",
      "N2EditorHost ready port=",
      "N2EditorHost ready port=12a",
      "N2EditorHost ready port=0", // the bound port is never 0
      "N2EditorHost ready port=65536",
      "N2EditorHost ready port=123456",
      "N2EditorHost ready xport=1234",
      "N2EditorHost ready port=1234\r\r",
    ]) {
      assert.equal(parseReadyLine(line), null, JSON.stringify(line))
    }
  })
})

describe("LineSplitter", () => {
  test("a line split across chunks comes out whole, once its newline arrives", () => {
    const lines = new LineSplitter()
    assert.deepEqual(lines.push("[INFO] a\r\nN2Edit"), ["[INFO] a\r"])
    assert.deepEqual(lines.push("orHost ready po"), [])
    assert.deepEqual(lines.push("rt=1234\r"), [])
    assert.deepEqual(lines.push("\n"), ["N2EditorHost ready port=1234\r"])
    assert.deepEqual(lines.end(), [])
  })

  test("many lines in one chunk, and a last line with no newline at the end", () => {
    const lines = new LineSplitter()
    assert.deepEqual(lines.push("a\nb\n\nc"), ["a", "b", ""])
    assert.deepEqual(lines.end(), ["c"])
  })

  test("a UTF-8 character split across chunks is decoded whole", () => {
    const lines = new LineSplitter()
    const bytes = Buffer.from("héllo\n", "utf-8")
    assert.deepEqual(lines.push(bytes.subarray(0, 2)), [])
    assert.deepEqual(lines.push(bytes.subarray(2)), ["héllo"])
  })
})

describe("the host's command line and environment", () => {
  test("the arguments name the project, port 0, the token's variable and --exit-on-disconnect", () => {
    assert.deepEqual(buildHostArgs("C:\\Games\\My Game"), [
      "--project",
      "C:\\Games\\My Game",
      "--port",
      "0",
      "--token-env",
      "N2_EDITOR_TOKEN",
      "--exit-on-disconnect",
    ])
  })

  test("the token goes into a copy of the environment; the original is untouched", () => {
    const parent = { PATH: "/bin", OTHER: "x" }
    const child = buildChildEnv(parent, "secret")
    assert.deepEqual(child, { PATH: "/bin", OTHER: "x", N2_EDITOR_TOKEN: "secret" })
    assert.deepEqual(parent, { PATH: "/bin", OTHER: "x" })
  })

  test("tokens are 32 random bytes in hex", () => {
    const a = generateToken()
    assert.match(a, /^[0-9a-f]{64}$/)
    assert.notEqual(a, generateToken())
  })
})

describe("HostProcess.launch", () => {
  test("spawns the host with the token in the child's environment only, and resolves on the ready line", async () => {
    const { calls, spawn } = fakeSpawn()
    const before = process.env[TokenEnvVariable]
    const launching = HostProcess.launch({
      hostPath: "N2EditorHost.exe",
      projectDir: "C:\\p",
      token: "s3cr3t-t0ken",
      spawn,
    })

    assert.equal(calls.length, 1)
    const { command, args, options, child } = calls[0]
    assert.equal(command, "N2EditorHost.exe")
    assert.deepEqual(args, buildHostArgs("C:\\p"))
    assert.ok(!args.some((arg) => arg.includes("s3cr3t")), "the token isn't on the command line")
    assert.equal(options.env?.[TokenEnvVariable], "s3cr3t-t0ken")
    assert.equal(process.env[TokenEnvVariable], before, "this process's environment is unchanged")
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"], "stdin stays a pipe")

    // Log lines first, the ready line split across chunks, with \r\n
    child.stdout.write("[INFO] Engine initialized\r\n")
    child.stdout.write("N2EditorHost re")
    await settle()
    child.stdout.write("ady port=50123\r\n")
    const host = await launching
    assert.equal(host.port, 50123)
    assert.equal(host.token, "s3cr3t-t0ken")
    assert.equal(host.exited, false)
    assert.equal(child.stdin.writableEnded, false, "stdin is kept open")
  })

  test("generates a token when none is given", async () => {
    const { calls, spawn } = fakeSpawn()
    const launching = HostProcess.launch({ hostPath: "h", projectDir: "p", spawn })
    calls[0].child.stdout.write(`${ReadyLinePrefix} port=1\n`)
    const host = await launching
    assert.match(host.token, /^[0-9a-f]{64}$/)
    assert.equal(calls[0].options.env?.[TokenEnvVariable], host.token)
  })

  test("an exit before the ready line rejects, quoting stderr", async () => {
    const { calls, spawn } = fakeSpawn()
    const launching = HostProcess.launch({ hostPath: "h", projectDir: "missing", token: "s3cr3t-t0ken", spawn })
    const { child } = calls[0]
    child.stdout.write("[INFO] something\n")
    child.stderr.write("Project folder not found or not a folder: missing\r\n")
    child.exit(1)
    await assert.rejects(launching, (e: Error) => {
      assert.match(e.message, /exited with code 1 before it was ready/)
      assert.match(e.message, /Project folder not found or not a folder: missing$/)
      assert.ok(!e.message.includes("s3cr3t"))
      return true
    })
  })

  test("no ready line within the timeout rejects and kills the process", async () => {
    const { calls, spawn } = fakeSpawn()
    const launching = HostProcess.launch({ hostPath: "h", projectDir: "p", spawn, readyTimeoutMs: 20 })
    calls[0].child.stdout.write("[INFO] still starting\n")
    calls[0].child.stdout.write("N2EditorHost ready port=99") // no newline: not a complete line yet
    await assert.rejects(launching, /didn't report it was ready within 0.02 s:\n\[INFO\] still starting/)
    assert.equal(calls[0].child.killed, true)
  })

  test("a host that can't be started rejects", async () => {
    const { calls, spawn } = fakeSpawn()
    const launching = HostProcess.launch({ hostPath: "nope.exe", projectDir: "p", spawn })
    calls[0].child.emit("error", new Error("spawn nope.exe ENOENT"))
    await assert.rejects(launching, /Couldn't start nope.exe: spawn nope.exe ENOENT/)
  })

  test("after the ready line, output is still read, and an exit is reported", async () => {
    const { calls, spawn } = fakeSpawn()
    const exits: HostExit[] = []
    const launching = HostProcess.launch({
      hostPath: "h",
      projectDir: "p",
      spawn,
      onExit: (exit) => exits.push(exit),
    })
    const { child } = calls[0]
    child.stdout.write("N2EditorHost ready port=7\n")
    const host = await launching
    const heard: HostExit[] = []
    host.onExit((exit) => heard.push(exit))

    child.stdout.write("[INFO] more\n")
    child.stderr.write("oh no\n")
    await settle()
    assert.equal(child.stdout.readableFlowing, true)
    child.exit(3)
    await settle()
    await settle()
    assert.deepEqual(exits, [{ code: 3, signal: null }])
    assert.deepEqual(heard, [{ code: 3, signal: null }])
    assert.equal(host.exited, true)
    assert.match(host.lastOutput, /oh no/)
  })

  test("a host that exits after the ready line quotes its stdout, without the ready line", async () => {
    const { calls, spawn } = fakeSpawn()
    const launching = HostProcess.launch({ hostPath: "h", projectDir: "p", spawn })
    const { child } = calls[0]
    child.stdout.write("[INFO] Engine initialized\r\nN2EditorHost ready port=7\r\n")
    const host = await launching
    child.stdout.write("[ERROR] Fatal error: boom\r\n")
    child.exit(1)
    await settle()
    await settle()
    assert.equal(host.lastOutput, ":\n[INFO] Engine initialized\n[ERROR] Fatal error: boom")
  })

  test("kill ends the process, once", async () => {
    const { calls, spawn } = fakeSpawn()
    const launching = HostProcess.launch({ hostPath: "h", projectDir: "p", spawn })
    calls[0].child.stdout.write("N2EditorHost ready port=7\n")
    const host = await launching
    host.kill()
    assert.equal(calls[0].child.killed, true)
    await settle()
    await settle()
    assert.equal(host.exited, true)
    host.kill() // a no-op now
  })
})

describe("HostProcess.launch with a real process", () => {
  // A stand-in for N2EditorHost, run by this Node: it checks it got the token in its environment and on no command
  // line, then prints log lines and the ready line in pieces, and stays up until killed (or exits, if told to)
  const script = `
    const args = process.argv.slice(2)
    const token = process.env.N2_EDITOR_TOKEN
    if (!token || args.some((a) => a.includes(token))) { console.error("bad token"); process.exit(2) }
    if (args.includes("--fail")) { console.error("Project folder not found or not a folder: x"); process.exit(1) }
    process.stdout.write("[INFO] Engine initialized\\r\\nN2EditorHost ready ")
    setTimeout(() => process.stdout.write("port=4321 extra=1\\r\\n"), 20)
    setInterval(() => {}, 1000)
  `
  let dir: string
  let scriptPath: string

  /** Runs the script with Node in place of the host executable */
  const viaNode: SpawnFunction = (_command, args, options) => spawn(process.execPath, [scriptPath, ...args], options)

  test("setup", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "n2-host-launcher-"))
    scriptPath = path.join(dir, "fake-host.js")
    fs.writeFileSync(scriptPath, script)
  })

  test("reads the ready line from a real child's stdout, and kill ends it", async () => {
    const host = await HostProcess.launch({ hostPath: "N2EditorHost", projectDir: dir, spawn: viaNode })
    assert.equal(host.port, 4321)
    assert.equal(process.env[TokenEnvVariable], undefined)
    const exited = new Promise<HostExit>((resolve) => host.onExit(resolve))
    host.kill()
    const exit = await exited
    assert.ok(exit.code !== 0 || exit.signal !== null)
    assert.equal(host.exited, true)
  })

  test("a real child that exits early rejects with its stderr", async () => {
    const failing: SpawnFunction = (_command, args, options) =>
      spawn(process.execPath, [scriptPath, ...args, "--fail"], options)
    await assert.rejects(
      HostProcess.launch({ hostPath: "N2EditorHost", projectDir: dir, spawn: failing }),
      /exited with code 1 before it was ready:\nProject folder not found/,
    )
  })

  test("cleanup", () => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("createProjectWithHost (the intended contract of engine #75)", () => {
  test("runs --create <dir> and resolves when the host exits with 0", async () => {
    const { calls, spawn } = fakeSpawn()
    const creating = createProjectWithHost({ hostPath: "h", projectDir: "C:\\New Game", spawn })
    assert.deepEqual(calls[0].args, ["--create", "C:\\New Game"])
    assert.equal(calls[0].options.env, undefined, "no token: nothing connects to it")
    calls[0].child.exit(0)
    await creating
  })

  test("passes --project-id when given", async () => {
    const { calls, spawn } = fakeSpawn()
    const creating = createProjectWithHost({ hostPath: "h", projectDir: "d", projectId: "8e0c3a8e", spawn })
    assert.deepEqual(calls[0].args, ["--create", "d", "--project-id", "8e0c3a8e"])
    calls[0].child.exit(0)
    await creating
  })

  test("a non-zero exit rejects with stderr, and says what it needs", async () => {
    const { calls, spawn } = fakeSpawn()
    const creating = createProjectWithHost({ hostPath: "h", projectDir: "d", spawn })
    calls[0].child.stderr.write("Folder is not empty: d\n")
    calls[0].child.exit(1)
    await assert.rejects(creating, (e: Error) => {
      assert.match(e.message, /--create exited with code 1:\nFolder is not empty: d/)
      assert.ok(e.message.includes(CreateNeedsEngine))
      return true
    })
  })

  test("a host without --create starts serving instead: its ready line rejects, and it is killed", async () => {
    const { calls, spawn } = fakeSpawn()
    const creating = createProjectWithHost({ hostPath: "h", projectDir: "d", spawn })
    calls[0].child.stdout.write("N2EditorHost ready port=9999\r\n")
    await assert.rejects(creating, /doesn't support --create/)
    assert.equal(calls[0].child.killed, true)
  })

  test("a timeout rejects and kills", async () => {
    const { calls, spawn } = fakeSpawn()
    const creating = createProjectWithHost({ hostPath: "h", projectDir: "d", spawn, timeoutMs: 20 })
    await assert.rejects(creating, /didn't finish/)
    assert.equal(calls[0].child.killed, true)
  })
})
