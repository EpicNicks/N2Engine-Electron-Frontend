// The real bundle, dist/n2-mcp.mjs, run as a child process the way Claude Code or Claude Desktop run it, and driven by the
// SDK's own stdio client: the CLI, the token's sources, stdout carrying nothing but MCP, the lazy connection, the exit
// when stdin closes. The host is a fake over TLS in this process. (npm test builds the bundle first.)
import { test, describe, after, before } from "node:test"
import * as assert from "node:assert/strict"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { TestIdentityA } from "../../src/test/test-tls-identity"
import { WriteTools } from "../src/tools-write"
import { FakeHost } from "./fake-host"
import { TestToken } from "./harness"

const here = path.dirname(fileURLToPath(import.meta.url))
const bundle = path.join(here, "..", "n2-mcp.mjs")

interface CallResult {
  isError?: boolean
  content: Array<{ type: string; text?: string }>
  structuredContent?: any
  _meta?: Record<string, unknown>
}

describe("dist/n2-mcp.mjs over stdio", () => {
  let host: FakeHost
  const running: Client[] = []

  before(async () => {
    assert.ok(fs.existsSync(bundle), "dist/n2-mcp.mjs is missing: run npm run build (or npm run build:mcp) first")
    host = await new FakeHost({ token: TestToken, tls: TestIdentityA }).start()
  })
  after(async () => {
    await Promise.all(running.splice(0).map((c) => c.close().catch(() => undefined)))
    await host.stop()
  })

  const connectArgs = (extra: string[] = []): string[] => [
    bundle,
    "--connect",
    `127.0.0.1:${host.port}`,
    "--fingerprint",
    TestIdentityA.fingerprint,
    "--token-env",
    "N2_TEST_TOKEN",
    "--user",
    "agent-test",
    ...extra,
  ]

  async function startClient(args: string[], env: Record<string, string> = { N2_TEST_TOKEN: TestToken }, negotiation: "legacy" | "auto" = "legacy") {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args,
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...env },
      stderr: "pipe",
    })
    let stderr = ""
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    const client = new Client({ name: "e2e", version: "0" }, { versionNegotiation: { mode: negotiation } })
    running.push(client)
    await client.connect(transport)
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallResult> =>
      (await client.callTool({ name, arguments: args })) as unknown as CallResult
    return { client, call, stderr: () => stderr }
  }

  test("a full session: initialize, tools/list, a read, a screenshot; the token never reaches the client or the log", async () => {
    const { client, call, stderr } = await startClient(connectArgs())
    assert.equal(client.getServerVersion()?.name, "n2-mcp")
    const { tools } = await client.listTools()
    assert.equal(tools.length, 11 + WriteTools.length, "the host gave an editor role: the write tools are listed too")
    const status = await call("n2_status")
    assert.ok(!status.isError, JSON.stringify(status))
    assert.equal(status.structuredContent.data.host.role, "editor")
    const shot = await call("n2_screenshot", { width: 64, height: 36 })
    assert.ok(shot.content.some((c) => c.type === "image"))
    assert.ok(!JSON.stringify([tools, status, shot]).includes(TestToken))
    assert.match(stderr(), /serving on stdio \(connect\)/)
    assert.match(stderr(), /connected to the connect host/)
    assert.ok(!stderr().includes(TestToken), "the token is not in the log")
    assert.ok(host.helloUsers.includes("agent-test"))
    assert.ok(host.helloTokens.every((t) => t === TestToken))
    await client.close()
  })

  test("a client that probes with server/discover first (2026-07-28) works, and the probe never touches the host", async () => {
    const before = host.connections
    const { client, call } = await startClient(connectArgs(["--read-only"]), undefined, "auto")
    const { tools } = await client.listTools()
    assert.equal(tools.length, 11, "--read-only lists no write tool")
    assert.equal(host.connections, before, "with --read-only listing the tools does not connect to the host (the host is reached on the first call)")
    assert.ok(!(await call("n2_status")).isError)
    assert.equal(host.connections, before + 1)
    await client.close()
  })

  test("without --read-only the first tools/list asks the host who the token is, so the write tools are listed right away", async () => {
    const before = host.connections
    const { client } = await startClient(connectArgs(), undefined, "auto")
    const { tools } = await client.listTools()
    assert.equal(tools.length, 11 + WriteTools.length)
    assert.equal(host.connections, before + 1)
    await client.close()
  })

  test("--token-file works as a token source", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n2-mcp-e2e-"))
    try {
      const file = path.join(dir, "token")
      fs.writeFileSync(file, TestToken + "\n", { mode: 0o600 })
      const args = connectArgs().filter((a) => a !== "--token-env" && a !== "N2_TEST_TOKEN").concat(["--token-file", file])
      const { client, call } = await startClient(args, {})
      assert.ok(!(await call("n2_status")).isError)
      await client.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a wrong token is auth_failed for the model, and neither token is logged", async () => {
    const { client, call, stderr } = await startClient(connectArgs(), { N2_TEST_TOKEN: "an-incorrect-token-0000000" })
    const r = await call("n2_status")
    assert.equal(r.isError, true)
    assert.equal(r._meta?.["n2/errorCode"], "auth_failed")
    assert.ok(!stderr().includes("an-incorrect-token"))
    assert.ok(!JSON.stringify(r).includes("an-incorrect-token"))
    await client.close()
  })

  test("the admin role is refused unless --allow-admin", async () => {
    const adminHost = await new FakeHost({ token: TestToken, tls: TestIdentityA, role: "admin" }).start()
    try {
      const args = connectArgs().map((a) => (a === `127.0.0.1:${host.port}` ? `127.0.0.1:${adminHost.port}` : a))
      const refused = await startClient(args)
      const r = await refused.call("n2_status")
      assert.equal(r.isError, true)
      assert.equal(r._meta?.["n2/errorCode"], "admin_refused")
      assert.match(refused.stderr(), /refusing to serve/)
      await refused.client.close()
      const allowed = await startClient([...args, "--allow-admin"])
      assert.ok(!(await allowed.call("n2_status")).isError)
      await allowed.client.close()
    } finally {
      await adminHost.stop()
    }
  })

  test("stdin closing ends the process promptly, with exit code 0", async () => {
    const child = spawn(process.execPath, connectArgs(), { env: { PATH: process.env.PATH ?? "", N2_TEST_TOKEN: TestToken }, stdio: ["pipe", "pipe", "pipe"] })
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)))
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(child.exitCode, null, "still serving while stdin is open")
    child.stdin.end()
    const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r("timeout"), 8000))])
    if (code === "timeout") child.kill()
    assert.equal(code, 0)
  })

  test("bad arguments exit with code 2 and a usage message, never echoing a token given as an argument", async () => {
    const run = (args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [bundle, ...args], { env: { PATH: process.env.PATH ?? "" }, stdio: ["pipe", "pipe", "pipe"] })
        let stdout = ""
        let stderr = ""
        child.stdout.on("data", (c: Buffer) => (stdout += c))
        child.stderr.on("data", (c: Buffer) => (stderr += c))
        child.on("exit", (code) => resolve({ code, stdout, stderr }))
        child.stdin.end()
      })
    const tokenArg = await run(["--connect", "h:1", "--fingerprint", TestIdentityA.fingerprint, "--token", "s3cr3t-token-value"])
    assert.equal(tokenArg.code, 2)
    assert.match(tokenArg.stderr, /never accepted as an argument/)
    assert.ok(!tokenArg.stderr.includes("s3cr3t") && !tokenArg.stdout.includes("s3cr3t"))
    assert.equal(tokenArg.stdout, "", "stdout carries nothing on an error")
    const missingEnv = await run(["--connect", "h:1", "--fingerprint", TestIdentityA.fingerprint, "--token-env", "N2_NOT_SET"])
    assert.equal(missingEnv.code, 2)
    assert.match(missingEnv.stderr, /N2_NOT_SET is not set/)
    const none = await run([])
    assert.equal(none.code, 2)
    const help = await run(["--help"])
    assert.equal(help.code, 0)
    assert.match(help.stdout, /--fingerprint/)
    const version = await run(["--version"])
    assert.match(version.stdout, /^n2-mcp \d+\.\d+\.\d+/)
  })
})
