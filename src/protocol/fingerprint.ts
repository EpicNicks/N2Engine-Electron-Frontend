// Certificate fingerprints and loopback addresses: pure string functions, shared by the main process (the pin check)
// and the page (the connect form), so no node modules here. Unit tested.

const HexFingerprint = /^[0-9a-f]{64}$/
const ColonFingerprint = /^(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/

/**
 * A SHA-256 fingerprint as 64 lowercase hex digits with no separators (the form the engine's ready line prints), or
 * null when the text isn't one. Accepts what node prints (upper-case pairs joined by colons) and surrounding spaces;
 * a partial, over-long or oddly separated value is refused, never trimmed or padded to fit.
 */
export function normaliseFingerprint(value: unknown): string | null {
  if (typeof value !== "string") return null
  const text = value.trim().toLowerCase()
  if (HexFingerprint.test(text)) return text
  if (ColonFingerprint.test(text)) return text.replace(/:/g, "")
  return null
}

/** A fingerprint in groups of 4 for showing to a person who compares it with another source */
export function formatFingerprint(fingerprint: string): string {
  return (fingerprint.match(/.{1,4}/g) ?? []).join(" ")
}

const LoopbackIpv4 = /^127(?:\.\d{1,3}){3}$/

/** Whether the host is this computer's loopback ("localhost", 127.x.x.x, ::1): the only place plaintext is allowed */
export function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase()
  return name === "localhost" || name === "::1" || name === "0:0:0:0:0:0:0:1" || LoopbackIpv4.test(name)
}
