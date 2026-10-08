import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { AssetDetails, AssetInfo } from "../protocol/protocol.generated"
import type { AssetsChangedEvent } from "../protocol/editor-events"
import { AssetsState, isDirty } from "../renderer/assets-state"
import { MaxTextAssetBytes } from "../renderer/asset-edit"
import { ConsoleStore, entriesAfter } from "../renderer/console-store"
import { assetDragData, parseAssetDrag } from "../renderer/drag-types"

const U1 = "11111111-1111-1111-1111-111111111111"
const U2 = "22222222-2222-2222-2222-222222222222"
const U3 = "33333333-3333-3333-3333-333333333333"

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function setup() {
  const state = {
    folders: ["res://scripts"] as string[],
    assets: [
      { path: "res://hero.png", uuid: U1, type: "Texture", size: 10, modified: 1 },
      { path: "res://scripts/a.lua", uuid: U2, type: "LuaScript", size: 5, modified: 1 },
    ] as AssetInfo[],
    files: new Map<string, string>([["res://scripts/a.lua", "print(1)"]]),
    settings: { sRGB: true } as Record<string, unknown>,
    fail: new Map<string, string>(),
  }
  const calls: string[] = []
  const gate = (name: string) => {
    const message = state.fail.get(name)
    if (message) throw new Error(message)
  }
  const engine = {
    listAssets: async (folder: string, recursive: boolean) => {
      calls.push(`listAssets ${folder} ${recursive}`)
      gate("listAssets")
      return { folders: [...state.folders], assets: state.assets.map((a) => ({ ...a })) }
    },
    getAssetInfo: async (uuidOrPath: string): Promise<AssetDetails> => {
      calls.push(`getAssetInfo ${uuidOrPath}`)
      gate("getAssetInfo")
      const asset = state.assets.find((a) => a.path === uuidOrPath || a.uuid === uuidOrPath)
      if (!asset) throw new Error(`No asset ${uuidOrPath}`)
      return { ...asset, customData: { ...state.settings }, loaded: false }
    },
    setImportSettings: async (path: string, customData: unknown) => {
      calls.push(`setImportSettings ${path} ${JSON.stringify(customData)}`)
      gate("setImportSettings")
      state.settings = customData as Record<string, unknown>
    },
    readTextAsset: async (path: string) => {
      calls.push(`readTextAsset ${path}`)
      gate("readTextAsset")
      const text = state.files.get(path)
      if (text === undefined) throw new Error(`${path} doesn't exist`)
      return text
    },
    writeTextAsset: async (path: string, text: string) => {
      calls.push(`writeTextAsset ${path}`)
      gate("writeTextAsset")
      state.files.set(path, text)
    },
    createScriptAsset: async (path: string, className: string) => {
      calls.push(`createScriptAsset ${path} [${className}]`)
      gate("createScriptAsset")
      if (state.files.has(path)) throw new Error(`${path} already exists`)
      state.files.set(path, "-- template")
      state.assets.push({ path, uuid: U3, type: "LuaScript", size: 11, modified: 2 })
      return { path, uuid: U3 }
    },
    createFolder: async (path: string) => {
      calls.push(`createFolder ${path}`)
      gate("createFolder")
      if (!state.folders.includes(path)) state.folders.push(path)
    },
  }
  const errors: string[] = []
  const logMarks = { mark: () => 7, poll: async () => void calls.push("poll") }
  const assets = new AssetsState(engine, logMarks, (what, e) => void errors.push(`${what}: ${(e as Error).message}`))
  return { assets, engine, state, calls, errors }
}

const change = (parts: Partial<AssetsChangedEvent>): AssetsChangedEvent => ({
  kind: "assetsChanged",
  added: [],
  removed: [],
  modified: [],
  ...parts,
})

describe("AssetsState listing", () => {
  test("lists everything below the root once, as rows, and finds the scenes", async () => {
    const { assets, state, calls } = setup()
    state.assets.push({ path: "res://scenes/Main.scene", uuid: U3, type: "Scene", size: 1, modified: 1 })
    await assets.refresh()
    assert.deepEqual(calls, ["listAssets  true"])
    assert.deepEqual(
      assets.rows.value.map((r) => r.name),
      ["scenes", "scripts", "hero.png"]
    )
    assert.deepEqual(assets.scenes.value, ["res://scenes/Main.scene"])
    assert.deepEqual(assets.types.value, ["LuaScript", "Scene", "Texture"])
  })

  test("a refusal is kept as the listing's error, and the old listing stays", async () => {
    const { assets, state } = setup()
    await assets.refresh()
    state.fail.set("listAssets", "No project is loaded")
    await assets.refresh()
    assert.equal(assets.listingError.value, "No project is loaded")
    assert.equal(assets.listing.value?.assets.length, 2)
    state.fail.delete("listAssets")
    await assets.refresh()
    assert.equal(assets.listingError.value, null)
  })

  test("refreshes asked for while one is on its way share one more read", async () => {
    const { assets, engine } = setup()
    let reads = 0
    const list = engine.listAssets
    engine.listAssets = async (...args: Parameters<typeof list>) => {
      reads++
      await tick()
      return list(...args)
    }
    await Promise.all([assets.refresh(), assets.refresh(), assets.refresh()])
    assert.equal(reads, 2)
  })

  test("an answer that arrives after a reset is dropped", async () => {
    const { assets, engine } = setup()
    let release!: () => void
    const list = engine.listAssets
    engine.listAssets = async (...args: Parameters<typeof list>) => {
      await new Promise<void>((resolve) => (release = resolve))
      return list(...args)
    }
    const reading = assets.refresh()
    await tick()
    assets.reset()
    release()
    await reading
    assert.equal(assets.listing.value, null)
  })

  test("folders open and close, and a path's folders can be revealed", async () => {
    const { assets } = setup()
    await assets.refresh()
    assert.equal(assets.rows.value.length, 2)
    assets.toggle("res://scripts")
    assert.equal(assets.rows.value.length, 3)
    assets.toggle("res://scripts")
    assert.equal(assets.rows.value.length, 2)
    assets.reveal("res://scripts/a.lua")
    assert.equal(assets.rows.value.length, 3)
  })

  test("a filter shows a flat list", async () => {
    const { assets } = setup()
    await assets.refresh()
    assets.setFilter({ text: "HERO" })
    assert.deepEqual(
      assets.rows.value.map((r) => r.path),
      ["res://hero.png"]
    )
  })
})

describe("AssetsState selection and import settings", () => {
  test("selecting a file reads its detail, a folder reads none", async () => {
    const { assets, calls } = setup()
    await assets.refresh()
    await assets.select("res://scripts")
    assert.equal(assets.detail.peek(), null)
    await assets.select("res://hero.png")
    assert.deepEqual(calls.filter((c) => c.startsWith("getAssetInfo")), ["getAssetInfo res://hero.png"])
    assert.equal(assets.detail.value?.settings, '{\n  "sRGB": true\n}')
    assert.equal(assets.detail.value?.info?.loaded, false)
  })

  test("the host's refusal to describe an asset is shown in its detail", async () => {
    const { assets, state } = setup()
    await assets.refresh()
    state.fail.set("getAssetInfo", "That UUID names a part of a file")
    await assets.select("res://hero.png")
    assert.equal(assets.detail.value?.error, "That UUID names a part of a file")
    assert.equal(assets.detail.value?.info, null)
  })

  test("invalid import settings are explained and nothing is sent", async () => {
    const { assets, calls } = setup()
    await assets.refresh()
    await assets.select("res://hero.png")
    assets.editSettings("{ nope")
    assert.equal(await assets.applySettings(), false)
    assert.match(assets.detail.value!.error!, /^Not valid JSON/)
    assert.equal(calls.some((c) => c.startsWith("setImportSettings")), false)
    // Editing again clears the message; the text is still there
    assets.editSettings("[1]")
    assert.equal(assets.detail.value?.error, null)
    assert.equal(assets.detail.value?.settings, "[1]")
  })

  test("valid settings are sent as an object, then read back", async () => {
    const { assets, state, calls } = setup()
    await assets.refresh()
    await assets.select("res://hero.png")
    assets.editSettings('{ "sRGB": false, "mips": 4 }')
    assert.equal(await assets.applySettings(), true)
    assert.deepEqual(state.settings, { sRGB: false, mips: 4 })
    assert.ok(calls.includes('setImportSettings res://hero.png {"sRGB":false,"mips":4}'))
    assert.equal(assets.detail.value?.settings, assets.detail.value?.baseline)
    assert.equal(assets.detail.value?.saving, false)
  })

  test("the host's refusal keeps the text and says why", async () => {
    const { assets, state } = setup()
    await assets.refresh()
    await assets.select("res://hero.png")
    assets.editSettings('{ "x": 1 }')
    state.fail.set("setImportSettings", "Import settings of res://hero.png are larger than 64 KiB")
    assert.equal(await assets.applySettings(), false)
    assert.match(assets.detail.value!.error!, /larger than 64 KiB/)
    assert.equal(assets.detail.value?.settings, '{ "x": 1 }')
    assert.equal(assets.detail.value?.saving, false)
    assets.revertSettings()
    assert.equal(assets.detail.value?.settings, assets.detail.value?.baseline)
  })

  test("a refresh keeps settings being edited, and says when the host's changed under them", async () => {
    const { assets, state } = setup()
    await assets.refresh()
    await assets.select("res://hero.png")
    assets.editSettings('{ "mine": 1 }')
    await assets.refresh()
    assert.equal(assets.detail.value?.settings, '{ "mine": 1 }')
    assert.equal(assets.detail.value?.outdated, false)
    state.settings = { other: 2 }
    await assets.refresh()
    assert.equal(assets.detail.value?.settings, '{ "mine": 1 }')
    assert.equal(assets.detail.value?.outdated, true)
    assert.equal(assets.detail.value?.baseline, '{\n  "other": 2\n}')
  })

  test("untouched settings follow the host", async () => {
    const { assets, state } = setup()
    await assets.refresh()
    await assets.select("res://hero.png")
    state.settings = { other: 2 }
    await assets.refresh()
    assert.equal(assets.detail.value?.settings, '{\n  "other": 2\n}')
  })

  test("an asset that is gone loses the selection", async () => {
    const { assets, state } = setup()
    await assets.refresh()
    await assets.select("res://hero.png")
    state.assets = state.assets.filter((a) => a.path !== "res://hero.png")
    await assets.refresh()
    assert.equal(assets.selected.value, null)
    assert.equal(assets.detail.value, null)
  })
})

describe("AssetsState making things", () => {
  test("a folder is made inside the folder, opened and selected", async () => {
    const { assets, calls } = setup()
    await assets.refresh()
    const path = await assets.createFolder("res://scripts", "enemies")
    assert.equal(path, "res://scripts/enemies")
    assert.ok(calls.includes("createFolder res://scripts/enemies"))
    assert.equal(assets.selected.value, "res://scripts/enemies")
    assert.deepEqual(
      assets.rows.value.map((r) => r.name),
      ["scripts", "enemies", "a.lua", "hero.png"]
    )
  })

  test("a bad name never reaches the host", async () => {
    const { assets, calls } = setup()
    await assert.rejects(assets.createFolder("res://", "a/b"), /can't contain/)
    await assert.rejects(assets.createScript("res://", "CON"), /reserved/)
    assert.deepEqual(calls, [])
  })

  test("the host's refusal of a folder is thrown", async () => {
    const { assets, state } = setup()
    state.fail.set("createFolder", "res://hero.png is a file")
    await assert.rejects(assets.createFolder("res://", "hero.png"), /is a file/)
  })

  test("a script is made from the template, selected and opened in the editor", async () => {
    const { assets, calls } = setup()
    await assets.refresh()
    const path = await assets.createScript("res://scripts", "Enemy")
    assert.equal(path, "res://scripts/Enemy.lua")
    assert.ok(calls.includes("createScriptAsset res://scripts/Enemy.lua []"))
    assert.equal(assets.selected.value, path)
    assert.equal(assets.activeTab.value, path)
    assert.equal(assets.tabs.value[0].text, "-- template")
    assert.equal(isDirty(assets.tabs.value[0]), false)
  })

  test("a script at an existing path is refused with the host's words", async () => {
    const { assets } = setup()
    await assert.rejects(assets.createScript("res://scripts", "a"), /already exists/)
    assert.equal(assets.tabs.value.length, 0)
  })

  test("a script made but not readable is still made; the failure is reported", async () => {
    const { assets, engine, errors } = setup()
    engine.readTextAsset = async () => Promise.reject(new Error("busy"))
    const path = await assets.createScript("res://scripts", "Enemy")
    assert.equal(path, "res://scripts/Enemy.lua")
    assert.deepEqual(errors, ["Failed to open the new script: busy"])
  })
})

describe("AssetsState text files", () => {
  test("a file opens once, into a clean tab", async () => {
    const { assets, calls } = setup()
    await assets.openText("res://scripts/a.lua")
    await assets.openText("res://scripts/a.lua")
    assert.equal(calls.filter((c) => c.startsWith("readTextAsset")).length, 1)
    assert.equal(assets.tabs.value.length, 1)
    assert.equal(assets.activeTab.value, "res://scripts/a.lua")
    assert.equal(assets.tabs.value[0].text, "print(1)")
  })

  test("a file the host won't read opens no tab", async () => {
    const { assets, state } = setup()
    state.fail.set("readTextAsset", "res://hero.png is not a text file")
    await assert.rejects(assets.openText("res://hero.png"), /not a text file/)
    assert.deepEqual(assets.tabs.value, [])
    assert.equal(assets.activeTab.value, null)
  })

  test("saving writes the text, marks the log, reads the host's events and cleans the tab", async () => {
    const { assets, state, calls } = setup()
    await assets.openText("res://scripts/a.lua")
    assets.editText("res://scripts/a.lua", "print(2)")
    assert.equal(isDirty(assets.tabs.value[0]), true)
    assert.equal(await assets.saveText("res://scripts/a.lua"), true)
    assert.equal(state.files.get("res://scripts/a.lua"), "print(2)")
    const tab = assets.tabs.value[0]
    assert.equal(isDirty(tab), false)
    assert.equal(tab.saveMark, 7)
    assert.deepEqual(calls.slice(-2), ["writeTextAsset res://scripts/a.lua", "poll"])
  })

  test("a refused write loses nothing: the text stays dirty with the host's words", async () => {
    const { assets, state } = setup()
    await assets.openText("res://scripts/a.lua")
    assets.editText("res://scripts/a.lua", "print(2)")
    state.fail.set("writeTextAsset", "res://scripts/a.lua is the open scene's file")
    assert.equal(await assets.saveText("res://scripts/a.lua"), false)
    const tab = assets.tabs.value[0]
    assert.equal(tab.text, "print(2)")
    assert.equal(isDirty(tab), true)
    assert.equal(tab.error, "res://scripts/a.lua is the open scene's file")
    assert.equal(tab.saving, false)
    // The next save, once the host takes it, clears the message
    state.fail.clear()
    assert.equal(await assets.saveText("res://scripts/a.lua"), true)
    assert.equal(assets.tabs.value[0].error, null)
  })

  test("text the host can't take is refused before it is sent", async () => {
    const { assets, calls } = setup()
    await assets.openText("res://scripts/a.lua")
    assets.editText("res://scripts/a.lua", "a\u0000b")
    assert.equal(await assets.saveText("res://scripts/a.lua"), false)
    assert.match(assets.tabs.value[0].error!, /NUL/)
    assert.equal(calls.some((c) => c.startsWith("writeTextAsset")), false)
    assert.equal(assets.tabs.value[0].text, "a\u0000b")
  })

  test("text typed while a save is on its way stays, dirty", async () => {
    const { assets, engine, state } = setup()
    await assets.openText("res://scripts/a.lua")
    assets.editText("res://scripts/a.lua", "one")
    let release!: () => void
    engine.writeTextAsset = async (path: string, text: string) => {
      await new Promise<void>((resolve) => (release = resolve))
      state.files.set(path, text)
    }
    const saving = assets.saveText("res://scripts/a.lua")
    await tick()
    assert.equal(assets.tabs.value[0].saving, true)
    assets.editText("res://scripts/a.lua", "two")
    release()
    assert.equal(await saving, true)
    const tab = assets.tabs.value[0]
    assert.equal(tab.text, "two")
    assert.equal(tab.savedText, "one")
    assert.equal(isDirty(tab), true)
  })

  test("saves of one file run one after the other", async () => {
    const { assets, engine } = setup()
    await assets.openText("res://scripts/a.lua")
    const order: string[] = []
    let running = 0
    engine.writeTextAsset = async (_path: string, text: string) => {
      running++
      assert.equal(running, 1, "two writes at once")
      await tick()
      order.push(text)
      running--
    }
    assets.editText("res://scripts/a.lua", "one")
    const first = assets.saveText("res://scripts/a.lua")
    assets.editText("res://scripts/a.lua", "two")
    const second = assets.saveText("res://scripts/a.lua")
    await Promise.all([first, second])
    // Each write takes the text as it is when its turn comes
    assert.equal(order.length, 2)
    assert.equal(order[1], "two")
    assert.equal(isDirty(assets.tabs.value[0]), false)
  })

  test("closing a tab moves to another", async () => {
    const { assets, state } = setup()
    state.files.set("res://b.lua", "b")
    await assets.openText("res://scripts/a.lua")
    await assets.openText("res://b.lua")
    assets.closeText("res://b.lua")
    assert.equal(assets.activeTab.value, "res://scripts/a.lua")
    assets.closeText("res://scripts/a.lua")
    assert.equal(assets.activeTab.value, null)
  })

  test("reloading throws away the edits", async () => {
    const { assets } = setup()
    await assets.openText("res://scripts/a.lua")
    assets.editText("res://scripts/a.lua", "mine")
    await assets.reloadText("res://scripts/a.lua")
    assert.equal(assets.tabs.value[0].text, "print(1)")
  })
})

describe("AssetsState following the host", () => {
  test("a file changed outside shows in a clean tab", async () => {
    const { assets, state } = setup()
    await assets.refresh()
    await assets.openText("res://scripts/a.lua")
    state.files.set("res://scripts/a.lua", "print('outside')")
    await assets.onAssetsChanged(change({ modified: ["res://scripts/a.lua"] }))
    assert.equal(assets.tabs.value[0].text, "print('outside')")
    assert.equal(assets.tabs.value[0].external, null)
  })

  test("a file changed outside under unsaved edits is flagged and the edits stay", async () => {
    const { assets, state } = setup()
    await assets.openText("res://scripts/a.lua")
    assets.editText("res://scripts/a.lua", "mine")
    state.files.set("res://scripts/a.lua", "theirs")
    await assets.onAssetsChanged(change({ modified: ["res://scripts/a.lua"] }))
    const tab = assets.tabs.value[0]
    assert.equal(tab.text, "mine")
    assert.equal(tab.external, "changed")
    // Saving is the user's choice, and clears the flag
    assert.equal(await assets.saveText("res://scripts/a.lua"), true)
    assert.equal(assets.tabs.value[0].external, null)
  })

  test("the echo of our own save changes nothing", async () => {
    const { assets } = setup()
    await assets.openText("res://scripts/a.lua")
    assets.editText("res://scripts/a.lua", "print(2)")
    await assets.saveText("res://scripts/a.lua")
    assets.editText("res://scripts/a.lua", "print(3)")
    await assets.onAssetsChanged(change({ modified: ["res://scripts/a.lua"] }))
    const tab = assets.tabs.value[0]
    assert.equal(tab.text, "print(3)")
    assert.equal(tab.external, null)
  })

  test("a deleted file's tab keeps its text and says so", async () => {
    const { assets, state } = setup()
    await assets.openText("res://scripts/a.lua")
    state.files.delete("res://scripts/a.lua")
    await assets.onAssetsChanged(change({ removed: ["res://scripts/a.lua"] }))
    assert.equal(assets.tabs.value[0].external, "removed")
    assert.equal(assets.tabs.value[0].text, "print(1)")
    // Saving makes it again
    assert.equal(await assets.saveText("res://scripts/a.lua"), true)
    assert.equal(assets.tabs.value[0].external, null)
  })

  test("only the files an event names are read; no event (missed events) reads them all", async () => {
    const { assets, state, calls } = setup()
    state.files.set("res://b.lua", "b")
    await assets.openText("res://scripts/a.lua")
    await assets.openText("res://b.lua")
    calls.length = 0
    await assets.onAssetsChanged(change({ modified: ["res://b.lua"] }))
    assert.deepEqual(calls.filter((c) => c.startsWith("readTextAsset")), ["readTextAsset res://b.lua"])
    calls.length = 0
    await assets.onAssetsChanged(null)
    assert.equal(calls.filter((c) => c.startsWith("readTextAsset")).length, 2)
    assert.ok(calls.some((c) => c.startsWith("listAssets")))
  })

  test("a connection that ends keeps the open files; a closed project drops them", async () => {
    const { assets } = setup()
    await assets.refresh()
    await assets.openText("res://scripts/a.lua")
    assets.editText("res://scripts/a.lua", "unsaved")
    assets.reset()
    assert.equal(assets.listing.value, null)
    assert.equal(assets.tabs.value[0].text, "unsaved")
    assets.resetProject()
    assert.deepEqual(assets.tabs.value, [])
  })
})

describe("the log after a save", () => {
  test("the errors the host logged after the mark are a save's reload errors", async () => {
    const polls: Array<{ epoch: number; afterSeq: number }> = []
    const log = new ConsoleStore(async (epoch, afterSeq) => {
      polls.push({ epoch, afterSeq })
      return { epoch: 1, nextSeq: 2, dropped: 0, events: [] } as never
    })
    const mark = log.lastEntryId
    assert.equal(mark, 0)
    log.note("error", "before")
    const before = log.lastEntryId
    log.note("info", "after, info")
    log.note("error", "after, error")
    const after = entriesAfter(log.entries.value, before, "error")
    assert.deepEqual(after.map((e) => e.message), ["after, error"])
    log.clear()
    assert.equal(log.lastEntryId, 3, "the mark counts entries ever added, so clearing the console doesn't reuse ids")
  })
})

describe("asset drags", () => {
  test("an asset's drag data is read back, checked", () => {
    const entry = { uuid: U1.toUpperCase(), path: "res://hero.png", resourceType: "Texture" }
    assert.deepEqual(parseAssetDrag(assetDragData(entry)), { uuid: U1, path: "res://hero.png", resourceType: "Texture" })
  })

  test("anything else is no asset", () => {
    assert.equal(parseAssetDrag(""), null)
    assert.equal(parseAssetDrag("C:\\project\\assets\\hero.png"), null)
    assert.equal(parseAssetDrag("[]"), null)
    assert.equal(parseAssetDrag(JSON.stringify({ uuid: "nope", path: "res://a", type: "Texture" })), null)
    assert.equal(parseAssetDrag(JSON.stringify({ uuid: U1, path: 5, type: "Texture" })), null)
  })
})

describe("review fixes", () => {
  test("a detail read that began before Apply doesn't replace what is being sent", async () => {
    const { assets, engine, state } = setup()
    await assets.refresh()
    await assets.select("res://hero.png")
    // A read of the detail that is slow, then an Apply while it is on its way
    const read = engine.getAssetInfo
    let answerRead!: () => void
    engine.getAssetInfo = async (...args: Parameters<typeof read>) => {
      const old = await read(...args)
      await new Promise<void>((resolve) => (answerRead = resolve))
      return old
    }
    const refreshing = assets.refresh()
    await tick()
    await tick()
    assets.editSettings('{ "mine": 1 }')
    let finishSet!: () => void
    engine.setImportSettings = async (_path: string, data: unknown) => {
      await new Promise<void>((resolve) => (finishSet = resolve))
      state.settings = data as Record<string, unknown>
    }
    engine.getAssetInfo = read
    const applying = assets.applySettings()
    await tick()
    assert.equal(assets.detail.value?.saving, true)
    answerRead() // the old answer: the host's settings from before
    await refreshing
    assert.equal(assets.detail.value?.settings, '{ "mine": 1 }')
    assert.equal(assets.detail.value?.saving, true)
    finishSet()
    assert.equal(await applying, true)
    assert.equal(assets.detail.value?.saving, false)
    assert.deepEqual(state.settings, { mine: 1 })
    assert.equal(assets.detail.value?.baseline, '{\n  "mine": 1\n}')
  })

  test("a refresh asked for while one is dropped by a reset still reads again for the new connection", async () => {
    const { assets, engine } = setup()
    let release!: () => void
    let reads = 0
    const list = engine.listAssets
    engine.listAssets = async (...args: Parameters<typeof list>) => {
      reads++
      if (reads === 1) await new Promise<void>((resolve) => (release = resolve))
      return list(...args)
    }
    const first = assets.refresh()
    await tick()
    assets.reset()
    const second = assets.refresh() // shares the running one and asks for another read
    release()
    await Promise.all([first, second])
    assert.equal(reads, 2)
    assert.equal(assets.listing.value?.assets.length, 2)
  })

  test("a CRLF file stays CRLF: the editor holds LF, the file gets CRLF back, and the tab is clean until edited", async () => {
    const { assets, state } = setup()
    state.files.set("res://c.lua", "a\r\nb\r\n")
    await assets.openText("res://c.lua")
    const tab = () => assets.tabs.value[0]
    assert.equal(tab().text, "a\nb\n")
    assert.equal(tab().lineEnding, "\r\n")
    assert.equal(isDirty(tab()), false)
    assets.editText("res://c.lua", "a\nb\nc\n")
    await assets.saveText("res://c.lua")
    assert.equal(state.files.get("res://c.lua"), "a\r\nb\r\nc\r\n")
    // Undoing the edit is no change
    assets.editText("res://c.lua", "a\nb\nc\n")
    assert.equal(isDirty(tab()), false)
    // The same file read from disk again is the same text, so the event's echo changes nothing
    await assets.onAssetsChanged(change({ modified: ["res://c.lua"] }))
    assert.equal(tab().external, null)
    assert.equal(tab().text, "a\nb\nc\n")
  })

  test("an LF file stays LF, and a file changed outside to CRLF follows when it has no edits", async () => {
    const { assets, state } = setup()
    await assets.openText("res://scripts/a.lua")
    assert.equal(assets.tabs.value[0].lineEnding, "\n")
    state.files.set("res://scripts/a.lua", "print(1)\r\n")
    await assets.onAssetsChanged(change({ modified: ["res://scripts/a.lua"] }))
    assert.equal(assets.tabs.value[0].lineEnding, "\r\n")
    assert.equal(assets.tabs.value[0].text, "print(1)\n")
  })

  test("the size limit is on what is written (CRLF counts)", async () => {
    const { assets, state, calls } = setup()
    state.files.set("res://big.lua", "a\r\n")
    await assets.openText("res://big.lua")
    // Under the limit with LF line breaks, over it with CRLF
    assets.editText("res://big.lua", "x\n".repeat(MaxTextAssetBytes / 2 - 100))
    assert.equal(await assets.saveText("res://big.lua"), false)
    assert.match(assets.tabs.value[0].error!, /larger than 4 MiB/)
    assert.equal(calls.some((c) => c.startsWith("writeTextAsset")), false)
  })

  test("errors the host logged after the save's poll are not blamed on that save", () => {
    const log = new ConsoleStore(async () => ({ epoch: 1, nextSeq: 2, dropped: 0, events: [] }) as never)
    const mark = log.lastEntryId
    log.note("error", "from the reload")
    const end = log.lastEntryId
    log.note("error", "something later")
    assert.deepEqual(
      entriesAfter(log.entries.value, mark, "error", end).map((e) => e.message),
      ["from the reload"]
    )
  })

  test("while a play session blocks edits nothing is sent, and the text stays", async () => {
    const { engine, calls } = setup()
    let blocked: string | null = "the game is playing"
    const assets = new AssetsState(
      engine,
      null,
      () => {},
      () => blocked
    )
    await assets.refresh()
    await assets.select("res://hero.png")
    await assert.rejects(assets.createFolder("res://", "x"), /can't be changed now: the game is playing/)
    await assert.rejects(assets.createScript("res://", "x"), /can't be changed now/)
    assets.editSettings('{ "a": 1 }')
    assert.equal(await assets.applySettings(), false)
    assert.match(assets.detail.value!.error!, /can't be changed now/)
    await assets.openText("res://scripts/a.lua")
    assets.editText("res://scripts/a.lua", "mine")
    assert.equal(await assets.saveText("res://scripts/a.lua"), false)
    assert.match(assets.tabs.value[0].error!, /can't be changed now/)
    assert.equal(assets.tabs.value[0].text, "mine")
    assert.equal(calls.some((c) => /^(createFolder|createScriptAsset|setImportSettings|writeTextAsset)/.test(c)), false)
    blocked = null
    assert.equal(await assets.saveText("res://scripts/a.lua"), true)
  })

  test("current() shares the read that is on its way and doesn't ask again", async () => {
    const { assets, calls } = setup()
    const reading = assets.refresh()
    const listing = await assets.current()
    await reading
    assert.equal(listing.assets.length, 2)
    assert.equal(calls.filter((c) => c.startsWith("listAssets")).length, 1)
  })
})
