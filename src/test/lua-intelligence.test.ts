import { test } from "node:test"
import * as assert from "node:assert/strict"
import { ApiIndex, apiMembers, indexForPath, luaCodeAt, luaCompletions, luaHover } from "../renderer/lua/lua-intelligence"
const index: ApiIndex = {
  classes: { Component: { name: "Component", description: "A component", fields: { gameObject: { name: "gameObject", type: "GameObject", description: "Owner" } } },
    LuaComponent: { name: "LuaComponent", base: "Component", description: "", fields: {} },
    Vector3: { name: "Vector3", description: "A vector", fields: { x: { name: "x", type: "number", description: "X axis" } } } },
  globals: { Vector3: { name: "Vector3", type: "Vector3", description: "A vector" } }, aliases: { Vector3: "Vector3" },
  functions: { "Vector3.Dot": { name: "Vector3.Dot", owner: "Vector3", method: false, signature: "Vector3.Dot(a, b)",
    description: "Dot product", params: [], returns: [{ type: "number", description: "" }], overloads: [] } },
}

test("global, dotted and colon completions preserve replacement ranges and inherited fields", () => {
  assert.equal(luaCompletions("Vec", 3, index)?.options[0].label, "Vector3")
  assert.equal(luaCompletions("Vector3.Do", 10, index)?.from, 8)
  assert.ok(luaCompletions("Vector3:", 8, index)?.options.some(item => item.label === "Dot"))
  assert.ok(apiMembers(index, "LuaComponent").some(item => item.label === "gameObject"))
  assert.deepEqual(luaCompletions("unknown.", 8, index)?.options, [])
})

test("self completions expose the behaviour's fields/methods without suggesting unrelated locals", () => {
  const source = `local Player = {}\nPlayer.SerializableFields = {\n health = { type = "float", default = 10 },\n speed = 2,\n}\nfunction Player:OnUpdate(dt)\n self.\nend\nreturn Player`
  const at = source.indexOf("self.") + 5
  const labels = luaCompletions(source, at, index)!.options.map(item => item.label)
  assert.ok(labels.includes("health")); assert.ok(labels.includes("speed")); assert.ok(labels.includes("OnUpdate"))
  assert.ok(labels.includes("gameObject")); assert.ok(!labels.includes("default"))
  assert.deepEqual(luaCompletions("self.", 5, index)?.options, [])
  const outside = source + "\nself."
  assert.deepEqual(luaCompletions(outside, outside.length, index)?.options, [])
  const nested = source.replace(" self.", " if true then print(\"end\") elseif false then end\n self.")
  assert.ok(luaCompletions(nested, nested.indexOf("self.") + 5, index)?.options.some(item => item.label === "health"))
})

test("declaration keys and hover signatures/docs are available without HTML interpretation", () => {
  const declaration = "Player.SerializableFields = { health = { ty"
  assert.ok(luaCompletions(declaration, declaration.length, index, true)?.options.some(item => item.label === "type"))
  const hover = luaHover("local n = Vector3.Dot(a,b)", 18, index)
  assert.equal(hover?.title, "Vector3.Dot(a, b)")
  assert.ok(hover?.description.includes("Dot product"))
})

test("quoted strings, line comments and long-bracket strings/comments suppress suggestions", () => {
  for (const source of ['"Vector3.', "-- Vector3.", "[=[Vector3.", "--[==[Vector3."])
    assert.equal(luaCompletions(source, source.length, index), null)
  assert.equal(luaCodeAt("-- comment\nVector3.", 19), true)
})

test("generated runtime and extension APIs remain separate and pinned", () => {
  assert.ok(indexForPath("res://scripts/a.lua").globals.Vector3)
  assert.ok(!indexForPath("res://scripts/a.lua").globals.Editor)
  assert.notEqual(indexForPath("project/editor/tool.lua"), indexForPath("res://scripts/a.lua"))
})
