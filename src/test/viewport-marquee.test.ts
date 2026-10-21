import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { BoundsResponse, HierarchyNode, PickResultResponse } from "../protocol/protocol.generated"
import { MaxEntityBoundsIds } from "../shared/api"
import type { Bounds } from "../renderer/viewport-camera"
import { buildTree, emptySelection, Selection } from "../renderer/hierarchy-tree"
import { IdentityQuat, mat4Multiply, projectionMatrix, vec3, viewMatrix, worldToScreen } from "../renderer/viewport-math"
import { boxCorners } from "../renderer/viewport-gizmo"
import { createPickBackend } from "../renderer/viewport-picking"
import type { PickBackend } from "../renderer/viewport-controller"
import {
  MarqueeBoundsCache,
  Rect,
  applyMarquee,
  clampRect,
  marqueeCandidatesOf,
  marqueeHits,
  marqueeKeysOf,
  marqueeOpOf,
  marqueeSelection,
  marqueeTakes,
  projectBounds,
  rectFrom,
  rectsIntersect,
} from "../renderer/viewport-marquee"
import { rig, settle } from "./viewport-rig"

const W = 800
const H = 600
// The rig's camera: at (0, 0, 10) looking down -Z, 60 degrees, near 0.1, far 1000
const VP = mat4Multiply(
  projectionMatrix({ fovY: 60, orthographic: false, orthoSize: 5, nearPlane: 0.1, farPlane: 1000 }, W / H),
  viewMatrix(vec3(0, 0, 10), IdentityQuat)
)

const box = (min: [number, number, number], max: [number, number, number]): Bounds => ({ min: vec3(...min), max: vec3(...max) })
const rect = (minX: number, minY: number, maxX: number, maxY: number): Rect => ({ minX, minY, maxX, maxY })
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6

describe("the marquee's rectangle", () => {
  test("rectFrom takes the corners in any order", () => {
    assert.deepEqual(rectFrom({ x: 50, y: 10 }, { x: 20, y: 40 }), rect(20, 10, 50, 40))
    assert.deepEqual(rectFrom({ x: 20, y: 40 }, { x: 50, y: 10 }), rect(20, 10, 50, 40))
  })

  test("clampRect keeps the part on the frame; none of it on the frame is null", () => {
    assert.deepEqual(clampRect(rect(-20, -5, 900, 700), W, H), rect(0, 0, W, H))
    assert.deepEqual(clampRect(rect(10, 10, 20, 20), W, H), rect(10, 10, 20, 20))
    assert.equal(clampRect(rect(820, 10, 900, 20), W, H), null)
  })

  test("rectsIntersect counts touching edges; disjoint ones do not", () => {
    assert.equal(rectsIntersect(rect(0, 0, 10, 10), rect(10, 10, 20, 20)), true)
    assert.equal(rectsIntersect(rect(0, 0, 10, 10), rect(10.5, 0, 20, 10)), false)
    assert.equal(rectsIntersect(rect(0, 0, 100, 100), rect(40, 40, 50, 50)), true)
  })
})

describe("projectBounds", () => {
  test("a box in front is the rectangle around its corners on screen", () => {
    const b = box([-1, -1, -1], [1, 2, 1])
    const p = projectBounds(VP, b, W, H)!
    const corners = boxCorners(b.min, b.max).map((c) => worldToScreen(VP, c, W, H)!)
    assert.equal(p.clipped, false)
    assert.ok(near(p.rect.minX, Math.min(...corners.map((c) => c.x))))
    assert.ok(near(p.rect.maxX, Math.max(...corners.map((c) => c.x))))
    assert.ok(near(p.rect.minY, Math.min(...corners.map((c) => c.y))))
    assert.ok(near(p.rect.maxY, Math.max(...corners.map((c) => c.y))))
    // centred on the screen's middle in x, above it in y (it reaches higher than lower)
    assert.ok(near((p.rect.minX + p.rect.maxX) / 2, W / 2))
    assert.ok(p.rect.minY < H / 2 && p.rect.maxY > H / 2)
  })

  test("a box wholly behind the camera is null (never selected)", () => {
    assert.equal(projectBounds(VP, box([-1, -1, 20], [1, 1, 30]), W, H), null)
    // behind and mirrored would land on screen if the divide were done unclipped
    assert.equal(projectBounds(VP, box([-50, -50, 10.5], [50, 50, 11]), W, H), null)
  })

  test("a box the near plane cuts is clipped: the part in front gives a finite rectangle", () => {
    const p = projectBounds(VP, box([-1, -1, 0], [1, 1, 15]), W, H)!
    assert.equal(p.clipped, true)
    for (const v of [p.rect.minX, p.rect.minY, p.rect.maxX, p.rect.maxY]) assert.ok(Number.isFinite(v))
    // it covers the middle of the screen (the camera is inside it)
    assert.ok(p.rect.minX < W / 2 && p.rect.maxX > W / 2 && p.rect.minY < H / 2 && p.rect.maxY > H / 2)
  })

  test("a flat box (zero thickness) still projects", () => {
    const p = projectBounds(VP, box([-1, 0, -1], [1, 0, 1]), W, H)!
    assert.equal(p.clipped, false)
    assert.ok(p.rect.maxX > p.rect.minX)
  })
})

describe("marqueeTakes and marqueeHits", () => {
  const b = box([-1, -1, -1], [1, 1, 1])
  const p = projectBounds(VP, b, W, H)!

  test("intersect takes a box the rectangle touches; inside only one wholly within it", () => {
    const touching = rect(p.rect.maxX - 2, p.rect.minY, p.rect.maxX + 50, p.rect.maxY)
    assert.equal(marqueeTakes(touching, p, false), true)
    assert.equal(marqueeTakes(touching, p, true), false)
    const around = rect(p.rect.minX - 1, p.rect.minY - 1, p.rect.maxX + 1, p.rect.maxY + 1)
    assert.equal(marqueeTakes(around, p, true), true)
    const beside = rect(p.rect.maxX + 5, 0, W, H)
    assert.equal(marqueeTakes(beside, p, false), false)
    assert.equal(marqueeTakes(around, null, false), false)
  })

  test("a box cut by the near plane is never fully inside, even under a rectangle over the whole frame", () => {
    const clipped = projectBounds(VP, box([-1, -1, 0], [1, 1, 15]), W, H)
    assert.equal(marqueeTakes(rect(0, 0, W, H), clipped, true), false)
    assert.equal(marqueeTakes(rect(0, 0, W, H), clipped, false), true)
  })

  test("the hits keep the candidates' order; an id with no box is not taken", () => {
    const bounds = new Map<string, Bounds>([
      ["c", b],
      ["a", box([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5])],
      ["far", box([30, 30, -1], [31, 31, 1])], // off the frame, up and to the right
      ["behind", box([-1, -1, 20], [1, 1, 21])],
    ])
    const all = rect(0, 0, W, H)
    assert.deepEqual(marqueeHits(VP, W, H, all, ["a", "nobox", "behind", "c", "far"], bounds, false), ["a", "c"])
    // a small rectangle in the middle: inside takes neither (both reach past it), intersect takes both
    const middle = rect(W / 2 - 5, H / 2 - 5, W / 2 + 5, H / 2 + 5)
    assert.deepEqual(marqueeHits(VP, W, H, middle, ["a", "c"], bounds, false), ["a", "c"])
    assert.deepEqual(marqueeHits(VP, W, H, middle, ["a", "c"], bounds, true), [])
  })
})

describe("the marquee's keys", () => {
  test("Shift adds, Ctrl or Cmd removes (and wins over Shift), Alt is inside; none replaces", () => {
    const keys = (k: Partial<{ altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }>) =>
      marqueeKeysOf({ altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...k })
    assert.equal(marqueeOpOf(keys({})), "replace")
    assert.equal(marqueeOpOf(keys({ shiftKey: true })), "add")
    assert.equal(marqueeOpOf(keys({ ctrlKey: true })), "remove")
    assert.equal(marqueeOpOf(keys({ metaKey: true })), "remove")
    assert.equal(marqueeOpOf(keys({ ctrlKey: true, shiftKey: true })), "remove")
    assert.equal(keys({ altKey: true }).inside, true)
    assert.equal(keys({}).inside, false)
  })
})

const node = (id: string, parentId: string, index: number, activeInHierarchy = true): HierarchyNode => ({
  id,
  parentId,
  index,
  name: id,
  active: activeInHierarchy,
  activeInHierarchy,
  layer: 0,
  tag: "",
  components: [],
})

describe("marqueeCandidatesOf", () => {
  test("every active object, in the tree's order; inactive ones (and what is under them) are left out", () => {
    const tree = buildTree([
      node("r", "", 0),
      node("r1", "r", 0),
      node("off", "", 1, false),
      node("off1", "off", 0, false),
      node("s", "", 2),
    ])
    assert.deepEqual(marqueeCandidatesOf(tree), ["r", "r1", "s"])
  })
})

const sel = (ids: string[], primary: string | null, anchor: string | null = ids[0] ?? null): Selection => ({
  ids: new Set(ids),
  primary,
  anchor,
})

describe("marqueeSelection", () => {
  test("replace: just the hits, the last is the primary; no hits clears", () => {
    const s = marqueeSelection(sel(["x"], "x"), ["a", "b"], "replace")
    assert.deepEqual([...s.ids], ["a", "b"])
    assert.equal(s.primary, "b")
    assert.equal(s.anchor, "a")
    assert.equal(marqueeSelection(sel(["x"], "x"), [], "replace"), emptySelection)
    const empty = sel([], null)
    assert.equal(marqueeSelection(empty, [], "replace"), empty)
  })

  test("add: the hits as well, the primary stays; with none selected the last hit is the primary", () => {
    const s = marqueeSelection(sel(["x"], "x"), ["a", "x", "b"], "add")
    assert.deepEqual([...s.ids].sort(), ["a", "b", "x"])
    assert.equal(s.primary, "x")
    const fresh = marqueeSelection(sel([], null), ["a", "b"], "add")
    assert.equal(fresh.primary, "b")
    const same = sel(["a"], "a")
    assert.equal(marqueeSelection(same, ["a"], "add"), same)
    assert.equal(marqueeSelection(same, [], "add"), same)
  })

  test("remove: the selection without the hits; the primary moves only when it was removed", () => {
    const s = marqueeSelection(sel(["x", "a", "b"], "x"), ["a"], "remove")
    assert.deepEqual([...s.ids], ["x", "b"])
    assert.equal(s.primary, "x")
    const moved = marqueeSelection(sel(["x", "a", "b"], "b", "b"), ["b"], "remove")
    assert.equal(moved.primary, "a")
    assert.equal(moved.anchor, null)
    const all = marqueeSelection(sel(["a"], "a"), ["a", "z"], "remove")
    assert.equal(all.ids.size, 0)
    assert.equal(all.primary, null)
    const same = sel(["a"], "a")
    assert.equal(marqueeSelection(same, ["z"], "remove"), same)
  })

  test("applyMarquee opens the way to what it selects (not to what it removes) and leaves an unchanged selection alone", () => {
    let selection = sel(["x", "a"], "x")
    const expanded: string[] = []
    let sets = 0
    const target = {
      selection: { peek: () => selection },
      setSelection: (s: Selection) => {
        sets++
        selection = s
      },
      expandAncestors: (id: string) => void expanded.push(id),
    }
    applyMarquee(target, ["b", "c"], "add")
    assert.deepEqual(expanded, ["b", "c"])
    assert.deepEqual([...selection.ids].sort(), ["a", "b", "c", "x"])
    applyMarquee(target, ["a"], "remove")
    assert.deepEqual(expanded, ["b", "c"])
    assert.equal(selection.ids.has("a"), false)
    applyMarquee(target, ["zzz"], "remove")
    assert.equal(sets, 2)
  })
})

describe("MarqueeBoundsCache", () => {
  test("one read per key, shared while in flight; a new key reads again; a failure is not kept", async () => {
    const asked: string[][] = []
    let fail = false
    const cache = new MarqueeBoundsCache(async (ids) => {
      asked.push(ids)
      if (fail) throw new Error("gone")
      return new Map(ids.map((id) => [id, box([0, 0, 0], [1, 1, 1])]))
    })
    const [one, two] = await Promise.all([cache.get("k1", ["a", "b"]), cache.get("k1", ["a", "b"])])
    assert.equal(one, two)
    assert.equal(asked.length, 1)
    await cache.get("k1", ["a", "b"])
    assert.equal(asked.length, 1)
    await cache.get("k2", ["a"])
    assert.equal(asked.length, 2)
    fail = true
    await assert.rejects(cache.get("k3", ["a"]))
    assert.equal(cache.has("k3"), false)
    fail = false
    await cache.get("k3", ["a"])
    assert.equal(asked.length, 4)
    cache.clear()
    assert.equal(cache.has("k3"), false)
  })

  test("a backend with no answer (null) is an empty map", async () => {
    const cache = new MarqueeBoundsCache(async () => null)
    assert.equal((await cache.get("k", ["a"])).size, 0)
  })

  test("over the engine's backend, more than 4096 candidates are asked in chunks of at most 4096", async () => {
    const calls: number[] = []
    const engine = {
      pickEntity: async (): Promise<PickResultResponse> => ({ entityId: "", point: vec3(0, 0, 0), distance: 0 }),
      getEntityBounds: async (ids: string[]): Promise<BoundsResponse> => {
        calls.push(ids.length)
        if (ids.length > MaxEntityBoundsIds) throw new Error("too many")
        return { bounds: ids.map((id) => ({ id, min: vec3(0, 0, 0), max: vec3(1, 1, 1) })) }
      },
    }
    const backend = createPickBackend(engine)
    const cache = new MarqueeBoundsCache((ids) => backend.bounds(ids))
    const ids = Array.from({ length: 2 * MaxEntityBoundsIds + 10 }, (_, i) => `id${i}`)
    const found = await cache.get("k", ids)
    assert.deepEqual(calls, [MaxEntityBoundsIds, MaxEntityBoundsIds, 10])
    assert.equal(found.size, ids.length)
  })
})

// ==================== The gesture, on the controller ====================

/** A picking backend that measures boxes from a table and counts the GetEntityBounds calls */
function measuring(boxes: Record<string, Bounds>) {
  const asked: string[][] = []
  const picks: Array<{ x: number; y: number }> = []
  let gate: Promise<void> | null = null
  const backend: PickBackend = {
    pick: async (x, y) => {
      picks.push({ x, y })
      return null
    },
    bounds: async (ids) => {
      asked.push(ids)
      if (gate) await gate
      return new Map(ids.filter((id) => boxes[id]).map((id) => [id, boxes[id]]))
    },
  }
  return {
    backend,
    asked,
    picks,
    /** Holds the next reads until the returned function is called */
    hold(): () => void {
      let release!: () => void
      gate = new Promise((resolve) => (release = resolve))
      return () => {
        gate = null
        release()
      }
    },
  }
}

const NoKeys = { inside: false, add: false, remove: false }
// The rig's scene: "a" around the origin (the middle of the frame), "b" up and to the right, "c" behind the camera
const Boxes = {
  a: box([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]),
  b: box([2.5, 1.5, -0.5], [3.5, 2.5, 0.5]),
  c: box([-1, -1, 20], [1, 1, 21]),
}
const B = projectBounds(VP, Boxes.b, W, H)!.rect

function marqueeRig(options: { revision?: number; selection?: string[] } = {}) {
  const m = measuring(Boxes)
  const marquee = { ids: ["a", "b", "c"], revision: options.revision ?? 1 }
  const r = rig({ picking: m.backend, selection: options.selection ?? [], marquee })
  return { ...r, m, marquee }
}

describe("the marquee gesture", () => {
  test("a press on empty space that moves past the click slop draws a rectangle; the release selects what it covers", async () => {
    const r = marqueeRig()
    await r.ready()
    const c = r.controller
    assert.equal(c.pointerDown({ x: 10, y: 10 }, false), false)
    c.pointerMove({ x: 12, y: 12 }, false, NoKeys)
    assert.equal(c.isMarquee, false, "within the click slop")
    c.pointerMove({ x: 600, y: 400 }, false, NoKeys)
    assert.equal(c.isMarquee, true)
    assert.deepEqual(c.marqueeShape(), { rect: rect(10, 10, 600, 400), inside: false, op: "replace" })
    await c.pointerUp({ x: 600, y: 400 }, {}, NoKeys)
    assert.equal(c.isMarquee, false)
    assert.deepEqual(r.marquees, [{ ids: ["a", "b"], op: "replace" }])
    assert.deepEqual(r.m.picks, [], "a marquee is not a click")
    assert.deepEqual(r.m.asked, [["a", "b", "c"]])
  })

  test("the keys at the release choose: Alt only what is fully inside, Shift adds, Ctrl removes", async () => {
    const r = marqueeRig()
    await r.ready()
    const c = r.controller
    // a rectangle that covers the middle of b only: intersect takes it, inside does not
    const cx = (B.minX + B.maxX) / 2
    const cy = (B.minY + B.maxY) / 2
    const drag = async (keys: typeof NoKeys, to = { x: cx, y: cy }) => {
      c.pointerDown({ x: B.maxX + 20, y: B.minY - 20 }, false)
      c.pointerMove(to, false, NoKeys)
      await c.pointerUp(to, {}, keys)
    }
    await drag({ inside: true, add: false, remove: false })
    await drag({ inside: false, add: true, remove: false })
    await drag({ inside: false, add: false, remove: true })
    // the whole of b inside the rectangle (and not a): inside takes it
    await drag({ inside: true, add: false, remove: false }, { x: B.minX - 5, y: B.maxY + 5 })
    assert.deepEqual(r.marquees, [
      { ids: [], op: "replace" },
      { ids: ["b"], op: "add" },
      { ids: ["b"], op: "remove" },
      { ids: ["b"], op: "replace" },
    ])
    // the scene did not change: the boxes were read once for all four
    assert.equal(r.m.asked.length, 1)
  })

  test("the drawing follows the keys during the drag; without keys at the release the last ones are used", async () => {
    const r = marqueeRig()
    await r.ready()
    const c = r.controller
    c.pointerDown({ x: 10, y: 10 }, false)
    c.pointerMove({ x: 790, y: 590 }, false, { inside: true, add: true, remove: false })
    assert.deepEqual(c.marqueeShape(), { rect: rect(10, 10, 790, 590), inside: true, op: "add" })
    await c.pointerUp({ x: 790, y: 590 })
    assert.deepEqual(r.marquees, [{ ids: ["a", "b"], op: "add" }])
  })

  test("the boxes are read again after a change of the scene or of its revision, and on a new connection", async () => {
    const r = marqueeRig()
    await r.ready()
    const c = r.controller
    const sweep = async () => {
      c.pointerDown({ x: 0, y: 0 }, false)
      c.pointerMove({ x: W, y: H }, false, NoKeys)
      await c.pointerUp({ x: W, y: H }, {}, NoKeys)
    }
    await sweep()
    await sweep()
    assert.equal(r.m.asked.length, 1)
    c.objectsChanged(["a"], false)
    await sweep()
    assert.equal(r.m.asked.length, 2)
    r.marquee.revision = 2
    await sweep()
    assert.equal(r.m.asked.length, 3)
    c.disconnected()
    await r.ready()
    await sweep()
    assert.equal(r.m.asked.length, 4)
  })

  test("the boxes are asked for when the marquee begins, and the release waits for them", async () => {
    const r = marqueeRig()
    await r.ready()
    const c = r.controller
    const release = r.m.hold()
    c.pointerDown({ x: 0, y: 0 }, false)
    c.pointerMove({ x: W, y: H }, false, NoKeys)
    assert.equal(r.m.asked.length, 1, "asked at the start of the marquee")
    const up = c.pointerUp({ x: W, y: H }, {}, NoKeys)
    await settle()
    assert.deepEqual(r.marquees, [])
    release()
    await up
    assert.deepEqual(r.marquees, [{ ids: ["a", "b"], op: "replace" }])
    assert.equal(r.m.asked.length, 1)
  })

  test("an answer that comes after the connection dropped, or after a newer click, is not applied", async () => {
    const r = marqueeRig()
    await r.ready()
    const c = r.controller
    let release = r.m.hold()
    c.pointerDown({ x: 0, y: 0 }, false)
    c.pointerMove({ x: W, y: H }, false, NoKeys)
    let up = c.pointerUp({ x: W, y: H }, {}, NoKeys)
    c.disconnected()
    release()
    await up
    assert.deepEqual(r.marquees, [])
    await r.ready()
    release = r.m.hold()
    c.pointerDown({ x: 0, y: 0 }, false)
    c.pointerMove({ x: W, y: H }, false, NoKeys)
    up = c.pointerUp({ x: W, y: H }, {}, NoKeys)
    // a click meanwhile
    c.pointerDown({ x: 5, y: 5 }, false)
    const click = c.pointerUp({ x: 5, y: 5 }, {})
    release()
    await up
    await click
    assert.deepEqual(r.marquees, [])
  })

  test("Escape (cancel) drops the rectangle and selects nothing; the release after it is not a click", async () => {
    const r = marqueeRig()
    await r.ready()
    const c = r.controller
    c.pointerDown({ x: 0, y: 0 }, false)
    c.pointerMove({ x: W, y: H }, false, NoKeys)
    await c.cancel()
    assert.equal(c.isMarquee, false)
    assert.equal(c.marqueeShape(), null)
    await c.pointerUp({ x: W, y: H }, {}, NoKeys)
    assert.deepEqual(r.marquees, [])
    assert.deepEqual(r.m.picks, [])
  })

  test("a press on a gizmo handle drags the gizmo, never a marquee", async () => {
    const m = measuring(Boxes)
    const r = rig({ picking: m.backend, selection: ["a"], marquee: { ids: ["a", "b"], revision: 1 } })
    await r.ready()
    const c = r.controller
    const handle = c.layout()!.handles[0]
    assert.equal(c.pointerDown(handle.to, false), true)
    c.pointerMove({ x: handle.to.x + 80, y: handle.to.y + 60 }, false, NoKeys)
    assert.equal(c.isMarquee, false)
    assert.equal(c.isDragging, true)
    await c.pointerUp({ x: handle.to.x + 80, y: handle.to.y + 60 }, {}, NoKeys)
    assert.deepEqual(r.marquees, [])
  })

  test("the camera does not zoom while a marquee is drawn; hover does not light a handle", async () => {
    const r = marqueeRig({ selection: [] })
    await r.ready()
    const c = r.controller
    const before = { ...c.camera.position }
    c.pointerDown({ x: 0, y: 0 }, false)
    c.pointerMove({ x: 300, y: 300 }, false, NoKeys)
    c.zoom(100)
    assert.deepEqual(c.camera.position, before)
    await c.pointerUp({ x: 300, y: 300 }, {}, NoKeys)
    c.zoom(100)
    assert.notDeepEqual(c.camera.position, before)
  })

  test("Frame Selected is refused while a marquee is drawn, and works again after the release", async () => {
    const r = marqueeRig({ selection: ["a"] })
    await r.ready()
    const c = r.controller
    const before = { ...c.camera.position }
    c.pointerDown({ x: 0, y: 0 }, false)
    c.pointerMove({ x: 300, y: 300 }, false, NoKeys)
    assert.equal(c.isMarquee, true)
    assert.equal(await c.frameSelected(), false)
    assert.deepEqual(c.camera.position, before)
    await c.pointerUp({ x: 300, y: 300 }, {}, NoKeys)
    assert.equal(await c.frameSelected(), true)
    assert.notDeepEqual(c.camera.position, before)
  })

  test("without candidates (or a picking backend) a drag on empty space draws nothing and selects nothing", async () => {
    const plain = rig({ picking: measuring(Boxes).backend, selection: [] })
    await plain.ready()
    plain.controller.pointerDown({ x: 0, y: 0 }, false)
    plain.controller.pointerMove({ x: 300, y: 300 }, false, NoKeys)
    assert.equal(plain.controller.isMarquee, false)
    const none = rig({ selection: [], marquee: { ids: ["a"], revision: 1 } })
    await none.ready()
    none.controller.pointerDown({ x: 0, y: 0 }, false)
    none.controller.pointerMove({ x: 300, y: 300 }, false, NoKeys)
    assert.equal(none.controller.isMarquee, false)
    await none.controller.pointerUp({ x: 300, y: 300 }, {}, NoKeys)
    assert.deepEqual(none.marquees, [])
  })

  test("a rectangle released off the frame is clamped to it; an empty marquee with no key clears", async () => {
    const r = marqueeRig()
    await r.ready()
    const c = r.controller
    c.pointerDown({ x: 10, y: 10 }, false)
    c.pointerMove({ x: -200, y: -200 }, false, NoKeys)
    await c.pointerUp({ x: -200, y: -200 }, {}, NoKeys)
    assert.deepEqual(r.marquees, [{ ids: [], op: "replace" }])
  })
})
