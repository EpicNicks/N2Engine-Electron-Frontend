// Remote engine mode, phase 1 (frontend issue #21): the editor reaches an N2EditorHost that is already running on
// another machine through a tunnel made by the system's ssh:
//
//   ssh -N -L 127.0.0.1:0:127.0.0.1:<hostPort> -p <port> -i <identity> -- user@host
//
// The remote host stays bound to loopback; only sshd is exposed. ssh picks the local port (0) and says which in an
// "Allocated port <n> for local forward" line once it is authenticated and listening; only then does the editor connect
// to 127.0.0.1:<n> and say Hello with the host's access token, as it does with a local host. (Probing a port would
// trust whatever listens there, and another local process could have taken it while ssh was still authenticating.) The token is never part of anything in
// this file: not an argument, not the environment, not a log line (the session passes it to the engine connection).
//
// Everything that decides what ssh is started with is here, in small pure functions, because an address typed by a
// user must not be able to become an ssh option: ssh is spawned without a shell, with the arguments as an array, and
// every value is validated first (a value starting with "-" is refused, and "--" ends ssh's options before the
// destination). Node only (no Electron), so it is unit tested with fakes.
import { ChildProcess, SpawnOptions, spawn as nodeSpawn } from "child_process"
import * as fs from "fs"
import * as path from "path"
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
// A host name (an ssh_config alias may have underscores) or an IPv4 address, or an IPv6 address (hex digits, at least
// two colons and dots; no brackets needed for ssh)
const HostNamePattern = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const Ipv6Pattern = /^(?=(?:[^:]*:){2,})[0-9A-Fa-f:.]+$/

/** Why this isn't a user@host ssh may be given, or null. A leading "-" is refused so it can't be read as an option. */
export function targetProblem(target: unknown): string | null {
  if (typeof target !== "string" || target.trim() === "") return "Enter the SSH address as user@host"
  if (target.length > MaxFieldLength) return "The SSH address is too long"
  if (target.startsWith("-")) return "The SSH address can't start with '-'"
  const at = target.indexOf("@")
  if (at < 1 || at !== target.lastIndexOf("@") || at === target.length - 1) return "Enter the SSH address as user@host"
  const user = target.slice(0, at)
  const host = target.slice(at + 1)
  if (user.includes("\\")) {
    return "Domain users (DOMAIN\\user) aren't supported: use the user name alone, or set it in your ssh config"
  }
  if (!UserPattern.test(user)) return "The SSH user has characters ssh addresses don't"
  if (/^[^:]+:\d*$/.test(host)) {
    return "Put the port in the SSH port field, not after the host (user@host, not user@host:22)"
  }
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
export function buildSshArgs(settings: RemoteSettings): string[] {
  const clean = parseRemoteSettings(settings)
  const args = [
    "-N",
    // Never ask anything: a password, a passphrase or an unknown host key can't be answered (ssh has no terminal)
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    // A ControlMaster or ControlPersist in the user's config could hand this to a master that outlives it, leaving the
    // forward orphaned after the editor killed "ssh"
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    // The "Allocated port" line below is how the editor learns the forward is up: a LogLevel in the user's config
    // (QUIET, ERROR) must not hide it
    "-o",
    "LogLevel=INFO",
    "-o",
    `ConnectTimeout=${SshConnectTimeoutSeconds}`,
    "-o",
    `ServerAliveInterval=${SshServerAliveIntervalSeconds}`,
    "-o",
    "ServerAliveCountMax=3",
    // Local port 0: ssh itself picks a free port and says which, once it has authenticated and is listening on it
    // (no port is chosen here and given up again for another process to take before ssh binds it)
    "-L",
    `127.0.0.1:0:127.0.0.1:${clean.hostPort}`,
  ]
  if (clean.sshPort !== undefined) args.push("-p", String(clean.sshPort))
  if (clean.identityFile !== undefined) args.push("-i", clean.identityFile, "-o", "IdentitiesOnly=yes")
  // "--" ends the options: whatever the destination is, it is one
  args.push("--", clean.target)
  return args
}

/**
 * The port from ssh's "Allocated port 50123 for local forward to 127.0.0.1:7777" line (printed at LogLevel INFO once
 * the forward listens, which is after authentication), or null if the line isn't one
 */
export function parseAllocatedPort(line: string): number | null {
  const match = /^Allocated port (\d{1,5}) for local forward to /.exec(line.replace(/\r$/, ""))
  if (!match) return null
  const port = Number(match[1])
  return port >= 1 && port <= 65535 ? port : null
}

/**
 * The ssh to run: on Windows the OpenSSH that ships with the system when it is there (a Git for Windows ssh found
 * first on the PATH is another program with its own known_hosts and keys), else "ssh" from the PATH
 */
export function resolveSshPath(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = fs.existsSync,
): string {
  if (platform === "win32") {
    const root = env.SystemRoot ?? env.windir
    if (root) {
      const system = path.win32.join(root, "System32", "OpenSSH", "ssh.exe")
      if (exists(system)) return system
    }
  }
  return "ssh"
}

let resolvedSshPath: string | null = null

/** resolveSshPath(), asked once */
function defaultSshPath(): string {
  return (resolvedSshPath ??= resolveSshPath())
}

/** An actionable hint for an ssh failure it recognises (appended to the message), or "" */
export function sshHint(lines: readonly string[], sshPath: string, settings: RemoteSettings): string {
  if (lines.some((line) => line.includes("Host key verification failed"))) {
    const ssh = /\s/.test(sshPath) ? `"${sshPath}"` : sshPath
    const port = settings.sshPort !== undefined ? ` -p ${settings.sshPort}` : ""
    return (
      `\nssh doesn't trust this host's key (it is new, or it changed), and the editor can't answer ssh's question. ` +
      `If the key is the one you expect, run this once in a terminal and answer yes, then connect again:\n` +
      `  ${ssh}${port} ${settings.target}\n` +
      `Use this same ssh: Windows' OpenSSH and Git's ssh keep separate known_hosts files. ` +
      `If the key changed and you didn't expect it, don't accept it.`
    )
  }
  return ""
}

/** child_process.spawn, or a fake in tests */
export type SpawnFunction = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface TunnelOptions {
  settings: RemoteSettings
  /** Defaults to resolveSshPath(): the system's OpenSSH on Windows when present, else "ssh" from the PATH */
  sshPath?: string
  /** How long ssh gets to authenticate and set up the forward; defaults to its connect timeout plus a margin */
  readyTimeoutMs?: number
  env?: NodeJS.ProcessEnv
  spawn?: SpawnFunction
  /** Aborting (the editor is quitting) ends ssh at once, or stops it from being spawned: open rejects */
  signal?: AbortSignal
  /** Called once ssh has exited, if open resolved */
  onExit?: (exit: HostExit, tunnel: SshTunnel) => void
  /** Called as soon as ssh is spawned, with a function that kills it: a tunnel still opening can be ended */
  onSpawned?: (kill: () => void) => void
}

/** How long ssh gets to connect and authenticate, and print that the forward listens */
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
 * A running ssh tunnel. SshTunnel.open starts ssh and resolves once ssh itself has said its forward is listening (it
 * authenticated, and it holds the local port: nothing else could have taken it), never on the strength of something
 * accepting connections on a port. It rejects (and kills ssh) when ssh exits first, can't be started, says nothing in
 * time or the signal aborts, with ssh's last stderr lines.
 */
export class SshTunnel {
  private exitInfo: HostExit | null = null
  private readonly exitListeners: Array<(exit: HostExit) => void> = []

  private constructor(
    private readonly child: ChildProcess,
    /** The port on 127.0.0.1 that reaches the remote host, as ssh allocated it */
    readonly localPort: number,
    readonly settings: RemoteSettings,
    /** ssh's last stderr lines, shared with the open() that reads them */
    private readonly stderrLines: string[],
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

  static open(options: TunnelOptions): Promise<SshTunnel> {
    const spawn = options.spawn ?? nodeSpawn
    const sshPath = options.sshPath ?? defaultSshPath()
    return new Promise<SshTunnel>((resolve, reject) => {
      const cancelled = (): Error => new Error("Cancelled: the tunnel was closed while it opened")
      let args: string[]
      try {
        args = buildSshArgs(options.settings)
      } catch (e) {
        reject(e)
        return
      }
      // Checked right before spawning: the editor may have quit while the caller was getting here
      if (options.signal?.aborted) {
        reject(cancelled())
        return
      }
      let child: ChildProcess
      try {
        child = spawn(sshPath, args, {
          env: options.env ?? process.env,
          // ssh asks nothing (BatchMode) and prints nothing we need on stdout: only stderr is read
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        })
      } catch (e) {
        reject(new Error(`Couldn't start ${sshPath}: ${e instanceof Error ? e.message : String(e)}`))
        return
      }

      const stderrLines: string[] = []
      let tunnel: SshTunnel | null = null
      let settled = false
      let closed = false
      const kill = (): void => {
        if (closed) return
        try {
          child.kill()
        } catch {
          // already gone
        }
      }
      const onAbort = (): void => fail(cancelled())
      const timer = setTimeout(
        () =>
          fail(
            new Error(
              `ssh didn't report its forward within ${(options.readyTimeoutMs ?? DefaultTunnelReadyTimeoutMs) / 1000} s ` +
                `(it prints "Allocated port <n> for local forward" once it is connected)` +
                quoteStderr(stderrLines) +
                sshHint(stderrLines, sshPath, options.settings),
            ),
          ),
        options.readyTimeoutMs ?? DefaultTunnelReadyTimeoutMs,
      )
      function fail(error: Error): void {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", onAbort)
        kill()
        reject(error)
      }
      options.signal?.addEventListener("abort", onAbort, { once: true })

      options.onSpawned?.(kill)

      const onLines = (lines: string[]): void => {
        const rest: string[] = []
        for (const line of lines) {
          const port = settled ? null : parseAllocatedPort(line)
          if (port === null) {
            rest.push(line)
            continue
          }
          // ssh authenticated and listens on the port: now (and not before) the editor may connect
          settled = true
          clearTimeout(timer)
          options.signal?.removeEventListener("abort", onAbort)
          tunnel = new SshTunnel(child, port, options.settings, stderrLines)
          resolve(tunnel)
        }
        pushLast(stderrLines, rest)
      }
      const stderr = new LineSplitter()
      child.stderr?.on("data", (chunk: Buffer) => onLines(stderr.push(chunk)))
      child.stderr?.on("end", () => onLines(stderr.end()))

      child.on("error", (e) =>
        fail(
          new Error(
            `Couldn't start ${sshPath}: ${e.message}${(e as NodeJS.ErrnoException).code === "ENOENT" ? " (is the OpenSSH client installed?)" : ""}`,
          ),
        ),
      )
      // "close", not "exit": by then stderr is read to the end, so a failure quotes all of it
      child.on("close", (code, signal) => {
        closed = true
        const exit: HostExit = { code, signal }
        if (!tunnel) {
          fail(
            new Error(
              `ssh ${describeExit(exit)} before the tunnel was up${quoteStderr(stderrLines)}${sshHint(stderrLines, sshPath, options.settings)}`,
            ),
          )
          return
        }
        tunnel.exitInfo = exit
        tunnel.exitListeners.splice(0).forEach((listener) => listener(exit))
        options.onExit?.(exit, tunnel)
      })
    })
  }
}
