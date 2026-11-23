// The inspector's shader section's rules (protocol 1.35.0, shader-state.ts)
import { test } from "node:test"
import * as assert from "node:assert/strict"
import type { ShaderInfo, ShaderParamInfo } from "../protocol/protocol.generated"
import {
  componentCount,
  editableParams,
  paramBool,
  paramNumbers,
  readShaderState,
  shaderStatePatch,
  withParam,
} from "../renderer/shader-state"

const S = "6a1f0c2e-1b2d-4e3f-8a9b-0c1d2e3f4a5b"
const param = (name: string, type: string, def: unknown): ShaderParamInfo => ({ name, type, default: def })

test("a component's shaderState is read only when it names a shader", () => {
  assert.equal(readShaderState({}), null)
  assert.equal(readShaderState({ shaderState: null }), null)
  assert.equal(readShaderState({ shaderState: { params: {} } }), null)
  assert.deepEqual(readShaderState({ shaderState: { shader: S } }), { shader: S, params: {} })
  assert.deepEqual(readShaderState({ shaderState: { shader: S, params: { u: 1 } } }), { shader: S, params: { u: 1 } })
})

test("values come from the stored params, else the shader's default, else zeros", () => {
  const state = { shader: S, params: { u_Amount: 0.5, u_Tint: [1, 0, 0, 1], u_Bad: "x" } }
  assert.deepEqual(paramNumbers(state, param("u_Amount", "float", 1)), [0.5])
  assert.deepEqual(paramNumbers(state, param("u_Tint", "color", [1, 1, 1, 1])), [1, 0, 0, 1])
  assert.deepEqual(paramNumbers(state, param("u_Bad", "vec2", [3, 4])), [3, 4], "a stored value of the wrong shape falls back to the default")
  assert.deepEqual(paramNumbers(state, param("u_None", "vec3", null)), [0, 0, 0])
  assert.equal(paramBool({ shader: S, params: {} }, param("u_On", "bool", true)), true)
  assert.equal(paramBool({ shader: S, params: { u_On: false } }, param("u_On", "bool", true)), false)
  assert.deepEqual([componentCount("int"), componentCount("vec4"), componentCount("texture"), componentCount("mat4")], [1, 4, 0, 0])
})

test("setting a parameter keeps the others; an int is rounded; null clears the shader", () => {
  const state = { shader: S, params: { a: 1 } }
  assert.deepEqual(withParam(state, param("b", "int", 0), [2.6]), { shader: S, params: { a: 1, b: 3 } })
  assert.deepEqual(withParam(state, param("c", "vec2", [0, 0]), [1, 2]).params.c, [1, 2])
  assert.deepEqual(withParam(state, param("d", "bool", false), true).params.d, true)
  assert.deepEqual(state.params, { a: 1 }, "the state given is not changed")
  assert.deepEqual(shaderStatePatch(null), { shaderState: null })
  assert.deepEqual(shaderStatePatch(state), { shaderState: { shader: S, params: { a: 1 } } })
})

test("the reserved baseColorTexture is not offered (the component fills it)", () => {
  const info = { params: [param("baseColorTexture", "texture", "white"), param("u_A", "float", 0)] } as unknown as ShaderInfo
  assert.deepEqual(editableParams(info).map((p) => p.name), ["u_A"])
})
