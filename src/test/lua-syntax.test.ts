import { test } from "node:test"
import * as assert from "node:assert/strict"
import { LuaSyntaxScheduler, LuaSyntaxResult, SyntaxTimers, syntaxDiagnostic } from "../renderer/lua/lua-syntax"
class Timers implements SyntaxTimers {
  tasks = new Map<number, () => void>(); next = 0
  set(fn: () => void, delay: number) { assert.equal(delay, 500); const id = ++this.next; this.tasks.set(id, fn); return id }
  clear(id: unknown) { this.tasks.delete(id as number) }
  fire() { const tasks = [...this.tasks.values()]; this.tasks.clear(); tasks.forEach(fn => fn()) }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
test("syntax diagnostics use 1-based lines/columns and clamp malformed locations to the document", () => {
  assert.deepEqual(syntaxDiagnostic("a\nbad line\nc", { ok: false, line: 2, column: 3, message: "bad" }),
    [{ from: 4, to: 5, severity: "error", message: "bad" }])
  assert.deepEqual(syntaxDiagnostic("a\nb", { ok: true, line: 0, message: "" }), [])
  assert.equal(syntaxDiagnostic("a", { ok: false, line: 99, column: 99, message: "bad" })[0].from, 1)
})
test("debounce, one in-flight request, stale-result rejection and latest queued document", async () => {
  const timers = new Timers(), sent: string[] = [], published: string[] = []
  const pending: ((result: LuaSyntaxResult) => void)[] = []
  const scheduler = new LuaSyntaxScheduler(async text => { sent.push(text); return new Promise(resolve => pending.push(resolve)) },
    diagnostics => { if (diagnostics.length) published.push(diagnostics[0].message) }, timers)
  scheduler.update("old", "old.lua"); scheduler.update("first", "first.lua"); timers.fire()
  assert.deepEqual(sent, ["first"])
  scheduler.update("second", "second.lua"); timers.fire(); scheduler.update("latest", "latest.lua"); timers.fire()
  assert.deepEqual(sent, ["first"])
  pending.shift()!({ ok: false, line: 1, message: "stale" }); await tick()
  assert.deepEqual(sent, ["first", "latest"]); assert.deepEqual(published, [])
  pending.shift()!({ ok: false, line: 1, message: "current" }); await tick()
  assert.deepEqual(published, ["current"])
  scheduler.dispose()
})
test("disposed editors ignore late replies and network errors are not Lua syntax errors", async () => {
  const timers = new Timers(), updates: unknown[] = []
  let reply!: (result: LuaSyntaxResult) => void
  const scheduler = new LuaSyntaxScheduler(() => new Promise(resolve => reply = resolve), (...result) => updates.push(result), timers)
  scheduler.update("text", "a.lua"); timers.fire(); scheduler.dispose(); const before = updates.length
  reply({ ok: false, line: 1, message: "late" }); await tick(); assert.equal(updates.length, before)
  const errors: string[] = []
  const failed = new LuaSyntaxScheduler(async () => { throw new Error("offline") }, (diagnostics, error) => { assert.deepEqual(diagnostics, []); if (error) errors.push(error) }, timers)
  failed.update("text", "a.lua"); timers.fire(); await tick(); assert.match(errors[0], /unavailable.*offline/)
})
