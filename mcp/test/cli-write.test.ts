// The write-policy flags of the command line: what they set, and that a bad one is refused with a message.
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { CliError, parseArgs } from "../src/cli"
import { MaxWritesPerSession } from "../src/limits"

const launch = ["--launch", "/proj", "--host-path", "/bin/host"]
const parse = (extra: string[]) => parseArgs([...launch, ...extra], {})

describe("write policy flags", () => {
  test("the defaults: writes on, irreversible operations need the person, the default budget", () => {
    const a = parse([])
    assert.equal(a.mode === "launch" && a.readOnly, false)
    assert.equal(a.mode === "launch" && a.allowIrreversible, false)
    assert.equal(a.mode === "launch" && a.maxWrites, MaxWritesPerSession)
    assert.equal(a.mode === "launch" && a.writeTools, null)
    assert.deepEqual(a.mode === "launch" && a.disableTools, [])
    assert.equal(a.mode === "launch" && a.keepJournal, false)
  })

  test("--read-only, --allow-irreversible, --keep-journal, --max-writes and the tool lists", () => {
    const a = parse(["--read-only", "--allow-irreversible", "--keep-journal", "--max-writes", "50", "--write-tools", "n2_create_entity,n2_undo", "--disable-tools", "n2_screenshot,n2_save_scene"])
    assert.ok(a.mode === "launch")
    if (a.mode !== "launch") return
    assert.equal(a.readOnly, true)
    assert.equal(a.allowIrreversible, true)
    assert.equal(a.keepJournal, true)
    assert.equal(a.maxWrites, 50)
    assert.deepEqual(a.writeTools, ["n2_create_entity", "n2_undo"])
    assert.deepEqual(a.disableTools, ["n2_screenshot", "n2_save_scene"])
  })

  test("the same flags work with --connect", () => {
    const fp = "ab".repeat(32)
    const a = parseArgs(["--connect", "h:9", "--fingerprint", fp, "--token-env", "T", "--allow-irreversible"], {})
    assert.equal(a.mode === "connect" && a.allowIrreversible, true)
  })

  test("bad values and unknown tool names are refused, and no flag takes a consent from the command line of an agent", () => {
    const refuses = (extra: string[], pattern: RegExp): void =>
      assert.throws(() => parse(extra), (e: unknown) => e instanceof CliError && pattern.test(e.message), extra.join(" "))
    refuses(["--max-writes", "0"], /--max-writes/)
    refuses(["--max-writes", "many"], /--max-writes/)
    refuses(["--max-writes"], /needs a value/)
    refuses(["--write-tools", "n2_nope"], /no such tool n2_nope/)
    refuses(["--write-tools", "n2_status"], /no such tool/)
    refuses(["--write-tools", "n2_undo,,n2_redo"], /comma separated/)
    refuses(["--disable-tools", "rm"], /no such tool/)
    refuses(["--confirm-all"], /unknown option/)
  })
})
