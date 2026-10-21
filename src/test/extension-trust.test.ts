import { test, describe, beforeEach, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  DefaultScanLimits,
  EditorFolderScan,
  ExtensionTrust,
  ExtensionTrustStore,
  MaxTrusted,
  scanEditorFolder,
  trustKey,
  trustPromptText,
} from "../main/extension-trust"
import { buildHostArgs } from "../main/host-launcher"

let root: string

beforeEach(() => {
  // realpath: a temp folder may itself be reached through a link (macOS /var), and the tests compare real paths
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "n2-trust-")))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function project(name: string, files: string[] = []): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "project.n2proj"), "{}")
  for (const file of files) {
    const full = path.join(dir, "editor", ...file.split("/"))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, "return {}")
  }
  return dir
}

/** Makes a link (a junction for a folder on Windows, which needs no privilege); null when links can't be made here */
function link(target: string, at: string, type: "dir" | "file"): boolean {
  try {
    fs.symlinkSync(target, at, type === "dir" && process.platform === "win32" ? "junction" : type)
    return true
  } catch {
    return false
  }
}

describe("scanEditorFolder", () => {
  test("a project with no editor folder has no extensions", () => {
    assert.deepEqual(scanEditorFolder(project("a")), { present: false, files: [], total: 0, truncated: false })
  })

  test("lists the .lua files of editor/ and below in byte order, in any letter case, and nothing else", () => {
    const dir = project("a", ["Zed.lua", "tools/Align.lua", "tools/deep/x.LUA", "notes.txt", "tools/readme.md", "b.lua"])
    const scan = scanEditorFolder(dir)
    assert.equal(scan.present, true)
    assert.deepEqual(scan.files, ["Zed.lua", "b.lua", "tools/Align.lua", "tools/deep/x.LUA"])
    assert.equal(scan.total, 4)
    assert.equal(scan.truncated, false)
  })

  test("an editor folder with no .lua file is present but has no extensions", () => {
    const scan = scanEditorFolder(project("a", ["notes.txt"]))
    assert.equal(scan.present, true)
    assert.equal(scan.total, 0)
  })

  test("a .lua file outside editor/ (assets/) is not an extension", () => {
    const dir = project("a")
    fs.mkdirSync(path.join(dir, "assets"))
    fs.writeFileSync(path.join(dir, "assets", "player.lua"), "x")
    fs.writeFileSync(path.join(dir, "top.lua"), "x")
    assert.equal(scanEditorFolder(dir).total, 0)
  })

  test("looks no deeper than the host does", () => {
    const levels = Array.from({ length: DefaultScanLimits.maxDepth }, (_, i) => `d${i}`)
    const deepest = project("a", [`${levels.join("/")}/ok.lua`, `${levels.join("/")}/more/too-deep.lua`])
    assert.deepEqual(scanEditorFolder(deepest).files, [`${levels.join("/")}/ok.lua`])
  })

  test("lists at most maxListed names but counts them all, and stops at the entry limit", () => {
    const names = Array.from({ length: 8 }, (_, i) => `e${i}.lua`)
    const dir = project("a", names)
    const listed = scanEditorFolder(dir, { ...DefaultScanLimits, maxListed: 3 })
    assert.deepEqual(listed.files, ["e0.lua", "e1.lua", "e2.lua"])
    assert.equal(listed.total, 8)
    const stopped = scanEditorFolder(dir, { ...DefaultScanLimits, maxEntries: 4 })
    assert.equal(stopped.truncated, true)
    assert.ok(stopped.total <= 4)
  })

  test("a long name is cut for display", () => {
    const scan = scanEditorFolder(project("a", ["abcdefghijklmnop.lua"]), { ...DefaultScanLimits, maxNameLength: 10 })
    assert.deepEqual(scan.files, ["abcdefghij..."])
  })

  test("a linked folder is not followed", (t) => {
    const dir = project("a", ["own.lua"])
    const outside = path.join(root, "outside")
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, "evil.lua"), "x")
    if (!link(outside, path.join(dir, "editor", "linked"), "dir")) return t.skip("links can't be made here")
    assert.deepEqual(scanEditorFolder(dir).files, ["own.lua"])
  })

  test("a linked file is not listed", (t) => {
    const dir = project("a", ["own.lua"])
    const outside = path.join(root, "evil.lua")
    fs.writeFileSync(outside, "x")
    if (!link(outside, path.join(dir, "editor", "linked.lua"), "file")) return t.skip("file links can't be made here")
    assert.deepEqual(scanEditorFolder(dir).files, ["own.lua"])
  })

  test("an editor folder that is itself a link has no extensions", (t) => {
    const dir = project("a")
    const outside = path.join(root, "elsewhere")
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, "evil.lua"), "x")
    if (!link(outside, path.join(dir, "editor"), "dir")) return t.skip("links can't be made here")
    assert.deepEqual(scanEditorFolder(dir), { present: false, files: [], total: 0, truncated: false })
  })

  test("editor as a file, and a missing project folder, have no extensions", () => {
    const dir = project("a")
    fs.writeFileSync(path.join(dir, "editor"), "not a folder")
    assert.equal(scanEditorFolder(dir).present, false)
    assert.equal(scanEditorFolder(path.join(root, "missing")).present, false)
  })

  test("never reads a file's content: an unreadable or huge file is listed by name", () => {
    const dir = project("a", ["big.lua"])
    fs.writeFileSync(path.join(dir, "editor", "big.lua"), Buffer.alloc(3 * 1024 * 1024, 0x41))
    assert.deepEqual(scanEditorFolder(dir).files, ["big.lua"])
  })
})

describe("trustKey", () => {
  test("is the folder's real path, whatever way it is named", () => {
    const dir = project("Proj")
    const key = trustKey(dir)
    assert.equal(key, dir)
    assert.equal(trustKey(dir + path.sep), key, "a trailing separator")
    assert.equal(trustKey(path.join(dir, "..", "Proj")), key, "a .. segment")
    assert.equal(trustKey(path.join(dir, "editor", "..")), key)
  })

  test("a folder that does not exist, or a file, has no key", () => {
    assert.equal(trustKey(path.join(root, "missing")), null)
    const file = path.join(root, "f.txt")
    fs.writeFileSync(file, "x")
    assert.equal(trustKey(file), null)
  })

  test("macOS folds case, the others keep the real path as it is", () => {
    const dir = project("MixedCase")
    assert.equal(trustKey(dir, "darwin"), dir.toLowerCase())
    assert.equal(trustKey(dir, "linux"), dir)
  })
})

describe("ExtensionTrustStore", () => {
  let file: string
  beforeEach(() => {
    file = path.join(root, "userdata", "extension-trust.json")
  })

  test("trusts nothing at first, and exactly the folder that was trusted", () => {
    const store = new ExtensionTrustStore(file)
    const a = project("a", ["x.lua"])
    const b = project("b", ["x.lua"])
    assert.equal(store.isTrusted(a), false)
    store.trust(a)
    assert.equal(store.isTrusted(a), true)
    assert.equal(store.isTrusted(b), false, "another project does not inherit it")
    assert.equal(store.size, 1)
  })

  test("is kept between runs", () => {
    const a = project("a", ["x.lua"])
    new ExtensionTrustStore(file).trust(a)
    assert.equal(new ExtensionTrustStore(file).isTrusted(a), true)
  })

  test("trailing separators and .. segments name the same folder; a folder inside it or above it is another", () => {
    const store = new ExtensionTrustStore(file)
    const a = project("a", ["x.lua"])
    store.trust(a + path.sep)
    assert.equal(store.isTrusted(a), true)
    assert.equal(store.isTrusted(path.join(a, "editor", "..")), true)
    assert.equal(store.isTrusted(path.join(a, "editor")), false, "a folder inside the project is another folder")
    assert.equal(store.isTrusted(root), false, "and so is the one above")
  })

  test("the letters' case does not make a different folder where the file system ignores case", (t) => {
    const store = new ExtensionTrustStore(file)
    const a = project("CaseProj", ["x.lua"])
    const swapped = path.join(root, "caseproj")
    if (!fs.existsSync(swapped)) return t.skip("a case-sensitive file system: another name is another folder")
    store.trust(a)
    assert.equal(store.isTrusted(swapped), true)
    assert.equal(store.isTrusted(path.join(root, "CASEPROJ")), true)
  })

  test("a moved or renamed folder, and a copy, are not trusted", () => {
    const store = new ExtensionTrustStore(file)
    const a = project("a", ["x.lua"])
    store.trust(a)
    const copy = path.join(root, "copy")
    fs.cpSync(a, copy, { recursive: true })
    assert.equal(store.isTrusted(copy), false, "a copy")
    const moved = path.join(root, "moved")
    fs.renameSync(a, moved)
    assert.equal(store.isTrusted(moved), false, "the same files at another path")
    assert.equal(store.isTrusted(a), false, "the old path no longer exists")
    // A different folder made at the old path later is the path's trust, as for any folder-level trust (VS Code's model)
    fs.mkdirSync(a)
    assert.equal(store.isTrusted(a), true)
  })

  test("a link to a trusted folder is that folder; a link to an untrusted one is not trusted", (t) => {
    const store = new ExtensionTrustStore(file)
    const trusted = project("trusted", ["x.lua"])
    const other = project("other", ["x.lua"])
    store.trust(trusted)
    const toTrusted = path.join(root, "to-trusted")
    const toOther = path.join(root, "to-other")
    if (!link(trusted, toTrusted, "dir") || !link(other, toOther, "dir")) return t.skip("links can't be made here")
    assert.equal(store.isTrusted(toTrusted), true)
    assert.equal(store.isTrusted(toOther), false)
  })

  test("a folder that does not exist is never trusted, and cannot be trusted", () => {
    const store = new ExtensionTrustStore(file)
    assert.throws(() => store.trust(path.join(root, "missing")), /Not a folder/)
    assert.equal(store.isTrusted(path.join(root, "missing")), false)
    assert.equal(store.size, 0)
  })

  test("revoking forgets exactly that folder, and nothing is an error", () => {
    const store = new ExtensionTrustStore(file)
    const a = project("a", ["x.lua"])
    const b = project("b", ["x.lua"])
    store.trust(a)
    store.trust(b)
    store.revoke(a)
    assert.equal(store.isTrusted(a), false)
    assert.equal(store.isTrusted(b), true)
    store.revoke(a)
    store.revoke(path.join(root, "missing"))
    assert.equal(store.isTrusted(b), true)
  })

  test("a malformed, hostile or wrong-shaped file trusts nothing", () => {
    const a = project("a", ["x.lua"])
    fs.mkdirSync(path.dirname(file), { recursive: true })
    for (const content of ["", "not json", "null", "[]", '{"trusted": 5}', '{"trusted": [null, 3, "x", {"key": 7}, {"key": ""}]}']) {
      fs.writeFileSync(file, content)
      assert.equal(new ExtensionTrustStore(file).isTrusted(a), false, content)
    }
  })

  test("a file inside the project cannot grant trust: only the store's own file counts", () => {
    const store = new ExtensionTrustStore(file)
    const a = project("a", ["x.lua"])
    for (const name of ["extension-trust.json", ".n2/extension-trust.json", "editor/trusted"]) {
      const planted = path.join(a, name)
      fs.mkdirSync(path.dirname(planted), { recursive: true })
      fs.writeFileSync(planted, JSON.stringify({ version: 1, trusted: [{ key: a, path: a, at: "" }] }))
    }
    assert.equal(store.isTrusted(a), false)
  })

  test("keeps the newest MaxTrusted folders", () => {
    const store = new ExtensionTrustStore(file)
    const first = project("p0", ["x.lua"])
    store.trust(first)
    for (let i = 1; i <= MaxTrusted; i++) store.trust(project(`p${i}`, ["x.lua"]))
    assert.equal(store.size, MaxTrusted)
    assert.equal(store.isTrusted(first), false, "the oldest answer went")
    assert.equal(store.isTrusted(path.join(root, `p${MaxTrusted}`)), true)
  })

  test("trusting twice is one record", () => {
    const store = new ExtensionTrustStore(file)
    const a = project("a", ["x.lua"])
    store.trust(a)
    store.trust(a)
    assert.equal(store.size, 1)
  })
})

describe("ExtensionTrust", () => {
  /** A store in memory (a Set of folders) with the same keys as the real one, and a dialog that answers as told */
  function setup(answer: boolean | Error = true, opts: { failTrust?: boolean } = {}) {
    const trusted = new Set<string>()
    const asked: Array<{ dir: string; scan: EditorFolderScan }> = []
    const store = {
      isTrusted: (dir: string) => trusted.has(dir),
      trust: (dir: string) => {
        if (opts.failTrust) throw new Error("disk full")
        trusted.add(dir)
      },
      revoke: (dir: string) => void trusted.delete(dir),
    }
    const gate = new ExtensionTrust({
      store,
      ask: async (dir, scan) => {
        asked.push({ dir, scan })
        if (answer instanceof Error) throw answer
        return answer
      },
    })
    return { gate, trusted, asked }
  }

  test("a project with no editor extensions is never asked and never gets the flag", async () => {
    const { gate, asked } = setup()
    const none = project("none")
    assert.deepEqual(await gate.forOpen(none), { flag: false, state: null })
    assert.deepEqual(gate.forRestart(none), { flag: false, state: null })
    assert.equal(await gate.enable(none), null)
    assert.equal(asked.length, 0)
  })

  test("an editor folder with no .lua file is the same as none", async () => {
    const { gate, asked } = setup()
    assert.deepEqual(await gate.forOpen(project("a", ["readme.txt"])), { flag: false, state: null })
    assert.equal(asked.length, 0)
  })

  test("an untrusted project with extensions is asked, once, with its file list; Trust gives the flag and is remembered", async () => {
    const { gate, asked, trusted } = setup(true)
    const dir = project("a", ["b.lua", "a.lua"])
    const launch = await gate.forOpen(dir)
    assert.equal(launch.flag, true)
    assert.deepEqual(launch.state, { files: ["a.lua", "b.lua"], more: 0, trusted: true, enabled: true })
    assert.equal(asked.length, 1)
    assert.equal(asked[0].dir, dir)
    assert.deepEqual(asked[0].scan.files, ["a.lua", "b.lua"])
    assert.ok(trusted.has(dir))
    // Opened again: remembered, no new question
    assert.equal((await gate.forOpen(dir)).flag, true)
    assert.equal(asked.length, 1)
  })

  test("Not now starts without the flag, records nothing, and says the extensions are not trusted", async () => {
    const { gate, trusted } = setup(false)
    const dir = project("a", ["x.lua"])
    const launch = await gate.forOpen(dir)
    assert.equal(launch.flag, false)
    assert.deepEqual(launch.state, { files: ["x.lua"], more: 0, trusted: false, enabled: false })
    assert.equal(trusted.size, 0)
  })

  test("a dialog that fails is Not now", async () => {
    const { gate, trusted } = setup(new Error("no window"))
    const launch = await gate.forOpen(project("a", ["x.lua"]))
    assert.equal(launch.flag, false)
    assert.equal(trusted.size, 0)
  })

  test("an answer that cannot be recorded gives no flag (nothing is trusted that is not on record)", async () => {
    const { gate } = setup(true, { failTrust: true })
    const launch = await gate.forOpen(project("a", ["x.lua"]))
    assert.equal(launch.flag, false)
    assert.equal(launch.state?.trusted, false)
  })

  test("another project does not inherit the trust", async () => {
    const { gate, asked } = setup(true)
    const a = project("a", ["x.lua"])
    const b = project("b", ["x.lua"])
    await gate.forOpen(a)
    assert.equal(asked.length, 1)
    assert.equal(gate.forRestart(b).flag, false, "a restart never asks and never trusts")
    await gate.forOpen(b)
    assert.equal(asked.length, 2, "the other project is asked on its own")
  })

  test("a restart passes the flag only for a trusted folder and never asks", async () => {
    const { gate, asked } = setup(false)
    const dir = project("a", ["x.lua"])
    const untrusted = gate.forRestart(dir)
    assert.equal(untrusted.flag, false)
    assert.equal(untrusted.state?.trusted, false)
    assert.equal(asked.length, 0)
  })

  test("trust the store holds does not make a flag when the folder has no extensions any more", async () => {
    const { gate, trusted } = setup(true)
    const dir = project("a", ["x.lua"])
    await gate.forOpen(dir)
    fs.rmSync(path.join(dir, "editor"), { recursive: true })
    assert.ok(trusted.has(dir))
    assert.deepEqual(gate.forRestart(dir), { flag: false, state: null })
  })

  test("enable always asks, trusts on Trust, and answers null on Not now", async () => {
    const dir = project("a", ["x.lua"])
    const yes = setup(true)
    const launch = await yes.gate.enable(dir)
    assert.equal(launch?.flag, true)
    assert.ok(yes.trusted.has(dir))
    // Trusted already: it still asks (the banner restarts the host, which the user confirms)
    await yes.gate.enable(dir)
    assert.equal(yes.asked.length, 2)

    const no = setup(false)
    assert.equal(await no.gate.enable(dir), null)
    assert.equal(no.trusted.size, 0)

    const failing = setup(true, { failTrust: true })
    assert.equal(await failing.gate.enable(dir), null)
  })

  test("revoking forgets the trust; the running host is said to be still enabled until it restarts", async () => {
    const { gate, trusted } = setup(true)
    const dir = project("a", ["x.lua"])
    await gate.forOpen(dir)
    assert.deepEqual(gate.revoke(dir, true), { files: ["x.lua"], more: 0, trusted: false, enabled: true })
    assert.equal(trusted.size, 0)
    assert.equal(gate.forRestart(dir).flag, false)
    assert.equal(gate.revoke(project("none"), false), null)
  })

  test("more files than are listed are counted", async () => {
    const files = Array.from({ length: DefaultScanLimits.maxListed + 5 }, (_, i) => `f${String(i).padStart(3, "0")}.lua`)
    const { gate } = setup(false)
    const launch = await gate.forOpen(project("a", files))
    assert.equal(launch.state?.files.length, DefaultScanLimits.maxListed)
    assert.equal(launch.state?.more, 5)
  })
})

describe("trustPromptText", () => {
  const scan = (names: string[], total = names.length): EditorFolderScan => ({ present: true, files: names, total, truncated: false })

  test("says how many, shows the names and the folder, and that capabilities are not known yet", () => {
    const { message, detail } = trustPromptText("C:\\Games\\A", scan(["Align.lua", "tools/Snap.lua"]))
    assert.match(message, /contains 2 editor extensions/)
    assert.match(message, /Trust this project\?/)
    assert.match(detail, /C:\\Games\\A/)
    assert.match(detail, /Align\.lua/)
    assert.match(detail, /tools\/Snap\.lua/)
    assert.match(detail, /run code on this computer's editor host/)
    assert.match(detail, /capabilities\) is not known until the host loads/)
  })

  test("one extension is singular, and a long list is cut with a count", () => {
    assert.match(trustPromptText("p", scan(["a.lua"])).message, /contains 1 editor extension\./)
    const many = Array.from({ length: 15 }, (_, i) => `e${i}.lua`)
    const { detail } = trustPromptText("p", scan(many))
    assert.match(detail, /and 5 more/)
    assert.ok(!detail.includes("e14.lua"))
  })
})

describe("the launcher's flag", () => {
  test("--editor-extensions only when asked for with exactly true", () => {
    assert.ok(buildHostArgs("p", { editorExtensions: true }).includes("--editor-extensions"))
    assert.ok(!buildHostArgs("p").includes("--editor-extensions"))
    assert.ok(!buildHostArgs("p", { editorExtensions: false }).includes("--editor-extensions"))
    assert.ok(!buildHostArgs("p", { editorExtensions: "yes" as unknown as boolean }).includes("--editor-extensions"))
  })

  test("never for a play host, even if asked", () => {
    assert.ok(!buildHostArgs("p", { editorExtensions: true, playFile: "f.scene" }).includes("--editor-extensions"))
  })

  test("the rest of the arguments are as they were", () => {
    assert.deepEqual(buildHostArgs("p", { editorExtensions: true }), [
      "--project",
      "p",
      "--port",
      "0",
      "--token-env",
      "N2_EDITOR_TOKEN",
      "--editor-extensions",
      "--exit-on-disconnect",
      "--exit-on-stdin-eof",
    ])
  })
})
