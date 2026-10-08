// Launches N2EditorHost for a project and waits for its ready line (docs/logging-and-editor.html §ready-line, engine
// #84/#89). Node only (no Electron), so it is unit tested with a fake child process and with a real one.
//
// The host is started as
//   N2EditorHost --project <dir> --port 0 --token-env N2_EDITOR_TOKEN --exit-on-disconnect
// with a fresh random token in N2_EDITOR_TOKEN in the child's environment only: never in this process's
// environment, never on the command line, never in a log line or anything sent to the page. Once listening the host
// prints "N2EditorHost ready port=<port>" to stdout, and the editor connects to that port and says Hello with the
// token. --exit-on-disconnect makes the host exit when that session ends, so it can't outlive the editor once
// connected; the editor also kills it when it quits.
//
// The child's stdin is a pipe the editor keeps open and never writes to. When the editor dies, the pipe closes, so
// a later engine change can make the host exit on stdin EOF: that covers a launcher that dies before its first
// Hello, which --exit-on-disconnect can't (a host with a token ignores connections that never said Hello).
import { ChildProcess, SpawnOptions, spawn as nodeSpawn } from "child_process"
import { randomBytes } from "crypto"

/** The environment variable the token is passed in (--token-env names it) */
export const TokenEnvVariable = "N2_EDITOR_TOKEN"

/** The ready line starts with this (HostOptions.hpp's ReadyLinePrefix), then a space */
export const ReadyLinePrefix = "N2EditorHost ready"

/** How long a host may take to print its ready line (PhysX, the GL context and the asset scan come first) */
export const DefaultReadyTimeoutMs = 30000

/** How many of the host's last stderr and stdout lines a failure message quotes */
const QuotedLines = 8

/** The bound port from a ready line, or null if the line isn't one. A trailing \r (Windows' \r\n) is ignored. */
export function parseReadyLine(line: string): number | null {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line
  if (!text.startsWith(ReadyLinePrefix + " ")) return null
  // Space-separated key=value fields after the prefix; unknown keys are ignored, in any order
  for (const field of text.slice(ReadyLinePrefix.length + 1).split(" ")) {
    const match = /^port=(\d{1,5})$/.exec(field)
    if (match) {
      const port = Number(match[1])
      return port >= 1 && port <= 65535 ? port : null
    }
  }
  return null
}

/** Splits a byte stream into lines as chunks arrive: a line split across chunks comes out whole, once complete */
export class LineSplitter {
  private partial = ""
  private readonly decoder = new TextDecoder("utf-8")

  /** The lines completed by this chunk, without their \n (a \r before it is kept; parseReadyLine ignores it) */
  push(chunk: Uint8Array | string): string[] {
    this.partial += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true })
    const lines = this.partial.split("\n")
    this.partial = lines.pop() ?? ""
    return lines
  }

  /** What's left once the stream ended: a last line with no \n, if any */
  end(): string[] {
    this.partial += this.decoder.decode()
    const rest = this.partial
    this.partial = ""
    return rest.length > 0 ? [rest] : []
  }
}

/** A random access token: 32 bytes, hex */
export function generateToken(): string {
  return randomBytes(32).toString("hex")
}

/** The host's arguments: the token travels in the environment, so only the variable's name is here */
export function buildHostArgs(projectDir: string): string[] {
  return ["--project", projectDir, "--port", "0", "--token-env", TokenEnvVariable, "--exit-on-disconnect"]
}

/** The child's environment: a copy of this process's with the token added. The parent's is left as it was. */
export function buildChildEnv(parentEnv: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  return { ...parentEnv, [TokenEnvVariable]: token }
}

/** child_process.spawn, or a fake in tests */
export type SpawnFunction = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

/** How a host process ended */
export interface HostExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface LaunchOptions {
  hostPath: string
  projectDir: string
  /** Defaults to generateToken() */
  token?: string
  readyTimeoutMs?: number
  /** Defaults to process.env; only the child's copy gets the token */
  env?: NodeJS.ProcessEnv
  spawn?: SpawnFunction
  /** Called once the process has exited, if launch resolved */
  onExit?: (exit: HostExit, process: HostProcess) => void
  /**
   * Called as soon as the process is spawned, with a function that kills it: a host still starting can be ended
   * (the editor quits) before launch resolves, which then rejects
   */
  onSpawned?: (kill: () => void) => void
}

/** What a host's failure message quotes: its last stderr lines, else its last stdout lines */
function quoteOutput(stderr: string[], stdout: string[]): string {
  const lines = (stderr.length > 0 ? stderr : stdout).map((line) => line.replace(/\r$/, "")).filter((l) => l !== "")
  return lines.length > 0 ? `:\n${lines.join("\n")}` : ""
}

function describeExit({ code, signal }: HostExit): string {
  return code !== null ? `exited with code ${code}` : `was ended by ${signal ?? "an unknown signal"}`
}

/** Keeps the last n lines */
function pushLast(lines: string[], added: string[], n: number = QuotedLines): void {
  lines.push(...added)
  if (lines.length > n) lines.splice(0, lines.length - n)
}

/**
 * A running N2EditorHost. HostProcess.launch starts one and resolves once it printed its ready line, with the port
 * and the token to say Hello with; it rejects (and kills the process) when the process exits, fails to start or
 * doesn't print the line within the timeout.
 */
export class HostProcess {
  private exitInfo: HostExit | null = null
  private readonly exitListeners: Array<(exit: HostExit) => void> = []
  private readonly stderrLines: string[] = []
  private readonly stdoutLines: string[] = []

  private constructor(
    private readonly child: ChildProcess,
    /** The port the host listens on */
    readonly port: number,
    /** The access token for Hello. Main process only: never logged or sent to the page. */
    readonly token: string,
  ) {}

  /** Whether the process has exited */
  get exited(): boolean {
    return this.exitInfo !== null
  }

  get exit(): HostExit | null {
    return this.exitInfo
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  /** The host's last stderr (else stdout) lines, for a message about why it exited */
  get lastOutput(): string {
    return quoteOutput(this.stderrLines, this.stdoutLines)
  }

  onExit(listener: (exit: HostExit) => void): void {
    if (this.exitInfo) listener(this.exitInfo)
    else this.exitListeners.push(listener)
  }

  /** Ends the process (TerminateProcess on Windows, SIGTERM elsewhere) unless it already exited. Synchronous. */
  kill(): void {
    if (this.exitInfo) return
    try {
      this.child.kill()
    } catch {
      // already gone
    }
  }

  static launch(options: LaunchOptions): Promise<HostProcess> {
    const token = options.token ?? generateToken()
    const spawn = options.spawn ?? nodeSpawn
    const timeoutMs = options.readyTimeoutMs ?? DefaultReadyTimeoutMs

    return new Promise((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(options.hostPath, buildHostArgs(options.projectDir), {
          env: buildChildEnv(options.env ?? process.env, token),
          // stdin: a pipe kept open and never written to (see the top of this file)
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        })
      } catch (e) {
        reject(new Error(`Couldn't start ${options.hostPath}: ${e instanceof Error ? e.message : String(e)}`))
        return
      }

      options.onSpawned?.(() => {
        try {
          child.kill()
        } catch {
          // already gone
        }
      })

      const stderrLines: string[] = []
      const stdoutLines: string[] = []
      let host: HostProcess | null = null
      let settled = false
      const fail = (message: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          child.kill()
        } catch {
          // already gone
        }
        reject(new Error(message))
      }

      const timer = setTimeout(
        () =>
          fail(
            `N2EditorHost didn't report it was ready within ${timeoutMs / 1000} s${quoteOutput(stderrLines, stdoutLines)}`,
          ),
        timeoutMs,
      )

      // stdout is read to the end, whatever it holds: a pipe nobody reads fills up, and the host would block writing
      // its log lines. Only the ready line matters; the log lines also reach the editor through PollEvents.
      const stdout = new LineSplitter()
      const onStdoutLines = (lines: string[]): void => {
        pushLast(host ? host.stdoutLines : stdoutLines, lines)
        if (settled) return
        for (const line of lines) {
          const port = parseReadyLine(line)
          if (port === null) continue
          settled = true
          clearTimeout(timer)
          host = new HostProcess(child, port, token)
          host.stderrLines.push(...stderrLines)
          host.stdoutLines.push(...stdoutLines)
          resolve(host)
          return
        }
      }
      child.stdout?.on("data", (chunk: Buffer) => onStdoutLines(stdout.push(chunk)))
      child.stdout?.on("end", () => onStdoutLines(stdout.end()))

      const stderr = new LineSplitter()
      child.stderr?.on("data", (chunk: Buffer) => pushLast(host ? host.stderrLines : stderrLines, stderr.push(chunk)))
      child.stderr?.on("end", () => pushLast(host ? host.stderrLines : stderrLines, stderr.end()))

      // The editor never writes to stdin; an error on it (the host exited) is no news
      child.stdin?.on("error", () => {})

      child.on("error", (e) => fail(`Couldn't start ${options.hostPath}: ${e.message}`))

      // "close", not "exit": by then stdout and stderr are read to the end, so a failure quotes all of it
      child.on("close", (code, signal) => {
        const exit: HostExit = { code, signal }
        fail(`N2EditorHost ${describeExit(exit)} before it was ready${quoteOutput(stderrLines, stdoutLines)}`)
        if (host) {
          host.exitInfo = exit
          host.exitListeners.splice(0).forEach((listener) => listener(exit))
          options.onExit?.(exit, host)
        }
      })
    })
  }
}

/** How long `--create` may take: no engine starts, so it should be quick */
export const DefaultCreateTimeoutMs = 30000

export interface CreateOptions {
  hostPath: string
  projectDir: string
  /** --project-id: adopt this id, so an existing folder keeps its asset UUIDs */
  projectId?: string
  timeoutMs?: number
  spawn?: SpawnFunction
}

/** What creating needs from the engine, said in every failure message until it lands */
export const CreateNeedsEngine = "Creating a project needs N2EditorHost --create (engine #75, phase E3)"

/**
 * Creates a project with the host's `--create`: `N2EditorHost --create <dir> [--project-id <uuid>]`, which writes
 * the project (project.n2proj and its layout) and exits with code 0, without starting the engine. The editor never
 * writes the project file itself.
 *
 * This is the intended contract of engine #75 (E3), which hasn't merged yet; this function is the one place to
 * adjust when it lands. A host without --create ignores the unknown argument and starts serving instead, so its
 * ready line (or a timeout) means --create isn't supported, and that host is killed.
 */
export function createProjectWithHost(options: CreateOptions): Promise<void> {
  const spawn = options.spawn ?? nodeSpawn
  const timeoutMs = options.timeoutMs ?? DefaultCreateTimeoutMs
  const args = ["--create", options.projectDir]
  if (options.projectId !== undefined) args.push("--project-id", options.projectId)

  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(options.hostPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    } catch (e) {
      reject(new Error(`Couldn't start ${options.hostPath}: ${e instanceof Error ? e.message : String(e)}`))
      return
    }

    const stderrLines: string[] = []
    const stdoutLines: string[] = []
    let settled = false
    const finish = (error: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        try {
          child.kill()
        } catch {
          // already gone
        }
        reject(error)
      } else {
        resolve()
      }
    }

    const timer = setTimeout(
      () =>
        finish(new Error(`N2EditorHost --create didn't finish within ${timeoutMs / 1000} s. ${CreateNeedsEngine}.`)),
      timeoutMs,
    )

    const stdout = new LineSplitter()
    const onStdoutLines = (lines: string[]): void => {
      pushLast(stdoutLines, lines)
      if (lines.some((line) => parseReadyLine(line) !== null)) {
        finish(
          new Error(
            `This N2EditorHost doesn't support --create: it started an editor host instead. ${CreateNeedsEngine}.`,
          ),
        )
      }
    }
    child.stdout?.on("data", (chunk: Buffer) => onStdoutLines(stdout.push(chunk)))
    child.stdout?.on("end", () => onStdoutLines(stdout.end()))
    const stderr = new LineSplitter()
    child.stderr?.on("data", (chunk: Buffer) => pushLast(stderrLines, stderr.push(chunk)))
    child.stderr?.on("end", () => pushLast(stderrLines, stderr.end()))

    child.on("error", (e) => finish(new Error(`Couldn't start ${options.hostPath}: ${e.message}`)))
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish(null)
      } else {
        finish(
          new Error(
            `N2EditorHost --create ${describeExit({ code, signal })}${quoteOutput(stderrLines, stdoutLines)}\n` +
              `(${CreateNeedsEngine}.)`,
          ),
        )
      }
    })
  })
}
