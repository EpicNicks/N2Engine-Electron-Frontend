// Direct-address remote mode: the editor connects straight to an N2EditorHost's address (host and port), with TLS
// (--tls, a self-signed certificate pinned by its fingerprint) or, only to this computer's loopback, without. The
// settings are validated here before anything is opened: the page's input is never passed on unchecked. Plaintext to
// any other address is refused: the access token and the project would cross the network in the clear. Node only, so
// it is unit tested.
import { isLoopbackHost, normaliseFingerprint } from "../protocol/tls-pin"
import type { DirectRemoteSettings } from "../shared/api"
import { pinKey } from "./pin-store"
import type { Pin } from "./pin-store"

const MaxHostLength = 253
const HostNamePattern = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
// An IPv6 address (hex digits, at least two colons; no brackets, no zone)
const Ipv6Pattern = /^(?=(?:[^:]*:){2,})[0-9A-Fa-f:.]+$/

/** Why this isn't a host name or IP address to connect to, or null */
export function hostProblem(host: unknown): string | null {
  if (typeof host !== "string" || host.trim() === "") return "Enter the host's address"
  if (host.length > MaxHostLength) return "The host's address is too long"
  if (!(HostNamePattern.test(host) || Ipv6Pattern.test(host))) {
    return "The host's address has characters addresses don't (give it without a port or brackets)"
  }
  return null
}

/** The settings from a value that came from the page: a fresh object with only the known fields, or an Error */
export function parseDirectRemoteSettings(value: unknown): DirectRemoteSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid remote settings")
  const input = value as Record<string, unknown>
  const host = typeof input.host === "string" ? input.host.trim().toLowerCase() : input.host
  const problem = hostProblem(host)
  if (problem) throw new Error(problem)
  const port = input.port
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("The host's port must be a whole number from 1 to 65535")
  }
  if (typeof input.tls !== "boolean") throw new Error("Invalid remote settings")
  if (!input.tls && !isLoopbackHost(host as string)) {
    throw new Error(
      "TLS is required for a host that isn't on this computer: the access token and the project would cross the network in the clear"
    )
  }
  const settings: DirectRemoteSettings = { host: host as string, port, tls: input.tls }
  if (input.fingerprint !== undefined && input.fingerprint !== null && input.fingerprint !== "") {
    const fingerprint = normaliseFingerprint(input.fingerprint)
    if (fingerprint === null) throw new Error("The fingerprint must be a SHA-256 fingerprint: 64 hex digits")
    if (!input.tls) throw new Error("A fingerprint needs TLS")
    settings.fingerprint = fingerprint
  }
  return settings
}

/** A short name for the remote, for the toolbar: host:port */
export function describeDirect(settings: Pick<DirectRemoteSettings, "host" | "port">): string {
  return pinKey(settings.host, settings.port)
}

/**
 * The fingerprint a TLS connection must present: the one the user typed or confirmed (settings.fingerprint), else the
 * stored pin. Never "whatever the host presents": with neither, or with a typed one that differs from the stored pin,
 * this throws, so a host is only ever trusted by an explicit act (confirming its fingerprint, or forgetting a pin).
 */
export function requiredFingerprint(settings: DirectRemoteSettings, pinned: Pin | undefined): string {
  const label = describeDirect(settings)
  if (pinned && settings.fingerprint && pinned.fingerprint !== settings.fingerprint) {
    throw new Error(
      `The fingerprint given for ${label} (${settings.fingerprint}) is not the one pinned for it (${pinned.fingerprint}). ` +
        "If the host's certificate was replaced on purpose, press Forget pin and confirm the new fingerprint"
    )
  }
  const required = settings.fingerprint ?? pinned?.fingerprint
  if (!required) {
    throw new Error(`The certificate of ${label} hasn't been confirmed: check its fingerprint and confirm it first`)
  }
  return required
}

/** The error for a certificate that isn't the expected one, naming both fingerprints and how to reset */
export function describeMismatch(label: string, expected: string, actual: string | null, pinned: boolean): string {
  const presented = actual === null ? "no certificate" : `a certificate with fingerprint ${actual}`
  const advice = pinned
    ? "If the host's certificate was replaced on purpose, press Forget pin and confirm the new fingerprint; otherwise do not connect: this may not be your host"
    : "Check the fingerprint you entered; if it is right, this may not be your host"
  return `${label} presented ${presented}, not the expected ${expected}. ${advice}`
}
