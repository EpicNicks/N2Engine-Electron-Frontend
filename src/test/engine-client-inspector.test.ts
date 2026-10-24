// Typed client support for inspector sections (protocol 1.16.0): the InvokeInspectorAction wrapper against a host
// stand-in (1.16 with the capability, 1.15 and 1.14 with it too, 1.13 without), the same coded refusals as
// InvokeMenuItem, defensive parsing of the sections in GetEditorUi, and the capability gate. There is no UI to test.
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import * as net from "node:net"
import { EngineClient } from "../protocol/engine-client"
import {
  EditorExtensionsCapability,
  checkInspectorArguments,
  parseExtensionsUi,
  supportsInvokeInspectorAction,
} from "../protocol/extensions"
import {
  CommandType,
  PROTOCOL_VERSION,
  RequestCodecs,
  ResponseType,
  decodeHelloRequest,
  decodeInvokeInspectorActionRequest,
  encodeEditorUiResponse,
  encodeErrorCodedResponse,
  encodeErrorResponse,
  encodeExtensionResultResponse,
  encodeFrame,
  encodeServerInfoResponse,
} from "../protocol/protocol.generated"
import type { EditorUiInfo, ExtensionResultResponse } from "../protocol/protocol.generated"

type Answer = (command: number, payload: Uint8Array) => Uint8Array

class FakeSocket extends EventEmitter {
  destroyed = false
  /** The command ids written after Hello */
  commands: number[] = []
  /** The payloads written after Hello (without the frame header) */
  payloads: Uint8Array[] = []

  constructor(
    private readonly protocolVersion: string,
    private readonly capabilities: string[],
    private readonly answer: Answer
  ) {
    super()
  }

  end(): this {
    return this
  }

  write(data: Uint8Array): boolean {
    if (data[0] === CommandType.Hello) {
      decodeHelloRequest(data.subarray(5))
      const info = {
        protocolVersion: this.protocolVersion,
        engineVersion: "0.9.0",
        capabilities: this.capabilities,
        projectLoaded: true,
        readOnly: false,
        user: "",
        role: "admin",
      }
      const reply = encodeFrame(ResponseType.ServerInfo, encodeServerInfoResponse(info))
      setImmediate(() => this.emit("data", Buffer.from(reply)))
      return true
    }
    this.commands.push(data[0])
    this.payloads.push(data.subarray(5))
    const reply = this.answer(data[0], data.subarray(5))
    setImmediate(() => this.emit("data", Buffer.from(reply)))
    return true
  }

  destroy(): this {
    this.destroyed = true
    setImmediate(() => this.emit("close"))
    return this
  }
}

async function connected(
  protocolVersion: string,
  capabilities: string[],
  answer: Answer
): Promise<{ client: EngineClient; socket: FakeSocket }> {
  let socket!: FakeSocket
  const client = new EngineClient((_options, onConnect) => {
    socket = new FakeSocket(protocolVersion, capabilities, answer)
    setImmediate(onConnect)
    return socket as unknown as net.Socket
  })
  await client.connect()
  return { client, socket }
}

const component = "11111111-2222-3333-4444-555555555555"
const withCapability = [EditorExtensionsCapability]
const coded = (code: string, message = "refused"): Uint8Array =>
  encodeFrame(ResponseType.ErrorCoded, encodeErrorCodedResponse({ message, code }))

const answerOf = (value: Partial<ExtensionResultResponse> = {}): Uint8Array =>
  encodeFrame(
    ResponseType.ExtensionResult,
    encodeExtensionResultResponse({
      label: "Fix it",
      revision: 7,
      canUndo: true,
      canRedo: false,
      savedRevision: 5,
      result: { message: "Fixed", select: [component], warnings: ["careful"] },
      ...value,
    })
  )

describe("the generated protocol at 1.16.0", () => {
  test("the client is at 1.18.0 and InvokeInspectorAction is 0x83", () => {
    assert.equal(PROTOCOL_VERSION, "1.18.0")
    assert.equal(CommandType.InvokeInspectorAction, 0x83)
  })

  test("the request round-trips through the generated codec", () => {
    const request = { componentId: component, actionId: "fix.it", params: { power: 2 }, uiRevision: 9 }
    assert.deepEqual(RequestCodecs.InvokeInspectorAction.decode(RequestCodecs.InvokeInspectorAction.encode(request)), request)
  })
})

describe("supportsInvokeInspectorAction", () => {
  test("needs the capability and a host of 1.16 or later", () => {
    assert.equal(supportsInvokeInspectorAction(withCapability, "1.16.0"), true)
    assert.equal(supportsInvokeInspectorAction(withCapability, "1.17.2"), true)
    assert.equal(supportsInvokeInspectorAction(withCapability, "2.0.0"), true)
    assert.equal(supportsInvokeInspectorAction(withCapability, "1.15.0"), false)
    assert.equal(supportsInvokeInspectorAction(withCapability, "1.14.0"), false)
    assert.equal(supportsInvokeInspectorAction([], "1.16.0"), false)
    assert.equal(supportsInvokeInspectorAction(undefined, "1.16.0"), false)
  })

  test("never throws on a malformed version or list", () => {
    for (const version of [undefined, null, 16, "", "x", "1", "1.x.0"]) {
      assert.equal(supportsInvokeInspectorAction(withCapability, version), false)
    }
    assert.equal(supportsInvokeInspectorAction("editorExtensions", "1.16.0"), false)
  })
})

describe("checkInspectorArguments", () => {
  test("accepts a UUID, an id, an object and an unsigned 32-bit revision", () => {
    assert.equal(checkInspectorArguments(component, "a.b", {}, 0), null)
    assert.equal(checkInspectorArguments(component, "a", { x: 1 }, 0xffffffff), null)
  })

  test("names the first thing that is wrong", () => {
    assert.match(checkInspectorArguments("nope", "a", {}, 0) ?? "", /componentId/)
    assert.match(checkInspectorArguments(5, "a", {}, 0) ?? "", /componentId/)
    assert.match(checkInspectorArguments(component, "", {}, 0) ?? "", /actionId/)
    assert.match(checkInspectorArguments(component, "a\0b", {}, 0) ?? "", /actionId/)
    assert.match(checkInspectorArguments(component, "a", null, 0) ?? "", /params/)
    assert.match(checkInspectorArguments(component, "a", [], 0) ?? "", /params/)
    assert.match(checkInspectorArguments(component, "a", {}, -1) ?? "", /uiRevision/)
    assert.match(checkInspectorArguments(component, "a", {}, 1.5) ?? "", /uiRevision/)
    assert.match(checkInspectorArguments(component, "a", {}, 0x100000000) ?? "", /uiRevision/)
  })
})

describe("invokeInspectorAction against a 1.16 host", () => {
  test("sends 0x83 with the request and returns the typed result", async () => {
    const { client, socket } = await connected("1.16.0", withCapability, () => answerOf())
    const result = await client.invokeInspectorAction(component, "fix.it", { power: 2 }, 3)
    assert.deepEqual(socket.commands, [0x83])
    assert.deepEqual(decodeInvokeInspectorActionRequest(socket.payloads[0]), {
      componentId: component,
      actionId: "fix.it",
      params: { power: 2 },
      uiRevision: 3,
    })
    assert.deepEqual(result, {
      status: "ok",
      value: {
        result: { message: "Fixed", select: [component], warnings: ["careful"] },
        edit: { label: "Fix it", revision: 7, savedRevision: 5, canUndo: true, canRedo: false },
      },
    })
  })

  test("a button that returned nothing is an ok result with empty parts", async () => {
    const { client } = await connected("1.16.0", withCapability, () => answerOf({ result: {} }))
    const result = await client.invokeInspectorAction(component, "a", {}, 0)
    assert.equal(result.status, "ok")
    if (result.status === "ok") assert.deepEqual(result.value.result, { message: "", select: [], warnings: [] })
  })

  test("each coded refusal is its own typed error with the code and the host's message", async () => {
    const cases: Array<[string, string]> = [
      ["staleUiRevision", "staleUi"],
      ["editGroupOpen", "editGroupOpen"],
      ["extensionsDisabled", "disabled"],
      ["extensionFailed", "failed"],
      ["extensionFaulted", "faulted"],
      ["forbidden", "forbidden"],
      ["readOnly", "readOnly"],
      ["busy", "other"],
      ["aCodeFromTheFuture", "other"],
    ]
    for (const [code, kind] of cases) {
      const { client } = await connected("1.16.0", withCapability, () => coded(code, `why ${code}`))
      assert.deepEqual(await client.invokeInspectorAction(component, "a", {}, 0), {
        status: "error",
        kind,
        message: `why ${code}`,
        code,
      })
    }
  })

  test("a plain Error answer is an other error, and never throws", async () => {
    const { client } = await connected("1.16.0", withCapability, () =>
      encodeFrame(ResponseType.Error, encodeErrorResponse({ message: "No such component" }))
    )
    assert.deepEqual(await client.invokeInspectorAction(component, "a", {}, 0), {
      status: "error",
      kind: "other",
      message: "No such component",
    })
  })

  test("an answer that is not an ExtensionResult is an error, not a throw", async () => {
    const empty = await connected("1.16.0", withCapability, () => encodeFrame(ResponseType.ExtensionResult, new Uint8Array(0)))
    assert.equal((await empty.client.invokeInspectorAction(component, "a", {}, 0)).status, "error")
    const wrong = await connected("1.16.0", withCapability, () => encodeFrame(ResponseType.Ok, new Uint8Array(0)))
    assert.equal((await wrong.client.invokeInspectorAction(component, "a", {}, 0)).status, "error")
  })

  test("arguments of the wrong shape are an invalid error and nothing is sent", async () => {
    const { client, socket } = await connected("1.16.0", withCapability, () => answerOf())
    const bad = [
      await client.invokeInspectorAction("nope", "a", {}, 0),
      await client.invokeInspectorAction(component, "", {}, 0),
      await client.invokeInspectorAction(component, "a", null as unknown as Record<string, unknown>, 0),
      await client.invokeInspectorAction(component, "a", {}, -1),
    ]
    for (const result of bad) {
      assert.equal(result.status, "error")
      if (result.status === "error") assert.equal(result.kind, "invalid")
    }
    assert.deepEqual(socket.commands, [])
  })
})

describe("invokeInspectorAction against older hosts", () => {
  test("a 1.15 host has the capability but not the command: unsupported, nothing sent", async () => {
    const { client, socket } = await connected("1.15.0", withCapability, () => answerOf())
    assert.deepEqual(await client.invokeInspectorAction(component, "a", {}, 0), { status: "unsupported" })
    assert.deepEqual(socket.commands, [])
  })

  test("a 1.14 host: unsupported, nothing sent", async () => {
    const { client, socket } = await connected("1.14.0", withCapability, () => answerOf())
    assert.deepEqual(await client.invokeInspectorAction(component, "a", {}, 0), { status: "unsupported" })
    assert.deepEqual(socket.commands, [])
  })

  test("a 1.16 host without the capability: unsupported, nothing sent", async () => {
    const { client, socket } = await connected("1.16.0", [], () => answerOf())
    assert.deepEqual(await client.invokeInspectorAction(component, "a", {}, 0), { status: "unsupported" })
    assert.deepEqual(socket.commands, [])
  })

  test("not connected is unsupported too", async () => {
    assert.deepEqual(await new EngineClient().invokeInspectorAction(component, "a", {}, 0), { status: "unsupported" })
  })

  test("a 1.15 host's GetEditorUi has no sections and still parses", async () => {
    const ui: EditorUiInfo = { uiRevision: 2, menuItems: [], inspectorSections: [] }
    const { client } = await connected("1.15.0", withCapability, () =>
      encodeFrame(ResponseType.EditorUi, encodeEditorUiResponse({ ui }))
    )
    assert.deepEqual(await client.getEditorUi(), {
      status: "ok",
      value: { uiRevision: 2, menuItems: [], inspectorSections: [] },
    })
  })
})

describe("GetEditorUi's inspector sections", () => {
  const field = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    displayName: name,
    kind: "Float",
    typeName: "float",
    hidden: false,
    readOnly: true,
    ...over,
  })

  test("a section keeps its component type, extension, label, fields and buttons in order", async () => {
    const ui = {
      uiRevision: 6,
      menuItems: [],
      inspectorSections: [
        {
          componentType: "Light",
          extension: "Light Tools",
          label: "Light helpers",
          fields: [field("watts")],
          buttons: [
            { id: "light.reset", label: "Reset", minRole: "editor" },
            {
              id: "light.set",
              label: "Set power",
              minRole: "admin",
              form: { fields: [field("power", { readOnly: false })], defaults: { power: 3 } },
            },
          ],
        },
      ],
    }
    const { client } = await connected("1.16.0", withCapability, () =>
      encodeFrame(ResponseType.EditorUi, encodeEditorUiResponse({ ui: ui as unknown as EditorUiInfo }))
    )
    const result = await client.getEditorUi()
    assert.equal(result.status, "ok")
    if (result.status !== "ok") return
    const sections = result.value.inspectorSections
    assert.equal(sections.length, 1)
    assert.equal(sections[0].componentType, "Light")
    assert.equal(sections[0].extension, "Light Tools")
    assert.equal(sections[0].label, "Light helpers")
    assert.deepEqual(sections[0].fields.map((f) => f.name), ["watts"])
    assert.deepEqual(sections[0].buttons.map((b) => [b.id, b.label, b.minRole]), [
      ["light.reset", "Reset", "editor"],
      ["light.set", "Set power", "admin"],
    ])
    assert.equal(sections[0].buttons[0].form, undefined)
    assert.deepEqual(sections[0].buttons[1].form?.defaults, { power: 3 })
    assert.deepEqual(sections[0].buttons[1].form?.fields.map((f) => f.name), ["power"])
  })

  test("a malformed list of sections is empty, and nothing throws", () => {
    for (const value of [undefined, null, 5, "x", {}, true]) {
      assert.deepEqual(parseExtensionsUi({ uiRevision: 1, menuItems: [], inspectorSections: value })?.inspectorSections, [])
    }
  })

  test("a section with no component type, and entries that are not objects, are dropped", () => {
    const parsed = parseExtensionsUi({
      inspectorSections: [null, 5, "x", [], { label: "no type" }, { componentType: "", label: "empty" }, { componentType: "A" }],
    })
    assert.deepEqual(parsed?.inspectorSections.map((s) => s.componentType), ["A"])
  })

  test("missing and wrongly typed parts take defaults", () => {
    const parsed = parseExtensionsUi({
      inspectorSections: [{ componentType: "A", extension: 5, label: 7, fields: "no", buttons: { id: "x" } }],
    })
    assert.deepEqual(parsed?.inspectorSections, [{ componentType: "A", extension: "", label: "A", fields: [], buttons: [] }])
  })

  test("a button with no id is dropped, a repeated id is ignored across sections, an unknown role is admin", () => {
    const parsed = parseExtensionsUi({
      inspectorSections: [
        {
          componentType: "A",
          buttons: [
            { label: "no id" },
            { id: "x", label: "First", minRole: "viewer" },
            { id: "x", label: "Again", minRole: "editor" },
            { id: "y", minRole: "editor" },
            "junk",
          ],
        },
        {
          componentType: "B",
          buttons: [
            { id: "x", label: "Elsewhere", minRole: "editor" },
            { id: "z", label: "Z", minRole: "editor" },
          ],
        },
      ],
    })
    const [a, b] = parsed?.inspectorSections ?? []
    assert.deepEqual(a.buttons.map((x) => [x.id, x.label, x.minRole]), [
      ["x", "First", "admin"],
      ["y", "y", "editor"],
    ])
    assert.deepEqual(b.buttons.map((x) => x.id), ["z"])
  })

  test("a field the editor cannot show is left out without dropping the section", () => {
    const parsed = parseExtensionsUi({
      inspectorSections: [{ componentType: "A", fields: [field("ok"), { name: 5 }, null, field("also")] }],
    })
    assert.deepEqual(parsed?.inspectorSections[0].fields.map((f) => f.name), ["ok", "also"])
  })

  test("extension text is kept as the text it is: markup stays a string", () => {
    const evil = "<img src=x onerror=alert(1)>"
    const parsed = parseExtensionsUi({
      inspectorSections: [{ componentType: "A", label: evil, buttons: [{ id: "b", label: evil, minRole: "editor" }] }],
    })
    assert.equal(parsed?.inspectorSections[0].label, evil)
    assert.equal(parsed?.inspectorSections[0].buttons[0].label, evil)
  })
})
