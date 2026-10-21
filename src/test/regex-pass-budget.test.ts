// The console's regex filter draws its work on two buckets of steps per matcher, one for testing the lines (shared by
// the list and both kinds of count) and one for highlighting, so at most MaxUpdateSteps for one update, refilled at
// RegexStepsPerSecond while lines stream in; highlighting can never starve the filter. A pattern that is linear per line but slow over a full console turns itself off with a message instead of
// freezing the page, and the list and the counts always agree on whether it is off. Also the ignore-case class folding.
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ConsoleStore, ConsoleEntry, FilterDebounceMs, LogLevel } from "../renderer/console-store"
import {
  compileMatcher,
  MaxHighlightSteps,
  MaxRegexInput,
  MaxTestSteps,
  MaxUpdateSteps,
  RegexStepsPerSecond,
  TestStepsPerSecond,
} from "../renderer/console-filter"
import { compileProgram, exec } from "../renderer/safe-regex"

const never = async () => ({ epoch: 1, nextSeq: 1, dropped: 0, events: [] }) as never
const entry = (message: string, level: LogLevel = "info"): Omit<ConsoleEntry, "id"> => ({ level, message, source: "host", time: 1 })

/** A store whose budget clock is driven by the test (it starts at 0 and only moves when the test moves it) */
function storeWithClock() {
  const clock = { now: 0 }
  const log = new ConsoleStore(never, { now: () => 1000, clock: () => clock.now })
  return { log, clock }
}

function fullStore(message: string, search: string, lines = 5000): ConsoleStore {
  const { log } = storeWithClock()
  log.addEntries(Array.from({ length: lines }, () => entry(message)))
  log.regex.value = true
  log.search.value = search
  return log
}

/** Reads everything one update of the panel reads */
function update(log: ConsoleStore) {
  return { visible: log.visible.value.length, counts: log.counts.value, sources: log.sourceCounts.value, slow: log.regexSlow.value }
}

// Accepted (linear per line) but costly on long lines: the steps one line of 4096 "a" costs
const Costly = "[a-z]{1,60}[0-9]{1,60}q"
const long = "a".repeat(4096)
function stepsPerLine(pattern: string, message: string): number {
  const budget = { left: Number.MAX_SAFE_INTEGER }
  exec(compileProgram(pattern, true), message, 0, true, budget)
  return Number.MAX_SAFE_INTEGER - budget.left
}

describe("the step bucket", () => {
  test("the costly pattern costs what the tests below assume", () => {
    const s = stepsPerLine(Costly, long)
    assert.ok(s > 100_000 && s < MaxTestSteps / 10, `${s} steps per line`)
  })

  test("a slow pattern over a full console turns itself off and nothing is filtered", { timeout: 20000 }, () => {
    const log = fullStore(long, Costly)
    const started = Date.now()
    assert.equal(log.visible.value.length, 5000, "everything is shown once the regular expression is off")
    assert.equal(log.regexSlow.value, true)
    assert.equal(log.counts.value.info, 5000)
    assert.equal(log.sourceCounts.value.host, 5000)
    assert.ok(log.matcher.value.spent <= MaxUpdateSteps, "one update spends at most the bucket")
    assert.ok(Date.now() - started < 10000, "the passes are bounded, not minutes long")
    // Editing the pattern compiles a new matcher with a full bucket, which tries again (on fewer lines: even a literal
    // over 5000 lines of 4096 characters is more than one update's budget)
    log.search.value = "zzz"
    assert.equal(log.matcher.value.slow, false)
    log.entries.value = log.entries.value.slice(0, 500)
    assert.equal(log.regexSlow.value, false)
    assert.equal(log.visible.value.length, 0)
  })

  test("a cheap pattern over a large console stays on and filters", { timeout: 20000 }, () => {
    const log = fullStore(long, "b", 1000)
    assert.equal(log.visible.value.length, 0)
    assert.equal(log.regexSlow.value, false)
  })

  for (const order of ["list first", "counts first"]) {
    test(`the list and the counts agree when a hidden level's lines run the bucket dry (${order})`, { timeout: 20000 }, () => {
      // The shown (info) lines alone fit in the bucket, all the lines don't: the list used to stay filtered while
      // the counts turned the regular expression off
      const s = stepsPerLine(Costly, long)
      const info = Math.floor((0.5 * MaxTestSteps) / s)
      const warn = Math.ceil((0.7 * MaxTestSteps) / s)
      const { log } = storeWithClock()
      log.addEntries([
        ...Array.from({ length: info }, () => entry(long, "info")),
        ...Array.from({ length: warn }, () => entry(long, "warn")),
      ])
      log.toggleLevel("warn")
      log.regex.value = true
      log.search.value = Costly
      if (order === "counts first") log.counts.value
      const u = update(log)
      assert.equal(u.slow, true)
      assert.equal(u.visible, info, "the regular expression is off for the list too: every shown line is listed")
      assert.deepEqual(u.counts, { info, warn, error: 0 })
      assert.equal(u.sources.host, info)
      assert.deepEqual(log.matcher.value.ranges(long), [], "and nothing is highlighted")
    })
  }

  test("a pattern just under the bucket per batch does not stall every batch: it turns off", { timeout: 30000 }, () => {
    const s = stepsPerLine(Costly, long)
    const perBatch = Math.floor((0.8 * MaxTestSteps) / s) // each batch alone fits in one update's budget
    const { log, clock } = storeWithClock()
    log.regex.value = true
    log.search.value = Costly
    const spentPerUpdate: number[] = []
    for (let i = 0; i < 10; i++) {
      clock.now += 100 // batches 100 ms apart: the log streams faster than the refill
      const before = log.matcher.value.spent
      log.addEntries(Array.from({ length: perBatch }, () => entry(long + i)))
      update(log)
      for (const row of log.rows.value.slice(-50)) log.matcher.value.ranges(row.entry.message)
      spentPerUpdate.push(log.matcher.value.spent - before)
    }
    const elapsed = clock.now / 1000
    for (const spent of spentPerUpdate) assert.ok(spent <= MaxUpdateSteps, `one update spent ${spent}`)
    assert.ok(
      log.matcher.value.spent <= MaxUpdateSteps + RegexStepsPerSecond * elapsed,
      "the total is bounded by the bucket plus the refill over the time"
    )
    assert.equal(log.regexSlow.value, true, "the stream outran the refill, so the pattern is off")
    assert.deepEqual(spentPerUpdate.slice(3), [0, 0, 0, 0, 0, 0, 0], "and costs nothing more after that")
  })

  test("a costly pattern on a slow stream stays on and only tests the new lines", { timeout: 30000 }, () => {
    const s = stepsPerLine(Costly, long)
    const perBatch = Math.floor((0.3 * MaxTestSteps) / s)
    const { log, clock } = storeWithClock()
    log.regex.value = true
    log.search.value = Costly
    for (let i = 0; i < 6; i++) {
      clock.now += 10_000 // the refill keeps up
      const before = log.matcher.value.spent
      log.addEntries(Array.from({ length: perBatch }, () => entry(long)))
      update(log)
      const spent = log.matcher.value.spent - before
      assert.ok(spent <= perBatch * s * 1.01, `update ${i} spent ${spent}: the lines tested before are not tested again`)
      log.toggleLevel("info")
      update(log)
      log.toggleLevel("info")
      assert.equal(log.matcher.value.spent - before, spent, "toggling a level tests nothing")
    }
    assert.equal(log.regexSlow.value, false)
    assert.equal(log.visible.value.length, 0)
  })

  test("highlighting has its own bucket and running it dry only stops marking", { timeout: 20000 }, () => {
    const matcher = compileMatcher({ search: "x(.*y)?", matchCase: false, regex: true }, () => 0)
    const message = "x".repeat(4096)
    const started = Date.now()
    let unmarked = 0
    for (let i = 0; i < 5000; i++) if (matcher.ranges(message + i).length === 0) unmarked++
    assert.ok(Date.now() - started < 10000)
    assert.ok(matcher.spent <= MaxHighlightSteps, "highlighting a full console spends at most its bucket")
    assert.ok(unmarked > 0, "the rows past the bucket are not marked")
    assert.equal(matcher.slow, false, "running out of highlight budget does not disable the filter")
  })

  test("highlighting that runs its bucket dry does not starve the filter of the next lines", { timeout: 30000 }, () => {
    // A cheap pattern with a match every few characters: testing 2000 rows costs little, highlighting them all costs
    // far more than a bucket. The next batch of lines (non-matching, so each is read to its end) must still be filtered.
    const { log, clock } = storeWithClock()
    log.addEntries(Array.from({ length: 2000 }, (_, i) => entry(("12 ".repeat(1366) + i).slice(-4096))))
    log.regex.value = true
    log.search.value = "[0-9]+"
    assert.equal(update(log).visible, 2000)
    const beforeHighlight = log.matcher.value.spent
    let unmarked = 0
    for (const row of log.rows.value) if (log.matcher.value.ranges(row.entry.message).length === 0) unmarked++
    assert.ok(unmarked > 0, "highlighting ran its bucket dry")
    assert.ok(log.matcher.value.spent - beforeHighlight <= MaxHighlightSteps)
    clock.now += 250
    log.addEntries(Array.from({ length: 150 }, () => entry("a".repeat(4096))))
    const u = update(log)
    assert.equal(u.slow, false, "the filter stays on")
    assert.equal(u.visible, 2000, "and the new lines are filtered out")
    assert.equal(u.counts.info, 2000)
  })

  test("the editor waits for typing to pause before it applies a changed text filter", () => {
    const pending = new Map<number, () => void>()
    let nextHandle = 1
    const timers = {
      setTimeout: (callback: () => void, ms: number) => {
        assert.equal(ms, FilterDebounceMs)
        pending.set(nextHandle, callback)
        return nextHandle++
      },
      clearTimeout: (handle: unknown) => void pending.delete(handle as number),
    }
    const fire = () => {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const callback of callbacks) callback()
    }
    const log = new ConsoleStore(never, { now: () => 1000, clock: () => 0, timers, filterDelayMs: FilterDebounceMs })
    log.addEntries([entry("alpha"), entry("beta")])
    log.regex.value = true
    const first = log.matcher.value
    for (const typed of ["b", "be", "bet", "beta"]) log.search.value = typed
    assert.equal(log.matcher.value, first, "no matcher is compiled while typing")
    assert.equal(log.visible.value.length, 2)
    assert.equal(pending.size, 1, "each change restarts the one wait")
    fire()
    assert.deepEqual(log.visible.value.map((e) => e.message), ["beta"], "the pattern applies once typing pauses")
    log.search.value = ""
    assert.equal(pending.size, 0, "clearing the text applies at once")
    assert.equal(log.visible.value.length, 2)
    log.applyFilterState({ levels: { info: true, warn: true, error: true }, hiddenSources: [], search: "alp", matchCase: false, regex: false, collapse: false })
    assert.equal(pending.size, 0, "the saved filters apply at once")
    assert.deepEqual(log.visible.value.map((e) => e.message), ["alpha"])
  })

  test("a line that passes gets its first match highlighted while the bucket lasts", () => {
    const matcher = compileMatcher({ search: ".{1,100}z", matchCase: false, regex: true })
    const message = "x".repeat(4095) + "z"
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
      update(log)
      assert.ok(Date.now() - started < 10000, pattern)
      assert.ok(log.matcher.value.spent <= MaxUpdateSteps, pattern)
      assert.ok(log.visible.value.length === 0 || log.regexSlow.value, pattern)
    }
  })

  test("the budget is sane", () => {
    assert.ok(MaxUpdateSteps >= MaxRegexInput * 100, "a few ordinary lines never run it dry")
    assert.ok(RegexStepsPerSecond < MaxUpdateSteps, "the refill is slower than one full update")
    assert.ok(TestStepsPerSecond < MaxTestSteps)
    assert.equal(MaxUpdateSteps, MaxTestSteps + MaxHighlightSteps)
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
