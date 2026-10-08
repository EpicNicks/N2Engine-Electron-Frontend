import { test, describe, beforeEach, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { MaxRecent, RecentProjects } from "../main/recent-projects"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "n2-recent-"))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("RecentProjects", () => {
  test("starts empty, and keeps paths newest first, each once", () => {
    const recent = new RecentProjects(path.join(dir, "recent-projects.json"))
    assert.deepEqual(recent.list(), [])
    recent.add("C:\\A")
    recent.add("C:\\B")
    recent.add("C:\\A")
    assert.deepEqual(recent.list(), ["C:\\A", "C:\\B"])
    assert.equal(recent.includes("C:\\B"), true)
    assert.equal(recent.includes("C:\\C"), false)
  })

  test("is plain paths in a JSON file, kept between runs", () => {
    const file = path.join(dir, "recent-projects.json")
    new RecentProjects(file).add("/games/a")
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), ["/games/a"])
    assert.deepEqual(new RecentProjects(file).list(), ["/games/a"])
  })

  test(`keeps at most ${MaxRecent}`, () => {
    const recent = new RecentProjects(path.join(dir, "recent-projects.json"))
    for (let i = 0; i < MaxRecent + 5; i++) recent.add(`p${i}`)
    const list = recent.list()
    assert.equal(list.length, MaxRecent)
    assert.equal(list[0], `p${MaxRecent + 4}`)
  })

  test("remove takes one out", () => {
    const recent = new RecentProjects(path.join(dir, "recent-projects.json"))
    recent.add("a")
    recent.add("b")
    recent.remove("a")
    recent.remove("not there")
    assert.deepEqual(recent.list(), ["b"])
  })

  test("a malformed file is an empty list, and anything but non-empty strings is skipped", () => {
    const file = path.join(dir, "recent-projects.json")
    fs.writeFileSync(file, "{not json")
    assert.deepEqual(new RecentProjects(file).list(), [])
    fs.writeFileSync(file, JSON.stringify({ a: 1 }))
    assert.deepEqual(new RecentProjects(file).list(), [])
    fs.writeFileSync(file, JSON.stringify(["a", 1, null, "", "b", "a"]))
    assert.deepEqual(new RecentProjects(file).list(), ["a", "b"])
  })

  test("the user data folder is created if missing", () => {
    const recent = new RecentProjects(path.join(dir, "new", "recent-projects.json"))
    recent.add("a")
    assert.deepEqual(recent.list(), ["a"])
  })
})
