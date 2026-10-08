// One spec per command, built from the generated codecs (protocol.generated.ts, generated from the engine's
// protocol.json by npm run sync-protocol): EngineClient sends spec.command with spec.encode(request) and decodes the
// reply with spec.decode. Nothing here knows a payload layout, and a command added to protocol.json gets its spec
// when the protocol is synced. (The exceptions are decoders the generated ones can't be: GetAudio's samples, and a
// text file's text with its byte order mark.)

import {
  CommandResponse,
  CommandType,
  RequestCodecs,
  ResponseCodecs,
  ResponseType,
  ReadTextAssetRequest,
  TextDataResponse,
  decodeErrorResponse,
} from "./protocol.generated"
import { AudioSamples, decodeAudioSamples } from "../audio-stream"

/** A request with no fields */
export type Empty = Record<string, never>

/** One command: its id, the response type it succeeds with, and how each side's payload is laid out */
export interface CommandSpec<Request, Response> {
  name: string
  command: CommandType
  response: ResponseType
  encode(request: Request): Uint8Array
  decode(payload: Uint8Array): Response
}

export type CommandName = keyof typeof CommandType

/** A command's request: its generated request type, or Empty when it has no fields */
export type RequestOf<C extends CommandName> = C extends keyof typeof RequestCodecs
  ? Parameters<(typeof RequestCodecs)[C]["encode"]>[0]
  : Empty

/** A command's decoded success response: void for Ok, which has no fields */
export type ResponseOf<C extends CommandName> = (typeof CommandResponse)[C] extends "Ok"
  ? void
  : ReturnType<(typeof ResponseCodecs)[(typeof CommandResponse)[C]]["decode"]>

type GeneratedSpecs = { [C in CommandName]: CommandSpec<RequestOf<C>, ResponseOf<C>> }

const noPayload = (): Uint8Array => new Uint8Array(0)
const ok = (): void => undefined

function generatedSpec(name: CommandName): CommandSpec<unknown, unknown> {
  const requestCodecs: Partial<Record<string, { encode(request: never): Uint8Array }>> = RequestCodecs
  const response = CommandResponse[name]
  return {
    name,
    command: CommandType[name],
    response: ResponseType[response],
    encode: (requestCodecs[name]?.encode ?? noPayload) as (request: unknown) => Uint8Array,
    decode: response === "Ok" ? ok : ResponseCodecs[response].decode,
  }
}

const generated = Object.fromEntries(
  (Object.keys(CommandType) as CommandName[]).map((name) => [name, generatedSpec(name)])
) as GeneratedSpecs

/** An Error response's payload is the message as raw UTF-8 (no length prefix), the documented special case */
export function decodeError(payload: Uint8Array): string {
  return decodeErrorResponse(payload).message
}

const keepBomDecoder = new TextDecoder("utf-8", { ignoreBOM: true })

/** TextData's payload: the text as a uint32-length-prefixed string, its byte order mark kept */
export function decodeTextData(payload: Uint8Array): TextDataResponse {
  if (payload.length < 4) throw new Error("TextData: the payload is too short for its text's length")
  const length = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true)
  if (length > payload.length - 4) throw new Error(`TextData: the text claims ${length} bytes, ${payload.length - 4} follow`)
  return { text: keepBomDecoder.decode(payload.subarray(4, 4 + length)) }
}

export const Commands = {
  ...generated,
  // The samples arrive as int16 or float32 bytes; the editor wants them as float32 in [-1, 1], checked against the
  // header
  GetAudio: { ...generated.GetAudio, decode: decodeAudioSamples } satisfies CommandSpec<Empty, AudioSamples>,
  // A text file's byte order mark is part of its text, and the generated string reader drops one (TextDecoder's default),
  // which would take it off a file the editor then saves
  ReadTextAsset: { ...generated.ReadTextAsset, decode: decodeTextData } satisfies CommandSpec<
    ReadTextAssetRequest,
    TextDataResponse
  >,
}
