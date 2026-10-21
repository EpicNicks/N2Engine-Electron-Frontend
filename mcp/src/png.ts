// A PNG encoder with no dependency but Node's zlib (design 3.5). The host's frames are RGBA8 with alpha 255, so the
// picture is written as 8-bit RGB (a quarter smaller); each row uses the Sub filter, which compresses flat renders
// well. encodePng and decodePngRgb (for the tests' round trip) are the whole module.
import { crc32, deflateSync, inflateSync } from "node:zlib"

const Signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, "latin1")
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length)
  return out
}

/** The PNG of RGBA8 pixels (top row first); the alpha channel is dropped (frames are opaque) */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("PNG size must be positive integers")
  }
  if (rgba.length !== width * height * 4) throw new Error("PNG pixel data does not match the size")
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 1 // Sub: each byte minus the one a pixel to the left
    let src = y * width * 4
    for (let x = 0; x < width; x++, src += 4) {
      for (let c = 0; c < 3; c++) {
        const left = x === 0 ? 0 : rgba[src - 4 + c]
        raw[rowStart + 1 + x * 3 + c] = (rgba[src + c] - left) & 0xff
      }
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // truecolour (RGB)
  return Buffer.concat([
    Signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/** Decodes a PNG written by encodePng (RGB, Sub or None filters): for the tests' round trip */
export function decodePngRgb(png: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  const buffer = Buffer.from(png)
  if (!buffer.subarray(0, 8).equals(Signature)) throw new Error("Not a PNG")
  let offset = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString("latin1", offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (buffer.readUInt32BE(offset + 8 + length) !== crc32(buffer.subarray(offset + 4, offset + 8 + length)) >>> 0) {
      throw new Error(`Bad CRC in ${type}`)
    }
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 2) throw new Error("Only 8-bit RGB is supported")
    } else if (type === "IDAT") idat.push(data)
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 3
  const rgb = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let i = 0; i < stride; i++) {
      const value = raw[y * (stride + 1) + 1 + i]
      const left = filter === 1 && i >= 3 ? rgb[y * stride + i - 3] : 0
      if (filter !== 0 && filter !== 1) throw new Error("Unsupported filter")
      rgb[y * stride + i] = (value + left) & 0xff
    }
  }
  return { width, height, rgb }
}

/** The size that fits the longest side into maxSide, keeping the aspect ratio (never larger than asked) */
export function fitSize(width: number, height: number, maxSide: number): { width: number; height: number; scaled: boolean } {
  const longest = Math.max(width, height)
  if (longest <= maxSide) return { width, height, scaled: false }
  const factor = maxSide / longest
  return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)), scaled: true }
}
