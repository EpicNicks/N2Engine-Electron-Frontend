import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { ConsoleStore, ConsoleEntry, LogLevel } from "../renderer/console-store"
import {
  ConsoleSourceRegistry,
  MaxPatternLength,
  collapseRepeats,
  compileMatcher,
  consoleSources,
  highlightPieces,
} from "../renderer/console-filter"
import { ConsoleFilterPref, DefaultConsoleFilter, attachConsoleFilterPrefs } from "../renderer/console-filter-prefs"
import { KeyValueStore, PrefsStore, Schedule, prefStorageKey } from "../renderer/prefs"

const never = async () => ({ epoch: 1, nextSeq: 1, dropped: 0, events: [] }) as never

function store(registry?: ConsoleSourceRegistry): ConsoleStore {
  return new ConsoleStore(never, { now: () => 1000, sources: registry })
}

const line = (level: LogLevel, message: string, source = "host", time = 1): Omit<ConsoleEntry, "id"> => ({
  level,
  message,
  source,
  time,
})
const messages = (log: ConsoleStore) => log.visible.value.map((e) => e.message)

describe("the text matcher", () => {
  test("plain text ignores case unless asked; no text passes everything", () => {
    const loose = compileMatcher({ search: "Err", matchCase: false, regex: false })
    assert.equal(loose.test("an ERROR"), true)
    assert.equal(loose.test("fine"), false)
    assert.equal(compileMatcher({ search: "Err", matchCase: true, regex: false }).test("an ERROR"), false)
    assert.equal(compileMatcher({ search: "ERR", matchCase: true, regex: false }).test("an ERROR"), true)
    const none = compileMatcher({ search: "", matchCase: false, regex: true })
    assert.equal(none.test("anything"), true)
    assert.equal(none.active, false)
  })

  test("plain text is not a pattern: regex characters are literal", () => {
    const m = compileMatcher({ search: "a.c(", matchCase: false, regex: false })
    assert.equal(m.test("xa.c(y"), true)
    assert.equal(m.test("abc"), false)
    assert.equal(m.error, null)
  })

  test("a regular expression matches, with case when asked", () => {
    const m = compileMatcher({ search: "^load \\d+ files", matchCase: false, regex: true })
    assert.equal(m.test("Load 12 files"), true)
    assert.equal(m.test("Load x files"), false)
    assert.equal(compileMatcher({ search: "^load", matchCase: true, regex: true }).test("Load"), false)
    // The same matcher can be used again and again (a global regex keeps lastIndex)
    for (let i = 0; i < 4; i++) assert.equal(m.test("Load 12 files"), true)
  })

  test("an invalid pattern passes everything and says why; a too long one is refused the same way", () => {
    const bad = compileMatcher({ search: "(", matchCase: false, regex: true })
    assert.equal(bad.test("anything"), true)
    assert.ok(bad.error && bad.error.length > 0)
    assert.equal(bad.active, false)
    const long = compileMatcher({ search: "a".repeat(MaxPatternLength + 1), matchCase: false, regex: true })
    assert.ok(long.error?.includes(String(MaxPatternLength)))
    // The same text is fine as plain text
    assert.equal(compileMatcher({ search: "(", matchCase: false, regex: false }).error, null)
  })

  test("a nested repeat is no longer refused: it is matched in linear time (safe-regex.test.ts has the corpus)", () => {
    for (const bomb of ["(a+)+$", "(a*)*b", "((a+))+", "(a|aa)+$", "(x+x+)+y"]) {
      const m = compileMatcher({ search: bomb, matchCase: false, regex: true })
      assert.equal(m.error, null, bomb)
      assert.equal(m.active, true)
    }
    assert.equal(compileMatcher({ search: "(a+)+$", matchCase: false, regex: true }).test("a".repeat(4000) + "!"), false)
  })

  test("a regex looks at a bounded part of a very long line", () => {
    const m = compileMatcher({ search: "needle$", matchCase: false, regex: true })
    assert.equal(m.test("x".repeat(100000) + "needle"), false)
    assert.equal(m.test("needle"), true)
  })

  test("ranges for highlighting: every match, in order, empty matches skipped without looping", () => {
    assert.deepEqual(compileMatcher({ search: "ab", matchCase: false, regex: false }).ranges("xAByabab"), [
      [1, 3],
      [4, 6],
      [6, 8],
    ])
    assert.deepEqual(compileMatcher({ search: "\\d+", matchCase: false, regex: true }).ranges("a12b345"), [
      [1, 3],
      [4, 7],
    ])
    assert.deepEqual(compileMatcher({ search: "x*", matchCase: false, regex: true }).ranges("abc"), [])
    assert.deepEqual(compileMatcher({ search: "", matchCase: false, regex: false }).ranges("abc"), [])
  })

  test("pieces cut a message at the ranges", () => {
    assert.deepEqual(highlightPieces("a12b", [[1, 3]]), [
      { text: "a", match: false },
      { text: "12", match: true },
      { text: "b", match: false },
    ])
    assert.deepEqual(highlightPieces("abc", []), [{ text: "abc", match: false }])
  })
})

describe("the source registry", () => {
  test("host, game and editor are there; registering adds one, and again only renames it", () => {
    assert.deepEqual(
      consoleSources.all().map((s) => s.id),
      ["host", "game", "editor"]
    )
    const registry = new ConsoleSourceRegistry([{ id: "host", label: "Host" }])
    registry.register({ id: "extension", label: "Extension" })
    registry.register({ id: "extension", label: "Extensions" })
    assert.deepEqual(registry.all(), [
      { id: "host", label: "Host" },
      { id: "extension", label: "Extensions" },
    ])
    assert.equal(registry.has("extension"), true)
    assert.equal(registry.has("nope"), false)
  })

  test("an extension registers its own source and its lines can be filtered like the others", () => {
    const registry = new ConsoleSourceRegistry([
      { id: "host", label: "Host" },
      { id: "editor", label: "Editor" },
    ])
    const log = store(registry)
    log.addEntries([line("info", "host line"), line("info", "ext line", "extension")])
    // Not registered yet: it counts as the host's
    assert.deepEqual(log.sourceCounts.value, { host: 2 })
    registry.register({ id: "extension", label: "Extension" })
    log.entries.value = [...log.entries.value] // a change of the lines re-reads the registry
    assert.deepEqual(log.sourceCounts.value, { host: 1, extension: 1 })
    log.toggleSource("extension")
    assert.deepEqual(messages(log), ["host line"])
  })

  test("an unknown source is grouped with the host: hiding the host hides it, hiding nothing shows it", () => {
    const log = store()
    log.addEntries([line("info", "a", "host"), line("info", "b", "mystery"), line("info", "c", "game")])
    assert.deepEqual(messages(log), ["a", "b", "c"])
    log.toggleSource("host")
    assert.deepEqual(messages(log), ["c"])
    log.toggleSource("host")
    log.toggleSource("game")
    assert.deepEqual(messages(log), ["a", "b"])
  })
})

describe("the console's filters", () => {
  test("levels, sources and text combine; counts follow the source and text filters, not the level toggles", () => {
    const log = store()
    log.addEntries([
      line("info", "loaded scene", "host"),
      line("warn", "slow frame", "game"),
      line("error", "scene failed", "host"),
      line("info", "scene saved", "editor"),
    ])
    assert.deepEqual(log.counts.value, { info: 2, warn: 1, error: 1 })
    log.search.value = "scene"
    assert.deepEqual(log.counts.value, { info: 2, warn: 0, error: 1 })
    log.toggleSource("editor")
    assert.deepEqual(log.counts.value, { info: 1, warn: 0, error: 1 })
    log.toggleLevel("error")
    assert.deepEqual(messages(log), ["loaded scene"])
    assert.deepEqual(log.counts.value, { info: 1, warn: 0, error: 1 }, "a level switched off still says how many it has")
    // Sources count what the levels and text show
    assert.deepEqual(log.sourceCounts.value, { host: 1, editor: 1 })
  })

  test("regex is off by default and when on an invalid pattern shows everything", () => {
    const log = store()
    log.addEntries([line("info", "a(b"), line("info", "ab")])
    log.search.value = "a(b"
    assert.deepEqual(messages(log), ["a(b"], "plain")
    log.regex.value = true
    assert.ok(log.matcher.value.error)
    assert.deepEqual(messages(log), ["a(b", "ab"])
    log.search.value = "a.?b"
    assert.equal(log.matcher.value.error, null)
    assert.deepEqual(messages(log), ["a(b", "ab"])
    log.search.value = "^ab$"
    assert.deepEqual(messages(log), ["ab"])
    log.matchCase.value = true
    log.search.value = "^AB$"
    assert.deepEqual(messages(log), [])
  })

  test("collapse: consecutive identical lines become one row with the count; the first line keeps the key", () => {
    const log = store()
    log.addEntries([
      line("info", "tick", "host", 10),
      line("info", "tick", "host", 11),
      line("info", "tick", "host", 12),
      line("warn", "tick", "host", 13),
      line("info", "tick", "game", 14),
      line("info", "tock", "host", 15),
      line("info", "tick", "host", 16),
    ])
    assert.equal(log.rows.value.length, 7, "off: one row per line")
    log.collapse.value = true
    assert.deepEqual(
      log.rows.value.map((r) => [r.entry.message, r.entry.level, r.entry.source, r.count, r.lastTime]),
      [
        ["tick", "info", "host", 3, 12],
        ["tick", "warn", "host", 1, 13],
        ["tick", "info", "game", 1, 14],
        ["tock", "info", "host", 1, 15],
        ["tick", "info", "host", 1, 16],
      ]
    )
    const key = log.rows.value[0].entry.id
    log.addEntries([line("info", "tick", "host", 17)])
    assert.equal(log.rows.value[log.rows.value.length - 1].count, 2)
    log.addEntries([line("info", "tick", "host", 18)])
    assert.equal(log.rows.value[0].entry.id, key)
    // The lines are unchanged by collapsing, and so are the counts
    assert.equal(log.visible.value.length, 9)
    assert.deepEqual(log.counts.value, { info: 8, warn: 1, error: 0 })
  })

  test("collapse works over what the filters show: a hidden line does not split a run", () => {
    const log = store()
    log.addEntries([line("info", "a"), line("warn", "b"), line("info", "a")])
    log.collapse.value = true
    assert.equal(log.rows.value.length, 3)
    log.toggleLevel("warn")
    assert.deepEqual(
      log.rows.value.map((r) => r.count),
      [2]
    )
    assert.deepEqual(collapseRepeats([]), [])
  })

  test("clear empties the lines but keeps the filters", () => {
    const log = store()
    log.addEntries([line("info", "x")])
    log.search.value = "x"
    log.collapse.value = true
    log.clear()
    assert.equal(log.visible.value.length, 0)
    assert.equal(log.search.value, "x")
    assert.equal(log.collapse.value, true)
  })

  test("10,000 lines: still capped at the store's limit, and every derived view is one pass", () => {
    const log = new ConsoleStore(never, { now: () => 1 })
    const lines: Array<Omit<ConsoleEntry, "id">> = []
    for (let i = 0; i < 10000; i++) lines.push(line(i % 50 === 0 ? "error" : "info", `line ${i % 100} of the log`, i % 3 === 0 ? "game" : "host"))
    const started = Date.now()
    log.addEntries(lines)
    log.search.value = "line 4"
    log.regex.value = true
    log.search.value = "line 4\\d of"
    log.collapse.value = true
    const rows = log.rows.value.length
    const counts = log.counts.value
    const elapsed = Date.now() - started
    assert.equal(log.entries.value.length, 5000, "the store keeps the newest 5000, as before")
    assert.ok(rows > 0)
    assert.ok(counts.info + counts.error > 0)
    assert.ok(elapsed < 1500, `took ${elapsed} ms`)
  })
})

// ==================== Persistence ====================

class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>()
  broken = false
  get(key: string): string | null {
    if (this.broken) throw new Error("unavailable")
    return this.data.get(key) ?? null
  }
  set(key: string, value: string): void {
    if (this.broken) throw new Error("unavailable")
    this.data.set(key, value)
  }
  remove(key: string): void {
    if (this.broken) throw new Error("unavailable")
    this.data.delete(key)
  }
}
const P1 = "11111111-1111-4111-8111-111111111111"
const P2 = "22222222-2222-4222-8222-222222222222"
function manual() {
  const pending: Array<() => void> = []
  const schedule: Schedule = (callback) => {
    pending.push(callback)
    return () => void pending.splice(pending.indexOf(callback) >>> 0, 1)
  }
  return { schedule, run: () => pending.splice(0).forEach((callback) => callback()) }
}

describe("the console filters are kept per project", () => {
  test("round trip through the preferences, debounced", () => {
    const storage = new MemoryStore()
    const clock = manual()
    const log = store()
    const detach = attachConsoleFilterPrefs(log, new PrefsStore(storage, clock.schedule).project(P1))
    assert.equal(storage.data.size, 0, "attaching with nothing saved writes nothing")
    log.toggleLevel("info")
    log.toggleSource("game")
    log.search.value = "boom"
    log.matchCase.value = true
    log.regex.value = true
    log.collapse.value = true
    assert.equal(storage.data.size, 0)
    clock.run()
    const saved = JSON.parse(storage.data.get(prefStorageKey(ConsoleFilterPref, P1))!).value
    assert.deepEqual(saved, {
      levels: { info: false, warn: true, error: true },
      hiddenSources: ["game"],
      search: "boom",
      matchCase: true,
      regex: false, // the switch is never kept: a pattern that hangs would hang every launch
      collapse: true,
    })
    detach()

    const next = store()
    attachConsoleFilterPrefs(next, new PrefsStore(storage, clock.schedule).project(P1))
    assert.deepEqual(next.filterState.value, saved)
    assert.equal(next.shown.value.info, false)
    assert.equal(next.hiddenSources.value.has("game"), true)
    // Another project is untouched
    const other = store()
    attachConsoleFilterPrefs(other, new PrefsStore(storage, clock.schedule).project(P2))
    assert.deepEqual(other.filterState.value, DefaultConsoleFilter)
  })

  test("a damaged entry is not used: wrong types fall back field by field, garbage falls back whole", () => {
    const storage = new MemoryStore()
    const key = prefStorageKey(ConsoleFilterPref, P1)
    storage.data.set(key, JSON.stringify({ version: 1, value: { levels: { info: "no", warn: false }, hiddenSources: "game", search: 4, regex: true } }))
    const log = store()
    attachConsoleFilterPrefs(log, new PrefsStore(storage).project(P1))
    assert.deepEqual(log.filterState.value, {
      ...DefaultConsoleFilter,
      levels: { info: true, warn: false, error: true },
      regex: false,
    })
    for (const bad of ["{", JSON.stringify({ version: 1, value: 5 }), JSON.stringify({ version: 1, value: { search: "x".repeat(300) } })]) {
      storage.data.set(key, bad)
      const fresh = store()
      attachConsoleFilterPrefs(fresh, new PrefsStore(storage).project(P1))
      assert.equal(fresh.search.value, "")
    }
  })

  test("blocked storage still lets the filters work", () => {
    const storage = new MemoryStore()
    storage.broken = true
    const log = store()
    const detach = attachConsoleFilterPrefs(log, new PrefsStore(storage, manual().schedule).project(P1))
    log.search.value = "still"
    log.addEntries([line("info", "still here")])
    assert.deepEqual(messages(log), ["still here"])
    detach()
  })
})
