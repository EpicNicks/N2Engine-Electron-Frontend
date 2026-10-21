// The console's regex filter has a step budget per pass over the lines: a pattern that is linear per line but slow over
// a full console turns itself off with a message instead of freezing the page. Also the ignore-case class folding.
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ConsoleStore, ConsoleEntry } from "../renderer/console-store"
import { compileMatcher, MaxPassSteps, MaxRegexInput } from "../renderer/console-filter"
import { compileProgram, exec } from "../renderer/safe-regex"

const never = async () => ({ epoch: 1, nextSeq: 1, dropped: 0, events: [] }) as never
const entry = (message: string): Omit<ConsoleEntry, "id"> => ({ level: "info", message, source: "host", time: 1 })

function fullStore(message: string, search: string, lines = 5000): ConsoleStore {
  const log = new ConsoleStore(never, { now: () => 1000 })
  log.addEntries(Array.from({ length: lines }, () => entry(message)))
  log.regex.value = true
  log.search.value = search
  return log
}

describe("the pass budget", () => {
  test("a slow pattern over a full console turns itself off and nothing is filtered", { timeout: 20000 }, () => {
    // [a-z]{1,60}[0-9]{1,60}q is accepted (linear per line) but costs seconds over 5000 lines of 4096 characters
    const log = fullStore("a".repeat(4096), "[a-z]{1,60}[0-9]{1,60}q")
    const started = Date.now()
    assert.equal(log.visible.value.length, 5000, "everything is shown once the regular expression is off")
    assert.equal(log.matcher.value.slow, true)
    assert.equal(log.counts.value.info, 5000)
    assert.equal(log.sourceCounts.value.host, 5000)
    assert.ok(Date.now() - started < 10000, "the passes are bounded, not minutes long")
    // Editing the pattern compiles a new matcher, which tries again
    log.search.value = "zzz"
    assert.equal(log.matcher.value.slow, false)
  })

  test("a cheap pattern over the same console stays on and filters", { timeout: 20000 }, () => {
    const log = fullStore("a".repeat(4096), "b", 2000)
    assert.equal(log.visible.value.length, 0)
    assert.equal(log.matcher.value.slow, false)
  })

  test("highlighting a full console is bounded by the pass, not only by the line", { timeout: 20000 }, () => {
    const matcher = compileMatcher({ search: "x(.*y)?", matchCase: false, regex: true })
    const message = "x".repeat(4096)
    matcher.beginPass()
    const started = Date.now()
    for (let i = 0; i < 5000; i++) matcher.ranges(message + (i % 2 === 0 ? "" : " "))
    assert.ok(Date.now() - started < 10000)
    assert.equal(matcher.slow, false, "running out of highlight budget does not disable the filter")
  })

  test("a line that passes still gets its first match highlighted", () => {
    const matcher = compileMatcher({ search: ".{1,100}z", matchCase: false, regex: true })
    const message = "x".repeat(4095) + "z"
    matcher.beginPass()
    assert.equal(matcher.test(message), true)
    assert.deepEqual(matcher.ranges(message), [[3995, 4096]])
  })

  test("the old bypass shapes finish within the budget on 1000 long lines", { timeout: 20000 }, () => {
    for (const [pattern, text] of [
      ["((a+))+$", "a".repeat(4000) + "!"],
      ["(a|aa)+$", "a".repeat(4000) + "!"],
      ["(a*)*b", "a".repeat(4000)],
      ["(x+x+)+y", "x".repeat(4000)],
    ]) {
      const log = fullStore(text, pattern, 1000)
      const started = Date.now()
      log.visible.value
      log.counts.value
      assert.ok(Date.now() - started < 10000, pattern)
      assert.ok(log.visible.value.length === 0 || log.matcher.value.slow, pattern)
    }
  })

  test("the budget is sane", () => {
    assert.ok(MaxPassSteps >= MaxRegexInput * 100, "a few ordinary lines never run it dry")
  })
})

describe("ignore-case classes fold non-ASCII letters the way RegExp does", () => {
  const cases: Array<[string, string]> = [
    ["[\u0430-\u044f]+", "\u041f"],
    ["[\u00e0]", "\u00c0"],
    ["[\u0101]", "\u0100"],
    ["[^\u00e0]", "\u00c0"],
    ["[\u00c0]", "\u00e0"],
    ["[k]", "\u212a"],
    ["[\u212a]", "k"],
    ["[a-z]", "\u017f"],
    ["[^a-z]", "K"],
  ]
  for (const [source, text] of cases) {
    test(`/${JSON.stringify(source)}/i on ${JSON.stringify(text)}`, () => {
      const program = compileProgram(source, true)
      assert.equal(exec(program, text, 0, true) !== null, new RegExp(source, "i").test(text))
    })
  }
})
