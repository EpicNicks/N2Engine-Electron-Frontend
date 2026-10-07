// The command specs (codec.ts) against the engine's golden vectors (src/protocol/test-vectors.json, copied from the
// engine by npm run sync-protocol): every request encodes to the engine's bytes, and every response decodes to its
// fields, through the same specs EngineClient uses.
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { CommandName, Commands, decodeError } from "../protocol/codec"
import { CommandResponse, CommandType, PROTOCOL_VERSION, ResponseType } from "../protocol/protocol.generated"

interface Vector {
  id: string
  fields: Record<string, unknown>
  payload: string
}
interface Vectors {
  protocolVersion: string
  requests: Array<Vector & { command: string }>
  responses: Array<Vector & { response: string }>
}

// dist/test/codec.test.js: the source tree is two levels up
const vectors: Vectors = JSON.parse(
  readFileSync(path.join(__dirname, "..", "..", "src", "protocol", "test-vectors.json"), "utf-8")
)

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex")
const fromHex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "hex"))

// The vectors write bytes fields as hex strings
function withHexBytes(value: unknown): unknown {
  if (value instanceof Uint8Array) return hex(value)
  if (Array.isArray(value)) return value.map(withHexBytes)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, withHexBytes(field)]))
  }
  return value
}

const commandNames = Object.keys(CommandType) as CommandName[]
const spec = (name: string) =>
  Commands[name as CommandName] as { encode(request: unknown): Uint8Array; decode(payload: Uint8Array): unknown }

test("the vectors are the synced protocol's", () => {
  assert.equal(vectors.protocolVersion, PROTOCOL_VERSION)
})

describe("command specs", () => {
  test("every command has a spec with its generated ids", () => {
    assert.deepEqual(Object.keys(Commands).sort(), [...commandNames].sort())
    for (const name of commandNames) {
      assert.equal(Commands[name].name, name)
      assert.equal(Commands[name].command, CommandType[name], name)
      assert.equal(Commands[name].response, ResponseType[CommandResponse[name]], name)
    }
  })

  test("commands with no request fields send an empty payload", () => {
    const withFields = new Set(vectors.requests.map((v) => v.command))
    for (const name of commandNames.filter((n) => !withFields.has(n))) {
      assert.equal(spec(name).encode({}).length, 0, name)
    }
  })

  test("Ok is decoded as undefined (the client's void)", () => {
    assert.equal(Commands.RescanAssets.decode(new Uint8Array(0)), undefined)
  })

  test("an Error payload is the message as raw UTF-8", () => {
    const vector = vectors.responses.find((v) => v.response === "Error")!
    assert.equal(decodeError(fromHex(vector.payload)), vector.fields.message)
  })
})

describe("requests encode to the engine's vectors", () => {
  for (const vector of vectors.requests) {
    test(vector.command, () => {
      assert.equal(Commands[vector.command as CommandName].command, Number.parseInt(vector.id, 16))
      assert.equal(hex(spec(vector.command).encode(vector.fields)), vector.payload)
    })
  }
})

describe("responses decode to the engine's vectors", () => {
  for (const vector of vectors.responses) {
    // Ok and Error have no command of their own; AudioSamples is converted to float32 (below, and audio-stream.test)
    const name = commandNames.find((n) => CommandResponse[n] === vector.response)
    if (vector.response === "Ok" || vector.response === "Error" || vector.response === "AudioSamples") continue

    test(`${vector.response} (${name})`, () => {
      assert.ok(name, `a command answers with ${vector.response}`)
      assert.equal(Commands[name].response, Number.parseInt(vector.id, 16))
      // Decode a view with an offset into a larger buffer, as the socket's chunks are, with bytes after it
      const payload = fromHex(vector.payload)
      const padded = new Uint8Array(3 + payload.length + 4)
      padded.set(payload, 3)
      const decoded = spec(name).decode(padded.subarray(3, 3 + payload.length))
      assert.deepEqual(withHexBytes(decoded), vector.fields)
    })
  }

  test("AudioSamples: the generated decoder's fields, checked and converted to float32", () => {
    const vector = vectors.responses.find((v) => v.response === "AudioSamples")!
    // The vector's fields are placeholders (no real sample format), so the editor refuses them
    assert.throws(() => Commands.GetAudio.decode(fromHex(vector.payload)), /Unsupported audio sample format/)
  })

  test("a truncated payload throws instead of reading garbage", () => {
    const vector = vectors.responses.find((v) => v.response === "EntityList")!
    const payload = fromHex(vector.payload)
    assert.throws(() => Commands.GetAllEntities.decode(payload.subarray(0, payload.length - 1)), RangeError)
  })
})
