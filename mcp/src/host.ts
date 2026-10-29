// How the bridge reaches a host. A HostConnector opens one session (a connected EngineClient whose Hello succeeded);
// the bridge asks for a new one whenever the last one is gone. Two real connectors: `launch` (a host of its own, on a
// free loopback port, with a throwaway editor-role token) and `connect` (a remote or local host over TLS with a pinned
// fingerprint); `electron` (electron-backend.ts) is the person's open editor. Tests pass their own.
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { EngineClient } from "../../src/protocol/engine-client"
import type { ServerInfoResponse } from "../../src/protocol/protocol.generated"
import { HostProcess, type LaunchOptions, generateToken } from "../../src/main/host-launcher"
import { BridgeAdvice, BridgeError } from "./errors"
import type { Scrubber } from "./scrub"
import { BridgeName, BridgeVersion } from "./version"

/** One connected session with a host */
export interface HostLink {
  client: EngineClient
  info: ServerInfoResponse
}

export interface HostConnector {
  /** "launch", "connect" or a test's name: shown by n2_status */
  readonly kind: string
  /** Whether this connector's Hello says `yield` (protocol 1.22): the bridge gives way to people. Absent: no. */
  readonly yields?: boolean
  /**
   * The host puts irreversible operations to the person itself, in a dialog of its own (the --electron backend: the editor's
   * native dialog), so the bridge neither elicits nor takes --allow-irreversible for them: it only lets the command through
   */
  readonly confirmsNatively?: boolean
  /** Opens a session. Rejects with HostBusyError, HelloError, FingerprintMismatchError, a BridgeError or a socket error. */
  connect(): Promise<HostLink>
  /** Ends what the connector started (a launched host) and removes what it wrote. Synchronous: it runs as the process exits. */
  dispose(): void
}

export const ClientName = `${BridgeName} ${BridgeVersion}`

/** The user a launched host's one token belongs to (audit lines say user=n2-mcp) */
export const LaunchUser = "n2-mcp"

export interface ConnectBackendOptions {
  host: string
  port: number
  /** SHA-256 of the host's certificate: required, there is no trust on first use (nobody is at the prompt) */
  fingerprint: string
  token: string
  user?: string
  /** Say `yield` in Hello (default true; --no-yield turns it off) */
  yield?: boolean
}

/** A host over TLS with a pinned fingerprint */
export function connectConnector(options: ConnectBackendOptions): HostConnector {
  const yields = options.yield !== false
  return {
    kind: "connect",
    yields,
    async connect() {
      const client = new EngineClient()
      const info = await client.connect(options.host, options.port, {
        token: options.token,
        user: options.user,
        clientName: ClientName,
        tlsFingerprint: options.fingerprint,
        yield: yields,
      })
      return { client, info }
    },
    dispose() {
      // Nothing was started; the sockets are closed by the bridge
    },
  }
}

export interface LaunchBackendOptions {
  hostPath: string
  projectPath: string
  renderer?: string
  readyTimeoutMs?: number
  scrubber: Scrubber
  /** A test's fake child process spawner */
  spawn?: LaunchOptions["spawn"]
  log?: (message: string) => void
  /** Where the tokens file goes; defaults to a new folder in the OS temp folder */
  tempRoot?: string
  /** Say `yield` in Hello (default true; --no-yield turns it off) */
  yield?: boolean
}

/** The tokens file's entry for an editor named LaunchUser: the host keeps only the token's SHA-256 (TokenTable) */
export function tokensFileText(token: string, user: string = LaunchUser): string {
  const hash = createHash("sha256").update(token, "utf8").digest("hex")
  return JSON.stringify([{ user, role: "editor", hash: `sha256:${hash}` }])
}

/**
 * A host of the bridge's own: N2EditorHost --project <dir> --port 0 --tokens-file <temp file> --exit-on-stdin-eof, with
 * a fresh 256-bit token for one editor user, so the bridge's session is an editor's and never an admin's (the host's
 * --token-env token has every right). The token lives in this process and in the 0600 file's hash only; it is not in the
 * host's environment or arguments. The host outlives an idle disconnect (no --exit-on-disconnect: the bridge reconnects),
 * and ends when the bridge's stdin pipe to it closes, however the bridge dies.
 */
export function launchConnector(options: LaunchBackendOptions): HostConnector {
  let host: HostProcess | null = null
  let dir: string | null = null
  let token = ""
  let pending: Promise<HostProcess> | null = null
  const yields = options.yield !== false

  const start = async (): Promise<HostProcess> => {
    removeDir()
    dir = fs.mkdtempSync(path.join(options.tempRoot ?? os.tmpdir(), "n2-mcp-"))
    try {
      fs.chmodSync(dir, 0o700)
    } catch {
      // Windows has no such modes
    }
    token = generateToken()
    options.scrubber.addSecret(token)
    const file = path.join(dir, "tokens.json")
    fs.writeFileSync(file, tokensFileText(token), { mode: 0o600 })
    try {
      return await HostProcess.launch({
        hostPath: options.hostPath,
        projectDir: options.projectPath,
        renderer: options.renderer,
        tokensFile: file,
        exitOnDisconnect: false,
        token,
        readyTimeoutMs: options.readyTimeoutMs,
        spawn: options.spawn,
        onExit: (exit) => options.log?.(`the launched host exited (code ${exit.code}, signal ${exit.signal})`),
      })
    } catch (e) {
      options.log?.(`launching the host failed: ${e instanceof Error ? options.scrubber.message(e.message) : "unknown error"}`)
      removeDir()
      const reason = e instanceof Error ? options.scrubber.message(e.message, 600) : "unknown error"
      throw new BridgeError(
        "host_unavailable",
        "The bridge could not start N2EditorHost for the project.",
        BridgeAdvice.unavailable,
        reason,
        e
      )
    }
  }

  const removeDir = (): void => {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // best effort
      }
      dir = null
    }
  }

  return {
    kind: "launch",
    yields,
    async connect() {
      if (host && host.exited) host = null
      if (!host) {
        pending ??= start().finally(() => {
          pending = null
        })
        host = await pending
      }
      const client = new EngineClient()
      const info = await client.connect("127.0.0.1", host.port, { token, user: LaunchUser, clientName: ClientName, yield: yields })
      return { client, info }
    },
    dispose() {
      host?.kill()
      host = null
      removeDir()
    },
  }
}
