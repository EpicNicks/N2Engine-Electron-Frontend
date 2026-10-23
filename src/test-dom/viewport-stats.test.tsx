import "./setup"
import { test } from "node:test"
import * as assert from "node:assert/strict"
import { ClientStats } from "../renderer/client-stats"
import { ViewportRenderer, type FrameTarget } from "../renderer/viewport-renderer"
import type { FrameUpdateResponse } from "../protocol/protocol.generated"

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

test("viewport counts successful canvas presentations, excluding unchanged, failed and stale frames", async (t) => {
  let now = 0
  const stats = new ClientStats(() => now)
  stats.connectionChanged(true)
  const callbacks = new Map<number, FrameRequestCallback>()
  let next = 0
  // jsdom deliberately has no graphics surface or ResizeObserver. Restore these local stand-ins after the test.
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const define = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  define("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++next, callback)
    return next
  })
  define("cancelAnimationFrame", (id: number) => { callbacks.delete(id) })
  define("ResizeObserver", class { observe() {} disconnect() {} })
  define("matchMedia", () => ({ addEventListener() {} }))
  define("ImageData", class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} })
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  })
  const canvas = document.createElement("canvas")
  const container = document.createElement("div")
  let presented = 0
  let fail = false
  t.mock.method(canvas, "getContext", (() => ({ putImageData() {
    if (fail) throw new Error("canvas failed")
    presented++
  } })) as unknown as typeof canvas.getContext)
  const pending: Array<(frame: FrameUpdateResponse) => void> = []
  const target: FrameTarget = {
    kind: "edit", isConnected: () => true, setViewportSize: async () => {},
    request: () => new Promise((resolve) => pending.push(resolve)),
  }
  const errors: unknown[] = []
  const renderer = new ViewportRenderer(canvas, container, target, (error) => errors.push(error), { stats })
  t.after(() => renderer.dispose())
  const fire = () => {
    const current = [...callbacks.values()]
    callbacks.clear()
    current.forEach((callback) => callback(now))
  }
  const frame = (modified: boolean): FrameUpdateResponse => ({ revision: 1, modified, width: 1, height: 1,
    pixels: new Uint8Array(modified ? 4 : 0) })
  renderer.start()
  fire()
  now = 20
  pending.shift()!(frame(true))
  await turn()
  now = 1000
  assert.equal(presented, 1)
  assert.equal(stats.snapshot().displayedFramesPerSecond, 1)
  assert.equal(stats.snapshot().editorRequestMs, 20)
  assert.equal(stats.snapshot().editorPixelBytesPerSecond, 4)
  renderer.invalidate()
  fire()
  now = 1020
  pending.shift()!(frame(false))
  await turn()
  assert.equal(presented, 1)
  renderer.invalidate()
  fire()
  renderer.stop()
  renderer.start()
  now = 1040
  pending.shift()!(frame(true))
  await turn()
  assert.equal(presented, 1)
  assert.equal(stats.snapshot().displayedFramesPerSecond, null)
  fire()
  now = 1060
  fail = true
  pending.shift()!(frame(true))
  await turn()
  assert.equal(errors.length, 1)
  assert.equal(presented, 1)
  assert.equal(stats.snapshot().displayedFramesPerSecond, null)
})
