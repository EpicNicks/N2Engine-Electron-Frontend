// Remote engine mode, phase 1 (frontend issue #21): the editor reaches an N2EditorHost that is already running on
// another machine through a tunnel made by the system's ssh:
//
//   ssh -N -L 127.0.0.1:<localPort>:127.0.0.1:<hostPort> -p <port> -i <identity> -- user@host
//
// The remote host stays bound to loopback; only sshd is exposed. The editor then connects to 127.0.0.1:<localPort>
// and says Hello with the host's access token, as it does with a local host. The token is never part of anything in
// this file: not an argument, not the environment, not a log line (the session passes it to the engine connection).
//
// Everything that decides what ssh is started with is here, in small pure functions, because an address typed by a
// user must not be able to become an ssh option: ssh is spawned without a shell, with the arguments as an array, and
// every value is validated first (a value starting with "-" is refused, and "--" ends ssh's options before the
// destination). Node only (no Electron), so it is unit tested with fakes.
import { ChildProcess, SpawnOptions, spawn as nodeSpawn } from "child_process"
import * as net from "net"
import { HostExit, LineSplitter, describeExit } from "./host-launcher"

/** What the user types for a remote engine, without the token (these are saved as recent remotes) */
export interface RemoteSettings {
  /** user@host */
  target: string
  /** ssh's port (-p); undefined: ssh's own default (22, or what ~/.ssh/config says) */
  sshPort?: number
  /** The private key file (-i); undefined: the ssh agent, the default keys, and ~/.ssh/config */
  identityFile?: string
  /** The port the remote N2EditorHost listens on (its --port) */
  hostPort: number
}

const MaxFieldLength = 256

const UserPattern = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
// A host name or an IPv4 address, or an IPv6 address (hex digits, colons and dots; no brackets needed for ssh)
const HostNamePattern = /^[A-Za-z0-9][A-Za-z0-9.-]*$/
const Ipv6Pattern = /^[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*$/

/** Why this isn't a user@host ssh may be given, or null. A leading "-" is refused so it can't be read as an option. */
export function targetProblem(target: unknown): string | null {
  if (typeof target !== "string" || target.trim() === "") return "Enter the SSH address as user@host"
  if (target.length > MaxFieldLength) return "The SSH address is too long"
  if (target.startsWith("-")) return "The SSH address can't start with '-'"
  const at = target.indexOf("@")
  if (at < 1 || at !== target.lastIndexOf("@") || at === target.length - 1) return "Enter the SSH address as user@host"
  const user = target.slice(0, at)
  const host = target.slice(at + 1)
  if (!UserPattern.test(user)) return "The SSH user has characters ssh addresses don't"
  if (!(HostNamePattern.test(host) || Ipv6Pattern.test(host))) return "The SSH host has characters host names don't"
  return null
}

/** Why this isn't a TCP port, or null */
export function portProblem(port: unknown, what: string): string | null {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535
    ? null
    : `${what} must be a whole number from 1 to 65535`
}

/** Why this isn't an identity file path ssh may be given, or null */
export function identityProblem(file: unknown): string | null {
  if (typeof file !== "string" || file === "") return "The identity file is empty"
  if (file.length > 1024) return "The identity file's path is too long"
  if (file.startsWith("-")) return "The identity file's path can't start with '-'"
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(file)) return "The identity file's path has control characters"
  return null
}

/**
 * The settings from a value that came from the page or a file: a fresh object with only the known fields, or an Error
 * saying what is wrong. Empty optional fields (null, undefined, "") are no setting.
 */
export function parseRemoteSettings(value: unknown): RemoteSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid remote settings")
  const input = value as Record<string, unknown>
  const target = typeof input.target === "string" ? input.target.trim() : input.target
  const problem = targetProblem(target)
  if (problem) throw new Error(problem)
  const hostPortProblem = portProblem(input.hostPort, "The host's port")
  if (hostPortProblem) throw new Error(hostPortProblem)
  const settings: RemoteSettings = { target: target as string, hostPort: input.hostPort as number }
  if (input.sshPort !== undefined && input.sshPort !== null && input.sshPort !== "") {
    const sshProblem = portProblem(input.sshPort, "The SSH port")
    if (sshProblem) throw new Error(sshProblem)
    settings.sshPort = input.sshPort as number
  }
  const file = typeof input.identityFile === "string" ? input.identityFile.trim() : input.identityFile
  if (file !== undefined && file !== null && file !== "") {
    const identity = identityProblem(file)
    if (identity) throw new Error(identity)
    settings.identityFile = file as string
  }
  return settings
}

/** A short name for the remote, for the toolbar and the recent list: user@host:hostPort */
export function describeRemote(settings: RemoteSettings): string {
  return `${settings.target}:${settings.hostPort}`
}

/** How long ssh gets to connect and authenticate (-o ConnectTimeout) */
export const SshConnectTimeoutSeconds = 15

/** ssh sends a keepalive this often (s) and exits after 3 unanswered, so a dead connection ends the tunnel (and is shown) */
export const SshServerAliveIntervalSeconds = 15

/** How many of ssh's last stderr lines a failure message quotes */
const QuotedLines = 8

/** The options ssh is started with; throws for settings parseRemoteSettings would refuse */
export function buildSshArgs(settings: RemoteSettings, localPort: number): string[] {
  const clean = parseRemoteSettings(settings)
  const portCheck = portProblem(localPort, "The local port")
  if (portCheck) throw new Error(portCheck)
  const args = [
    "-N",
    // Never ask anything: a password, a passphrase or an unknown host key can't be answered (ssh has no terminal)
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    `ConnectTimeout=${SshConnectTimeoutSeconds}`,
    "-o",
    `ServerAliveInterval=${SshServerAliveIntervalSeconds}`,
    "-o",
    "ServerAliveCountMax=3",
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:${clean.hostPort}`,
  ]
  if (clean.sshPort !== undefined) args.push("-p", String(clean.sshPort))
  if (clean.identityFile !== undefined) args.push("-i", clean.identityFile, "-o", "IdentitiesOnly=yes")
  // "--" ends the options: whatever the destination is, it is one
  args.push("--", clean.target)
  return args
}

/** A free TCP port on loopback: asks the OS for one and gives it back (another process could take it before ssh does) */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("The OS gave no free port"))))
    })
  })
}

/** Whether something accepts a TCP connection on 127.0.0.1:port (the connection is closed at once) */
export function tryConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port })
    const done = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })
}

export interface WaitForForwardOptions {
  timeoutMs: number
  /** Default 100 */
  intervalMs?: number
  /** Default tryConnect */
  connect?: (port: number) => Promise<boolean>
  /** Aborting stops the wait, which rejects with the signal's reason */
  signal?: AbortSignal
}

/** Resolves once something accepts connections on 127.0.0.1:port; rejects after timeoutMs, or when the signal aborts */
export async function waitForForward(port: number, options: WaitForForwardOptions): Promise<void> {
  const connect = options.connect ?? tryConnect
  const intervalMs = options.intervalMs ?? 100
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    options.signal?.throwIfAborted()
    if (await connect(port)) return
    options.signal?.throwIfAborted()
    if (Date.now() >= deadline) {
      throw new Error(`The SSH tunnel wasn't ready within ${options.timeoutMs / 1000} s`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** child_process.spawn, or a fake in tests */
export type SpawnFunction = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface TunnelOptions {
  settings: RemoteSettings
  /** Defaults to "ssh" (the system's: OpenSSH, found on the PATH) */
  sshPath?: string
  /** Defaults to how long ssh's connect timeout plus a margin takes */
  readyTimeoutMs?: number
  /** Defaults to pickFreePort */
  pickPort?: () => Promise<number>
  /** Defaults to tryConnect */
  connect?: (port: number) => Promise<boolean>
  /** Default 100 */
  pollIntervalMs?: number
  env?: NodeJS.ProcessEnv
  spawn?: SpawnFunction
  /** Called once ssh has exited, if open resolved */
  onExit?: (exit: HostExit, tunnel: SshTunnel) => void
  /** Called as soon as ssh is spawned, with a function that kills it: a tunnel still opening can be ended */
  onSpawned?: (kill: () => void) => void
}

/** How long the forward gets to accept connections: ssh's own connect timeout, then a margin for authentication */
export const DefaultTunnelReadyTimeoutMs = (SshConnectTimeoutSeconds + 10) * 1000

/** Keeps the last n lines */
function pushLast(lines: string[], added: string[]): void {
  lines.push(...added)
  if (lines.length > QuotedLines) lines.splice(0, lines.length - QuotedLines)
}

/** ":\n<lines>" of what ssh said (without blank lines), or "" when it said nothing */
export function quoteStderr(lines: readonly string[]): string {
  const text = lines.map((line) => line.replace(/\r$/, "")).filter((line) => line.trim() !== "")
  return text.length > 0 ? `:\n${text.join("\n")}` : ""
}

/**
 * A running ssh tunnel. SshTunnel.open starts ssh, waits until the local end accepts connections and resolves with the
 * tunnel; it rejects (and kills ssh) when ssh exits first, can't be started or the forward isn't up in time, with
 * ssh's last stderr lines.
 */
export class SshTunnel {
  private exitInfo: HostExit | null = null
  private readonly exitListeners: Array<(exit: HostExit) => void> = []
  private readonly stderrLines: string[] = []

  private constructor(
    private readonly child: ChildProcess,
    /** The port on 127.0.0.1 that reaches the remote host */
    readonly localPort: number,
    readonly settings: RemoteSettings
  ) {}

  get exited(): boolean {
    return this.exitInfo !== null
  }

  get exit(): HostExit | null {
    return this.exitInfo
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  /** ssh's last stderr lines, for a message about why the tunnel ended ("" when it said nothing) */
  get lastOutput(): string {
    return quoteStderr(this.stderrLines)
  }

  onExit(listener: (exit: HostExit) => void): void {
    if (this.exitInfo) listener(this.exitInfo)
    else this.exitListeners.push(listener)
  }

  /** Ends ssh (TerminateProcess on Windows, SIGTERM elsewhere) unless it already exited. Synchronous. */
  kill(): void {
    if (this.exitInfo) return
    try {
      this.child.kill()
    } catch {
      // already gone
    }
  }

  static async open(options: TunnelOptions): Promise<SshTunnel> {
    const spawn = options.spawn ?? nodeSpawn
    const sshPath = options.sshPath ?? "ssh"
    const localPort = await (options.pickPort ?? pickFreePort)()
    const args = buildSshArgs(options.settings, localPort)

    let child: ChildProcess
    try {
      child = spawn(sshPath, args, {
        env: options.env ?? process.env,
        // ssh asks nothing (BatchMode) and prints nothing we need on stdout: only stderr is read
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      })
    } catch (e) {
      throw new Error(`Couldn't start ${sshPath}: ${e instanceof Error ? e.message : String(e)}`)
    }
    options.onSpawned?.(() => {
      try {
        child.kill()
      } catch {
        // already gone
      }
    })

    const stderrLines: string[] = []
    let tunnel: SshTunnel | null = null
    const stderr = new LineSplitter()
    child.stderr?.on("data", (chunk: Buffer) => pushLast(tunnel ? tunnel.stderrLines : stderrLines, stderr.push(chunk)))
    child.stderr?.on("end", () => pushLast(tunnel ? tunnel.stderrLines : stderrLines, stderr.end()))

    const abort = new AbortController()
    let failure: Error | null = null
    let closed = false
    child.on("error", (e) => {
      failure = new Error(
        `Couldn't start ${sshPath}: ${e.message}${(e as NodeJS.ErrnoException).code === "ENOENT" ? " (is the OpenSSH client installed?)" : ""}`
      )
      abort.abort(failure)
    })
    // "close", not "exit": by then stderr is read to the end, so a failure quotes all of it
    child.on("close", (code, signal) => {
      closed = true
      const exit: HostExit = { code, signal }
      if (!tunnel) {
        failure ??= new Error(`ssh ${describeExit(exit)} before the tunnel was up${quoteStderr(stderrLines)}`)
        abort.abort(failure)
        return
      }
      tunnel.exitInfo = exit
      tunnel.exitListeners.splice(0).forEach((listener) => listener(exit))
      options.onExit?.(exit, tunnel)
    })

    try {
      await waitForForward(localPort, {
        timeoutMs: options.readyTimeoutMs ?? DefaultTunnelReadyTimeoutMs,
        intervalMs: options.pollIntervalMs,
        connect: options.connect,
        signal: abort.signal,
      })
    } catch (e) {
      if (!closed) {
        try {
          child.kill()
        } catch {
          // already gone
        }
      }
      // The reason is ssh's own when it ended first (a bad key, a refused host key, no route); a timeout quotes it too
      if (failure) throw failure
      throw new Error(`${e instanceof Error ? e.message : String(e)}${quoteStderr(stderrLines)}`)
    }
    // The forward can be up and ssh gone in the same moment: the exit is the news
    if (failure) throw failure
    tunnel = new SshTunnel(child, localPort, options.settings)
    tunnel.stderrLines.push(...stderrLines)
    return tunnel
  }
}
