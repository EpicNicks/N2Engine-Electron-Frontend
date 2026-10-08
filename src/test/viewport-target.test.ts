import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { InitialPlayState, PlayState } from "../shared/api"
import { editTarget, gameTarget } from "../renderer/viewport-renderer"

describe("frame targets", () => {
  test("the editor view asks for a frame only if it changed, and sizes the editor host", async () => {
    const calls: string[] = []
    const target = editTarget({
      isConnected: () => true,
      renderFrameIfChanged: async (since) => {
        calls.push(`since ${since}`)
        return { revision: since + 1, modified: false, width: 0, height: 0, pixels: new Uint8Array(0) }
      },
      setViewportSize: async (w, h) => void calls.push(`size ${w}x${h}`),
    })
    assert.equal(target.kind, "edit")
    assert.equal((await target.request(4)).modified, false)
    await target.setViewportSize(800, 600)
    assert.deepEqual(calls, ["since 4", "size 800x600"])
  })

  test("the game's frames are always new, and the game is connected only while playing or paused", async () => {
    let state: PlayState = InitialPlayState
    const sizes: string[] = []
    const target = gameTarget({
      state: () => state,
      renderFrame: async () => ({ width: 2, height: 1, pixels: new Uint8Array(8) }),
      setViewportSize: async (w, h) => void sizes.push(`${w}x${h}`),
    })
    assert.equal(target.kind, "game")
    for (const [status, connected] of [
      ["stopped", false],
      ["starting", false],
      ["playing", true],
      ["paused", true],
      ["exited", false],
      ["failed", false],
    ] as const) {
      state = { ...InitialPlayState, status }
      assert.equal(target.isConnected(), connected, status)
    }
    const a = await target.request(0)
    const b = await target.request(a.revision)
    assert.equal(a.modified, true)
    assert.equal(b.modified, true)
    assert.notEqual(a.revision, b.revision)
    assert.equal(a.width, 2)
    await target.setViewportSize(640, 480)
    assert.deepEqual(sizes, ["640x480"])
  })
})
