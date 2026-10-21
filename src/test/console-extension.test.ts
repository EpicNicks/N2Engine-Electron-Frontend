import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { EditorEvent } from "../protocol/protocol.generated"
import { ConsoleStore } from "../renderer/console-store"
import { consoleSources } from "../renderer/console-filter"
import { FakeHostEvents, FakeTimers, log } from "./fake-store-api"

const output = (seq: number, extension: string, level: string, message: string, time = 5000): EditorEvent =>
  ({ seq, kind: "extensionOutput", extension, level, message, time }) as EditorEvent

/** A console over a fake host whose events are the given ones; connected and polled once */
async function polled(events: EditorEvent[]) {
  const host = new FakeHostEvents()
  host.events = events
  const timers = new FakeTimers()
  const store = new ConsoleStore(host.poll, { timers, now: () => 1234 })
  store.connect(1)
  await timers.fire()
  return { store, host, timers }
}

describe("extension output in the console", () => {
  test("the Extension source is registered in the page's registry", () => {
    assert.deepEqual(consoleSources.all().find((s) => s.id === "extension"), { id: "extension", label: "Extension" })
  })

  test("an extensionOutput event is a line from the Extension source with the extension's name and its level", async () => {
    const { store } = await polled([output(1, "Align Tools", "warn", "two objects were skipped")])
    assert.deepEqual(store.entries.value, [
      { id: 1, level: "warn", message: "[Align Tools] two objects were skipped", time: 5000, source: "extension" },
    ])
  })

  test("levels: info, warn, error; an unknown level is info", async () => {
    const { store } = await polled([
      output(1, "E", "info", "a"),
      output(2, "E", "warn", "b"),
      output(3, "E", "error", "c"),
      output(4, "E", "debug", "d"),
    ])
    assert.deepEqual(store.entries.value.map((e) => e.level), ["info", "warn", "error", "info"])
  })

  test("text stays text: markup, script and control characters are not interpreted or kept", async () => {
    const hostile = `<img src=x onerror="alert(1)"> <script>boom()</script>\u0007\r`
    const { store } = await polled([output(1, "<b>Evil</b>", "info", hostile)])
    const [entry] = store.entries.value
    assert.equal(entry.message, `[<b>Evil</b>] <img src=x onerror="alert(1)"> <script>boom()</script>??`)
    assert.equal(entry.source, "extension")
  })

  test("a line the host did not time is stamped now", async () => {
    const { store } = await polled([output(1, "E", "info", "x", 0)])
    assert.equal(store.entries.value[0].time, 1234)
  })

  test("the source's chip counts them, and hiding it hides them", async () => {
    const { store } = await polled([output(1, "E", "info", "from the extension"), log(2, "from the host")])
    assert.deepEqual(store.sourceCounts.value, { host: 1, extension: 1 })
    store.toggleSource("extension")
    assert.deepEqual(store.visible.value.map((e) => e.message), ["from the host"])
  })

  test("the host's mirrored Admin log line is not shown twice, whichever comes first", async () => {
    const mirrored = (seq: number) => log(seq, "extension Align Tools: snapped 3")
    const first = await polled([output(1, "Align Tools", "info", "snapped 3"), mirrored(2)])
    assert.deepEqual(first.store.entries.value.map((e) => [e.source, e.message]), [["extension", "[Align Tools] snapped 3"]])
    const second = await polled([mirrored(1), output(2, "Align Tools", "info", "snapped 3")])
    assert.deepEqual(second.store.entries.value.map((e) => [e.source, e.message]), [["extension", "[Align Tools] snapped 3"]])
  })

  test("the mirror can come in a later poll; and a log line that is not a mirror is kept", async () => {
    const { store, host, timers } = await polled([output(1, "E", "info", "hi")])
    host.events.push(log(2, "extension E: hi"), log(3, "extension E: something else"), log(4, "an ordinary line"))
    await timers.fire()
    assert.deepEqual(store.entries.value.map((e) => e.message), [
      "[E] hi",
      "extension E: something else",
      "an ordinary line",
    ])
  })

  test("two identical output lines are two lines, and each mirror is dropped once", async () => {
    const { store } = await polled([
      output(1, "E", "info", "same"),
      output(2, "E", "info", "same"),
      log(3, "extension E: same"),
      log(4, "extension E: same"),
      log(5, "extension E: same"),
    ])
    assert.deepEqual(store.entries.value.map((e) => e.message), ["[E] same", "[E] same", "extension E: same"])
  })

  test("an event with no message is not a line", async () => {
    const { store } = await polled([{ seq: 1, kind: "extensionOutput", extension: "E", level: "info" } as EditorEvent])
    assert.deepEqual(store.entries.value, [])
  })
})
