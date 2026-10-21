/// <reference path="../renderer/globals.d.ts" />
import "./setup"
import { test, describe, beforeEach, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import { signal } from "@preact/signals"
import { screen, waitFor, within, fireEvent, act, render } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import { ActionDef, Keymap, keymap } from "../renderer/keymap"
import { useKeymapActions } from "../renderer/keymap-hooks"
import { GlobalActionDeps, globalActionHandlers } from "../renderer/global-actions"
import { EditActions, editActions } from "../renderer/edit-actions"
import { ViewportKeyboard } from "../renderer/viewport-keys"
import type { PointerAction } from "../renderer/viewport-input"
import { AssetsState } from "../renderer/assets-state"
import { AssetsPanel, TextEditor } from "../renderer/assets-panel"
import { ConfirmDialog, ContextMenu, ShortcutsDialog, closeShortcutsDialog, confirmDialog, modalOpen, showContextMenu, showShortcutsDialog } from "../renderer/ui"
import { ConsolePanel } from "../renderer/console-panel"
import { ConsoleStore } from "../renderer/console-store"
import { LayoutController } from "../renderer/layout/layout-controller"
import { LayoutPersistence } from "../renderer/layout/layout-storage"
import { WindowButton } from "../renderer/layout/layout-view"
import { fixtureRegistry } from "../test/layout-fixture"
import { renderWithApp } from "./helpers"
import { FakeAssetHost, stubStore } from "./panel-fakes"

beforeEach(() => {
  showContextMenu(0, 0, [])
  closeShortcutsDialog()
  editActions.value = null
})

afterEach(() => {
  document.body.innerHTML = ""
  closeShortcutsDialog()
  editActions.value = null
})

/** A key press as the browser makes it; fireEvent returns false when something prevented its default */
const press = (target: Element | Document, key: string, init: KeyboardEventInit = {}): boolean =>
  fireEvent.keyDown(target, { key, code: init.code ?? "", ...init })

// ==================== The dispatcher, over a keymap of its own and real DOM ====================

describe("the dispatcher", () => {
  const actions: ActionDef[] = [
    { id: "g.save", title: "Save", scope: "global", chords: ["Mod+S"], allowInText: true },
    { id: "g.undo", title: "Undo", scope: "global", chords: ["Mod+Z"] },
    { id: "v.save", title: "Viewport save", scope: "viewport", chords: ["Mod+S"], allowInText: true },
    { id: "v.frame", title: "Frame", scope: "viewport", chords: ["KeyF"] },
    { id: "h.delete", title: "Delete", scope: "hierarchy", chords: ["Delete"] },
  ]
  let km: Keymap
  let log: string[]
  let modal = false

  const page = () => {
    document.body.innerHTML =
      '<div id="vp" data-keymap-scope="viewport" tabindex="0"><input id="vpinput" type="text"><button id="vpbutton"></button></div>' +
      '<div id="vp2" data-keymap-scope="viewport" tabindex="0"><span id="vp2inner"></span></div>' +
      '<div id="hier" data-keymap-scope="hierarchy"><button id="hierbutton"></button></div>' +
      '<div id="plain"><input id="field" type="text"><textarea id="area"></textarea><input id="box" type="checkbox"><div id="editable"></div></div>'
    // jsdom does not compute isContentEditable
    Object.defineProperty(document.getElementById("editable")!, "isContentEditable", { value: true })
  }
  const el = (id: string) => document.getElementById(id)!

  beforeEach(() => {
    km = new Keymap(actions)
    log = []
    modal = false
    page()
    km.install(document, { isModalOpen: () => modal })
    for (const def of actions) km.handle(def.id, () => void log.push(def.id))
  })
  afterEach(() => km.uninstall())

  test("a chord runs its action once and prevents the key's default; other keys are left alone", () => {
    assert.equal(press(el("plain"), "z", { ctrlKey: true }), false)
    assert.deepEqual(log, ["g.undo"])
    assert.equal(press(el("plain"), "q"), true)
    assert.equal(press(el("plain"), "z"), true)
    assert.deepEqual(log, ["g.undo"])
  })

  test("while a text field has the focus only the actions marked for text run: undo is the field's own, save is the editor's", () => {
    for (const id of ["field", "area", "editable", "vpinput"]) {
      log.length = 0
      assert.equal(press(el(id), "z", { ctrlKey: true }), true, `${id}: undo is left to the field`)
      assert.deepEqual(log, [], id)
    }
    assert.equal(press(el("field"), "s", { ctrlKey: true }), false)
    assert.deepEqual(log, ["g.save"])
  })

  test("a field that takes no text (a checkbox, a button) is not text entry", () => {
    press(el("box"), "z", { ctrlKey: true })
    press(el("hierbutton"), "z", { ctrlKey: true })
    assert.deepEqual(log, ["g.undo", "g.undo"])
  })

  test("the focused scope's action comes first, a global one is the fallback, and an action of another scope never runs", () => {
    press(el("vpbutton"), "s", { ctrlKey: true })
    assert.deepEqual(log, ["v.save"], "the viewport's save, not the global one")
    log.length = 0
    press(el("hierbutton"), "s", { ctrlKey: true })
    assert.deepEqual(log, ["g.save"], "the hierarchy has none: the global one")
    log.length = 0
    press(el("plain"), "s", { ctrlKey: true })
    assert.deepEqual(log, ["g.save"], "no scope: the global one")
    log.length = 0
    for (const id of ["hierbutton", "plain", "hier"]) press(el(id), "f", { code: "KeyF" })
    press(el("vpbutton"), "Delete")
    press(el("plain"), "Delete")
    assert.deepEqual(log, [], "viewport keys outside the viewport, hierarchy keys outside the hierarchy")
    press(el("vpbutton"), "f", { code: "KeyF" })
    press(el("hierbutton"), "Delete")
    assert.deepEqual(log, ["v.frame", "h.delete"])
  })

  test("the scope is the nearest one up the tree, so a key in a child of the panel is the panel's", () => {
    press(el("vp2inner"), "f", { code: "KeyF" })
    assert.deepEqual(log, ["v.frame"])
  })

  test("a handler that returns false did not take the key: the global action gets it, and the default is not prevented before then", () => {
    km.handle("v.save", () => {
      log.push("v.save declined")
      return false
    })
    assert.equal(press(el("vpbutton"), "s", { ctrlKey: true }), false)
    assert.deepEqual(log, ["v.save declined", "g.save"])
  })

  test("when no handler takes the key it is not prevented", () => {
    const bare = new Keymap(actions)
    bare.handle("g.undo", () => false)
    km.uninstall()
    bare.install(document)
    assert.equal(press(el("plain"), "z", { ctrlKey: true }), true)
    bare.uninstall()
  })

  test("`within` picks the instance whose element has the key press, and the most recent registration wins", () => {
    km.handle("v.frame", () => void log.push("first vp"), { within: el("vp") })
    km.handle("v.frame", () => void log.push("vp2"), { within: el("vp2") })
    press(el("vp2inner"), "f", { code: "KeyF" })
    press(el("vpbutton"), "f", { code: "KeyF" })
    assert.deepEqual(log, ["vp2", "first vp"])
    log.length = 0
    const off = km.handle("v.frame", () => void log.push("newest"))
    press(el("vpbutton"), "f", { code: "KeyF" })
    off()
    press(el("vpbutton"), "f", { code: "KeyF" })
    assert.deepEqual(log, ["newest", "first vp"])
  })

  test("a dialog open stops every shortcut, text ones too, and they work again when it closes", () => {
    modal = true
    assert.equal(press(el("plain"), "z", { ctrlKey: true }), true)
    assert.equal(press(el("field"), "s", { ctrlKey: true }), true)
    assert.deepEqual(log, [])
    modal = false
    press(el("plain"), "z", { ctrlKey: true })
    assert.deepEqual(log, ["g.undo"])
  })

  test("a key something already took (the viewport's fly keys, a game view) is not a shortcut, and neither is one while composing text", () => {
    el("vp").addEventListener("keydown", (e) => e.preventDefault())
    assert.equal(press(el("vpbutton"), "f", { code: "KeyF" }), false)
    assert.deepEqual(log, [])
    assert.equal(press(el("plain"), "z", { ctrlKey: true, isComposing: true }), true)
    assert.deepEqual(log, [])
  })

  test("installing again keeps one dispatcher: a key runs its action once; uninstalled, it runs none", () => {
    km.install(document, { isModalOpen: () => modal })
    km.install(document, { isModalOpen: () => modal })
    press(el("plain"), "z", { ctrlKey: true })
    assert.deepEqual(log, ["g.undo"])
    km.uninstall()
    press(el("plain"), "z", { ctrlKey: true })
    assert.deepEqual(log, ["g.undo"])
  })

  test("a handler that throws does not break the page: the key counts as taken, and the error is logged", () => {
    km.handle("g.undo", () => {
      throw new Error("handler bug")
    })
    const original = console.error
    const errors: unknown[][] = []
    console.error = (...args: unknown[]) => void errors.push(args)
    try {
      assert.equal(press(el("plain"), "z", { ctrlKey: true }), false)
    } finally {
      console.error = original
    }
    assert.equal(errors.length, 1)
    assert.match(String(errors[0][0]), /g\.undo/)
  })

  test("rebinding moves an action to the new chord and reset gives the old one back", () => {
    assert.equal(km.bind("g.undo", ["Mod+U"]).ok, true)
    press(el("plain"), "z", { ctrlKey: true })
    assert.deepEqual(log, [])
    press(el("plain"), "u", { ctrlKey: true })
    assert.deepEqual(log, ["g.undo"])
    km.reset("g.undo")
    press(el("plain"), "z", { ctrlKey: true })
    assert.deepEqual(log, ["g.undo", "g.undo"])
    // A chord another action of the scope has is refused, and the old one keeps working
    const result = km.bind("g.undo", ["Mod+S"])
    assert.equal(result.ok, false)
    assert.equal(result.conflicts.length, 1)
    press(el("plain"), "z", { ctrlKey: true })
    assert.equal(log.at(-1), "g.undo")
  })
})

// ==================== The editor's global shortcuts ====================

function Harness({ deps }: { deps: GlobalActionDeps }) {
  useKeymapActions(globalActionHandlers(deps))
  return (
    <div id="area">
      <input id="field" type="text" />
      <input id="box" type="checkbox" />
      <div class="inspector-panel">
        <input id="insp" type="text" />
      </div>
      <div class="modal">
        <input id="dialogfield" type="text" />
      </div>
    </div>
  )
}

function fakeDeps(options: { scene?: boolean; busy?: boolean } = {}) {
  const calls: string[] = []
  const errors: string[] = []
  const deps: GlobalActionDeps = {
    store: {
      scene: { value: options.scene === false ? null : { name: "a" } },
      busy: { value: options.busy ? "Saving..." : null },
      saveScene: async () => {
        calls.push("saveScene")
        return true
      },
      reportError: (what, e) => void errors.push(`${what}: ${e instanceof Error ? e.message : String(e)}`),
    },
    hierarchy: { renameSettled: Promise.resolve() },
    inspector: {
      flush: async () => {
        calls.push("inspector.flush")
      },
    },
    assets: {
      refresh: async () => {
        calls.push("assets.refresh")
      },
    },
  }
  return { deps, calls, errors }
}

const editFake = (options: { busy?: boolean } = {}) => {
  const log: string[] = []
  const actions: EditActions = {
    undo: () => void log.push("undo"),
    redo: () => void log.push("redo"),
    canUndo: () => true,
    canRedo: () => true,
    busy: () => options.busy === true,
  }
  editActions.value = actions
  return log
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 15))

describe("Ctrl+S, undo and redo (the global actions)", () => {
  test("Ctrl+S (and Cmd+S) commits the inspector, saves the scene, then reads the assets again", async () => {
    const { deps, calls } = fakeDeps()
    renderWithApp(<Harness deps={deps} />)
    assert.equal(press(document.getElementById("area")!, "s", { ctrlKey: true }), false)
    await waitFor(() => assert.deepEqual(calls, ["inspector.flush", "saveScene", "assets.refresh"]))
    calls.length = 0
    press(document.getElementById("area")!, "s", { metaKey: true })
    await waitFor(() => assert.deepEqual(calls, ["inspector.flush", "saveScene", "assets.refresh"]))
  })

  test("it saves from a text field too, and an inspector field is committed (left) first", async () => {
    const { deps, calls } = fakeDeps()
    renderWithApp(<Harness deps={deps} />)
    const field = document.getElementById("field") as HTMLInputElement
    press(field, "s", { ctrlKey: true })
    await waitFor(() => assert.ok(calls.includes("saveScene")))
    calls.length = 0
    const insp = document.getElementById("insp") as HTMLInputElement
    insp.focus()
    assert.equal(document.activeElement, insp)
    press(insp, "s", { ctrlKey: true })
    assert.notEqual(document.activeElement, insp, "the field's value is committed by leaving it")
    await waitFor(() => assert.ok(calls.includes("saveScene")))
  })

  test("with no scene, or while busy, the key does nothing (and is still taken)", async () => {
    for (const options of [{ scene: false }, { busy: true }]) {
      const { deps, calls } = fakeDeps(options)
      const view = renderWithApp(<Harness deps={deps} />)
      assert.equal(press(document.getElementById("area")!, "s", { ctrlKey: true }), false)
      await settle()
      assert.deepEqual(calls, [], JSON.stringify(options))
      view.unmount()
    }
  })

  test("a key in a dialog's field does nothing (it is taken)", async () => {
    const { deps, calls } = fakeDeps()
    renderWithApp(<Harness deps={deps} />)
    assert.equal(press(document.getElementById("dialogfield")!, "s", { ctrlKey: true }), false)
    await settle()
    assert.equal(calls.length, 0)
  })

  test("with a dialog open nothing happens, and the key is not taken", async () => {
    const { deps, calls } = fakeDeps()
    renderWithApp(
      <>
        <Harness deps={deps} />
        <ConfirmDialog />
      </>
    )
    const answer = confirmDialog("Sure?", "Yes")
    await screen.findByRole("alertdialog")
    assert.equal(modalOpen(), true)
    assert.equal(press(document.getElementById("area")!, "s", { ctrlKey: true }), true)
    await settle()
    assert.equal(calls.length, 0)
    fireEvent.click(screen.getByText("Cancel"))
    assert.equal(await answer, false)
    press(document.getElementById("area")!, "s", { ctrlKey: true })
    await waitFor(() => assert.ok(calls.includes("saveScene")))
  })

  test("Ctrl+Z undoes; Ctrl+Shift+Z and Ctrl+Y redo (Cmd too)", () => {
    const { deps } = fakeDeps()
    renderWithApp(<Harness deps={deps} />)
    const log = editFake()
    const area = document.getElementById("area")!
    assert.equal(press(area, "z", { ctrlKey: true }), false)
    press(area, "z", { metaKey: true })
    press(area, "Z", { ctrlKey: true, shiftKey: true })
    press(area, "y", { ctrlKey: true })
    press(area, "y", { metaKey: true })
    assert.deepEqual(log, ["undo", "undo", "redo", "redo", "redo"])
  })

  test("other chords are not undo or redo (no modifier, Alt, Ctrl+Shift+Y, Ctrl+X)", () => {
    const { deps } = fakeDeps()
    renderWithApp(<Harness deps={deps} />)
    const log = editFake()
    const area = document.getElementById("area")!
    for (const init of [{ key: "z" }, { key: "y" }, { key: "x", ctrlKey: true }, { key: "z", ctrlKey: true, altKey: true }, { key: "y", ctrlKey: true, shiftKey: true }]) {
      assert.equal(press(area, init.key, init), true)
    }
    assert.deepEqual(log, [])
  })

  test("in a text field Ctrl+Z is the field's own undo (not taken); in a checkbox it is the editor's", () => {
    const { deps } = fakeDeps()
    renderWithApp(<Harness deps={deps} />)
    const log = editFake()
    assert.equal(press(document.getElementById("field")!, "z", { ctrlKey: true }), true)
    assert.equal(press(document.getElementById("insp")!, "y", { ctrlKey: true }), true)
    assert.deepEqual(log, [])
    assert.equal(press(document.getElementById("box")!, "z", { ctrlKey: true }), false)
    assert.deepEqual(log, ["undo"])
  })

  test("with nothing registered the keys do nothing and are not taken; with a dialog open neither", () => {
    const { deps } = fakeDeps()
    renderWithApp(
      <>
        <Harness deps={deps} />
        <ConfirmDialog />
      </>
    )
    assert.equal(editActions.value, null)
    assert.equal(press(document.getElementById("area")!, "z", { ctrlKey: true }), true)
    const log = editFake()
    void confirmDialog("Sure?", "Yes")
    return screen.findByRole("alertdialog").then(() => {
      assert.equal(press(document.getElementById("area")!, "z", { ctrlKey: true }), true)
      assert.deepEqual(log, [])
      fireEvent.click(screen.getByText("Cancel"))
    })
  })

  test("a held key (repeat) is ignored while an undo is running, and not otherwise", () => {
    const { deps } = fakeDeps()
    renderWithApp(<Harness deps={deps} />)
    const area = document.getElementById("area")!
    const busy = editFake({ busy: true })
    assert.equal(press(area, "z", { ctrlKey: true, repeat: true }), false, "taken, not run")
    assert.deepEqual(busy, [])
    const free = editFake({ busy: false })
    press(area, "z", { ctrlKey: true, repeat: true })
    assert.deepEqual(free, ["undo"])
  })

  test("a failing undo is reported, not thrown", async () => {
    const { deps, errors } = fakeDeps()
    renderWithApp(<Harness deps={deps} />)
    editActions.value = {
      undo: async () => {
        throw new Error("Nothing to undo")
      },
      redo: () => {},
      canUndo: () => true,
      canRedo: () => true,
    }
    press(document.getElementById("area")!, "z", { ctrlKey: true })
    await waitFor(() => assert.deepEqual(errors, ["Failed to undo: Nothing to undo"]))
  })

  test("a rebound chord works and the old one stops; the keys are released when the editor goes", async () => {
    const { deps, calls } = fakeDeps()
    const view = renderWithApp(<Harness deps={deps} />)
    const area = document.getElementById("area")!
    assert.equal(keymap.bind("file.save", ["Mod+Shift+S"]).ok, true)
    press(area, "s", { ctrlKey: true })
    await settle()
    assert.equal(calls.length, 0)
    press(area, "S", { ctrlKey: true, shiftKey: true })
    await waitFor(() => assert.ok(calls.includes("saveScene")))
    keymap.reset("file.save")
    calls.length = 0
    const probe = document.createElement("div")
    document.body.append(probe)
    view.unmount()
    // Nothing registered (Preact runs the unregistering a moment after the unmount): the action has no handler, so the key is not taken
    await waitFor(() => assert.equal(press(probe, "s", { ctrlKey: true }), true))
    // (what the presses before the unregistering did is not the question)
    await settle()
    calls.length = 0
    press(probe, "s", { ctrlKey: true })
    await settle()
    assert.equal(calls.length, 0)
  })
})

// ==================== The text editor and the import settings ====================

describe("Ctrl+S in the assets panel and the text editor", () => {
  async function renderAssets() {
    const host = new FakeAssetHost()
    const writes: string[] = []
    host.engine.writeTextAsset = (async (path: string, text: string) => {
      writes.push(`${path}=${text}`)
    }) as typeof host.engine.writeTextAsset
    const imports: string[] = []
    host.engine.setImportSettings = (async (path: string) => {
      imports.push(path)
    }) as typeof host.engine.setImportSettings
    const fake = stubStore()
    Object.assign(fake.signals, { console: { entries: signal([]) } })
    const assets = new AssetsState(host.engine, null, fake.signals.reportError, () => fake.signals.readOnlyReason.peek())
    await assets.refresh()
    const { deps, calls } = fakeDeps()
    function Page() {
      useKeymapActions(globalActionHandlers(deps))
      return (
        <>
          <AssetsPanel />
          {assets.tabs.value.map((t) => (
            <TextEditor path={t.path} key={t.path} />
          ))}
          <ContextMenu />
        </>
      )
    }
    renderWithApp(<Page />, { store: fake.store, assets })
    return { host, assets, writes, imports, calls }
  }

  test("in the text editor Ctrl+S writes that file and not the scene", async () => {
    const t = await renderAssets()
    await act(() => t.assets.openText("res://scripts/a.lua"))
    t.assets.editText("res://scripts/a.lua", "print(2)")
    const area = (await screen.findByLabelText("a.lua")) as HTMLTextAreaElement
    assert.equal(area.closest("[data-keymap-scope]")!.getAttribute("data-keymap-scope"), "text")
    assert.equal(press(area, "s", { ctrlKey: true }), false)
    await waitFor(() => assert.deepEqual(t.writes, ["res://scripts/a.lua=print(2)"]))
    assert.equal(t.calls.length, 0, "the scene is not saved")
    press(area, "s", { metaKey: true })
    await waitFor(() => assert.equal(t.writes.length, 2))
  })

  test("two text editors: the key writes the file of the editor it was pressed in", async () => {
    const t = await renderAssets()
    t.host.files.set("res://scripts/b.lua", "print(b)")
    t.host.assets.push({ path: "res://scripts/b.lua", uuid: "55555555-5555-5555-5555-555555555555", type: "LuaScript", size: 8, modified: 1 })
    await act(async () => {
      await t.assets.openText("res://scripts/a.lua")
      await t.assets.openText("res://scripts/b.lua")
    })
    t.assets.editText("res://scripts/a.lua", "A!")
    t.assets.editText("res://scripts/b.lua", "B!")
    const b = (await screen.findByLabelText("b.lua")) as HTMLTextAreaElement
    press(b, "s", { ctrlKey: true })
    await waitFor(() => assert.deepEqual(t.writes, ["res://scripts/b.lua=B!"]))
    const a = (await screen.findByLabelText("a.lua")) as HTMLTextAreaElement
    press(a, "s", { ctrlKey: true })
    await waitFor(() => assert.deepEqual(t.writes, ["res://scripts/b.lua=B!", "res://scripts/a.lua=A!"]))
  })

  test("in the import settings field Ctrl+S applies the edited settings; unedited, it does nothing; neither saves the scene", async () => {
    const t = await renderAssets()
    await act(() => t.assets.select("res://hero.png"))
    act(() => t.assets.setSettingsView("json")) // a texture shows its typed form first
    const field = (await screen.findByLabelText("Import settings")) as HTMLTextAreaElement
    assert.equal(field.closest("[data-keymap-scope]")!.getAttribute("data-keymap-scope"), "assets")
    assert.equal(press(field, "s", { ctrlKey: true }), false)
    await settle()
    assert.deepEqual(t.imports, [], "nothing was edited")
    act(() => t.assets.editSettings('{"compress": true}'))
    assert.equal(press(field, "s", { ctrlKey: true }), false)
    await waitFor(() => assert.deepEqual(t.imports, ["res://hero.png"]))
    assert.equal(t.calls.length, 0)
  })

  test("in a field of the typed import settings form Ctrl+S applies the settings, not the scene", async () => {
    const t = await renderAssets()
    await act(() => t.assets.select("res://hero.png"))
    const filter = (await screen.findByLabelText("Filter")) as HTMLSelectElement
    act(() => t.assets.editSettingField("filter", "nearest"))
    assert.equal(press(filter, "s", { ctrlKey: true }), false)
    await waitFor(() => assert.deepEqual(t.imports, ["res://hero.png"]))
    assert.equal(t.calls.length, 0)
  })

  test("elsewhere in the assets panel Ctrl+S is the scene's save, as it was", async () => {
    const t = await renderAssets()
    const row = document.querySelector(".asset-list .asset-row") as HTMLElement
    press(row, "s", { ctrlKey: true })
    await waitFor(() => assert.ok(t.calls.includes("saveScene")))
    assert.deepEqual(t.imports, [])
  })
})

describe("the console panel", () => {
  test("is the console scope; its filter field saves the scene on Ctrl+S (global) and keeps Ctrl+Z for itself", async () => {
    const { deps, calls } = fakeDeps()
    const log = editFake()
    const consoleStore = new ConsoleStore((async () => {
      throw new Error("not polled")
    }) as never)
    function Page() {
      useKeymapActions(globalActionHandlers(deps))
      return <ConsolePanel />
    }
    renderWithApp(<Page />, { store: { console: consoleStore } as never })
    const panel = document.querySelector(".console-panel")!
    assert.equal(panel.getAttribute("data-keymap-scope"), "console")
    const search = screen.getByPlaceholderText("Filter")
    assert.equal(press(search, "s", { ctrlKey: true }), false)
    await waitFor(() => assert.ok(calls.includes("saveScene")))
    assert.equal(press(search, "z", { ctrlKey: true }), true)
    assert.deepEqual(log, [])
    // A checkbox of the console's filters is not text: undo is the editor's there
    press(panel.querySelector('input[type="checkbox"]')!, "z", { ctrlKey: true })
    assert.deepEqual(log, ["undo"])
  })
})

// ==================== The viewport's keys ====================

describe("the viewport's keys", () => {
  let host: HTMLElement
  let gesture: PointerAction | null
  let live: boolean
  let calls: string[]
  let kb: ViewportKeyboard
  let off: () => void

  beforeEach(() => {
    document.body.innerHTML = '<div id="host" data-keymap-scope="viewport" tabindex="0"><input id="note" type="text"><button id="tool"></button></div><div id="other"></div>'
    host = document.getElementById("host")!
    gesture = null
    live = false
    calls = []
    kb = new ViewportKeyboard({
      gesture: () => gesture,
      endGesture: () => {
        calls.push("end")
        gesture = null
      },
      frameSelected: () => void calls.push("frame"),
      live: () => live,
    })
    off = kb.register(keymap, host)
    // The view's own listener, as viewport-panel.tsx has it (outside a game)
    host.addEventListener("keydown", (e) => {
      if (live) return
      if (kb.keyDown(e)) e.preventDefault()
    })
    keymap.install(document, { isModalOpen: modalOpen })
  })
  afterEach(() => off())

  test("F frames the selection (also from a control inside the view); nothing else frames", () => {
    assert.equal(press(host, "f", { code: "KeyF" }), false)
    press(document.getElementById("tool")!, "F", { code: "KeyF" })
    assert.deepEqual(calls, ["frame", "frame"])
    calls.length = 0
    press(host, "f", { code: "KeyF", ctrlKey: true })
    press(host, "f", { code: "KeyF", altKey: true })
    press(host, "f", { code: "KeyF", metaKey: true })
    press(host, "g", { code: "KeyG" })
    press(document.getElementById("other")!, "f", { code: "KeyF" })
    assert.equal(calls.length, 0)
  })

  test("F in the view's own text field is typing, not a shortcut", () => {
    press(document.getElementById("note")!, "f", { code: "KeyF" })
    assert.equal(calls.length, 0)
  })

  test("a layout that types another letter on the F key still frames (the code is what counts)", () => {
    press(host, "\u0430", { code: "KeyF" })
    assert.deepEqual(calls, ["frame"])
  })

  test("Escape cancels a move in progress (a gesture that selects) and only that", () => {
    gesture = "select"
    assert.equal(press(host, "Escape", { code: "Escape" }), false)
    assert.deepEqual(calls, ["end"])
    for (const other of ["look", "orbit", "pan", "dolly", null] as const) {
      gesture = other
      assert.equal(press(host, "Escape", { code: "Escape" }), true, String(other))
    }
    assert.deepEqual(calls, ["end"])
  })

  test("while a game is live the keys are the game's: neither F nor Escape is the editor's", () => {
    live = true
    gesture = "select"
    press(host, "f", { code: "KeyF" })
    press(host, "Escape", { code: "Escape" })
    assert.equal(calls.length, 0)
  })

  test("the fly keys are taken while the right button is held, and prevented so no shortcut gets them", () => {
    gesture = "look"
    for (const code of ["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      assert.equal(press(host, "", { code }), false, code)
    }
    assert.equal(kb.keys.any, true)
    assert.deepEqual(kb.keys.direction(), { x: 0, y: 0, z: 0 }, "opposite keys cancel")
    kb.keys.clear()
    press(host, "w", { code: "KeyW" })
    assert.deepEqual(kb.keys.direction(), { x: 0, y: 0, z: 1 })
    kb.keyUp({ code: "KeyW", shiftKey: false, target: host })
    assert.equal(kb.keys.any, false)
  })

  test("outside a look the fly keys are not taken", () => {
    gesture = null
    assert.equal(press(host, "", { code: "KeyW" }), true)
    gesture = "select"
    assert.equal(press(host, "", { code: "KeyW" }), true)
    assert.equal(kb.keys.any, false)
  })

  test("priority: a shortcut on a fly key does not fire while the right button is held, and does when it is not", () => {
    // Bind the frame action to W, as a rebinding could (W is the Move tool's, so that goes first): it must lose to the fly key
    assert.equal(keymap.bind("gizmo.translate", []).ok, true)
    assert.equal(keymap.bind("viewport.frame", ["KeyW"]).ok, true)
    gesture = "look"
    press(host, "w", { code: "KeyW" })
    assert.deepEqual(calls, [], "flying, not framing")
    assert.equal(kb.keys.any, true)
    kb.keys.clear()
    gesture = null
    press(host, "w", { code: "KeyW" })
    assert.deepEqual(calls, ["frame"], "no look in progress: it is the shortcut")
    keymap.reset("viewport.frame")
    keymap.reset("gizmo.translate")
  })

  test("Shift is noted for the fly camera's speed, from a key press and when it is released", () => {
    press(host, "Shift", { code: "ShiftLeft", shiftKey: true })
    assert.equal(kb.boost, true)
    kb.keyUp({ code: "ShiftLeft", shiftKey: false, target: host })
    assert.equal(kb.boost, false)
    // Typing in the field is not the camera's
    kb.boost = false
    press(document.getElementById("note")!, "Shift", { code: "ShiftLeft", shiftKey: true })
    assert.equal(kb.boost, false)
  })

  test("unregistering leaves the keys without an owner: no handler, nothing taken", () => {
    off()
    assert.equal(press(host, "f", { code: "KeyF" }), true)
    gesture = "select"
    assert.equal(press(host, "Escape", { code: "Escape" }), true)
    assert.equal(calls.length, 0)
    off = kb.register(keymap, host)
  })
})

// ==================== The shortcuts list ====================

describe("the Keyboard shortcuts list", () => {
  test("lists every action with its chords, by scope, in a table with headers", () => {
    render(<ShortcutsDialog />)
    act(() => showShortcutsDialog(keymap.describe()))
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" })
    assert.equal(dialog.getAttribute("aria-modal"), "true")
    const table = within(dialog).getByRole("table")
    assert.ok(within(table).getByText("Keyboard shortcuts"), "a caption")
    assert.deepEqual(
      within(table).getAllByRole("rowheader").map((h) => h.textContent).slice(0, 4),
      ["Save the scene", "Undo", "Redo", "Frame the selection"]
    )
    const redo = table.querySelector('tr[data-action="edit.redo"]')!
    assert.deepEqual(Array.from(redo.querySelectorAll("kbd")).map((k) => k.textContent), ["Ctrl+Shift+Z", "Ctrl+Y"])
    const frame = table.querySelector('tr[data-action="viewport.frame"]')!
    assert.deepEqual(Array.from(frame.querySelectorAll("kbd")).map((k) => k.textContent), ["F"])
    for (const heading of ["Everywhere", "Viewport", "Hierarchy", "Assets", "Text editor"]) {
      assert.ok(within(table).getByRole("columnheader", { name: heading }), heading)
    }
    assert.equal(table.querySelectorAll("tr[data-action]").length, keymap.describe().length)
  })

  test("shows the chords the keymap has now, and says so for an action with none", () => {
    render(<ShortcutsDialog />)
    keymap.bind("hierarchy.duplicate", ["Mod+Shift+D"])
    keymap.bind("hierarchy.collapse", [])
    act(() => showShortcutsDialog(keymap.describe()))
    const row = (id: string) => document.querySelector(`tr[data-action="${id}"]`)!
    assert.deepEqual(Array.from(row("hierarchy.duplicate").querySelectorAll("kbd")).map((k) => k.textContent), ["Ctrl+Shift+D"])
    assert.equal(row("hierarchy.collapse").textContent, "Collapse the objectNot bound")
    keymap.resetAll()
  })

  test("is read-only: the only control is Close, and there is nothing to type in", () => {
    render(<ShortcutsDialog />)
    act(() => showShortcutsDialog(keymap.describe()))
    const dialog = screen.getByRole("dialog")
    assert.deepEqual(within(dialog).getAllByRole("button").map((b) => b.textContent), ["Close"])
    assert.equal(within(dialog).queryAllByRole("textbox").length, 0)
    assert.equal(dialog.querySelectorAll("input, textarea, select").length, 0)
  })

  test("takes the focus (on Close); Escape, Close and a click outside close it; the focus goes back to what had it", async () => {
    render(
      <>
        <button id="opener">Window</button>
        <ShortcutsDialog />
      </>
    )
    const opener = document.getElementById("opener") as HTMLButtonElement
    opener.focus()
    act(() => showShortcutsDialog(keymap.describe()))
    await waitFor(() => assert.equal(document.activeElement, screen.getByRole("button", { name: "Close" })))
    assert.equal(modalOpen(), true, "the editor's shortcuts are off while it is open")
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    await waitFor(() => assert.equal(screen.queryByRole("dialog"), null))
    assert.equal(modalOpen(), false)
    await waitFor(() => assert.equal(document.activeElement, opener))

    act(() => showShortcutsDialog(keymap.describe()))
    await userEvent.setup().click(await screen.findByRole("button", { name: "Close" }))
    assert.equal(screen.queryByRole("dialog"), null)
    act(() => showShortcutsDialog(keymap.describe()))
    fireEvent.click(document.querySelector(".modal-overlay")!)
    assert.equal(screen.queryByRole("dialog"), null)
  })

  test("the keyboard alone closes it: Enter on the focused Close button", async () => {
    render(<ShortcutsDialog />)
    act(() => showShortcutsDialog(keymap.describe()))
    await waitFor(() => assert.equal(document.activeElement, screen.getByRole("button", { name: "Close" })))
    await userEvent.setup().keyboard("{Enter}")
    assert.equal(screen.queryByRole("dialog"), null)
  })

  test("the Window menu has it, and choosing it opens the list", async () => {
    const registry = fixtureRegistry<undefined>()
    const controller = new LayoutController(registry, new LayoutPersistence({ get: () => null, set: () => {}, remove: () => {} }, registry))
    render(
      <>
        <WindowButton controller={controller} />
        <ContextMenu />
        <ShortcutsDialog />
      </>
    )
    fireEvent.click(screen.getByRole("button", { name: "Window" }))
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)
    assert.equal(items.at(-1), "Keyboard shortcuts")
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Keyboard shortcuts" }))
    assert.ok(await screen.findByRole("dialog", { name: "Keyboard shortcuts" }))
  })

  test("no keymap shortcut fires while it is open, and they work again once it is closed", async () => {
    const { deps, calls } = fakeDeps()
    renderWithApp(
      <>
        <Harness deps={deps} />
        <ShortcutsDialog />
      </>
    )
    act(() => showShortcutsDialog(keymap.describe()))
    assert.equal(press(document.getElementById("area")!, "s", { ctrlKey: true }), true)
    await settle()
    assert.equal(calls.length, 0)
    act(() => closeShortcutsDialog())
    press(document.getElementById("area")!, "s", { ctrlKey: true })
    await waitFor(() => assert.ok(calls.includes("saveScene")))
  })
})
