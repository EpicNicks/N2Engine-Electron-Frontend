// Moving assets in the Assets panel (protocol 1.24.0): which moves a drop makes and why one is refused, the path a held
// path goes to, and the count that asks first. Pure functions, so no host is needed.
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { AssetInfo } from "../protocol/protocol.generated"
import { ConfirmMoveAssets, assetsMoving, canDrop, isInside, planMove, remapPath } from "../renderer/asset-move"
import { AssetListing } from "../renderer/asset-tree"

const U = "11111111-1111-1111-1111-111111111111"
const asset = (path: string, type = "Texture"): AssetInfo => ({ path, uuid: U, type, size: 1, modified: 1 })

const listing: AssetListing = {
  folders: ["res://scenes", "res://scripts", "res://scripts/enemies", "res://textures"],
  assets: [
    asset("res://hero.png"),
    asset("res://scenes/main.scene", "Scene"),
    asset("res://scripts/a.lua", "LuaScript"),
    asset("res://scripts/enemies/boss.lua", "LuaScript"),
    asset("res://textures/Wall.PNG"),
  ],
}

describe("planMove", () => {
  test("a file dropped on a folder moves there, keeping its name", () => {
    const plan = planMove(listing, ["res://hero.png"], "res://scenes", null)
    assert.deepEqual(plan, {
      moves: [{ from: "res://hero.png", to: "res://scenes/hero.png" }],
      skipped: [],
      problem: null,
    })
    assert.equal(canDrop(plan), true)
  })

  test("the root takes a file from a folder, with the name after res://", () => {
    const plan = planMove(listing, ["res://scripts/a.lua"], "res://", null)
    assert.deepEqual(plan.moves, [{ from: "res://scripts/a.lua", to: "res://a.lua" }])
  })

  test("a folder moves as one entry, and what is inside a moving folder is left out", () => {
    const plan = planMove(
      listing,
      ["res://scripts/a.lua", "res://scripts", "res://scripts/enemies"],
      "res://textures",
      null,
    )
    assert.deepEqual(plan.moves, [{ from: "res://scripts", to: "res://textures/scripts" }])
    assert.deepEqual(plan.skipped.sort(), ["res://scripts/a.lua", "res://scripts/enemies"])
  })

  test("a source already in the folder needs no move, and a drop with nothing to do is not a drop", () => {
    const plan = planMove(listing, ["res://scripts/a.lua"], "res://scripts", null)
    assert.deepEqual(plan, { moves: [], skipped: ["res://scripts/a.lua"], problem: null })
    assert.equal(canDrop(plan), false)
  })

  test("a folder cannot go into itself or below itself", () => {
    assert.match(planMove(listing, ["res://scripts"], "res://scripts", null).problem ?? "", /into itself/)
    assert.match(planMove(listing, ["res://scripts"], "res://scripts/enemies", null).problem ?? "", /into itself/)
    // A name that merely starts the same is another folder
    assert.equal(planMove(listing, ["res://scenes"], "res://scenes2", null).problem, "There is no folder res://scenes2")
    assert.equal(planMove(listing, ["res://scripts/enemies"], "res://scripts", null).problem, null)
  })

  test("a name already in the folder refuses the drop, compared without regard to case", () => {
    const wall = { ...listing, assets: [...listing.assets, asset("res://wall.png")] }
    assert.match(
      planMove(wall, ["res://wall.png"], "res://textures", null).problem ?? "",
      /wall\.png already exists in textures/,
    )
    // A folder name counts too
    const clash = { ...listing, folders: [...listing.folders, "res://scenes/Scripts"] }
    assert.match(planMove(clash, ["res://scripts"], "res://scenes", null).problem ?? "", /already exists/)
  })

  test("two sources with one name cannot land in the same folder", () => {
    const two = { ...listing, assets: [...listing.assets, asset("res://scenes/a.lua", "LuaScript")] }
    assert.match(
      planMove(two, ["res://scripts/a.lua", "res://scenes/a.lua"], "res://", null).problem ?? "",
      /already exists in the root/,
    )
  })

  test("the open scene's file, or a folder that holds it, is not moved", () => {
    const open = "res://scenes/main.scene"
    assert.match(planMove(listing, [open], "res://textures", open).problem ?? "", /save the scene elsewhere first/)
    assert.match(planMove(listing, ["res://scenes"], "res://textures", open).problem ?? "", /open scene is in scenes/)
    assert.equal(planMove(listing, ["res://scripts"], "res://textures", open).problem, null)
  })

  test("the root, a model's part and what the listing does not hold are not moved", () => {
    const plan = planMove(listing, ["res://", "res://hero.png#mesh/Body", "res://gone.png"], "res://scenes", null)
    assert.deepEqual(plan, { moves: [], skipped: [], problem: null })
  })

  test("a folder that does not exist is no target", () => {
    assert.equal(
      planMove(listing, ["res://hero.png"], "res://nowhere", null).problem,
      "There is no folder res://nowhere",
    )
  })
})

describe("remapPath", () => {
  const moves = [
    { from: "res://scripts", to: "res://textures/scripts" },
    { from: "res://hero.png", to: "res://scenes/hero.png" },
  ]
  test("the moved path, what is under a moved folder, and a model's part follow", () => {
    assert.equal(remapPath("res://hero.png", moves), "res://scenes/hero.png")
    assert.equal(remapPath("res://hero.png#mesh/Body", moves), "res://scenes/hero.png#mesh/Body")
    assert.equal(remapPath("res://scripts", moves), "res://textures/scripts")
    assert.equal(remapPath("res://scripts/enemies/boss.lua", moves), "res://textures/scripts/enemies/boss.lua")
  })

  test("another path is left alone, even one that starts with the same letters", () => {
    assert.equal(remapPath("res://scripts2/a.lua", moves), "res://scripts2/a.lua")
    assert.equal(remapPath("res://hero.png.bak", moves), "res://hero.png.bak")
    assert.equal(remapPath("res://scenes/main.scene", moves), "res://scenes/main.scene")
  })
})

describe("counting and containment", () => {
  test("isInside is a path component test, not a prefix test", () => {
    assert.equal(isInside("res://a/b", "res://a"), true)
    assert.equal(isInside("res://a", "res://a"), true)
    assert.equal(isInside("res://ab", "res://a"), false)
    assert.equal(isInside("res://a/b.glb#mesh/x", "res://a/b.glb"), true)
    assert.equal(isInside("res://a", "res://"), true)
  })

  test("the assets a move carries are counted, a folder's included, and the limit is 200", () => {
    assert.equal(assetsMoving(listing, [{ from: "res://scripts", to: "res://textures/scripts" }]), 2)
    assert.equal(assetsMoving(listing, [{ from: "res://hero.png", to: "res://scenes/hero.png" }]), 1)
    assert.equal(ConfirmMoveAssets, 200)
  })
})
