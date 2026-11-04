import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { parsePrefabStageInfo, isPrefabPath, PrefabStage, PrefabStageMode } from "../protocol/prefab-stage"
import { parseStateEvent } from "../protocol/editor-events"
import { EditorStore } from "../renderer/store"
import { FakeApi, FakeTimers, settle } from "./fake-store-api"
import { followScene } from "../renderer/scene-follow"
import { signal } from "@preact/signals-core"

const info = (overrides: Record<string, unknown> = {}) => ({
  open: true,
  prefabUuid: "p-1",
  path: "res://Crate.prefab",
  name: "Crate",
  mode: "isolated",
  dirty: false,
  revision: 5,
  savedRevision: 5,
  contextAvailable: true,
  rootLocked: false,
  sceneName: "Main",
  scenePath: "res://scenes/Main.scene",
  warnings: [],
  externalChange: false,
  orphaned: false,
  ...overrides,
})

describe("PrefabStageInfo", () => {
  test("an open stage parses with its fields, a closed one is null, and bad fields take their defaults", () => {
    const stage = parsePrefabStageInfo(info({ anchorEntityId: "e-1", mode: "context", warnings: ["w", 3] }))
    assert.equal(stage?.name, "Crate")
    assert.equal(stage?.mode, "context")
    assert.equal(stage?.anchorEntityId, "e-1")
    assert.deepEqual(stage?.warnings, ["w"])
    assert.equal(parsePrefabStageInfo({ open: false }), null)
    assert.equal(parsePrefabStageInfo(null), null)
    const odd = parsePrefabStageInfo({ open: true, mode: "sideways", dirty: "yes", revision: -1 })
    assert.equal(odd?.mode, "isolated")
    assert.equal(odd?.dirty, false)
    assert.equal(odd?.revision, 0)
    assert.equal(odd?.anchorEntityId, null)
  })

  test("prefabStageChanged is a state event with the stage, null when closed", () => {
    const opened = parseStateEvent({ seq: 1, kind: "prefabStageChanged", stage: info() })
    assert.equal(opened?.kind, "prefabStageChanged")
    assert.equal(opened?.kind === "prefabStageChanged" ? opened.stage?.path : "", "res://Crate.prefab")
    const closed = parseStateEvent({ seq: 2, kind: "prefabStageChanged", stage: { open: false } })
    assert.equal(closed?.kind === "prefabStageChanged" ? closed.stage : "x", null)
  })

  test("a .prefab path is a prefab", () => {
    assert.ok(isPrefabPath("res://a/Crate.PREFAB"))
    assert.ok(!isPrefabPath("res://a/Crate.scene"))
  })
})

/** A host with the prefab stage: the stage commands the store sends, and what each answers */
function stageHost(api: FakeApi) {
  const host = {
    stage: null as PrefabStage | null,
    calls: [] as string[],
    refuse: null as string | null,
  }
  const answer = () => host.stage
  Object.assign(api.engine, {
    openPrefabStage: async (uuidOrPath: string, mode: PrefabStageMode, anchor: string) => {
      host.calls.push(`open ${uuidOrPath} ${mode} ${anchor}`)
      host.stage = parsePrefabStageInfo(info({ path: uuidOrPath, mode, anchorEntityId: anchor }))
      return answer()
    },
    setPrefabStageMode: async (mode: PrefabStageMode) => {
      host.calls.push(`mode ${mode}`)
      host.stage = host.stage && { ...host.stage, mode }
      return answer()
    },
    savePrefabStage: async () => {
      host.calls.push("save")
      if (host.refuse) throw new Error(host.refuse)
      host.stage = host.stage && { ...host.stage, dirty: false }
      return answer()
    },
    closePrefabStage: async (discard: boolean) => {
      host.calls.push(`close ${discard}`)
      if (host.stage?.dirty && !discard) throw new Error("unsaved changes")
      host.stage = null
      return null
    },
    getPrefabStage: async () => answer(),
  })
  return host
}

async function connectedStore(capabilities = ["prefabStage", "prefabStageContext"]) {
  const api = new FakeApi()
  api.info = { ...api.info, protocolVersion: "1.26.0", capabilities }
  api.openScene = { path: "res://scenes/Main.scene", name: "Main", uuid: "s", revision: 1, savedRevision: 1 }
  const timers = new FakeTimers()
  const store = new EditorStore(api, { timers, now: () => 0 })
  const host = stageHost(api)
  await store.openProject()
  await settle()
  return { api, store, timers, host }
}

describe("EditorStore and the prefab stage", () => {
  test("opening a prefab opens the stage in the last mode; the event keeps it current; closing a clean stage asks nothing", async () => {
    const { api, store, timers, host } = await connectedStore()
    assert.equal(store.prefabStageAvailable.value, true)
    assert.equal(await store.openPrefabStage("res://Crate.prefab"), true)
    assert.deepEqual(host.calls, ["open res://Crate.prefab isolated "])
    assert.equal(store.prefabStage.value?.name, "Crate")
    await settle() // the poll the open started

    api.events.events.push({ seq: 1, kind: "prefabStageChanged", stage: info({ dirty: true }) })
    await timers.fire()
    assert.equal(store.prefabStage.value?.dirty, true)
    api.events.events.push({ seq: 2, kind: "prefabStageChanged", stage: info({ dirty: false }) })
    await timers.fire()

    await store.setPrefabStageMode("context")
    assert.equal(store.lastStageMode.value, "context")
    host.stage = host.stage && { ...host.stage, dirty: false }
    assert.equal(await store.closePrefabStage(), true)
    assert.equal(store.prefabStage.value, null)
    assert.equal(api.asked.filter((q) => q.startsWith("unsaved")).length, 0)

    // The next one opens In Scene, as the last one was left
    await store.openPrefabStage("res://Barrel.prefab")
    assert.equal(host.calls.at(-1), "open res://Barrel.prefab context ")
  })

  test("closing with unsaved changes asks: Cancel keeps it, Discard closes, Save saves then closes", async () => {
    const { api, store, host } = await connectedStore()
    await store.openPrefabStage("res://Crate.prefab")
    host.stage = host.stage && { ...host.stage, dirty: true }

    api.unsavedAnswers = ["cancel"]
    assert.equal(await store.closePrefabStage(), false)
    assert.ok(store.prefabStage.value)
    assert.match(api.asked.at(-1) ?? "", /^unsaved Discard and close it: The prefab Crate has unsaved changes\.$/)

    api.unsavedAnswers = ["save"]
    assert.equal(await store.closePrefabStage(), true)
    assert.deepEqual(host.calls.slice(-2), ["save", "close false"])

    await store.openPrefabStage("res://Crate.prefab")
    host.stage = host.stage && { ...host.stage, dirty: true }
    api.unsavedAnswers = ["discard"]
    assert.equal(await store.closePrefabStage(), true)
    assert.equal(host.calls.at(-1), "close true")
  })

  test("opening a scene closes the stage first; a cancelled prompt opens nothing", async () => {
    const { api, store, host } = await connectedStore()
    await store.openPrefabStage("res://Crate.prefab")
    host.stage = host.stage && { ...host.stage, dirty: true }
    api.unsavedAnswers = ["cancel"]
    assert.equal(await store.openScene("res://scenes/Other.scene"), undefined)
    assert.ok(!api.calls.includes("openScene res://scenes/Other.scene"))
    api.unsavedAnswers = ["discard"]
    await store.openScene("res://scenes/Other.scene")
    assert.ok(host.calls.includes("close true"))
    assert.ok(api.calls.includes("openScene res://scenes/Other.scene"))
  })

  test("Ctrl+S saves the prefab while a stage is open; Save as is refused", async () => {
    const { api, store, host } = await connectedStore()
    await store.openPrefabStage("res://Crate.prefab")
    await store.saveScene()
    assert.equal(host.calls.at(-1), "save")
    assert.ok(!api.calls.some((c) => c.startsWith("saveSceneToFile")))
    await store.saveSceneAs()
    assert.match(store.error.value ?? "", /not while a prefab is open/)
  })

  test("a host without the capability is never asked, and In Scene falls back to Isolated without prefabStageContext", async () => {
    const { store, host } = await connectedStore([])
    assert.equal(await store.openPrefabStage("res://Crate.prefab"), false)
    assert.deepEqual(host.calls, [])
    assert.match(store.error.value ?? "", /no prefab stage/)

    const other = await connectedStore(["prefabStage"])
    await other.store.openPrefabStage("res://Crate.prefab", "context")
    assert.equal(other.host.calls[0], "open res://Crate.prefab isolated ")
  })

  test("a reconnect asks the host whether a stage is open", async () => {
    const { api, store, host } = await connectedStore()
    host.stage = parsePrefabStageInfo(info())
    api.pushConnection(false)
    assert.equal(store.prefabStage.value, null)
    api.pushConnection(true)
    await settle()
    assert.equal((store.prefabStage.value as PrefabStage | null)?.path, "res://Crate.prefab")
  })
})

describe("followScene and the prefab stage", () => {
  test("the hierarchy keeps the scene's selection aside while a stage is open and gets it back after", () => {
    const calls: string[] = []
    const prefabStage = signal<PrefabStage | null>(null)
    const store = {
      connected: signal(true),
      sceneChangeCount: signal(0),
      lastSceneChange: signal(null),
      assetsChangeCount: signal(0),
      lastAssetsChange: signal(null),
      newestSceneRevision: null,
      reportError: () => {},
      prefabStage,
    }
    const stop = followScene({
      store: store as never,
      scene: { selectedId: signal(null), reset: () => {} } as never,
      hierarchy: {
        reset: () => {},
        applyChange: async () => {},
        tree: signal({ nodes: new Map() }),
        selection: signal({ ids: new Set(), primary: null }),
        enterPrefabStage: () => calls.push("enter"),
        leavePrefabStage: () => calls.push("leave"),
      } as never,
      assets: { reset: () => {}, refresh: async () => {}, onAssetsChanged: () => {} } as never,
      inspector: {
        reset: () => {},
        loadTypes: async () => {},
        loadAssets: async () => {},
        select: async () => {},
        applyChange: async () => {},
        refreshLuaFields: async () => {},
        multi: { select: async () => {} },
      } as never,
    })
    prefabStage.value = parsePrefabStageInfo(info())
    prefabStage.value = parsePrefabStageInfo(info({ dirty: true })) // the same stage changing: nothing
    prefabStage.value = null
    stop()
    assert.deepEqual(calls, ["enter", "leave"])
  })
})
