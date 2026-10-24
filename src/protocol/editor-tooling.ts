// The editor tooling commands' answers (protocol 1.17.0: CheckLuaSyntax, GetAssetPreview), validated before anything
// uses them: the host is the authority on what a file is, this only makes sure what arrives has the shape (and the
// sizes) the page reads, so a wrong answer is an error and never a garbled picture or an out-of-range read.
import type { AssetPreviewResponse, AudioPeak, LuaSyntaxResponse, LuaSyntaxResult } from "./protocol.generated"

/** The largest edge or peak-bin count GetAssetPreview takes (maxSize is 1..256) */
export const MaxPreviewSize = 256

/** The protocol minor that added SetEditorViewOptions, CheckLuaSyntax and GetAssetPreview */
export const EditorToolingMinMinor = 17

/** Whether a host speaking this protocol version has the 1.17.0 editor tooling commands (never throws) */
export function hostHasEditorTooling(protocolVersion: unknown): boolean {
  const match = typeof protocolVersion === "string" ? /^(\d+)\.(\d+)\.(\d+)$/.exec(protocolVersion) : null
  if (!match) return false
  const major = Number(match[1])
  return major > 1 || (major === 1 && Number(match[2]) >= EditorToolingMinMinor)
}

export interface TexturePreview {
  kind: "texture"
  uuid: string
  path: string
  /** The file's modification time in Unix milliseconds, with which a client may cache */
  modified: number
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
  /** width x height RGBA8 pixels, top row first */
  pixels: Uint8Array
}

export interface AudioPreview {
  kind: "audio"
  uuid: string
  path: string
  modified: number
  durationMs: number
  channels: number
  sampleRate: number
  peaks: AudioPeak[]
}

export type AssetPreview = TexturePreview | AudioPreview

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value)

function requireCount(object: Record<string, unknown>, key: string, where: string): number {
  const value = object[key]
  if (!isCount(value)) throw new Error(`${where}: ${key} must be a non-negative whole number`)
  return value
}

function requireString(object: Record<string, unknown>, key: string, where: string): string {
  const value = object[key]
  if (typeof value !== "string") throw new Error(`${where}: ${key} must be a string`)
  return value
}

/** CheckLuaSyntax's answer: {ok, line, column?, message}; line 0 is "no line" */
export function parseLuaSyntax(response: LuaSyntaxResponse): LuaSyntaxResult {
  const where = "The Lua syntax result"
  const value: unknown = isObject(response) ? response.result : undefined
  if (!isObject(value)) throw new Error(`${where} must be an object`)
  if (typeof value.ok !== "boolean") throw new Error(`${where}: ok must be a boolean`)
  const line = requireCount(value, "line", where)
  const message = requireString(value, "message", where)
  const result: LuaSyntaxResult = { ok: value.ok, line, message }
  if (value.column !== undefined) result.column = requireCount(value, "column", where)
  return result
}

/** The size a preview may be asked for: a whole number from 1 to MaxPreviewSize */
export function checkPreviewSize(maxSize: unknown): number {
  if (typeof maxSize !== "number" || !Number.isInteger(maxSize) || maxSize < 1 || maxSize > MaxPreviewSize) {
    throw new Error(`The preview size must be a whole number from 1 to ${MaxPreviewSize}`)
  }
  return maxSize
}

/** GetAssetPreview's answer for a request of maxSize: a texture's pixels, or an audio clip's peaks */
export function parseAssetPreview(response: AssetPreviewResponse, maxSize: number): AssetPreview {
  const where = "The asset preview"
  const info: unknown = isObject(response) ? response.info : undefined
  if (!isObject(info)) throw new Error(`${where} must be an object`)
  const pixels: unknown = response.pixels
  if (!(pixels instanceof Uint8Array)) throw new Error(`${where}: pixels must be bytes`)
  const uuid = requireString(info, "uuid", where)
  const path = requireString(info, "path", where)
  const modified = requireCount(info, "modified", where)
  if (info.kind === "texture") {
    const width = requireCount(info, "width", where)
    const height = requireCount(info, "height", where)
    const sourceWidth = requireCount(info, "sourceWidth", where)
    const sourceHeight = requireCount(info, "sourceHeight", where)
    if (width < 1 || height < 1 || width > maxSize || height > maxSize) {
      throw new Error(`${where}: ${width}x${height} doesn't fit the requested ${maxSize}`)
    }
    if (width > sourceWidth || height > sourceHeight) throw new Error(`${where}: the preview is larger than the source`)
    if (pixels.length !== width * height * 4) {
      throw new Error(`${where}: ${pixels.length} bytes for a ${width}x${height} RGBA picture`)
    }
    return { kind: "texture", uuid, path, modified, width, height, sourceWidth, sourceHeight, pixels }
  }
  if (info.kind === "audio") {
    const durationMs = requireCount(info, "durationMs", where)
    const channels = requireCount(info, "channels", where)
    const sampleRate = requireCount(info, "sampleRate", where)
    if (pixels.length !== 0) throw new Error(`${where}: an audio preview has no pixels`)
    const rawPeaks = info.peaks
    if (!Array.isArray(rawPeaks)) throw new Error(`${where}: peaks must be an array`)
    if (rawPeaks.length > 2 * maxSize) throw new Error(`${where}: ${rawPeaks.length} peaks exceed the limit of ${2 * maxSize}`)
    const peaks = rawPeaks.map((peak: unknown, i) => {
      if (
        !isObject(peak) ||
        typeof peak.min !== "number" ||
        typeof peak.max !== "number" ||
        !Number.isFinite(peak.min) ||
        !Number.isFinite(peak.max) ||
        peak.min > peak.max
      ) {
        throw new Error(`${where}: peak ${i} must be a finite {min, max}`)
      }
      return { min: peak.min, max: peak.max }
    })
    return { kind: "audio", uuid, path, modified, durationMs, channels, sampleRate, peaks }
  }
  throw new Error(`${where}: unknown kind ${JSON.stringify(info.kind)}`)
}
