import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { basename, extname, join, normalizeScenePath, toResPath } from "../renderer/paths"

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

describe("scene paths", () => {
  test("toResPath: files and folders of the assets folder, on both platforms' paths", () => {
    assert.equal(toResPath("C:\\Games\\P", "C:\\Games\\P\\assets\\scenes\\Main.scene"), "res://scenes/Main.scene")
    assert.equal(toResPath("C:\\Games\\P\\", "c:\\games\\p\\ASSETS\\scenes"), "res://scenes")
    assert.equal(toResPath("/home/me/p", "/home/me/p/assets/a.scene"), "res://a.scene")
    assert.equal(toResPath("/home/me/p", "/home/me/p/assets"), "res://")
    assert.equal(toResPath("/home/me/p", "/home/me/p/Assets/a.scene"), null, "case matters off Windows")
    assert.equal(toResPath("/home/me/p", "/home/me/p/assets2/a.scene"), null)
    assert.equal(toResPath("/home/me/p", "/home/me/p/scripts/a.lua"), null)
    assert.equal(toResPath("/home/me/p", "/elsewhere/assets/a.scene"), null)
  })

  test("normalizeScenePath adds res:// and .scene, and keeps what is there", () => {
    assert.equal(normalizeScenePath("res://scenes/Main.scene"), "res://scenes/Main.scene")
    assert.equal(normalizeScenePath("  levels/One "), "res://levels/One.scene")
    assert.equal(normalizeScenePath("/levels/One.SCENE"), "res://levels/One.SCENE")
    assert.equal(normalizeScenePath("levels\\One"), "res://levels/One.scene")
    assert.equal(normalizeScenePath("res://a.scene.scene"), "res://a.scene.scene")
    assert.equal(normalizeScenePath("user://x"), "user://x.scene", "the host refuses it")
    assert.equal(normalizeScenePath("   "), "")
  })
})
