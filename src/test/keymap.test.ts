import { test, describe } from "node:test"
import { effect } from "@preact/signals-core"
import * as assert from "node:assert/strict"
import {
  ActionDef,
  DefaultActions,
  KeyPress,
  Keymap,
  KeymapOverridesPref,
  KeymapScopes,
  MaxChordsPerAction,
  canonicalChord,
  chordMatches,
  formatChord,
  keymap as pageKeymap,
  parseChord,
} from "../renderer/keymap"
import { KeyValueStore, PrefsStore } from "../renderer/prefs"
import { editShortcutOf } from "../renderer/edit-actions"
import { shortcutFor } from "../renderer/viewport-input"

const press = (key: string, mods: Partial<Omit<KeyPress, "key">> = {}): KeyPress => ({
  key,
  code: mods.code ?? "",
  ctrlKey: mods.ctrlKey ?? false,
  metaKey: mods.metaKey ?? false,
  altKey: mods.altKey ?? false,
  shiftKey: mods.shiftKey ?? false,
})

const chord = (text: string) => {
  const parsed = parseChord(text)
  assert.ok(parsed, text)
  return parsed
}

class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>()
  get(key: string): string | null {
    return this.data.get(key) ?? null
  }
  set(key: string, value: string): void {
    this.data.set(key, value)
  }
  remove(key: string): void {
    this.data.delete(key)
  }
}

describe("chords", () => {
  test("parse: modifiers in any case, one key at the end", () => {
    assert.deepEqual(parseChord("Mod+Shift+Z"), { mod: true, ctrl: false, meta: false, alt: false, shift: true, key: "Z" })
    assert.deepEqual(parseChord("ctrl+alt+Delete"), { mod: false, ctrl: true, meta: false, alt: true, shift: false, key: "Delete" })
    assert.deepEqual(parseChord("Cmd+D"), { mod: false, ctrl: false, meta: true, alt: false, shift: false, key: "D" })
    assert.deepEqual(parseChord("Option+Control+Command+Shift+KeyF"), {
      mod: false,
      ctrl: true,
      meta: true,
      alt: true,
      shift: true,
      key: "KeyF",
    })
    assert.equal(chord("F2").key, "F2")
  })

  test("parse: what is not a chord is null", () => {
    for (const text of ["", "+", "Ctrl+", "+Z", "Ctrl+Ctrl+Z", "Hyper+Z", "Ctrl", "Shift+Alt", "Z+Ctrl", "Ctrl++Z", "x".repeat(41)]) {
      assert.equal(parseChord(text), null, JSON.stringify(text))
    }
    assert.equal(parseChord(5 as unknown as string), null)
  })

  test("match: modifiers are exact, Mod is Ctrl or Cmd, letters ignore case, a code names a physical key", () => {
    assert.equal(chordMatches(chord("Mod+Z"), press("z", { ctrlKey: true })), true)
    assert.equal(chordMatches(chord("Mod+Z"), press("Z", { metaKey: true })), true)
    assert.equal(chordMatches(chord("Mod+Z"), press("z")), false)
    assert.equal(chordMatches(chord("Mod+Z"), press("z", { ctrlKey: true, shiftKey: true })), false)
    assert.equal(chordMatches(chord("Mod+Z"), press("z", { ctrlKey: true, altKey: true })), false)
    assert.equal(chordMatches(chord("Mod+Shift+Z"), press("Z", { ctrlKey: true, shiftKey: true })), true)
    assert.equal(chordMatches(chord("Ctrl+Z"), press("z", { metaKey: true })), false)
    assert.equal(chordMatches(chord("Cmd+Z"), press("z", { metaKey: true })), true)
    assert.equal(chordMatches(chord("Cmd+Z"), press("z", { ctrlKey: true })), false)
    assert.equal(chordMatches(chord("ArrowDown"), press("ArrowDown")), true)
    assert.equal(chordMatches(chord("Shift+ArrowDown"), press("ArrowDown")), false)
    assert.equal(chordMatches(chord("KeyF"), press("f", { code: "KeyF" })), true)
    // The same physical key on another layout types another letter: the code still matches
    assert.equal(chordMatches(chord("KeyF"), press("\u0430", { code: "KeyF" })), true)
    assert.equal(chordMatches(chord("KeyF"), press("g", { code: "KeyG" })), false)
    assert.equal(chordMatches(chord("F2"), press("F2", { code: "F2" })), true)
    assert.equal(chordMatches(chord("Escape"), press("Escape", { code: "Escape" })), true)
  })

  test("a code chord is the physical key only: a key that types the letter somewhere else is not it (non-Latin and Dvorak layouts)", () => {
    // Russian layout: the physical F key types a Cyrillic letter
    assert.equal(chordMatches(chord("KeyF"), press("\u0430", { code: "KeyF" })), true, "physical F on a Russian layout")
    // A key that types "f" but is not the F key (Dvorak: the physical U key types f; Cyrillic layouts have no f at all)
    assert.equal(chordMatches(chord("KeyF"), press("f", { code: "KeyU" })), false, "types f, is not F")
    assert.equal(chordMatches(chord("KeyF"), press("F", { code: "KeyU", shiftKey: false })), false, "types F, is not F")
    // Digits are physical too: a French layout types the digit with Shift, and the symbol without
    assert.equal(chordMatches(chord("Digit1"), press("&", { code: "Digit1" })), true)
    assert.equal(chordMatches(chord("Digit1"), press("1", { code: "Numpad1" })), false)
    // The punctuation and numpad codes are physical as well
    assert.equal(chordMatches(chord("BracketLeft"), press("[", { code: "Quote" })), false)
    assert.equal(chordMatches(chord("BracketLeft"), press("x", { code: "BracketLeft" })), true)
    // A chord written with a character is what the key types, as it was; named keys are the same either way
    assert.equal(chordMatches(chord("f"), press("f", { code: "KeyU" })), true)
    assert.equal(chordMatches(chord("F2"), press("F2", { code: "F2" })), true)
    assert.equal(chordMatches(chord("Escape"), press("Escape", { code: "Escape" })), true)
    assert.equal(chordMatches(chord("Delete"), press("Delete", { code: "Delete" })), true)
    // The default frame and tool chords follow the same rule
    const keymap = new Keymap(DefaultActions)
    for (const [id, code] of [["viewport.frame", "KeyF"], ["gizmo.translate", "KeyW"], ["gizmo.rotate", "KeyE"], ["gizmo.scale", "KeyR"], ["gizmo.none", "KeyQ"], ["gizmo.space", "KeyX"]]) {
      assert.equal(keymap.chordsOf(id).some((c) => chordMatches(c, press("\u0444", { code }))), true, `${id} on a Cyrillic layout`)
      assert.equal(keymap.chordsOf(id).some((c) => chordMatches(c, press(code.slice(3).toLowerCase(), { code: "KeyZ" }))), false, `${id} typed from another key`)
    }
    // The loop types each letter from KeyZ, which is the pivot toggle's own key: it is checked from other keys here
    assert.equal(keymap.chordsOf("gizmo.pivot").some((c) => chordMatches(c, press("я", { code: "KeyZ" }))), true, "pivot on a Cyrillic layout")
    assert.equal(keymap.chordsOf("gizmo.pivot").some((c) => chordMatches(c, press("z", { code: "KeyX" }))), false, "pivot typed from another key")
  })

  test("canonical: spellings of one key press are one chord", () => {
    assert.equal(canonicalChord(chord("Mod+Z")), canonicalChord(chord("mod+z")))
    assert.equal(canonicalChord(chord("KeyF")), canonicalChord(chord("F")))
    assert.equal(canonicalChord(chord("Digit1")), canonicalChord(chord("1")))
    assert.notEqual(canonicalChord(chord("Mod+Z")), canonicalChord(chord("Ctrl+Z")))
    assert.notEqual(canonicalChord(chord("Mod+Z")), canonicalChord(chord("Mod+Shift+Z")))
  })

  test("format: Ctrl on Windows and Linux, Cmd on macOS, named keys short", () => {
    assert.equal(formatChord(chord("Mod+Shift+Z")), "Ctrl+Shift+Z")
    assert.equal(formatChord(chord("Mod+Shift+Z"), true), "Cmd+Shift+Z")
    assert.equal(formatChord(chord("Mod+D")), "Ctrl+D")
    assert.equal(formatChord(chord("KeyF")), "F")
    assert.equal(formatChord(chord("Delete")), "Del")
    assert.equal(formatChord(chord("Escape")), "Esc")
    assert.equal(formatChord(chord("Shift+ArrowDown")), "Shift+Down")
    assert.equal(formatChord(chord("F2")), "F2")
    assert.equal(formatChord(chord("Ctrl+Cmd+Alt+Shift+X"), true), "Ctrl+Cmd+Option+Shift+X")
  })
})

describe("the default actions", () => {
  test("every default chord parses, ids are unique and scopes are real", () => {
    const keymap = new Keymap(DefaultActions)
    const ids = new Set<string>()
    for (const def of DefaultActions) {
      assert.equal(ids.has(def.id), false, `${def.id} twice`)
      ids.add(def.id)
      assert.ok((KeymapScopes as readonly string[]).includes(def.scope), def.id)
      assert.match(def.id, /^[a-z]+\.[a-zA-Z]+$/)
      assert.ok(def.title.length > 0)
      assert.equal(keymap.chordsOf(def.id).length, def.chords.length, def.id)
    }
  })

  test("no two actions of one scope share a chord (a scope's action shadowing a global one is on purpose)", () => {
    assert.deepEqual(new Keymap(DefaultActions).conflicts(), [])
    assert.deepEqual(pageKeymap.conflicts(), [])
  })

  test("the actions are the ones the editor has today, nothing reserved for later in code", () => {
    assert.deepEqual(
      DefaultActions.map((a) => a.id),
      [
        "file.save",
        "edit.undo",
        "edit.redo",
        "hierarchy.rename",
        "hierarchy.delete",
        "hierarchy.duplicate",
        "hierarchy.next",
        "hierarchy.previous",
        "hierarchy.extendNext",
        "hierarchy.extendPrevious",
        "hierarchy.search",
        "hierarchy.expand",
        "hierarchy.collapse",
        "viewport.frame",
        "viewport.cancel",
        "gizmo.translate",
        "gizmo.rotate",
        "gizmo.scale",
        "gizmo.none",
        "gizmo.space",
        "gizmo.pivot",
        "assets.applySettings",
        "text.save",
      ]
    )
    // The gizmo's tool keys are the viewport's (W E R Q, as in Unity) and are physical keys, and so are the space and pivot toggles (X, Z)
    const gizmo = DefaultActions.filter((a) => a.id.startsWith("gizmo."))
    assert.deepEqual(
      gizmo.map((a) => [a.id, a.scope, a.chords]),
      [
        ["gizmo.translate", "viewport", ["KeyW"]],
        ["gizmo.rotate", "viewport", ["KeyE"]],
        ["gizmo.scale", "viewport", ["KeyR"]],
        ["gizmo.none", "viewport", ["KeyQ"]],
        ["gizmo.space", "viewport", ["KeyX"]],
        ["gizmo.pivot", "viewport", ["KeyZ"]],
      ]
    )
  })

  test("the saves work in a text field; undo and redo don't (the field has its own)", () => {
    const allow = Object.fromEntries(DefaultActions.map((a) => [a.id, a.allowInText === true]))
    assert.deepEqual(
      Object.keys(allow).filter((id) => allow[id]),
      ["file.save", "assets.applySettings", "text.save"]
    )
  })

  test("parity: the default undo and redo chords match what editShortcutOf says for every key and modifier combination", () => {
    const keymap = new Keymap(DefaultActions)
    const which = (e: KeyPress): "undo" | "redo" | null => {
      const hit = (id: string) => keymap.chordsOf(id).some((c) => chordMatches(c, e))
      return hit("edit.undo") ? "undo" : hit("edit.redo") ? "redo" : null
    }
    for (const key of ["z", "Z", "y", "Y", "x", "s", "Enter", "ArrowDown"]) {
      for (let bits = 0; bits < 16; bits++) {
        const e = press(key, { ctrlKey: !!(bits & 1), metaKey: !!(bits & 2), shiftKey: !!(bits & 4), altKey: !!(bits & 8) })
        // Ctrl and Cmd together: editShortcutOf accepts either, as Mod does
        assert.equal(which(e), editShortcutOf(e), `${key} ${bits}`)
      }
    }
  })

  test("parity: the default frame chord matches what shortcutFor said, except that Shift+F is no longer F", () => {
    const keymap = new Keymap(DefaultActions)
    const frames = (e: KeyPress) => keymap.chordsOf("viewport.frame").some((c) => chordMatches(c, e))
    for (const code of ["KeyF", "KeyG", "Escape"]) {
      for (let bits = 0; bits < 8; bits++) {
        const mods = { ctrlKey: !!(bits & 1), metaKey: !!(bits & 2), altKey: !!(bits & 4) }
        const e = press("", { ...mods, code })
        assert.equal(frames(e), shortcutFor({ code, ...mods }) === "frameSelected", `${code} ${bits}`)
      }
    }
    assert.equal(frames(press("F", { code: "KeyF", shiftKey: true })), false)
  })
})

describe("conflicts", () => {
  const actions: ActionDef[] = [
    { id: "a.one", title: "One", scope: "global", chords: ["Mod+K"] },
    { id: "a.two", title: "Two", scope: "global", chords: ["Mod+J"] },
    { id: "v.one", title: "V one", scope: "viewport", chords: ["Mod+K"] },
    { id: "v.two", title: "V two", scope: "viewport", chords: ["KeyQ"] },
  ]

  test("the same chord in one scope is a conflict; in two scopes it is shadowing, not a conflict", () => {
    assert.deepEqual(new Keymap(actions).conflicts(), [])
    const clashing = new Keymap([...actions, { id: "a.three", title: "Three", scope: "global", chords: ["mod+k"] }])
    assert.deepEqual(clashing.conflicts(), [{ chord: "Mod+k", scope: "global", actions: ["a.one", "a.three"] }])
  })

  test("bind reports a conflict and does not apply it; a chord that is free applies", () => {
    const keymap = new Keymap(actions)
    const refused = keymap.bind("a.two", ["Mod+K"])
    assert.equal(refused.ok, false)
    assert.deepEqual(refused.conflicts, [{ chord: "Mod+k", scope: "global", actions: ["a.one", "a.two"] }])
    assert.match(refused.problems[0], /Mod\+k is also a\.one/)
    assert.deepEqual(keymap.formatted("a.two"), ["Ctrl+J"], "unchanged")
    assert.equal(keymap.bind("a.two", ["Mod+L", "Alt+L"]).ok, true)
    assert.deepEqual(keymap.formatted("a.two"), ["Ctrl+L", "Alt+L"])
    // Binding an action to what it has already is no conflict with itself
    assert.equal(keymap.bind("a.two", ["Mod+L"]).ok, true)
  })

  test("a rebinding changes the revision signal, so what shows a chord can follow it", () => {
    const keymap = new Keymap(actions)
    const seen: number[] = []
    const stop = effect(() => {
      void keymap.formatted("a.two")
      seen.push(keymap.revision.value)
    })
    keymap.bind("a.two", ["Mod+L"])
    keymap.reset("a.two")
    stop()
    assert.ok(seen.length >= 3, "re-ran for the bind and the reset")
  })

  test("bind refuses more chords than the stored overrides allow, and says so, instead of storing what would be dropped on reading", () => {
    const storage = new MemoryStore()
    const prefs = new PrefsStore(storage, () => () => {})
    const keymap = new Keymap(actions)
    keymap.attachPrefs(prefs.user)
    const eight = Array.from({ length: MaxChordsPerAction }, (_, i) => `Alt+${i + 1}`)
    assert.equal(MaxChordsPerAction, 8)
    assert.equal(keymap.bind("a.two", eight).ok, true, "eight is the limit and is allowed")
    prefs.flush()
    // Read back through the validator by a new keymap: all eight survive
    const again = new Keymap(actions)
    again.attachPrefs(new PrefsStore(storage).user)
    assert.equal(again.formatted("a.two").length, 8)
    const nine = [...eight, "Alt+9"]
    const refused = keymap.bind("a.two", nine)
    assert.equal(refused.ok, false)
    assert.match(refused.problems[0], /at most 8 chords/)
    assert.equal(keymap.formatted("a.two").length, 8, "the earlier binding is kept")
    // The same limit as the validator: nine chords are exactly what it drops
    assert.equal(KeymapOverridesPref.validate({ "a.two": nine })?.["a.two"], undefined)
    assert.equal(KeymapOverridesPref.validate({ "a.two": eight })?.["a.two"]?.length, 8)
  })

  test("bind refuses an action that does not exist and a chord that does not parse, as a whole", () => {
    const keymap = new Keymap(actions)
    assert.equal(keymap.bind("nope.nothing", ["Mod+L"]).ok, false)
    const bad = keymap.bind("a.two", ["Mod+L", "Hyper+X"])
    assert.equal(bad.ok, false)
    assert.deepEqual(keymap.formatted("a.two"), ["Ctrl+J"])
  })
})

describe("overrides", () => {
  const actions: ActionDef[] = [
    { id: "x.save", title: "Save", scope: "global", chords: ["Mod+S"] },
    { id: "x.open", title: "Open", scope: "global", chords: ["Mod+O"] },
  ]

  test("an override replaces the action's chords, reset gives the defaults back, an empty list unbinds", () => {
    const keymap = new Keymap(actions)
    assert.equal(keymap.bind("x.save", ["Mod+Shift+S"]).ok, true)
    assert.deepEqual(keymap.formatted("x.save"), ["Ctrl+Shift+S"])
    assert.equal(chordMatches(keymap.chordsOf("x.save")[0], press("S", { ctrlKey: true, shiftKey: true })), true)
    assert.equal(keymap.chordsOf("x.save").some((c) => chordMatches(c, press("s", { ctrlKey: true }))), false)
    assert.deepEqual(keymap.getOverrides(), { "x.save": ["Mod+Shift+S"] })
    keymap.reset("x.save")
    assert.deepEqual(keymap.formatted("x.save"), ["Ctrl+S"])
    assert.deepEqual(keymap.getOverrides(), {})
    keymap.bind("x.open", [])
    assert.deepEqual(keymap.formatted("x.open"), [])
    keymap.resetAll()
    assert.deepEqual(keymap.formatted("x.open"), ["Ctrl+O"])
  })

  test("setOverrides skips an unknown action, a chord that does not parse and a list that is not one, and keeps the rest", () => {
    const keymap = new Keymap(actions)
    keymap.setOverrides({
      "x.save": ["Mod+Shift+S", "Hyper+X", 5 as unknown as string],
      "x.open": "Mod+P" as unknown as string[],
      "gone.action": ["Mod+Q"],
    })
    assert.deepEqual(keymap.getOverrides(), { "x.save": ["Mod+Shift+S"] })
    assert.deepEqual(keymap.formatted("x.open"), ["Ctrl+O"])
  })

  test("overrides that clash with each other (from storage) are kept and reported by conflicts()", () => {
    const keymap = new Keymap(actions)
    keymap.setOverrides({ "x.save": ["Mod+P"], "x.open": ["Mod+P"] })
    assert.equal(keymap.conflicts().length, 1)
  })

  test("with preferences attached the overrides are read, stored when they change, and follow the store", () => {
    const storage = new MemoryStore()
    const first = new PrefsStore(storage, () => () => {})
    first.user.set(KeymapOverridesPref, { "x.save": ["Mod+Shift+S"], "unknown.id": ["Mod+Q"] }, { immediate: true })
    const keymap = new Keymap(actions)
    const detach = keymap.attachPrefs(first.user)
    assert.deepEqual(keymap.formatted("x.save"), ["Ctrl+Shift+S"])
    assert.equal(keymap.bind("x.open", ["Mod+P"]).ok, true)
    first.flush()
    // A new keymap over a new store over the same storage sees both
    const again = new Keymap(actions)
    again.attachPrefs(new PrefsStore(storage).user)
    assert.deepEqual(again.formatted("x.save"), ["Ctrl+Shift+S"])
    assert.deepEqual(again.formatted("x.open"), ["Ctrl+P"])
    // Reset is stored too
    keymap.reset("x.save")
    first.flush()
    const third = new Keymap(actions)
    third.attachPrefs(new PrefsStore(storage).user)
    assert.deepEqual(third.formatted("x.save"), ["Ctrl+S"])
    // A change made elsewhere in the store reaches the keymap
    first.user.set(KeymapOverridesPref, { "x.open": ["Mod+L"] })
    assert.deepEqual(keymap.formatted("x.open"), ["Ctrl+L"])
    detach()
    first.user.set(KeymapOverridesPref, {})
    assert.deepEqual(keymap.formatted("x.open"), ["Ctrl+L"], "detached: no longer follows")
  })

  test("the stored overrides are validated: a value of the wrong shape gives no overrides, and bad entries are dropped", () => {
    const storage = new MemoryStore()
    storage.data.set("n2.prefs.user.keymap.overrides", JSON.stringify({ version: 1, value: ["not", "a", "map"] }))
    const prefs = new PrefsStore(storage)
    assert.deepEqual(prefs.user.get(KeymapOverridesPref), {})
    storage.data.set(
      "n2.prefs.user.keymap.overrides",
      JSON.stringify({ version: 1, value: { "x.save": ["Mod+S"], "x.open": [1, 2], "x.close": "Mod+W" } })
    )
    assert.deepEqual(new PrefsStore(storage).user.get(KeymapOverridesPref), { "x.save": ["Mod+S"] })
  })
})

describe("describe and withChord", () => {
  test("the list has every action with its current chords, scopes in order, macOS with Cmd", () => {
    const keymap = new Keymap(DefaultActions)
    const rows = keymap.describe()
    assert.equal(rows.length, DefaultActions.length)
    const scopes = rows.map((r) => r.scope)
    assert.deepEqual(
      scopes,
      [...scopes].sort((a, b) => KeymapScopes.indexOf(a) - KeymapScopes.indexOf(b))
    )
    const redo = rows.find((r) => r.id === "edit.redo")!
    assert.deepEqual(redo.chords, ["Ctrl+Shift+Z", "Ctrl+Y"])
    keymap.setMac(true)
    assert.deepEqual(keymap.describe().find((r) => r.id === "edit.redo")!.chords, ["Cmd+Shift+Z", "Cmd+Y"])
    assert.equal(keymap.withChord("Duplicate", "hierarchy.duplicate"), "Duplicate (Cmd+D)")
    keymap.bind("hierarchy.duplicate", [])
    assert.equal(keymap.withChord("Duplicate", "hierarchy.duplicate"), "Duplicate")
  })
})

describe("handlers and installation", () => {
  test("handle returns an unregister, and refuses an action that does not exist", () => {
    const keymap = new Keymap(DefaultActions)
    const off = keymap.handle("edit.undo", () => {})
    assert.equal(typeof off, "function")
    off()
    off()
    assert.throws(() => keymap.handle("nothing.here", () => {}), /no action/)
  })

  test("install puts one listener on the target; installing again replaces it; uninstall removes it", () => {
    const keymap = new Keymap(DefaultActions)
    const added: string[] = []
    const removed: string[] = []
    const fake = (name: string) =>
      ({
        addEventListener: (type: string) => void added.push(`${name}:${type}`),
        removeEventListener: (type: string) => void removed.push(`${name}:${type}`),
      }) as unknown as EventTarget
    const one = fake("one")
    const two = fake("two")
    assert.equal(keymap.installed, false)
    keymap.install(one)
    assert.equal(keymap.installed, true)
    keymap.install(two)
    assert.deepEqual(added, ["one:keydown", "two:keydown"])
    assert.deepEqual(removed, ["one:keydown"], "the first dispatcher is gone before the second is on")
    keymap.uninstall()
    assert.deepEqual(removed, ["one:keydown", "two:keydown"])
    assert.equal(keymap.installed, false)
    keymap.uninstall()
    assert.equal(removed.length, 2)
  })

  test("the detach an install returns removes only its own listener", () => {
    const keymap = new Keymap(DefaultActions)
    const removed: string[] = []
    const target = {
      addEventListener: () => {},
      removeEventListener: (type: string) => void removed.push(type),
    } as unknown as EventTarget
    const first = keymap.install(target)
    keymap.install(target)
    first() // already replaced: removes its own listener again, leaves the second one installed
    assert.equal(removed.length, 2)
    assert.equal(keymap.installed, true)
    keymap.uninstall()
    assert.equal(keymap.installed, false)
  })
})
