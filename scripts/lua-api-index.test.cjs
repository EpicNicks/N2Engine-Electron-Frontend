const { test } = require("node:test")
const assert = require("node:assert/strict")
const { parseLuaApi, typeAndDescription } = require("./lua-api-index")

test("class inheritance, typed fields, namespace aliases and overloads retain their documentation", () => {
  const index = parseLuaApi(`---An object\n---@class Body : Component\n---@field speed number Units per second\n---@field target? GameObject|nil Optional target\nBody = {}\n\n---Moves without running this definition file\n---@param position Vector3 New position\n---@param options? table<string, number> Values\n---@return boolean Whether it moved\n---@overload fun(x: number, y: number): boolean\nfunction Body:Move(position, options) end`)
  assert.equal(index.classes.Body.base, "Component")
  assert.equal(index.classes.Body.description, "An object")
  assert.deepEqual(index.classes.Body.fields.speed, { name: "speed", type: "number", description: "Units per second" })
  assert.equal(index.aliases.Body, "Body")
  assert.equal(index.functions["Body.Move"].signature, "Body:Move(position, options)")
  assert.equal(index.functions["Body.Move"].params[1].type, "table<string, number>")
  assert.equal(index.functions["Body.Move"].params[1].name, "options?")
  assert.equal(index.functions["Body.Move"].overloads.length, 1)
  assert.equal(index.functions["Body.Move"].returns[0].description, "Whether it moved")
})

test("the editor's nested API table is indexed separately from class names", () => {
  const index = parseLuaApi(`---@class EditorSceneApi\nEditor.Scene = {}\n---Finds an object\n---@param name string\nfunction Editor.Scene.FindByName(name) end`)
  assert.equal(index.aliases["Editor.Scene"], "EditorSceneApi")
  assert.equal(index.functions["Editor.Scene.FindByName"].owner, "Editor.Scene")
  assert.equal(index.functions["Editor.Scene.FindByName"].description, "Finds an object")
})

test("types containing balanced generic/function syntax do not lose spaces or turn prose into types", () => {
  assert.deepEqual(typeAndDescription("table<string, fun(a: number): boolean> callback map"),
    { type: "table<string, fun(a: number): boolean>", description: "callback map" })
})
