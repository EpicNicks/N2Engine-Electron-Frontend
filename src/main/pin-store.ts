// The pinned TLS fingerprints of direct-address remote engines (trust on first use), in a JSON file in the app's user
// data folder: host:port -> the SHA-256 fingerprint the user confirmed, and when it was first seen. Nothing secret
// (the access token is never saved). A pin is never replaced silently: a host whose certificate changed is refused
// until the user forgets the pin and confirms the new fingerprint. Node only, so it is unit tested.
import * as fs from "fs"
import * as path from "path"
import { normaliseFingerprint } from "../protocol/tls-pin"
import type { PinInspection } from "../shared/api"

export interface Pin {
  /** 64 lowercase hex digits */
  fingerprint: string
  /** ISO 8601 time of the first connect the user confirmed */
  firstSeen: string
}

/** The key a pin is stored under: the host (lower-cased; an IPv6 address in brackets) and the port */
export function pinKey(host: string, port: number): string {
  const name = host.toLowerCase()
  return `${name.includes(":") ? `[${name}]` : name}:${port}`
}

export class PinStore {
  constructor(private readonly file: string) {}

  /** The pin for host:port, or undefined (also for a file that is missing or unreadable, or a malformed entry) */
  get(host: string, port: number): Pin | undefined {
    return this.read()[pinKey(host, port)]
  }

  /**
   * Pins the fingerprint for host:port, with the time it is first seen. Pinning what is already pinned keeps the
   * original time; a different fingerprint is refused (forget the pin first): a pin never changes by itself.
   */
  pin(host: string, port: number, fingerprint: string, now: Date = new Date()): Pin {
    const normalised = normaliseFingerprint(fingerprint)
    if (normalised === null) throw new Error("Not a SHA-256 fingerprint (64 hex digits)")
    const pins = this.read()
    const key = pinKey(host, port)
    const existing = pins[key]
    if (existing) {
      if (existing.fingerprint === normalised) return existing
      throw new Error(`${key} is already pinned to a different fingerprint: forget the pin first`)
    }
    const pin: Pin = { fingerprint: normalised, firstSeen: now.toISOString() }
    pins[key] = pin
    this.write(pins)
    return pin
  }

  /** Removes the pin for host:port (the next connect asks the user to confirm the fingerprint again) */
  forget(host: string, port: number): void {
    const pins = this.read()
    const key = pinKey(host, port)
    if (!(key in pins)) return
    delete pins[key]
    this.write(pins)
  }

  private read(): Record<string, Pin> {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf-8"))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("Error reading pinned fingerprints:", err)
      return {}
    }
    const pins: Record<string, Pin> = {}
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return pins
    for (const [key, value] of Object.entries(parsed)) {
      // Re-validated on every read: the file is the user's to edit
      if (typeof value !== "object" || value === null) continue
      const { fingerprint, firstSeen } = value as Record<string, unknown>
      const normalised = normaliseFingerprint(fingerprint)
      if (normalised === null || typeof firstSeen !== "string") continue
      pins[key] = { fingerprint: normalised, firstSeen }
    }
    return pins
  }

  private write(pins: Record<string, Pin>): void {
    // Not best-effort: a pin that wasn't saved must not look as if it was, so a failure is thrown to the caller
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(pins, null, 1))
    fs.renameSync(temporary, this.file)
  }
}

/** What a presented fingerprint means for host:port, given what is pinned: for the connect form to show */
export function inspectPin(store: Pick<PinStore, "get">, host: string, port: number, presented: string): PinInspection {
  const pinned = store.get(host, port)
  if (!pinned) return { kind: "unknown", fingerprint: presented }
  if (pinned.fingerprint === presented) return { kind: "trusted", fingerprint: presented }
  return { kind: "changed", fingerprint: presented, pinned: pinned.fingerprint, firstSeen: pinned.firstSeen }
}
