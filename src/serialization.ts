export function writeString(buf: Buffer, offset: number, value: string): number {
  const bytes = Buffer.from(value, "utf-8")
  buf.writeUInt32LE(bytes.length, offset)
  bytes.copy(buf, offset + 4)
  return offset + 4 + bytes.length
}

export function readString(buf: Buffer, offset: number): { value: string; offset: number } {
  const len = buf.readUInt32LE(offset)
  const start = offset + 4
  const end = start + len
  return {
    value: buf.subarray(start, end).toString("utf-8"),
    offset: end,
  }
}
