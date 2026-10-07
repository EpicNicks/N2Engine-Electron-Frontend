import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { FrameReader, FrameTooLargeError, Frame } from "../protocol/framing"
import { FRAME_HEADER_BYTES as HeaderBytes, encodeFrame as encodeGeneratedFrame } from "../protocol/protocol.generated"

/** A frame as a Buffer, as the socket delivers it */
const encodeFrame = (type: number, payload: Uint8Array): Buffer => Buffer.from(encodeGeneratedFrame(type, payload))

/** A payload whose bytes depend on seed and position, so misordered or shifted bytes are caught */
function payload(length: number, seed: number): Buffer {
  const b = Buffer.allocUnsafe(length)
  for (let i = 0; i < length; i++) {
    b[i] = (i * 31 + seed * 7) & 0xff
  }
  return b
}

/** Splits data into chunks of the given sizes (cycled) */
function split(data: Buffer, sizes: number[]): Buffer[] {
  const chunks: Buffer[] = []
  let offset = 0
  let i = 0
  while (offset < data.length) {
    const size = sizes[i++ % sizes.length]
    chunks.push(data.subarray(offset, offset + size))
    offset += size
  }
  return chunks
}

function feed(reader: FrameReader, chunks: Buffer[]): Frame[] {
  return chunks.flatMap((chunk) => reader.push(chunk))
}

function assertFrames(actual: Frame[], expected: Array<{ type: number; payload: Buffer }>): void {
  assert.equal(actual.length, expected.length, "frame count")
  actual.forEach((frame, i) => {
    assert.equal(frame.type, expected[i].type, `frame ${i} type`)
    assert.ok(frame.payload.equals(expected[i].payload), `frame ${i} payload`)
  })
}

describe("FrameReader", () => {
  test("one frame in one chunk is returned as a view, without copying", () => {
    const reader = new FrameReader()
    const data = encodeFrame(0x02, payload(100, 1))
    const frames = reader.push(data)
    assertFrames(frames, [{ type: 0x02, payload: payload(100, 1) }])
    assert.equal(frames[0].payload.buffer, data.buffer)
    assert.equal(reader.bufferedBytes, 0)
  })

  test("a header split across chunks, byte by byte", () => {
    const reader = new FrameReader()
    const data = encodeFrame(0x07, payload(10, 2))
    const frames = feed(reader, split(data, [1]))
    assertFrames(frames, [{ type: 0x07, payload: payload(10, 2) }])
  })

  test("a header split at every position", () => {
    const data = encodeFrame(0x05, payload(20, 3))
    for (let cut = 1; cut < HeaderBytes + 20; cut++) {
      const reader = new FrameReader()
      assert.deepEqual(reader.push(data.subarray(0, cut)), [], `nothing before the frame is complete (cut ${cut})`)
      const frames = reader.push(data.subarray(cut))
      assertFrames(frames, [{ type: 0x05, payload: payload(20, 3) }])
    }
  })

  test("many frames in one chunk, including empty payloads", () => {
    const expected = Array.from({ length: 50 }, (_, i) => ({
      type: i % 11,
      payload: payload(i % 4 === 0 ? 0 : i * 3, i),
    }))
    const data = Buffer.concat(expected.map((f) => encodeFrame(f.type, f.payload)))
    const reader = new FrameReader()
    assertFrames(reader.push(data), expected)
    assert.equal(reader.bufferedBytes, 0)
  })

  test("frames straddling chunk boundaries at irregular sizes", () => {
    const expected = Array.from({ length: 30 }, (_, i) => ({ type: 0x01 + (i % 3), payload: payload(i * 17 + 1, i) }))
    const data = Buffer.concat(expected.map((f) => encodeFrame(f.type, f.payload)))
    for (const sizes of [[1], [2, 3], [7], [4, 1, 9, 100], [5], [6]]) {
      const reader = new FrameReader()
      assertFrames(feed(reader, split(data, sizes)), expected)
      assert.equal(reader.bufferedBytes, 0, `nothing left over (sizes ${sizes})`)
    }
  })

  test("a 3.7 MB frame in 64 KB chunks arrives intact, once", () => {
    const big = payload(1280 * 720 * 4, 9) // 3,686,400 bytes: a 720p RGBA viewport frame
    const data = Buffer.concat([encodeFrame(0x02, big), encodeFrame(0x00, Buffer.alloc(0))])
    const reader = new FrameReader()
    const chunks = split(data, [64 * 1024])

    const frames: Frame[] = []
    chunks.forEach((chunk, i) => {
      const got = reader.push(chunk)
      if (i < chunks.length - 1) assert.equal(got.length, 0, `no frame before the last chunk (chunk ${i})`)
      frames.push(...got)
    })
    assertFrames(frames, [
      { type: 0x02, payload: big },
      { type: 0x00, payload: Buffer.alloc(0) },
    ])
  })

  test("a large frame in byte-sized chunks stays linear (no quadratic re-concatenation)", () => {
    // 1 MB in 1-byte chunks: re-concatenating the buffer on every chunk would copy ~500 GB and never finish
    const big = payload(1024 * 1024, 4)
    const data = encodeFrame(0x02, big)
    const reader = new FrameReader()
    const started = Date.now()
    let frames: Frame[] = []
    for (let i = 0; i < data.length; i++) {
      frames = frames.concat(reader.push(data.subarray(i, i + 1)))
    }
    assertFrames(frames, [{ type: 0x02, payload: big }])
    assert.ok(Date.now() - started < 10000, "finishes quickly")
  })

  test("a frame claiming more than the limit is rejected", () => {
    const reader = new FrameReader(1000)
    const header = Buffer.alloc(HeaderBytes)
    header.writeUInt8(0x02, 0)
    header.writeUInt32LE(1001, 1)
    assert.throws(() => reader.push(header), FrameTooLargeError)
  })

  test("reset drops a partial frame", () => {
    const reader = new FrameReader()
    reader.push(encodeFrame(0x03, payload(12, 1)).subarray(0, 8))
    assert.equal(reader.bufferedBytes, 8)
    reader.reset()
    assert.equal(reader.bufferedBytes, 0)
    assertFrames(reader.push(encodeFrame(0x04, payload(3, 2))), [{ type: 0x04, payload: payload(3, 2) }])
  })
})
