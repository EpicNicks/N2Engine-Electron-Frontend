// The launcher's two opt-in options for the MCP bridge (mcp/): --tokens-file instead of --token-env, and no
// --exit-on-disconnect. Without them the host's arguments and environment are exactly what the editor has always used.
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { ChildProcess, SpawnOptions } from "node:child_process"
import { HostProcess, SpawnFunction, TokenEnvVariable, buildHostArgs } from "../main/host-launcher"

describe("buildHostArgs", () => {
  test("the default is unchanged: --token-env, --exit-on-disconnect, --exit-on-stdin-eof", () => {
    assert.deepEqual(buildHostArgs("C:\proj"), [
      "--project", "C:\proj", "--port", "0", "--token-env", TokenEnvVariable, "--exit-on-disconnect", "--exit-on-stdin-eof",
    ])
    assert.deepEqual(buildHostArgs("p", { renderer: "software", playFile: "f.scene" }), [
      "--project", "p", "--renderer", "software", "--port", "0", "--token-env", TokenEnvVariable, "--play", "f.scene",
      "--exit-on-disconnect", "--exit-on-stdin-eof",
    ])
  })

  test("tokensFile replaces --token-env, and exitOnDisconnect false leaves --exit-on-disconnect out", () => {
    assert.deepEqual(buildHostArgs("p", { tokensFile: "/tmp/t.json", exitOnDisconnect: false }), [
      "--project", "p", "--port", "0", "--tokens-file", "/tmp/t.json", "--exit-on-stdin-eof",
    ])
    assert.ok(buildHostArgs("p", { tokensFile: "/tmp/t.json" }).includes("--exit-on-disconnect"))
    assert.ok(!buildHostArgs("p", { exitOnDisconnect: false }).includes("--exit-on-disconnect"))
  })
})

describe("HostProcess.launch with a tokens file", () => {
  class FakeChild extends EventEmitter {
    stdin = new PassThrough()
    stdout = new PassThrough()
    stderr = new PassThrough()
    kill(): boolean {
      return true
    }
  }

  function launch(options: { tokensFile?: string }) {
    const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = []
    const spawn: SpawnFunction = (_command, args, spawnOptions: SpawnOptions) => {
      const child = new FakeChild()
      calls.push({ args, env: spawnOptions.env })
      setImmediate(() => child.stdout.write("N2EditorHost ready port=4321\n"))
      return child as unknown as ChildProcess
    }
    const promise = HostProcess.launch({ hostPath: "host", projectDir: "p", token: "caller-token-1234", env: { PATH: "x" }, spawn, ...options })
    return { calls, promise }
  }

  test("the token stays out of the child's environment, and the caller's token is the host's", async () => {
    const { calls, promise } = launch({ tokensFile: "/tmp/t.json" })
    const host = await promise
    assert.equal(host.port, 4321)
    assert.equal(host.token, "caller-token-1234")
    assert.deepEqual(calls[0].env, { PATH: "x" })
    assert.ok(calls[0].args.includes("--tokens-file"))
  })

  test("without a tokens file the token is in the child's environment, as before", async () => {
    const { calls, promise } = launch({})
    await promise
    assert.deepEqual(calls[0].env, { PATH: "x", [TokenEnvVariable]: "caller-token-1234" })
    assert.ok(calls[0].args.includes("--token-env"))
  })
})
