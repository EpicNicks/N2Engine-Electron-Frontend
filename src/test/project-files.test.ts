import { test, describe, beforeEach, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ProjectFiles, ProjectPathError } from "../main/project-files"

let temp: string
let root: string
let files: ProjectFiles

beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "n2-project-")))
  root = path.join(temp, "project")
  fs.mkdirSync(path.join(root, "assets", "scripts"), { recursive: true })
  fs.writeFileSync(path.join(root, "assets", "scripts", "main.lua"), "-- main")
  fs.writeFileSync(path.join(root, "project.json"), "{}")
  fs.writeFileSync(path.join(root, ".hidden.txt"), "")
  fs.writeFileSync(path.join(temp, "outside.txt"), "secret")
  files = new ProjectFiles()
  files.open(root)
})

afterEach(() => {
  fs.rmSync(temp, { recursive: true, force: true })
})

describe("ProjectFiles", () => {
  test("lists the tree, folders first, hidden entries skipped", () => {
    const tree = files.listFiles()
    assert.deepEqual(
      tree.map((f) => f.name),
      ["assets", "project.json"]
    )
    assert.equal(tree[0].children![0].name, "scripts")
    assert.equal(tree[0].children![0].children![0].path, path.join(root, "assets", "scripts", "main.lua"))
  })

  test("reads and writes text files by absolute or relative path", () => {
    const script = path.join(root, "assets", "scripts", "main.lua")
    assert.equal(files.readTextFile(script), "-- main")
    files.writeTextFile("assets/scripts/new.lua", "print(1)")
    assert.equal(fs.readFileSync(path.join(root, "assets", "scripts", "new.lua"), "utf-8"), "print(1)")
  })

  test("refuses paths outside the project", () => {
    assert.throws(() => files.readTextFile(path.join(temp, "outside.txt")), ProjectPathError)
    assert.throws(() => files.readTextFile("../outside.txt"), ProjectPathError)
    assert.throws(() => files.writeTextFile(path.join(root, "..", "evil.txt"), "x"), ProjectPathError)
    assert.throws(() => files.createDirectory(path.join(temp, "elsewhere")), ProjectPathError)
    assert.throws(() => files.deleteFile(path.join(temp, "outside.txt")), ProjectPathError)
    assert.ok(fs.existsSync(path.join(temp, "outside.txt")))
    assert.equal(fs.existsSync(path.join(temp, "evil.txt")), false)
  })

  test("refuses the project folder itself, other file types and invalid paths", () => {
    assert.throws(() => files.createDirectory(root), ProjectPathError)
    assert.throws(() => files.writeTextFile("tool.exe", "x"), /Not an editable file type/)
    assert.throws(() => files.deleteFile("assets"), ProjectPathError)
    assert.throws(() => files.readTextFile("project.json\0.txt"), ProjectPathError)
    assert.throws(() => files.readTextFile(""), ProjectPathError)
  })

  test("refuses a link that leads outside the project", (t) => {
    try {
      fs.symlinkSync(temp, path.join(root, "link"), "junction")
    } catch {
      t.skip("can't create links here")
      return
    }
    assert.throws(() => files.readTextFile(path.join(root, "link", "outside.txt")), /Outside the project/)
    assert.throws(() => files.writeTextFile(path.join(root, "link", "new.txt"), "x"), /Outside the project/)
  })

  test("deletes files only, and a missing file is not an error", () => {
    files.deleteFile("assets/scripts/main.lua")
    assert.equal(fs.existsSync(path.join(root, "assets", "scripts", "main.lua")), false)
    files.deleteFile("assets/scripts/main.lua")
  })

  test("creates nested directories", () => {
    files.createDirectory(path.join(root, "assets", "scenes", "levels"))
    assert.ok(fs.statSync(path.join(root, "assets", "scenes", "levels")).isDirectory())
  })

  test("nothing works with no project open", () => {
    files.close()
    assert.throws(() => files.listFiles(), /No project is open/)
    assert.throws(() => files.readTextFile(path.join(root, "project.json")), /No project is open/)
  })
})
