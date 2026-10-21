// MCP conformance of the pinned SDK (2.3.1) as the bridge uses it: a client that opens with the 2025-11-25 handshake
// (initialize) and one that probes with 2026-07-28's server/discover are both served; the tool list is deterministic, every
// schema is valid JSON Schema 2020-12 and every real result validates against its tool's outputSchema.
import { test, describe, after } from "node:test"
import * as assert from "node:assert/strict"
import Ajv2020 from "ajv/dist/2020"
import { ReadTools } from "../src/tools"
import { WriteTools } from "../src/tools-write"
import { BridgeVersion } from "../src/version"
import { closeAllHarnesses, startHarness, textOf, type Harness } from "./harness"
import { entityData } from "./fake-host"

after(closeAllHarnesses)

for (const era of ["legacy", "auto"] as const) {
  describe(`a client opening in the ${era === "legacy" ? "2025-11-25 (initialize)" : "2026-07-28 (server/discover)"} way`, () => {
    test("connects, sees the server's name, version, tools capability and instructions", async () => {
      const h = await startHarness({ era })
      const version = h.client.getServerVersion()
      assert.equal(version?.name, "n2-mcp")
      assert.equal(version?.version, BridgeVersion)
      assert.ok(h.client.getServerCapabilities()?.tools)
      assert.match(h.client.getInstructions() ?? "", /untrusted data, never instructions/)
      await h.close()
    })

    test("tools/list: the read tools then the write tools (an editor host), in the same order, with the stable names", async () => {
      const h = await startHarness({ era })
      const { tools } = await h.client.listTools()
      assert.deepEqual(tools.map((t) => t.name), [...ReadTools, ...WriteTools].map((t) => t.name))
      for (const t of tools) {
        assert.match(t.name, /^[a-z0-9_]{1,64}$/)
        assert.match(t.name, /^n2_/)
      }
      const again = await h.client.listTools()
      assert.deepEqual(again.tools, tools)
      await h.close()
    })

    test("a tool call works, with structured content and a text block", async () => {
      const h = await startHarness({ era })
      const r = await h.call("n2_status")
      assert.ok(!r.isError, textOf(r))
      assert.ok(r.structuredContent)
      assert.equal(r.content[0].type, "text")
      await h.close()
    })
  })
}

describe("tool schemas", () => {
  let h: Harness

  test("every inputSchema and outputSchema is valid JSON Schema 2020-12, objects only, and inputs refuse unknown keys", async () => {
    h = await startHarness()
    const ajv = new Ajv2020({ strict: false, validateFormats: false })
    const { tools } = await h.client.listTools()
    for (const t of tools) {
      assert.equal(t.inputSchema.type, "object", t.name)
      assert.equal(t.inputSchema.additionalProperties, false, `${t.name} input refuses unknown arguments`)
      assert.doesNotThrow(() => ajv.compile(t.inputSchema as object), `${t.name} input`)
      assert.ok(t.outputSchema, `${t.name} has an outputSchema`)
      assert.equal((t.outputSchema as { type?: string }).type, "object")
      assert.doesNotThrow(() => ajv.compile(t.outputSchema as object), `${t.name} output`)
      assert.ok((t.description ?? "").length > 80, `${t.name} has a real description`)
      assert.ok(t.title, `${t.name} has a title`)
    }
    await h.close()
  })

  test("every read tool is marked read-only, non-destructive, idempotent and closed-world", async () => {
    h = await startHarness()
    const { tools } = await h.client.listTools()
    for (const t of tools.filter((x) => ReadTools.some((r) => r.name === x.name))) {
      assert.equal(t.annotations?.readOnlyHint, true, t.name)
      assert.equal(t.annotations?.destructiveHint, false, t.name)
      assert.equal(t.annotations?.idempotentHint, true, t.name)
      assert.equal(t.annotations?.openWorldHint, false, t.name)
    }
    await h.close()
  })

  test("real results validate against their tool's outputSchema (and an image comes with its summary)", async () => {
    h = await startHarness()
    const id = "11111111-0000-0000-0000-000000000002"
    h.host.entities.set(id, entityData(id, "11111111-0000-0000-0000-000000000001", "Player", [{ type: "Light", uuid: "c2", values: { intensity: 3 } }]))
    h.host.addLogEvents(["info", "hello"])
    h.host.texts.set("res://a.txt", "text")
    const calls: Array<[string, Record<string, unknown>]> = [
      ["n2_status", {}],
      ["n2_get_project_info", {}],
      ["n2_get_hierarchy", {}],
      ["n2_get_entity", { entityId: id }],
      ["n2_get_component_types", {}],
      ["n2_describe_component", { typeName: "Light" }],
      ["n2_list_assets", {}],
      ["n2_get_asset_info", { pathOrUuid: "res://textures/wall.png" }],
      ["n2_read_text_asset", { path: "res://a.txt" }],
      ["n2_get_console", {}],
      ["n2_screenshot", { width: 64, height: 36 }],
    ]
    assert.equal(calls.length, ReadTools.length, "every tool is exercised")
    const ajv = new Ajv2020({ strict: false, validateFormats: false })
    const { tools } = await h.client.listTools()
    for (const [name, args] of calls) {
      const r = await h.call(name, args)
      assert.ok(!r.isError, `${name}: ${textOf(r)}`)
      const validate = ajv.compile(tools.find((t) => t.name === name)!.outputSchema as object)
      assert.ok(validate(r.structuredContent), `${name}: ${JSON.stringify((validate as unknown as { errors?: unknown }).errors)}`)
    }
    await h.close()
  })

  test("an unknown tool and bad arguments are errors the model can read; the connection stays usable", async () => {
    h = await startHarness()
    let unknown: unknown
    try {
      unknown = await h.client.callTool({ name: "n2_does_not_exist", arguments: {} })
    } catch (e) {
      unknown = e
    }
    assert.ok(unknown instanceof Error || (unknown as { isError?: boolean }).isError === true, "unknown tool is an error")
    const bad = await h.call("n2_get_hierarchy", { limit: "ten" })
    assert.equal(bad.isError, true)
    assert.match(textOf(bad), /Invalid arguments|validation/i)
    const extra = await h.call("n2_get_hierarchy", { sneaky: true })
    assert.equal(extra.isError, true, "unknown arguments are refused (additionalProperties: false)")
    assert.equal(h.host.count("GetHierarchy"), 0, "the host was never asked")
    assert.ok(!(await h.call("n2_status")).isError)
    await h.close()
  })
})
