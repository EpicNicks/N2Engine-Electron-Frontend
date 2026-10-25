// Typed client support for running an extension's menu item (protocol 1.15.0): the InvokeMenuItem wrapper against a
// host stand-in (1.15 with the capability, 1.14 with it too, 1.13 without), the two new error codes, defensive parsing
// of the ExtensionResult answer, the capability gate, and the extensionOutput event with its bounded log.
// There is no UI to test.
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
  MaxInvokeSelection,
  checkInvokeArguments,
  extensionErrorKindOf,
  parseExtensionResultInfo,
  parseInvokeResult,
  supportsInvokeMenuItem,
} from "../protocol/extensions"
import {
  ExtensionOutputLog,
  MaxExtensionOutputChars,
  MaxExtensionOutputLines,
  parseExtensionOutput,
} from "../protocol/extension-output"
import { parseStateEvent } from "../protocol/editor-events"
import {
  CommandType,
  PROTOCOL_VERSION,
  RequestCodecs,
  ResponseType,
  decodeExtensionResultResponse,
  decodeHelloRequest,
  decodeInvokeMenuItemRequest,
  encodeErrorCodedResponse,
  encodeErrorResponse,
  encodeExtensionResultResponse,
  encodeFrame,
  encodeServerInfoResponse,
} from "../protocol/protocol.generated"
import type { EditorEvent, ExtensionResultResponse, InvokeMenuItemRequest } from "../protocol/protocol.generated"

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

const uuid1 = "11111111-2222-3333-4444-555555555555"
const uuid2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

const withCapability = [EditorExtensionsCapability]
const coded = (code: string, message = "refused"): Uint8Array =>
  encodeFrame(ResponseType.ErrorCoded, encodeErrorCodedResponse({ message, code }))

const answerOf = (value: Partial<ExtensionResultResponse> = {}): Uint8Array =>
  encodeFrame(
    ResponseType.ExtensionResult,
    encodeExtensionResultResponse({
      label: "Snap",
      revision: 7,
      canUndo: true,
      canRedo: false,
      savedRevision: 5,
      result: { message: "Snapped 2", select: [uuid1], warnings: ["one was locked"] },
      ...value,
    })
  )

describe("the generated protocol since 1.15.0", () => {
  test("the client and the vectors are at 1.20.0", () => {
    const vectorsPath = path.join(__dirname, "..", "..", "src", "protocol", "test-vectors.json")
    const vectors = JSON.parse(fs.readFileSync(vectorsPath, "utf-8")) as { protocolVersion: string }
    assert.equal(PROTOCOL_VERSION, "1.20.0")
    assert.equal(vectors.protocolVersion, PROTOCOL_VERSION)
  })

  test("InvokeMenuItem is 0x82 (and InvokeInspectorAction 0x83 since 1.16.0)", () => {
    assert.equal(CommandType.InvokeMenuItem, 0x82)
    assert.equal(CommandType.InvokeInspectorAction, 0x83)
  })

  test("the request and the answer round-trip through the generated codecs", () => {
    const request: InvokeMenuItemRequest = { itemId: "a.b", selection: [uuid1], params: { grid: 2 }, uiRevision: 9 }
    assert.deepEqual(RequestCodecs.InvokeMenuItem.decode(RequestCodecs.InvokeMenuItem.encode(request)), request)
    const response: ExtensionResultResponse = {
      label: "x",
      revision: 1,
      canUndo: false,
      canRedo: true,
      savedRevision: 0,
      result: { message: "m" },
    }
    assert.deepEqual(decodeExtensionResultResponse(encodeExtensionResultResponse(response)), response)
  })
})

describe("supportsInvokeMenuItem", () => {
  test("needs the capability and a host of 1.15 or later", () => {
    assert.equal(supportsInvokeMenuItem(withCapability, "1.15.0"), true)
    assert.equal(supportsInvokeMenuItem(withCapability, "1.16.2"), true)
    assert.equal(supportsInvokeMenuItem(withCapability, "1.14.0"), false)
    assert.equal(supportsInvokeMenuItem([], "1.15.0"), false)
    assert.equal(supportsInvokeMenuItem(undefined, "1.15.0"), false)
  })

  test("a malformed version has no command", () => {
    for (const version of [undefined, null, 1.15, "", "1.15", "x.y.z", {}]) {
      assert.equal(supportsInvokeMenuItem(withCapability, version), false)
    }
  })
})

describe("the new error codes", () => {
  test("staleUiRevision and editGroupOpen have kinds of their own", () => {
    assert.equal(extensionErrorKindOf(ExtensionErrorCodes.staleUiRevision), "staleUi")
    assert.equal(extensionErrorKindOf(ExtensionErrorCodes.editGroupOpen), "editGroupOpen")
    assert.equal(extensionErrorKindOf("staleUiRevision"), "staleUi")
    assert.equal(extensionErrorKindOf("editGroupOpen"), "editGroupOpen")
  })

  test("every code of the extension commands maps to a different kind, and none is a denial", () => {
    const codes = [
      "extensionsDisabled",
      "extensionFailed",
      "extensionFaulted",
      "staleUiRevision",
      "editGroupOpen",
      "forbidden",
      "readOnly",
    ]
    const kinds = codes.map((code) => extensionErrorKindOf(code))
    assert.equal(new Set(kinds).size, codes.length)
    // busy and a code from the future are the generic kind
    assert.equal(extensionErrorKindOf("busy"), "other")
    assert.equal(extensionErrorKindOf("aCodeFromTheFuture"), "other")
    assert.equal(isDenialCode("staleUiRevision"), false)
    assert.equal(isDenialCode("editGroupOpen"), false)
  })
})

describe("checkInvokeArguments", () => {
  test("well-formed arguments pass", () => {
    assert.equal(checkInvokeArguments("a.b", [], {}, 0), null)
    assert.equal(checkInvokeArguments("a.b", [uuid1, uuid2], { grid: 1 }, 0xffffffff), null)
  })

  test("each wrong shape is named", () => {
    const bad: unknown[][] = [
      ["", [], {}, 0],
      [3, [], {}, 0],
      ["a\0b", [], {}, 0],
      ["a", "x", {}, 0],
      ["a", ["not-a-uuid"], {}, 0],
      ["a", [3], {}, 0],
      ["a", [], null, 0],
      ["a", [], [], 0],
      ["a", [], {}, -1],
      ["a", [], {}, 1.5],
      ["a", [], {}, 0x100000000],
      ["a", [], {}, "1"],
    ]
    for (const args of bad) {
      assert.equal(typeof checkInvokeArguments(args[0], args[1], args[2], args[3]), "string", JSON.stringify(args))
    }
  })

  test("the selection is bounded", () => {
    assert.equal(checkInvokeArguments("a", new Array(MaxInvokeSelection).fill(uuid1), {}, 0), null)
    assert.equal(typeof checkInvokeArguments("a", new Array(MaxInvokeSelection + 1).fill(uuid1), {}, 0), "string")
  })
})

describe("parsing the ExtensionResult answer", () => {
  test("a full answer is kept, with the edit result", () => {
    assert.deepEqual(
      parseInvokeResult({
        label: "Snap",
        revision: 7,
        canUndo: true,
        canRedo: false,
        savedRevision: 5,
        result: { message: "m", select: [uuid1], warnings: ["w"] },
      }),
      {
        result: { message: "m", select: [uuid1], warnings: ["w"] },
        edit: { label: "Snap", revision: 7, savedRevision: 5, canUndo: true, canRedo: false },
      }
    )
  })

  test("parts the host left out are empty, and unknown fields are ignored", () => {
    assert.deepEqual(parseInvokeResult({ result: { future: 1 }, other: true }), {
      result: { message: "", select: [], warnings: [] },
      edit: { label: "", revision: 0, savedRevision: 0, canUndo: false, canRedo: false },
    })
  })

  test("wrong types are dropped one by one", () => {
    const parsed = parseExtensionResultInfo({ message: 5, select: [uuid1, 3, null], warnings: "x" })
    assert.deepEqual(parsed, { message: "", select: [uuid1], warnings: [] })
    const edit = parseInvokeResult({ result: {}, revision: -1, savedRevision: "3", canUndo: "yes", label: 4 })
    assert.deepEqual(edit?.edit, { label: "", revision: 0, savedRevision: 0, canUndo: false, canRedo: false })
  })

  test("a result part that is not an object is null, and nothing throws", () => {
    for (const value of [null, undefined, 3, "x", [], true]) {
      assert.equal(parseInvokeResult(value), null)
      assert.equal(parseExtensionResultInfo(value), null)
    }
    assert.equal(parseInvokeResult({ result: [] }), null)
    assert.equal(parseInvokeResult({ label: "x" }), null)
  })
})

describe("invokeMenuItem against a 1.15 host", () => {
  test("sends 0x82 with the request and returns the typed result", async () => {
    const { client, socket } = await connected("1.15.0", withCapability, () => answerOf())
    const result = await client.invokeMenuItem("align.snap", [uuid1, uuid2], { grid: 2 }, 3)
    assert.deepEqual(socket.commands, [0x82])
    assert.deepEqual(decodeInvokeMenuItemRequest(socket.payloads[0]), {
      itemId: "align.snap",
      selection: [uuid1, uuid2],
      params: { grid: 2 },
      uiRevision: 3,
    })
    assert.deepEqual(result, {
      status: "ok",
      value: {
        result: { message: "Snapped 2", select: [uuid1], warnings: ["one was locked"] },
        edit: { label: "Snap", revision: 7, savedRevision: 5, canUndo: true, canRedo: false },
      },
    })
  })

  test("an item that returned nothing is an ok result with empty parts", async () => {
    const { client } = await connected("1.15.0", withCapability, () => answerOf({ result: {} }))
    const result = await client.invokeMenuItem("a", [], {}, 0)
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
      const { client } = await connected("1.15.0", withCapability, () => coded(code, `why ${code}`))
      assert.deepEqual(await client.invokeMenuItem("a", [], {}, 0), {
        status: "error",
        kind,
        message: `why ${code}`,
        code,
      })
    }
  })

  test("a plain Error answer is an other error", async () => {
    const { client } = await connected("1.15.0", withCapability, () =>
      encodeFrame(ResponseType.Error, encodeErrorResponse({ message: "Unknown menu item" }))
    )
    assert.deepEqual(await client.invokeMenuItem("a", [], {}, 0), {
      status: "error",
      kind: "other",
      message: "Unknown menu item",
    })
  })

  test("a result part of the wrong shape is malformed", async () => {
    for (const value of [null, 3, "x", []]) {
      const { client } = await connected("1.15.0", withCapability, () =>
        answerOf({ result: value as unknown as ExtensionResultResponse["result"] })
      )
      const result = await client.invokeMenuItem("a", [], {}, 0)
      assert.equal(result.status, "error")
      if (result.status === "error") assert.equal(result.kind, "malformed")
    }
  })

  test("an undecodable payload or a response of the wrong type is an error result, not a throw", async () => {
    const empty = await connected("1.15.0", withCapability, () =>
      encodeFrame(ResponseType.ExtensionResult, new Uint8Array(0))
    )
    assert.equal((await empty.client.invokeMenuItem("a", [], {}, 0)).status, "error")
    const wrong = await connected("1.15.0", withCapability, () => encodeFrame(ResponseType.Ok, new Uint8Array(0)))
    assert.equal((await wrong.client.invokeMenuItem("a", [], {}, 0)).status, "error")
  })

  test("arguments of the wrong shape are an invalid error and nothing is sent", async () => {
    const { client, socket } = await connected("1.15.0", withCapability, () => {
      assert.fail("a command was sent")
    })
    const selection = await client.invokeMenuItem("a", ["nope"], {}, 0)
    assert.equal(selection.status === "error" && selection.kind, "invalid")
    const params = await client.invokeMenuItem("a", [], null as unknown as Record<string, unknown>, 0)
    assert.equal(params.status === "error" && params.kind, "invalid")
    assert.deepEqual(socket.commands, [])
  })
})

describe("invokeMenuItem against older hosts", () => {
  test("a 1.14 host has the capability but not the command: unsupported, nothing sent", async () => {
    const { client, socket } = await connected("1.14.0", withCapability, () => {
      assert.fail("a command was sent to a 1.14 host")
    })
    assert.equal(client.hasCapability(EditorExtensionsCapability), true)
    assert.deepEqual(await client.invokeMenuItem("a", [], {}, 0), { status: "unsupported" })
    assert.deepEqual(socket.commands, [])
  })

  test("a host without the capability: unsupported, nothing sent", async () => {
    const { client, socket } = await connected("1.13.0", [], () => {
      assert.fail("a command was sent to a 1.13 host")
    })
    assert.deepEqual(await client.invokeMenuItem("a", [], {}, 0), { status: "unsupported" })
    assert.deepEqual(socket.commands, [])
  })

  test("a 1.15 host that lists no capability is unsupported too", async () => {
    const { client, socket } = await connected("1.15.0", [], () => {
      assert.fail("a command was sent")
    })
    assert.deepEqual(await client.invokeMenuItem("a", [], {}, 0), { status: "unsupported" })
    assert.deepEqual(socket.commands, [])
  })

  test("not connected is unsupported, and nothing throws", async () => {
    assert.deepEqual(await new EngineClient().invokeMenuItem("a", [], {}, 0), { status: "unsupported" })
  })

  test("the 1.14 commands still work on a 1.15 host", async () => {
    const { client, socket } = await connected("1.15.0", withCapability, () =>
      encodeFrame(ResponseType.Error, encodeErrorResponse({ message: "x" }))
    )
    const result = await client.getEditorUi()
    assert.equal(result.status, "error")
    assert.deepEqual(socket.commands, [CommandType.GetEditorUi])
  })
})

describe("the extensionOutput event", () => {
  const event = (fields: Record<string, unknown>): EditorEvent =>
    ({ seq: 1, kind: "extensionOutput", ...fields }) as unknown as EditorEvent

  test("carries the extension, the level, the message and the time", () => {
    assert.deepEqual(parseExtensionOutput(event({ extension: "Align", level: "warn", message: "hi", time: 1700 })), {
      extension: "Align",
      level: "warn",
      message: "hi",
      time: 1700,
    })
  })

  test("an unknown or missing level is info, and missing fields take defaults", () => {
    assert.equal(parseExtensionOutput(event({ message: "m", level: "fatal" }))?.level, "info")
    assert.equal(parseExtensionOutput(event({ message: "m", level: 3 }))?.level, "info")
    assert.deepEqual(parseExtensionOutput(event({ message: "m" })), {
      extension: "",
      level: "info",
      message: "m",
      time: 0,
    })
    assert.equal(parseExtensionOutput(event({ message: "m", time: "soon" }))?.time, 0)
    assert.equal(parseExtensionOutput(event({ message: "m", time: -4 }))?.time, 0)
  })

  test("an event without a text message, or of another kind, is no line", () => {
    assert.equal(parseExtensionOutput(event({})), null)
    assert.equal(parseExtensionOutput(event({ message: 5 })), null)
    assert.equal(parseExtensionOutput({ seq: 1, kind: "log", level: "info", message: "m" }), null)
    assert.equal(parseExtensionOutput(null as unknown as EditorEvent), null)
  })

  test("the text stays plain text: markup is not interpreted, control characters are replaced, long text is cut", () => {
    const html = '<img src=x onerror="alert(1)"><script>x()</script>'
    assert.equal(parseExtensionOutput(event({ message: html, extension: "<b>e</b>" }))?.message, html)
    assert.equal(parseExtensionOutput(event({ message: "a\nb\u0000c\u001bd\te" }))?.message, "a?b?c?d\te")
    const long = parseExtensionOutput(event({ message: "x".repeat(MaxExtensionOutputChars + 50) }))
    assert.equal(long?.message.length, MaxExtensionOutputChars + 3)
    assert.ok(long?.message.endsWith("..."))
  })

  test("it is not a state event, so no state counter can move on it", () => {
    assert.equal(parseStateEvent(event({ message: "m" })), null)
  })
})

describe("ExtensionOutputLog", () => {
  const out = (message: string, extra: Record<string, unknown> = {}): EditorEvent =>
    ({ seq: 1, kind: "extensionOutput", extension: "E", level: "info", message, time: 1, ...extra }) as unknown as EditorEvent

  test("keeps lines oldest first with counting ids, and says whether it added one", () => {
    const log = new ExtensionOutputLog()
    assert.equal(log.addEvent(out("a")), true)
    assert.equal(log.addEvent(out("b", { level: "error" })), true)
    assert.equal(log.addEvent({ seq: 3, kind: "log", message: "x" }), false)
    assert.deepEqual(
      log.lines.map((l) => [l.id, l.level, l.message]),
      [
        [1, "info", "a"],
        [2, "error", "b"],
      ]
    )
  })

  test("is a bounded ring: the oldest lines go first", () => {
    const log = new ExtensionOutputLog(3)
    for (let i = 1; i <= 5; i++) log.addEvent(out(`m${i}`))
    assert.deepEqual(
      log.lines.map((l) => [l.id, l.message]),
      [
        [3, "m3"],
        [4, "m4"],
        [5, "m5"],
      ]
    )
    const big = new ExtensionOutputLog()
    for (let i = 0; i < MaxExtensionOutputLines + 10; i++) big.addEvent(out("x"))
    assert.equal(big.lines.length, MaxExtensionOutputLines)
  })

  test("subscribers hear each change, can stop, and a throwing one hurts nobody", () => {
    const log = new ExtensionOutputLog()
    let heard = 0
    let other = 0
    const stop = log.subscribe(() => heard++)
    log.subscribe(() => {
      throw new Error("bad listener")
    })
    log.subscribe(() => other++)
    log.addEvent(out("a"))
    log.addEvent({ seq: 2, kind: "log" }) // not a line: no change
    assert.equal(heard, 1)
    assert.equal(other, 1)
    stop()
    log.clear()
    assert.equal(heard, 1)
    assert.equal(other, 2)
    log.clear() // already empty: no change
    assert.equal(other, 2)
    assert.equal(log.lines.length, 0)
  })

  test("the lines array is new after a change, so it can be compared by identity", () => {
    const log = new ExtensionOutputLog()
    const before = log.lines
    log.addEvent(out("a"))
    assert.notEqual(log.lines, before)
    assert.equal(before.length, 0)
  })
})
