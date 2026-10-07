// Reading frames off the socket: every message, both ways, is [type: uint8][payloadLength: uint32 LE][payload].
// Writing one is the generated encodeFrame. No DOM or Electron dependencies, so it is unit tested in Node.
import { FRAME_HEADER_BYTES as HeaderBytes } from "./protocol.generated"

/** A complete frame off the wire */
export interface Frame {
  type: number
  /** The payload only (no header) */
  payload: Buffer
}

/**
 * Frames larger than this are treated as a corrupt stream. The biggest legitimate frame is a viewport frame
 * (MaxViewportDimension squared, RGBA), well under this.
 */
export const DefaultMaxPayloadBytes = 256 * 1024 * 1024

export class FrameTooLargeError extends Error {
  constructor(
    readonly type: number,
    readonly payloadLength: number,
    readonly maxPayloadBytes: number
  ) {
    super(`Frame type 0x${type.toString(16)} claims ${payloadLength} payload bytes (the limit is ${maxPayloadBytes})`)
  }
}

/**
 * Splits a byte stream into frames. Chunks are kept in a list and only copied once a whole frame has arrived,
 * so a frame that arrives in n chunks costs O(frame size) rather than the O(n * buffered size) of concatenating
 * every chunk onto the buffer. A frame that lies entirely inside one chunk is returned as a view of that chunk
 * without copying.
 */
export class FrameReader {
  private chunks: Buffer[] = []
  /** chunks[head] is the first with unconsumed bytes (consumed chunks are dropped in batches, not shifted one by one) */
  private head = 0
  /** Bytes of chunks[head] already consumed */
  private headOffset = 0
  /** Unconsumed bytes across all chunks */
  private buffered = 0
  /** The header of the frame being waited for, once all of it has arrived */
  private pending: { type: number; payloadLength: number } | null = null

  constructor(private readonly maxPayloadBytes: number = DefaultMaxPayloadBytes) {}

  /** Bytes of the partial frame received so far (header included) */
  get bufferedBytes(): number {
    return this.buffered + (this.pending === null ? 0 : HeaderBytes)
  }

  /**
   * Adds a chunk and returns every frame it completes, in order. Throws FrameTooLargeError for a frame over the
   * limit; the reader is then unusable (call reset) since the stream can't be resynchronised.
   */
  push(chunk: Buffer): Frame[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk)
      this.buffered += chunk.length
    }

    const frames: Frame[] = []
    while (true) {
      if (this.pending === null) {
        if (this.buffered < HeaderBytes) break
        const header = this.take(HeaderBytes)
        const payloadLength = header.readUInt32LE(1)
        if (payloadLength > this.maxPayloadBytes) {
          throw new FrameTooLargeError(header.readUInt8(0), payloadLength, this.maxPayloadBytes)
        }
        this.pending = { type: header.readUInt8(0), payloadLength }
      }

      if (this.buffered < this.pending.payloadLength) break
      frames.push({ type: this.pending.type, payload: this.take(this.pending.payloadLength) })
      this.pending = null
    }
    return frames
  }

  /** Drops everything buffered (a partial frame from a dropped connection) */
  reset(): void {
    this.chunks = []
    this.head = 0
    this.headOffset = 0
    this.buffered = 0
    this.pending = null
  }

  /** Removes the next count bytes (count <= buffered): a view when they're within one chunk, else one copy */
  private take(count: number): Buffer {
    this.buffered -= count
    if (count === 0) return Buffer.alloc(0)

    const first = this.chunks[this.head]
    if (count <= first.length - this.headOffset) {
      const result = first.subarray(this.headOffset, this.headOffset + count)
      this.advanceHead(count)
      return result
    }

    const result = Buffer.allocUnsafe(count)
    let written = 0
    while (written < count) {
      const chunk = this.chunks[this.head]
      const n = Math.min(count - written, chunk.length - this.headOffset)
      chunk.copy(result, written, this.headOffset, this.headOffset + n)
      written += n
      this.advanceHead(n)
    }
    return result
  }

  private advanceHead(count: number): void {
    this.headOffset += count
    if (this.headOffset === this.chunks[this.head].length) {
      this.head++
      this.headOffset = 0
      if (this.head === this.chunks.length) {
        this.chunks = []
        this.head = 0
      } else if (this.head >= 64 && this.head * 2 >= this.chunks.length) {
        this.chunks = this.chunks.slice(this.head)
        this.head = 0
      }
    }
  }
}
