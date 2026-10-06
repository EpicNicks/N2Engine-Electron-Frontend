// Little-endian field encoding shared by every command: uint8/uint32/int32/float32/bool, length-prefixed UTF-8
// strings and vec3s, as protocol.json specifies.

import { Vec3 } from "./protocol.generated"

/** Builds a payload field by field */
export class PayloadWriter {
  private parts: Buffer[] = []

  uint8(value: number): this {
    const b = Buffer.allocUnsafe(1)
    b.writeUInt8(value, 0)
    return this.push(b)
  }

  bool(value: boolean): this {
    return this.uint8(value ? 1 : 0)
  }

  uint32(value: number): this {
    const b = Buffer.allocUnsafe(4)
    b.writeUInt32LE(value, 0)
    return this.push(b)
  }

  int32(value: number): this {
    const b = Buffer.allocUnsafe(4)
    b.writeInt32LE(value, 0)
    return this.push(b)
  }

  float32(value: number): this {
    const b = Buffer.allocUnsafe(4)
    b.writeFloatLE(value, 0)
    return this.push(b)
  }

  string(value: string): this {
    const bytes = Buffer.from(value, "utf-8")
    return this.uint32(bytes.length).push(bytes)
  }

  vec3(value: Vec3): this {
    return this.float32(value.x).float32(value.y).float32(value.z)
  }

  finish(): Buffer {
    return this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts)
  }

  private push(b: Buffer): this {
    this.parts.push(b)
    return this
  }
}

/** Reads a payload field by field; reading past the end throws rather than returning garbage */
export class PayloadReader {
  private offset = 0

  constructor(
    private readonly payload: Buffer,
    private readonly what: string = "payload"
  ) {}

  get remaining(): number {
    return this.payload.length - this.offset
  }

  uint8(): number {
    return this.payload.readUInt8(this.advance(1, "uint8"))
  }

  bool(): boolean {
    return this.uint8() !== 0
  }

  uint32(): number {
    return this.payload.readUInt32LE(this.advance(4, "uint32"))
  }

  int32(): number {
    return this.payload.readInt32LE(this.advance(4, "int32"))
  }

  float32(): number {
    return this.payload.readFloatLE(this.advance(4, "float32"))
  }

  string(): string {
    const length = this.uint32()
    const start = this.advance(length, "string")
    return this.payload.toString("utf-8", start, start + length)
  }

  vec3(): Vec3 {
    return { x: this.float32(), y: this.float32(), z: this.float32() }
  }

  /** Everything left (a trailing bytes field) */
  rest(): Buffer {
    return this.payload.subarray(this.advance(this.remaining, "bytes"))
  }

  private advance(count: number, field: string): number {
    if (this.offset + count > this.payload.length) {
      throw new Error(`${this.what} too short for a ${field} at byte ${this.offset} (${this.payload.length} bytes)`)
    }
    const start = this.offset
    this.offset += count
    return start
  }
}
