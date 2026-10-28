// The command line (tokens never as arguments, the fingerprint required, the token's sources) and the PNG encoder.
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { crc32 } from "node:zlib"
import { CliError, parseArgs, parseHostPort, readToken, type ConnectCli } from "../src/cli"
import { decodePngRgb, encodePng, fitSize } from "../src/png"

const FP = "ab".repeat(32)
const parse = (args: string[], env: NodeJS.ProcessEnv = {}) => parseArgs(args, env)
const refuses = (args: string[], pattern: RegExp, env: NodeJS.ProcessEnv = {}) =>
  assert.throws(() => parse(args, env), (e: unknown) => e instanceof CliError && pattern.test(e.message), args.join(" "))

describe("the command line", () => {
  test("--launch with the host from --host-path or N2ENGINE_HOST", () => {
    const a = parse(["--launch", "C:\\proj", "--host-path", "C:\\h\\N2EditorHost.exe", "--renderer", "software"])
    assert.deepEqual(a, { mode: "launch", projectPath: "C:\\proj", hostPath: "C:\\h\\N2EditorHost.exe", renderer: "software", readyTimeoutMs: undefined, allowAdmin: false, readOnly: false, allowIrreversible: false, maxWrites: 2000, writeTools: null, disableTools: [], keepJournal: false, busyWaitMs: 3000, callTimeoutMs: 60000, yield: true })
    const b = parse(["--launch", "/proj"], { N2ENGINE_HOST: "/bin/host" })
    assert.equal(b.mode === "launch" && b.hostPath, "/bin/host")
    refuses(["--launch", "/proj"], /needs the host/)
    refuses(["--launch", "/proj", "--host-path", "h", "--renderer", "vulkan"], /opengl or software/)
  })

  test("--connect needs host:port, a fingerprint and exactly one token source", () => {
    const a = parse(["--connect", "editor.example.net:9999", "--fingerprint", FP, "--token-env", "N2_AGENT_TOKEN", "--user", "agent-claude", "--allow-admin"])
    assert.deepEqual(a, { mode: "connect", host: "editor.example.net", port: 9999, fingerprint: FP, user: "agent-claude", tokenEnv: "N2_AGENT_TOKEN", tokenFile: undefined, allowAdmin: true, readOnly: false, allowIrreversible: false, maxWrites: 2000, writeTools: null, disableTools: [], keepJournal: false, busyWaitMs: 3000, callTimeoutMs: 60000, yield: true })
    refuses(["--connect", "h:9999", "--token-env", "T"], /--fingerprint/)
    refuses(["--connect", "h:9999", "--fingerprint", "abcd", "--token-env", "T"], /64 hex digits/)
    refuses(["--connect", "h:9999", "--fingerprint", FP], /exactly one of/)
    refuses(["--connect", "h:9999", "--fingerprint", FP, "--token-env", "T", "--token-file", "f"], /exactly one of/)
  })

  test("the fingerprint may be written with colons; the user is checked", () => {
    const colons = Array.from({ length: 32 }, () => "AB").join(":")
    const a = parse(["--connect", "h:1", "--fingerprint", colons, "--token-env", "T"])
    assert.equal(a.mode === "connect" && a.fingerprint, FP)
    refuses(["--connect", "h:1", "--fingerprint", FP, "--token-env", "T", "--user", "bad user!"], /--user/)
  })

  test("a token is never accepted as an argument, whatever the spelling", () => {
    for (const args of [
      ["--connect", "h:1", "--fingerprint", FP, "--token", "s3cret-value"],
      ["--connect", "h:1", "--fingerprint", FP, "--token=s3cret-value"],
      ["--connect", "h:1", "--fingerprint", FP, "--password", "x"],
    ]) {
      try {
        parse(args)
        assert.fail("accepted")
      } catch (e) {
        assert.ok(e instanceof CliError)
        assert.match(e.message, /never accepted as an argument/)
        assert.ok(!e.message.includes("s3cret"), "the value is not echoed")
      }
    }
    // A token pasted where the variable's name goes is refused, and not echoed
    try {
      parse(["--connect", "h:1", "--fingerprint", FP, "--token-env", "0123456789abcdef-token"])
      assert.fail("accepted")
    } catch (e) {
      assert.ok(e instanceof CliError)
      assert.ok(!e.message.includes("0123456789"))
    }
  })

  test("unknown options, mixed backends and options of the other backend are errors", () => {
    refuses(["--bogus"], /unknown option/)
    refuses([], /give --launch/)
    refuses(["--launch", "p", "--connect", "h:1"], /can't be combined/)
    refuses(["--launch", "p", "--host-path", "h", "--fingerprint", FP], /belong to --connect/)
    refuses(["--connect", "h:1", "--fingerprint", FP, "--token-env", "T", "--renderer", "software"], /belong to --launch/)
    refuses(["--launch"], /needs a value/)
    refuses(["--launch", "p", "--host-path", "h", "--busy-wait", "99999"], /between 1 and/)
    assert.deepEqual(parse(["--help"]), { mode: "help" })
    assert.deepEqual(parse(["--version"]), { mode: "version" })
  })

  test("parseHostPort handles names, IPv4 and bracketed IPv6", () => {
    assert.deepEqual(parseHostPort("localhost:9999"), { host: "localhost", port: 9999 })
    assert.deepEqual(parseHostPort("[::1]:1234"), { host: "::1", port: 1234 })
    assert.throws(() => parseHostPort("nohost"), CliError)
    assert.throws(() => parseHostPort("h:70000"), CliError)
    assert.throws(() => parseHostPort("::1:99"), CliError)
  })
})

describe("reading the token", () => {
  const connect = (extra: Partial<ConnectCli>): ConnectCli => ({ mode: "connect", host: "h", port: 1, fingerprint: FP, allowAdmin: false, readOnly: false, allowIrreversible: false, maxWrites: 1, writeTools: null, disableTools: [], keepJournal: false, busyWaitMs: 1, callTimeoutMs: 1, yield: true, ...extra })

  test("from an environment variable, which is then removed from the environment", () => {
    const env: NodeJS.ProcessEnv = { N2_AGENT_TOKEN: "  tok-123  " }
    assert.equal(readToken(connect({ tokenEnv: "N2_AGENT_TOKEN" }), env), "tok-123")
    assert.equal(env.N2_AGENT_TOKEN, undefined)
    assert.throws(() => readToken(connect({ tokenEnv: "N2_AGENT_TOKEN" }), env), /N2_AGENT_TOKEN is not set/)
    assert.throws(() => readToken(connect({ tokenEnv: "T" }), { T: "   " }), /empty/)
  })

  test("from a file; an empty or missing file is an error that names no token", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n2-mcp-tok-"))
    try {
      const file = path.join(dir, "token")
      fs.writeFileSync(file, "file-token-456\n", { mode: 0o600 })
      assert.equal(readToken(connect({ tokenFile: file }), {}), "file-token-456")
      fs.writeFileSync(path.join(dir, "empty"), "\n", { mode: 0o600 })
      assert.throws(() => readToken(connect({ tokenFile: path.join(dir, "empty") }), {}), /empty/)
      assert.throws(() => readToken(connect({ tokenFile: path.join(dir, "missing") }), {}), /can't be read/)
      assert.throws(() => readToken(connect({ tokenFile: dir }), {}), /not a file/)
      if (process.platform !== "win32") {
        fs.chmodSync(file, 0o644)
        assert.throws(() => readToken(connect({ tokenFile: file }), {}), /chmod 600/)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("the PNG encoder", () => {
  test("round trips an RGBA frame (alpha dropped), and has valid chunks", () => {
    const width = 37
    const height = 23
    const rgba = new Uint8Array(width * height * 4)
    for (let i = 0; i < rgba.length; i += 4) {
      const p = i / 4
      rgba[i] = (p * 7) & 255
      rgba[i + 1] = (p * 13 + 5) & 255
      rgba[i + 2] = p % width === 0 ? 255 : 3
      rgba[i + 3] = 255
    }
    const png = encodePng(width, height, rgba)
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const decoded = decodePngRgb(png)
    assert.deepEqual([decoded.width, decoded.height], [width, height])
    for (let p = 0; p < width * height; p++) {
      assert.deepEqual([...decoded.rgb.subarray(p * 3, p * 3 + 3)], [rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]], `pixel ${p}`)
    }
    // IEND is last, with its well-known CRC
    assert.deepEqual([...png.subarray(png.length - 12)], [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
    assert.equal(crc32(Buffer.from("IEND")) >>> 0, 0xae426082)
  })

  test("a flat picture compresses well, and bad sizes are refused", () => {
    const flat = new Uint8Array(768 * 432 * 4).fill(255)
    assert.ok(encodePng(768, 432, flat).length < 5000)
    assert.throws(() => encodePng(0, 10, new Uint8Array(0)))
    assert.throws(() => encodePng(2, 2, new Uint8Array(15)))
  })

  test("fitSize keeps the aspect ratio and the long side within the limit", () => {
    assert.deepEqual(fitSize(768, 432, 1568), { width: 768, height: 432, scaled: false })
    assert.deepEqual(fitSize(3136, 1568, 1568), { width: 1568, height: 784, scaled: true })
    assert.deepEqual(fitSize(1000, 4000, 1568), { width: 392, height: 1568, scaled: true })
    assert.deepEqual(fitSize(4096, 16, 1568), { width: 1568, height: 6, scaled: true })
  })
})
