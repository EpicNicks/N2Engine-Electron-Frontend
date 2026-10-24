// Typed client support for the Lua editor extensions (protocol 1.14.0): the parsers, the error-code mapping, the three
// commands against a host stand-in (a 1.14 host with the capability, a 1.13 host without), and the extensionsChanged
// event. There is no UI to test.
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { EngineClient, isDenialCode } from "../protocol/engine-client"
import {
  EditorExtensionsCapability,
  ExtensionErrorCodes,
  extensionErrorKindOf,
  hasCapability,
  parseExtensionsInfo,
  parseExtensionsUi,
} from "../protocol/extensions"
import { parseStateEvent } from "../protocol/editor-events"
import {
  CommandType,
  PROTOCOL_VERSION,
  ResponseCodecs,
  ResponseType,
  decodeHelloRequest,
  encodeEditorExtensionsResponse,
  encodeEditorUiResponse,
  encodeErrorCodedResponse,
  encodeErrorResponse,
  encodeFrame,
  encodeServerInfoResponse,
} from "../protocol/protocol.generated"
import type { EditorEvent, EditorExtensionsInfo, EditorUiInfo } from "../protocol/protocol.generated"

/** What the stand-in host answers a command with: a whole response frame */
type Answer = (command: number) => Uint8Array

class FakeSocket extends EventEmitter {
  destroyed = false
  /** The command ids written after Hello */
  commands: number[] = []

  constructor(
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
        protocolVersion: PROTOCOL_VERSION,
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
    const reply = this.answer(data[0])
    setImmediate(() => this.emit("data", Buffer.from(reply)))
    return true
  }

  destroy(): this {
    this.destroyed = true
    setImmediate(() => this.emit("close"))
    return this
  }
}

async function connected(capabilities: string[], answer: Answer): Promise<{ client: EngineClient; socket: FakeSocket }> {
  let socket!: FakeSocket
  const client = new EngineClient((_options, onConnect) => {
    socket = new FakeSocket(capabilities, answer)
    setImmediate(onConnect)
    return socket as unknown as net.Socket
  })
  await client.connect()
  return { client, socket }
}

const withCapability = [EditorExtensionsCapability]
const coded = (code: string, message = "refused"): Uint8Array =>
  encodeFrame(ResponseType.ErrorCoded, encodeErrorCodedResponse({ message, code }))

const info: EditorExtensionsInfo = {
  enabled: true,
  uiRevision: 3,
  extensions: [
    {
      id: "align.lua",
      name: "Align",
      sha256: "ab".repeat(32),
      apiVersion: 1,
      state: "loaded",
      capabilities: ["scene.read", "scene.write"],
      itemCount: 1,
    },
    { id: "bad.lua", name: "bad.lua", sha256: "", apiVersion: 0, state: "failed", error: "boom", capabilities: [], itemCount: 0 },
  ],
}

const ui: EditorUiInfo = {
  uiRevision: 3,
  menuItems: [
    {
      id: "align.snap",
      extension: "align.lua",
      path: "Tools/Align/Snap",
      title: "Snap",
      enabledWhen: { selection: "nonEmpty" },
      confirm: "Snap?",
      minRole: "editor",
      form: {
        fields: [
          { name: "grid", displayName: "Grid", kind: "Float", typeName: "float", hidden: false, readOnly: false },
        ],
        defaults: { grid: 1 },
      },
    },
  ],
  inspectorSections: [],
}

describe("the golden vectors and the generated protocol", () => {
  test("the client is at 1.18.0 and the vectors are the same version", () => {
    const vectorsPath = path.join(__dirname, "..", "..", "src", "protocol", "test-vectors.json")
    const vectors = JSON.parse(fs.readFileSync(vectorsPath, "utf-8")) as { protocolVersion: string }
    assert.equal(PROTOCOL_VERSION, "1.18.0")
    assert.equal(vectors.protocolVersion, PROTOCOL_VERSION)
  })

  test("the command ids are the engine's", () => {
    assert.equal(CommandType.ListEditorExtensions, 0x80)
    assert.equal(CommandType.GetEditorUi, 0x81)
    assert.equal(CommandType.ReloadEditorExtensions, 0x84)
  })

  test("the JSON answers round-trip through the generated codecs", () => {
    assert.deepEqual(ResponseCodecs.EditorExtensions.decode(encodeEditorExtensionsResponse({ info })), { info })
    assert.deepEqual(ResponseCodecs.EditorUi.decode(encodeEditorUiResponse({ ui })), { ui })
  })
})

describe("hasCapability", () => {
  test("is true only for a listed name", () => {
    assert.equal(hasCapability(["editorExtensions"], EditorExtensionsCapability), true)
    assert.equal(hasCapability([], EditorExtensionsCapability), false)
    assert.equal(hasCapability(["other"], EditorExtensionsCapability), false)
  })

  test("a missing or malformed list has none", () => {
    assert.equal(hasCapability(undefined, "x"), false)
    assert.equal(hasCapability(null, "x"), false)
    assert.equal(hasCapability("editorExtensions", "editorExtensions"), false)
    assert.equal(hasCapability({ 0: "x" }, "x"), false)
  })
})

describe("the error codes", () => {
  test("each extension code has its own kind", () => {
    assert.equal(extensionErrorKindOf(ExtensionErrorCodes.extensionsDisabled), "disabled")
    assert.equal(extensionErrorKindOf(ExtensionErrorCodes.extensionFailed), "failed")
    assert.equal(extensionErrorKindOf(ExtensionErrorCodes.extensionFaulted), "faulted")
  })

  test("they are distinct from forbidden, readOnly and busy", () => {
    assert.equal(extensionErrorKindOf("forbidden"), "forbidden")
    assert.equal(extensionErrorKindOf("readOnly"), "readOnly")
    assert.equal(extensionErrorKindOf("busy"), "other")
    assert.equal(extensionErrorKindOf(undefined), "other")
    assert.equal(extensionErrorKindOf("someFutureCode"), "other")
    // The extension codes are not denials: nothing about them is a role or read-only refusal
    for (const code of Object.values(ExtensionErrorCodes)) assert.equal(isDenialCode(code), false)
  })
})

describe("parseExtensionsInfo", () => {
  test("a well-formed answer is kept", () => {
    assert.deepEqual(parseExtensionsInfo(info), info)
  })

  test("unknown fields are ignored and missing ones defaulted", () => {
    const parsed = parseExtensionsInfo({ future: 1, extensions: [{ id: "a.lua", extra: true }] })
    assert.deepEqual(parsed, {
      enabled: false,
      uiRevision: 0,
      extensions: [
        { id: "a.lua", name: "a.lua", sha256: "", apiVersion: 0, state: "failed", capabilities: [], itemCount: 0 },
      ],
    })
  })

  test("an unknown state is shown as failed, never as loaded", () => {
    const parsed = parseExtensionsInfo({ extensions: [{ id: "a.lua", state: "running" }, { id: "b.lua", state: 4 }] })
    assert.deepEqual(
      parsed?.extensions.map((e) => e.state),
      ["failed", "failed"]
    )
  })

  test("a mistyped field takes its default and a bad entry is dropped", () => {
    const parsed = parseExtensionsInfo({
      enabled: "yes",
      uiRevision: -2,
      extensions: [null, 7, "x", [], { id: "" }, { id: "ok.lua", itemCount: "3", capabilities: ["a", 1, null] }],
    })
    assert.equal(parsed?.enabled, false)
    assert.equal(parsed?.uiRevision, 0)
    assert.equal(parsed?.extensions.length, 1)
    assert.deepEqual(parsed?.extensions[0].capabilities, ["a"])
    assert.equal(parsed?.extensions[0].itemCount, 0)
  })

  test("a shape that is not an object is null, and nothing throws", () => {
    for (const value of [null, undefined, 3, "x", [], true]) assert.equal(parseExtensionsInfo(value), null)
    assert.deepEqual(parseExtensionsInfo({ extensions: "nope" }), { enabled: false, uiRevision: 0, extensions: [] })
  })
})

describe("parseExtensionsUi", () => {
  test("a well-formed answer is kept (the reserved inspectorSections are not modelled)", () => {
    const parsed = parseExtensionsUi(ui)
    assert.equal(parsed?.uiRevision, 3)
    assert.equal(parsed?.menuItems.length, 1)
    const item = parsed!.menuItems[0]
    assert.equal(item.id, "align.snap")
    assert.equal(item.title, "Snap")
    assert.equal(item.minRole, "editor")
    assert.equal(item.confirm, "Snap?")
    assert.deepEqual(item.enabledWhen, { selection: "nonEmpty" })
    assert.deepEqual(item.form?.defaults, { grid: 1 })
    assert.equal(item.form?.fields[0].name, "grid")
  })

  test("missing fields default to the stricter choice", () => {
    const parsed = parseExtensionsUi({ menuItems: [{ id: "x", path: "Tools/Do it" }] })
    assert.deepEqual(parsed?.menuItems[0], {
      id: "x",
      extension: "",
      path: "Tools/Do it",
      title: "Do it",
      enabledWhen: { selection: "any" },
      minRole: "admin",
    })
  })

  test("an unknown role is admin and an unknown selection rule is any", () => {
    const parsed = parseExtensionsUi({
      menuItems: [{ id: "x", minRole: "root", enabledWhen: { selection: "many", componentType: 4 } }],
    })
    assert.equal(parsed?.menuItems[0].minRole, "admin")
    assert.deepEqual(parsed?.menuItems[0].enabledWhen, { selection: "any" })
  })

  test("an item without an id is dropped, a repeated id is ignored", () => {
    const parsed = parseExtensionsUi({
      menuItems: [{ path: "a" }, null, 5, { id: "x", title: "first" }, { id: "x", title: "second" }],
    })
    assert.deepEqual(
      parsed?.menuItems.map((i) => i.title),
      ["first"]
    )
  })

  test("a malformed form field is left out and the item stays", () => {
    const parsed = parseExtensionsUi({
      menuItems: [{ id: "x", form: { fields: [{ name: 3 }, null, ui.menuItems[0].form!.fields[0]], defaults: 5 } }],
    })
    assert.equal(parsed?.menuItems[0].form?.fields.length, 1)
    assert.deepEqual(parsed?.menuItems[0].form?.defaults, {})
  })

  test("a shape that is not an object is null, and nothing throws", () => {
    for (const value of [null, undefined, 3, "x", [], true]) assert.equal(parseExtensionsUi(value), null)
    assert.deepEqual(parseExtensionsUi({ menuItems: {} }), { uiRevision: 0, menuItems: [], inspectorSections: [] })
  })
})

describe("the commands against a 1.14 host", () => {
  const answers: Answer = (command) => {
    if (command === CommandType.GetEditorUi) return encodeFrame(ResponseType.EditorUi, encodeEditorUiResponse({ ui }))
    return encodeFrame(ResponseType.EditorExtensions, encodeEditorExtensionsResponse({ info }))
  }

  test("hasCapability reads the Hello answer", async () => {
    const { client } = await connected(withCapability, answers)
    assert.equal(client.hasCapability(EditorExtensionsCapability), true)
    assert.equal(client.hasCapability("nothing"), false)
  })

  test("listEditorExtensions sends 0x80 and returns the typed list", async () => {
    const { client, socket } = await connected(withCapability, answers)
    const result = await client.listEditorExtensions()
    assert.deepEqual(socket.commands, [0x80])
    assert.deepEqual(result, { status: "ok", value: info })
  })

  test("getEditorUi sends 0x81 and returns the typed items", async () => {
    const { client, socket } = await connected(withCapability, answers)
    const result = await client.getEditorUi()
    assert.deepEqual(socket.commands, [0x81])
    assert.equal(result.status, "ok")
    if (result.status === "ok") assert.equal(result.value.menuItems[0].id, "align.snap")
  })

  test("reloadEditorExtensions sends 0x84", async () => {
    const { client, socket } = await connected(withCapability, answers)
    const result = await client.reloadEditorExtensions()
    assert.deepEqual(socket.commands, [0x84])
    assert.equal(result.status, "ok")
  })

  test("a host without --editor-extensions answers enabled false, which is not an error", async () => {
    const off: EditorExtensionsInfo = { enabled: false, uiRevision: 0, extensions: [] }
    const { client } = await connected(withCapability, () =>
      encodeFrame(ResponseType.EditorExtensions, encodeEditorExtensionsResponse({ info: off }))
    )
    assert.deepEqual(await client.listEditorExtensions(), { status: "ok", value: off })
  })

  test("each coded error becomes its own typed error, with the code and the host's message", async () => {
    const cases: Array<[string, string]> = [
      ["extensionsDisabled", "disabled"],
      ["extensionFailed", "failed"],
      ["extensionFaulted", "faulted"],
      ["forbidden", "forbidden"],
      ["readOnly", "readOnly"],
      ["busy", "other"],
    ]
    for (const [code, kind] of cases) {
      const { client } = await connected(withCapability, () => coded(code, `why ${code}`))
      assert.deepEqual(await client.reloadEditorExtensions(), {
        status: "error",
        kind,
        message: `why ${code}`,
        code,
      })
    }
  })

  test("a plain Error answer (a host that was not asked for codes) is an other error", async () => {
    const { client } = await connected(withCapability, () =>
      encodeFrame(ResponseType.Error, encodeErrorResponse({ message: "No can do" }))
    )
    assert.deepEqual(await client.getEditorUi(), { status: "error", kind: "other", message: "No can do" })
  })

  test("a JSON answer of the wrong shape is malformed", async () => {
    const bad = (value: unknown): Uint8Array =>
      encodeFrame(ResponseType.EditorExtensions, encodeEditorExtensionsResponse({ info: value as EditorExtensionsInfo }))
    for (const value of [null, 3, "x", []]) {
      const { client } = await connected(withCapability, () => bad(value))
      const result = await client.listEditorExtensions()
      assert.equal(result.status, "error")
      if (result.status === "error") assert.equal(result.kind, "malformed")
    }
  })

  test("an undecodable payload is an error result, not a throw", async () => {
    const { client } = await connected(withCapability, () => encodeFrame(ResponseType.EditorUi, new Uint8Array(0)))
    const result = await client.getEditorUi()
    assert.equal(result.status, "error")
  })

  test("a response of the wrong type is an error result, not a throw", async () => {
    const { client } = await connected(withCapability, () => encodeFrame(ResponseType.Ok, new Uint8Array(0)))
    const result = await client.listEditorExtensions()
    assert.equal(result.status, "error")
  })
})

describe("against a 1.13 host (no capability)", () => {
  test("every helper reports unsupported and sends nothing", async () => {
    const { client, socket } = await connected([], () => {
      assert.fail("a command was sent to a host without the capability")
    })
    assert.equal(client.hasCapability(EditorExtensionsCapability), false)
    assert.deepEqual(await client.listEditorExtensions(), { status: "unsupported" })
    assert.deepEqual(await client.getEditorUi(), { status: "unsupported" })
    assert.deepEqual(await client.reloadEditorExtensions(), { status: "unsupported" })
    assert.deepEqual(socket.commands, [])
  })

  test("not connected is unsupported too, and nothing throws", async () => {
    const client = new EngineClient()
    assert.equal(client.hasCapability(EditorExtensionsCapability), false)
    assert.deepEqual(await client.listEditorExtensions(), { status: "unsupported" })
  })
})

describe("the extensionsChanged event", () => {
  test("carries the uiRevision", () => {
    assert.deepEqual(parseStateEvent({ seq: 1, kind: "extensionsChanged", uiRevision: 4 }), {
      kind: "extensionsChanged",
      uiRevision: 4,
    })
  })

  test("a missing or mistyped uiRevision is 0, and other keys are ignored", () => {
    assert.deepEqual(parseStateEvent({ seq: 1, kind: "extensionsChanged" }), { kind: "extensionsChanged", uiRevision: 0 })
    assert.deepEqual(
      parseStateEvent({ seq: 1, kind: "extensionsChanged", uiRevision: "x", future: 1 } as unknown as EditorEvent),
      { kind: "extensionsChanged", uiRevision: 0 }
    )
  })

  test("an extension log kind this client does not know is still ignored", () => {
    assert.equal(parseStateEvent({ seq: 1, kind: "extensionOutput" }), null)
  })
})
