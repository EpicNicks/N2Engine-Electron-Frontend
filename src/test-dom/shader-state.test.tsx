// The inspector's shader section (protocol 1.35.0): shown on a host with the shaderState capability, on a Sprite2D, Image or
// ParticleSystem; its parameters come from GetShaderInfo, and each edit sends the whole shaderState
import "./setup"
import { test } from "node:test"
import * as assert from "node:assert/strict"
import { fireEvent, screen, waitFor } from "@testing-library/preact"
import { signal } from "@preact/signals-core"
import { AssetLookup } from "../renderer/asset-lookup"
import { ShaderStateSection, numberField } from "../renderer/shader-state-ui"
import type { ComponentView } from "../renderer/inspector-state"
import { renderWithApp } from "./helpers"

const S = "6a1f0c2e-1b2d-4e3f-8a9b-0c1d2e3f4a5b"

function harness(options: { capability?: boolean; values?: Record<string, unknown>; type?: string } = {}) {
  const edits: Array<[string, unknown]> = []
  const view = { id: "c1", type: options.type ?? "Sprite2D", values: options.values ?? {} } as unknown as ComponentView
  const inspector = {
    valuesOf: (v: ComponentView) => (v as unknown as { values: Record<string, unknown> }).values,
    readOnly: signal(false),
    assets: signal(new AssetLookup([{ uuid: S, path: "res://shaders/glow.n2shader", resourceType: "Shader" }])),
    edit: (id: string, patch: unknown) => void edits.push([id, patch]),
  }
  const store = {
    serverInfo: signal({ capabilities: options.capability === false ? [] : ["shaderState"] }),
    reportError: (what: string, e: unknown) => assert.fail(`${what}: ${String(e)}`),
  }
  ;(window as unknown as { engine: unknown }).engine = {
    getShaderInfo: async () => ({
      path: "res://shaders/glow.n2shader", uuid: S, name: "Glow", usesLighting: false, state: {},
      params: [
        { name: "baseColorTexture", type: "texture", default: "white" },
        { name: "u_Amount", type: "float", default: 0.25 },
        { name: "u_On", type: "bool", default: true },
        { name: "u_Steps", type: "int", default: 2 },
      ],
      cook: { status: "ok", targets: [], diagnostics: [] },
    }),
  }
  return { view, inspector, store, edits }
}

test("nothing without the capability, or on another component", () => {
  for (const h of [harness({ capability: false }), harness({ type: "MeshRenderer" })]) {
    const { container } = renderWithApp(<ShaderStateSection view={h.view} />, { inspector: h.inspector as never, store: h.store as never })
    assert.equal(container.querySelector("[data-shader-state]"), null)
  }
})

test("without a shader: None, and picking one sends shaderState with no params", async () => {
  const h = harness()
  renderWithApp(<ShaderStateSection view={h.view} />, { inspector: h.inspector as never, store: h.store as never })
  fireEvent.click(screen.getByText("None"))
  fireEvent.click(await screen.findByText("shaders/glow.n2shader"))
  assert.deepEqual(h.edits, [["c1", { shaderState: { shader: S, params: {} } }]])
})

test("with a shader: its parameters (not baseColorTexture), an edit keeps the others, × clears it", async () => {
  const h = harness({ values: { shaderState: { shader: S, params: { u_On: false } } } })
  const { container } = renderWithApp(<ShaderStateSection view={h.view} />, { inspector: h.inspector as never, store: h.store as never })
  await waitFor(() => assert.ok(container.querySelector('[data-shader-param="u_Amount"]')))
  assert.equal(container.querySelector('[data-shader-param="baseColorTexture"]'), null)
  const on = screen.getByLabelText("u_On") as HTMLInputElement
  assert.equal(on.checked, false, "the stored value, not the default")
  fireEvent.click(on)
  assert.deepEqual(h.edits.at(-1), ["c1", { shaderState: { shader: S, params: { u_On: true } } }])
  fireEvent.click(screen.getByLabelText("Remove the shader"))
  assert.deepEqual(h.edits.at(-1), ["c1", { shaderState: null }])
})

test("picking the shader that is set sends nothing; an int is edited as an Int field", async () => {
  const h = harness({ values: { shaderState: { shader: S } } })
  const { container } = renderWithApp(<ShaderStateSection view={h.view} />, { inspector: h.inspector as never, store: h.store as never })
  await waitFor(() => assert.ok(container.querySelector('[data-shader-param="u_Steps"]')))
  fireEvent.click(screen.getByText("shaders/glow.n2shader"))
  const options = await screen.findAllByText("shaders/glow.n2shader")
  fireEvent.click(options.at(-1)!)
  assert.equal(h.edits.length, 0, "the same shader again: no request")
  assert.equal(numberField({ name: "u_Steps", type: "int", default: 2 }, null).kind, "Int")
  assert.equal(numberField({ name: "u_A", type: "float", default: 0, min: 0, max: 1 }, null).max, 1)
  assert.equal(numberField({ name: "u_V", type: "vec2", default: [0, 0], min: 0, max: 1 }, "x").max, undefined, "no range on a vector's axes")
})
