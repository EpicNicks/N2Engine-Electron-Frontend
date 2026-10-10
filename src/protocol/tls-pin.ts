// TLS with a pinned certificate fingerprint, for a direct connection to an N2EditorHost started with --tls. The host
// serves a self-signed certificate, so there is no chain to verify and no name to check: what authenticates the host is
// that its certificate's SHA-256 fingerprint is the one the user confirmed (trust on first use, see pin-store.ts) or
// typed in. Node's own checks are therefore switched off (rejectUnauthorized: false, checkServerIdentity) and the pin
// is the only check: it runs when the handshake completes, and the connection is reported as open (so Hello, and with
// it the access token, can be sent) only after it passed. Any other outcome destroys the socket. No dependency: node's
// tls module only. Node only, so it is unit tested against a local tls server.
import * as net from "net"
import * as tls from "tls"
import { normaliseFingerprint } from "./fingerprint"

export { formatFingerprint, isLoopbackHost, normaliseFingerprint } from "./fingerprint"

/** How long the TCP connect plus the TLS handshake may take before the attempt is dropped */
export const TlsHandshakeTimeoutMilliseconds = 10000

/** The certificate the host presented isn't the pinned one */
export class FingerprintMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string | null
  ) {
    super(
      actual === null
        ? "The host presented no certificate"
        : `The host's certificate (SHA-256 ${actual}) is not the pinned one (${expected})`
    )
    this.name = "FingerprintMismatchError"
  }
}

/** The normalised fingerprint of the certificate the peer presented, or null when it presented none */
export function peerFingerprint(socket: tls.TLSSocket): string | null {
  const certificate = socket.getPeerCertificate()
  if (!certificate || typeof certificate.fingerprint256 !== "string") return null
  return normaliseFingerprint(certificate.fingerprint256)
}

/** Throws a FingerprintMismatchError unless the peer's certificate has the (normalised) expected fingerprint */
export function checkPeerFingerprint(socket: tls.TLSSocket, expected: string): void {
  const actual = peerFingerprint(socket)
  if (actual === null || actual !== expected) throw new FingerprintMismatchError(expected, actual)
}

/** Starts a TLS connection with no verification of its own: whatever is presented is checked by the caller's pin */
function connectUnverified(host: string, port: number): tls.TLSSocket {
  return tls.connect({
    host,
    port,
    minVersion: "TLSv1.2",
    // The certificate is self-signed and named for nothing in particular: the pin is the identity check
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
  })
}

/** Destroys the socket with an error if the handshake isn't done in time; the returned function cancels that */
function armHandshakeTimeout(socket: net.Socket, ms: number, what: string): () => void {
  const timer = setTimeout(() => socket.destroy(new Error(`${what} timed out`)), ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export interface PinnedTlsOptions {
  host: string
  port: number
  /** The pinned SHA-256 fingerprint (any form normaliseFingerprint accepts) */
  fingerprint: string
  /** Default TlsHandshakeTimeoutMilliseconds */
  handshakeTimeoutMs?: number
}

/** Opens the connection; a parameter of EngineClient so tests can substitute a fake socket */
export type TlsSocketFactory = (options: PinnedTlsOptions, onConnect: () => void) => net.Socket

/**
 * Connects with TLS and pins the host's certificate: onConnect is called only once the handshake is done and the
 * peer's certificate has the pinned fingerprint. On a mismatch (or no certificate) the socket is destroyed with a
 * FingerprintMismatchError and onConnect is never called, so nothing is ever written to a host that isn't the pinned
 * one. Throws for a fingerprint that isn't a valid SHA-256 fingerprint.
 */
export const connectPinnedTls: TlsSocketFactory = (options, onConnect) => {
  const expected = normaliseFingerprint(options.fingerprint)
  if (expected === null) throw new Error("The pinned fingerprint isn't a SHA-256 fingerprint (64 hex digits)")
  const socket = connectUnverified(options.host, options.port)
  const cancel = armHandshakeTimeout(
    socket,
    options.handshakeTimeoutMs ?? TlsHandshakeTimeoutMilliseconds,
    "The TLS handshake"
  )
  socket.once("close", cancel)
  socket.once("secureConnect", () => {
    cancel()
    try {
      checkPeerFingerprint(socket, expected)
    } catch (e) {
      socket.destroy(e as Error)
      return
    }
    onConnect()
  })
  return socket
}

/**
 * The fingerprint of the certificate a host presents, for showing to the user who is deciding whether to trust it.
 * Nothing is sent: the connection is closed as soon as the handshake is done.
 */
export function fetchPeerFingerprint(
  host: string,
  port: number,
  timeoutMs: number = TlsHandshakeTimeoutMilliseconds
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connectUnverified(host, port)
    const cancel = armHandshakeTimeout(socket, timeoutMs, "The TLS handshake")
    socket.once("secureConnect", () => {
      cancel()
      const fingerprint = peerFingerprint(socket)
      socket.destroy()
      if (fingerprint === null) reject(new Error("The host presented no certificate"))
      else resolve(fingerprint)
    })
    socket.once("error", reject)
    socket.once("close", () => reject(new Error("Connection closed before the TLS handshake finished")))
  })
}
