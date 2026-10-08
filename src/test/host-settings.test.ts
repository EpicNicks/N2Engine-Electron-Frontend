import { test, describe, beforeEach, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { HostPathEnv, HostSettings } from "../main/host-settings"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "n2-settings-"))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("HostSettings (where N2EditorHost is)", () => {
  const exe = () => {
    const file = path.join(dir, "N2EditorHost.exe")
    fs.writeFileSync(file, "")
    return file
  }

  test("nothing set: no path, and require says how to set it", () => {
    const settings = new HostSettings(path.join(dir, "settings.json"), {})
    assert.deepEqual(settings.locate(), { path: null, source: null, problem: null })
    assert.throws(() => settings.require(), new RegExp(HostPathEnv))
  })

  test("a saved path is kept in settings.json, with the other settings", () => {
    const file = path.join(dir, "settings.json")
    fs.writeFileSync(file, JSON.stringify({ other: true }))
    const host = exe()
    new HostSettings(file, {}).setHostPath(host)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { other: true, hostPath: host })
    const settings = new HostSettings(file, {})
    assert.deepEqual(settings.locate(), { path: host, source: "setting", problem: null })
    assert.equal(settings.require(), host)
  })

  test(`${HostPathEnv} wins over the saved path`, () => {
    const file = path.join(dir, "settings.json")
    const host = exe()
    fs.writeFileSync(file, JSON.stringify({ hostPath: "elsewhere" }))
    const settings = new HostSettings(file, { [HostPathEnv]: host })
    assert.deepEqual(settings.locate(), { path: host, source: "env", problem: null })
  })

  test("a path that isn't a file is reported, and can't be saved", () => {
    const file = path.join(dir, "settings.json")
    const missing = path.join(dir, "gone.exe")
    const settings = new HostSettings(file, { [HostPathEnv]: missing })
    assert.equal(settings.locate().problem, `Not found: ${missing}`)
    assert.throws(() => settings.require(), /Not found: .*gone\.exe \(from N2_EDITOR_HOST\)/)
    assert.throws(() => new HostSettings(file, {}).setHostPath(dir), /Not a file/)
    assert.equal(fs.existsSync(file), false)
  })
})
