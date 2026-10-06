import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { basename, extname, join } from "../renderer/paths"

describe("renderer paths", () => {
  test("basename", () => {
    assert.equal(basename("C:\\Projects\\Game\\assets"), "assets")
    assert.equal(basename("/home/me/game/main.lua"), "main.lua")
    assert.equal(basename("/home/me/game/"), "game")
    assert.equal(basename("main.lua"), "main.lua")
  })

  test("extname", () => {
    assert.equal(extname("level.scene"), ".scene")
    assert.equal(extname("C:\\a.b\\file"), "")
    assert.equal(extname(".gitignore"), "")
    assert.equal(extname("archive.tar.gz"), ".gz")
  })

  test("join keeps the base's separator", () => {
    assert.equal(join("C:\\Projects\\Game", "scenes", "a.scene"), "C:\\Projects\\Game\\scenes\\a.scene")
    assert.equal(join("/home/me/game/", "scripts"), "/home/me/game/scripts")
    assert.equal(join("/home/me", "/x/"), "/home/me/x")
  })
})
