import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import {
  LayoutVersion,
  SizeLimits,
  activatePanel,
  closeDynamic,
  closePanel,
  defaultLayout,
  locate,
  movePanel,
  openDynamic,
  openPanel,
  openPanelIds,
  parseLayout,
  serializeLayout,
  setRegionSize,
  syncDynamic,
} from "../renderer/layout/layout-model"
import { PanelRegistry } from "../renderer/layout/panel-registry"
import { fixtureRegistry, shape } from "./layout-fixture"

const registry = fixtureRegistry()

describe("the default layout", () => {
  test("is the arrangement the editor always had", () => {
    const layout = defaultLayout(registry)
    assert.deepEqual(shape(layout), {
      left: [["assets"]],
      center: [["viewport"]],
      bottom: [["console"]],
      right: [["hierarchy"], ["inspector"], ["engine"]],
    })
    assert.equal(layout.regions.left.size, 300)
    assert.equal(layout.regions.right.size, 300)
    assert.equal(layout.regions.bottom.size, 220)
    assert.deepEqual(layout.closed, [])
    assert.equal(layout.version, LayoutVersion)
  })

  test("panels that share a default stack are tabs of one stack", () => {
    const shared = new PanelRegistry()
    for (const id of ["a", "b"]) {
      shared.register({ id, title: id, component: null, defaultRegion: "left", closable: true, singleton: true })
    }
    assert.deepEqual(shape(defaultLayout(shared)).left, [["a", "b"]])
  })
})

describe("the registry", () => {
  test("refuses a duplicate id, a bad id and a panel that is not a singleton", () => {
    const r = fixtureRegistry()
    const def = { title: "X", component: null, defaultRegion: "left", closable: true, singleton: true } as const
    assert.throws(() => r.register({ ...def, id: "assets" }), /already registered/)
    assert.throws(() => r.register({ ...def, id: "" }), /Invalid panel id/)
    assert.throws(() => r.register({ ...def, id: "text:x" }), /Invalid panel id/)
    assert.throws(() => r.register({ ...def, id: "y", singleton: false }), /singleton/)
    assert.throws(() => r.register({ ...def, id: "z", defaultRegion: "top" as never }), /unknown region/)
  })
})

describe("movePanel", () => {
  test("to another region puts it in that region's first stack, shown", () => {
    const next = movePanel(defaultLayout(registry), registry, "assets", { region: "right" })
    assert.deepEqual(shape(next).left, [])
    assert.deepEqual(shape(next).right, [["hierarchy", "assets"], ["inspector"], ["engine"]])
    assert.equal(next.regions.right.groups[0].active, "assets")
  })

  test("to an empty region makes a stack there", () => {
    const moved = movePanel(defaultLayout(registry), registry, "assets", { region: "right" })
    const next = movePanel(moved, registry, "console", { region: "left" })
    assert.deepEqual(shape(next).left, [["console"]])
    assert.deepEqual(shape(next).bottom, [])
  })

  test("a stack left empty goes, and the shown tab of the one left behind moves to its neighbour", () => {
    let layout = movePanel(defaultLayout(registry), registry, "inspector", { region: "right", group: 0 })
    assert.deepEqual(shape(layout).right, [["hierarchy", "inspector"], ["engine"]])
    layout = activatePanel(layout, "hierarchy")
    layout = movePanel(layout, registry, "hierarchy", { region: "left" })
    assert.equal(layout.regions.right.groups[0].active, "inspector")
    assert.deepEqual(shape(layout).left, [["assets", "hierarchy"]])
  })

  test("a stack that empties by a move to another region is removed", () => {
    const layout = movePanel(defaultLayout(registry), registry, "inspector", { region: "left" })
    assert.deepEqual(shape(layout).right, [["hierarchy"], ["engine"]])
  })

  test("before a tab inserts there; before itself changes nothing", () => {
    let layout = movePanel(defaultLayout(registry), registry, "engine", { region: "right", group: 0 })
    layout = movePanel(layout, registry, "inspector", { region: "right", group: 0, before: "engine" })
    assert.deepEqual(shape(layout).right, [["hierarchy", "inspector", "engine"]])
    assert.equal(movePanel(layout, registry, "inspector", { region: "right", group: 0, before: "inspector" }), layout)
  })

  test("to the end of its own stack reorders it; where it already is changes nothing", () => {
    let layout = movePanel(defaultLayout(registry), registry, "engine", { region: "right", group: 0 })
    layout = movePanel(layout, registry, "hierarchy", { region: "right", group: 0 })
    assert.deepEqual(shape(layout).right[0], ["engine", "hierarchy"])
    assert.equal(movePanel(layout, registry, "hierarchy", { region: "right", group: 0 }), layout)
    assert.equal(movePanel(layout, registry, "hierarchy", { region: "right" }), layout)
  })

  test("moving the only tab of a stack to its own stack changes nothing", () => {
    const layout = defaultLayout(registry)
    assert.equal(movePanel(layout, registry, "console", { region: "bottom", group: 0 }), layout)
  })

  test("a panel that is not shown, an unknown panel, a bad region or a bad stack changes nothing", () => {
    const closed = closePanel(defaultLayout(registry), registry, "engine")
    assert.equal(movePanel(closed, registry, "engine", { region: "left" }), closed)
    assert.equal(movePanel(closed, registry, "nope", { region: "left" }), closed)
    assert.equal(movePanel(closed, registry, "assets", { region: "top" as never }), closed)
    assert.equal(movePanel(closed, registry, "assets", { region: "right", group: 9 }), closed)
  })

  test("does not change the layout it was given", () => {
    const layout = defaultLayout(registry)
    const before = JSON.stringify(layout)
    movePanel(layout, registry, "assets", { region: "right" })
    assert.equal(JSON.stringify(layout), before)
  })
})

describe("closePanel and openPanel", () => {
  test("a closed panel is gone from its stack and listed as closed", () => {
    const next = closePanel(defaultLayout(registry), registry, "inspector")
    assert.deepEqual(shape(next).right, [["hierarchy"], ["engine"]])
    assert.deepEqual(next.closed, ["inspector"])
  })

  test("the viewport cannot be closed", () => {
    const layout = defaultLayout(registry)
    assert.equal(closePanel(layout, registry, "viewport"), layout)
  })

  test("reopening a panel puts it back where it starts, stacked as before", () => {
    const closed = closePanel(closePanel(defaultLayout(registry), registry, "inspector"), registry, "hierarchy")
    assert.deepEqual(shape(closed).right, [["engine"]])
    const reopened = openPanel(openPanel(closed, registry, "inspector"), registry, "hierarchy")
    assert.deepEqual(shape(reopened).right, [["hierarchy"], ["inspector"], ["engine"]])
    assert.deepEqual(reopened.closed, [])
  })

  test("reopening in a region that starts with one stack adds a tab, and makes a stack in an empty region", () => {
    let layout = closePanel(defaultLayout(registry), registry, "console")
    layout = movePanel(layout, registry, "assets", { region: "bottom" })
    layout = openPanel(layout, registry, "console")
    assert.deepEqual(shape(layout).bottom, [["assets", "console"]])
    layout = closePanel(closePanel(layout, registry, "assets"), registry, "console")
    assert.deepEqual(shape(layout).bottom, [])
    assert.deepEqual(shape(openPanel(layout, registry, "console")).bottom, [["console"]])
  })

  test("opening a panel that is shown switches to its tab", () => {
    let layout = movePanel(defaultLayout(registry), registry, "assets", { region: "right" })
    layout = activatePanel(layout, "hierarchy")
    const next = openPanel(layout, registry, "assets")
    assert.equal(next.regions.right.groups[0].active, "assets")
    assert.equal(openPanel(next, registry, "assets"), next)
  })

  test("an unknown panel cannot be opened", () => {
    const layout = defaultLayout(registry)
    assert.equal(openPanel(layout, registry, "nope"), layout)
  })
})

describe("sizes", () => {
  test("are kept within the splitters' limits", () => {
    const layout = defaultLayout(registry)
    assert.equal(setRegionSize(layout, registry, "left", 9999).regions.left.size, SizeLimits.left.max)
    assert.equal(setRegionSize(layout, registry, "left", 1).regions.left.size, SizeLimits.left.min)
    assert.equal(setRegionSize(layout, registry, "bottom", 1000).regions.bottom.size, 700)
    assert.equal(setRegionSize(layout, registry, "right", 250.4).regions.right.size, 250)
  })

  test("the centre has none, and an unchanged size returns the same layout", () => {
    const layout = defaultLayout(registry)
    assert.equal(setRegionSize(layout, registry, "center", 500), layout)
    assert.equal(setRegionSize(layout, registry, "left", 300), layout)
  })

  test("a panel can ask for more room than the limit", () => {
    const wide = new PanelRegistry()
    wide.register({ id: "w", title: "W", component: null, defaultRegion: "left", closable: true, singleton: true, minSize: 260 })
    const layout = defaultLayout(wide)
    assert.equal(setRegionSize(layout, wide, "left", 150).regions.left.size, 260)
  })
})

describe("dynamic tabs (text files)", () => {
  test("open in the bottom region's first stack and are shown", () => {
    const layout = openDynamic(defaultLayout(registry), "text:res://a.lua")
    assert.deepEqual(shape(layout).bottom, [["console", "text:res://a.lua"]])
    assert.equal(layout.regions.bottom.groups[0].active, "text:res://a.lua")
  })

  test("make a stack when the bottom region has none", () => {
    const layout = openDynamic(movePanel(defaultLayout(registry), registry, "console", { region: "left" }), "text:x")
    assert.deepEqual(shape(layout).bottom, [["text:x"]])
  })

  test("closing the shown one gives way to its neighbour on the left", () => {
    let layout = openDynamic(openDynamic(defaultLayout(registry), "text:a"), "text:b")
    layout = closeDynamic(layout, "text:b")
    assert.equal(layout.regions.bottom.groups[0].active, "text:a")
    layout = closeDynamic(layout, "text:a")
    assert.equal(layout.regions.bottom.groups[0].active, "console")
    assert.deepEqual(layout.closed, [])
  })

  test("syncDynamic makes them exactly the open files", () => {
    let layout = syncDynamic(defaultLayout(registry), ["text:a", "text:b"])
    assert.deepEqual(shape(layout).bottom, [["console", "text:a", "text:b"]])
    layout = syncDynamic(layout, ["text:b", "text:c"])
    assert.deepEqual(shape(layout).bottom, [["console", "text:b", "text:c"]])
    assert.equal(syncDynamic(layout, ["text:b", "text:c"]), layout)
  })

  test("are not saved, and are not panels", () => {
    const layout = syncDynamic(defaultLayout(registry), ["text:a"])
    assert.deepEqual(openPanelIds(layout).sort(), ["assets", "console", "engine", "hierarchy", "inspector", "viewport"])
    assert.deepEqual(shape(serializeLayout(layout)).bottom, [["console"]])
    // A stack of only text files is dropped from what is saved
    const onlyText = syncDynamic(closePanel(defaultLayout(registry), registry, "console"), ["text:a"])
    assert.deepEqual(shape(serializeLayout(onlyText)).bottom, [])
  })
})

describe("parseLayout", () => {
  const roundTrip = (layout: ReturnType<typeof defaultLayout>) =>
    parseLayout(JSON.parse(JSON.stringify(serializeLayout(layout))), registry)

  test("round-trips the default and an arranged layout", () => {
    assert.deepEqual(roundTrip(defaultLayout(registry)), defaultLayout(registry))
    let layout = movePanel(defaultLayout(registry), registry, "assets", { region: "right" })
    layout = closePanel(layout, registry, "engine")
    layout = setRegionSize(layout, registry, "right", 420)
    layout = setRegionSize(layout, registry, "bottom", 300)
    assert.deepEqual(roundTrip(layout), layout)
  })

  test("drops panels it does not know, and a panel named twice", () => {
    const layout = parseLayout(
      {
        version: 1,
        regions: {
          left: {
            size: 300,
            groups: [
              { tabs: ["assets", "ghost"], active: "ghost" },
              { tabs: ["ghost2"], active: "ghost2" },
            ],
          },
          center: { size: 0, groups: [{ tabs: ["viewport", "assets"], active: "viewport" }] },
          bottom: { size: 220, groups: [{ tabs: ["console"], active: "console" }] },
          right: { size: 300, groups: [{ tabs: ["hierarchy", "inspector", "engine"], active: "inspector" }] },
        },
        closed: [],
      },
      registry
    )!
    assert.deepEqual(shape(layout).left, [["assets"]])
    assert.deepEqual(shape(layout).center, [["viewport"]])
    assert.equal(layout.regions.left.groups[0].active, "assets")
    assert.equal(layout.regions.right.groups[0].active, "inspector")
  })

  test("adds a panel that is neither placed nor closed where it starts, and always the viewport", () => {
    const layout = parseLayout(
      {
        version: 1,
        regions: { left: { size: 300, groups: [] }, center: { groups: [] }, bottom: { groups: [] }, right: { groups: [] } },
        closed: ["assets", "viewport", "ghost"],
      },
      registry
    )!
    // assets was closed on purpose; the viewport cannot be; the others are new to this layout
    assert.deepEqual(layout.closed, ["assets"])
    assert.deepEqual(shape(layout), {
      left: [],
      center: [["viewport"]],
      bottom: [["console"]],
      right: [["hierarchy"], ["inspector"], ["engine"]],
    })
  })

  test("a panel added by a newer editor shows up in a layout saved without it", () => {
    const older = fixtureRegistry()
    const saved = serializeLayout(defaultLayout(older))
    const newer = fixtureRegistry()
    newer.register({ id: "history", title: "History", component: null, defaultRegion: "right", defaultGroup: 3, closable: true, singleton: true })
    const layout = parseLayout(JSON.parse(JSON.stringify(saved)), newer)!
    assert.deepEqual(shape(layout).right, [["hierarchy"], ["inspector"], ["engine"], ["history"]])
  })

  test("clamps sizes and replaces ones that are not numbers", () => {
    const layout = parseLayout(
      {
        version: 1,
        closed: [],
        regions: {
          left: { size: 99999, groups: [] },
          center: { groups: [] },
          bottom: { size: "tall", groups: [] },
          right: { size: -5, groups: [] },
        },
      },
      registry
    )!
    assert.equal(layout.regions.left.size, 500)
    assert.equal(layout.regions.bottom.size, 220)
    assert.equal(layout.regions.right.size, 200)
    assert.equal(layout.regions.center.size, 0)
  })

  test("gives null for what is not a layout, or is a newer version, without throwing", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "layout",
      42,
      [],
      {},
      { version: "1" },
      { version: 1.5, regions: {} },
      { version: 0, regions: {} },
      { version: LayoutVersion + 1, regions: {} },
      { version: 1 },
      { version: 1, regions: null },
      { version: 1, regions: [] },
    ]
    for (const value of bad) assert.equal(parseLayout(value, registry), null, JSON.stringify(value))
  })

  test("survives garbage inside a valid shell", () => {
    const layout = parseLayout(
      {
        version: 1,
        regions: {
          left: "x",
          center: { groups: "y" },
          bottom: { groups: [null, 5, { tabs: "z" }, { tabs: [1, null, {}] }, { tabs: ["console"], active: 7 }], size: {} },
          right: { groups: [{ tabs: ["hierarchy"], active: null }] },
        },
        closed: "nope",
      },
      registry
    )!
    assert.ok(layout)
    assert.deepEqual(shape(layout).bottom, [["console"]])
    assert.equal(layout.regions.bottom.groups[0].active, "console")
    assert.deepEqual(shape(layout).center, [["viewport"]])
  })

  test("a throwing getter cannot make it throw", () => {
    const hostile = {
      version: 1,
      get regions(): unknown {
        throw new Error("boom")
      },
    }
    assert.equal(parseLayout(hostile, registry), null)
  })

  test("migrates an older version through the steps it is given, one version at a time", () => {
    const v1 = {
      version: 1,
      regions: { left: { size: 400, groups: [{ tabs: ["assets"], active: "assets" }] }, center: {}, bottom: {}, right: {} },
      closed: [],
    }
    const steps = {
      // version 2 renamed "closed" to "hidden"; version 3 doubled nothing, it only moved the version on
      1: (v: Record<string, unknown>) => ({ ...v, version: 2, hidden: v.closed, closed: undefined }),
      2: (v: Record<string, unknown>) => ({ ...v, version: 3, closed: v.hidden }),
    }
    const layout = parseLayout(v1, registry, steps, 3)!
    assert.equal(layout.regions.left.size, 400)
    assert.deepEqual(shape(layout).left, [["assets"]])
    // No step for a version: refused. A step that does not move the version on: refused, not looped on.
    assert.equal(parseLayout(v1, registry, {}, 2), null)
    assert.equal(parseLayout(v1, registry, { 1: (v) => v }, 2), null)
    // A step that throws: refused
    assert.equal(
      parseLayout(v1, registry, { 1: () => { throw new Error("bad step") } }, 2),
      null
    )
    // Saved by a newer editor than the target: refused
    assert.equal(parseLayout({ ...v1, version: 4 }, registry, steps, 3), null)
  })
})

describe("locate", () => {
  test("finds a tab or says it is nowhere", () => {
    const layout = defaultLayout(registry)
    assert.deepEqual(locate(layout, "inspector"), { region: "right", group: 1, index: 0 })
    assert.equal(locate(layout, "nope"), null)
  })
})
