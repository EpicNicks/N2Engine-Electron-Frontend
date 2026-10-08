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

  test(`the configured path wins over ${HostPathEnv}`, () => {
    const file = path.join(dir, "settings.json")
    const host = exe()
    fs.writeFileSync(file, JSON.stringify({ hostPath: host }))
    const settings = new HostSettings(file, { [HostPathEnv]: path.join(dir, "elsewhere.exe") })
    assert.deepEqual(settings.locate(), { path: host, source: "setting", problem: null })
  })

  test(`without a configured path, ${HostPathEnv} names the host`, () => {
    const host = exe()
    const settings = new HostSettings(path.join(dir, "settings.json"), { [HostPathEnv]: host })
    assert.deepEqual(settings.locate(), { path: host, source: "env", problem: null })
    assert.equal(HostPathEnv, "N2ENGINE_HOST")
  })

  test("readyTimeoutMs comes from settings.json, else 30 s", () => {
    const file = path.join(dir, "settings.json")
    assert.equal(new HostSettings(file, {}).readyTimeoutMs(), 30000)
    fs.writeFileSync(file, JSON.stringify({ readyTimeoutMs: 90000 }))
    assert.equal(new HostSettings(file, {}).readyTimeoutMs(), 90000)
    for (const bad of [0, -5, "60000", null]) {
      fs.writeFileSync(file, JSON.stringify({ readyTimeoutMs: bad }))
      assert.equal(new HostSettings(file, {}).readyTimeoutMs(), 30000, JSON.stringify(bad))
    }
  })

  test("a path that isn't a file is reported, and can't be saved", () => {
    const file = path.join(dir, "settings.json")
    const missing = path.join(dir, "gone.exe")
    const settings = new HostSettings(file, { [HostPathEnv]: missing })
    assert.equal(settings.locate().problem, `Not found: ${missing}`)
    assert.throws(() => settings.require(), /Not found: .*gone\.exe \(from N2ENGINE_HOST\)/)
    assert.throws(() => new HostSettings(file, {}).setHostPath(dir), /Not a file/)
    assert.equal(fs.existsSync(file), false)
  })
})
