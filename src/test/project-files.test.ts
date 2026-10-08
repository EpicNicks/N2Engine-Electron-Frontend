import { test, describe, beforeEach, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ProjectFiles, ProjectPathError } from "../main/project-files"

let temp: string
let root: string

beforeEach(() => {
  temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "n2-project-")))
  root = path.join(temp, "project")
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(temp, "file.txt"), "x")
})

afterEach(() => {
  fs.rmSync(temp, { recursive: true, force: true })
})

describe("ProjectFiles", () => {
  test("holds the open project's real folder, and forgets it when closed", () => {
    const files = new ProjectFiles()
    assert.equal(files.rootPath, null)
    assert.equal(files.open(root), root)
    assert.equal(files.rootPath, root)
    files.close()
    assert.equal(files.rootPath, null)
  })

  test("only a folder can be opened", () => {
    const files = new ProjectFiles()
    assert.throws(() => files.open(path.join(temp, "file.txt")), ProjectPathError)
    assert.throws(() => files.open(path.join(temp, "missing")))
    assert.equal(files.rootPath, null)
  })

  test("a link to a folder is opened as the folder it leads to", (t) => {
    const link = path.join(temp, "link")
    try {
      fs.symlinkSync(root, link, "junction")
    } catch {
      t.skip("links can't be made here")
      return
    }
    assert.equal(new ProjectFiles().open(link), root)
  })
})
