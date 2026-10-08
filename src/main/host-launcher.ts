// Launches N2EditorHost for a project and waits for its ready line (docs/logging-and-editor.html §ready-line, engine
// #84/#89). Node only (no Electron), so it is unit tested with a fake child process and with a real one.
//
// The host is started as
//   N2EditorHost --project <dir> --port 0 --token-env N2_EDITOR_TOKEN --exit-on-disconnect --exit-on-stdin-eof
// with a fresh random token in N2_EDITOR_TOKEN in the child's environment only: never in this process's
// environment, never on the command line, never in a log line or anything sent to the page. Once listening the host
// prints "N2EditorHost ready port=<port>" to stdout, and the editor connects to that port and says Hello with the
// token. --exit-on-disconnect makes the host exit when that session ends, so it can't outlive the editor once
// connected; the editor also kills it when it quits.
//
// The child's stdin is a pipe the editor keeps open and never writes to. When the editor dies, the pipe closes, so
// --exit-on-stdin-eof (opt-in in the engine, so it is passed here) makes the host exit on stdin EOF: that covers a
// launcher that dies before its first Hello, which --exit-on-disconnect can't (a host with a token ignores
// connections that never said Hello).
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
  return [
    "--project",
    projectDir,
    "--port",
    "0",
    "--token-env",
    TokenEnvVariable,
    "--exit-on-disconnect",
    "--exit-on-stdin-eof",
  ]
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

/** What a host's failure message quotes: its last stderr lines, else its last stdout lines (not the ready line) */
function quoteOutput(stderr: string[], stdout: string[]): string {
  const lines = (stderr.length > 0 ? stderr : stdout)
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line !== "" && parseReadyLine(line) === null)
  return lines.length > 0 ? `:\n${lines.join("\n")}` : ""
}

/** "exited with code 1", or "was ended by SIGTERM" */
export function describeExit({ code, signal }: HostExit): string {
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
    readonly token: string
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
            `N2EditorHost didn't report it was ready within ${timeoutMs / 1000} s${quoteOutput(stderrLines, stdoutLines)}`
          ),
        timeoutMs
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

/** Starts the line `N2EditorHost --create` prints to stdout when it created the project, then a space */
export const CreatedLinePrefix = "N2EditorHost created"

/** `N2EditorHost --create`'s exit code when the folder already has a project.n2proj (nothing was changed) */
export const CreateExitAlreadyAProject = 2

/** What `N2EditorHost --create` reports */
export interface CreatedProject {
  /** The new project's id, lower-case */
  projectId: string
  /** Its startup scene, a res:// path (res://scenes/Main.scene) */
  startupScene: string | null
}

/**
 * The fields of a created line, `N2EditorHost created projectId=<uuid> startupScene=<res path>` (engine #90), or
 * null if the line isn't one. A trailing \r is ignored, the fields are space-separated key=value in any order, and
 * keys this editor doesn't know are skipped. projectId must be there.
 */
export function parseCreatedLine(line: string): CreatedProject | null {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line
  if (!text.startsWith(CreatedLinePrefix + " ")) return null
  const fields = new Map<string, string>()
  for (const field of text.slice(CreatedLinePrefix.length + 1).split(" ")) {
    const equals = field.indexOf("=")
    if (equals > 0) fields.set(field.slice(0, equals), field.slice(equals + 1))
  }
  const projectId = fields.get("projectId")
  if (!projectId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) return null
  return { projectId: projectId.toLowerCase(), startupScene: fields.get("startupScene") || null }
}

/** Why `N2EditorHost --create` didn't create a project */
export type CreateFailure =
  /** Exit code 2: the folder already has a project.n2proj, and nothing was changed */
  | "alreadyAProject"
  /** The host has no --create (it is older than engine #90): it started serving instead */
  | "unsupported"
  /** Anything else: the message is the host's reason */
  | "failed"

export class CreateProjectError extends Error {
  constructor(
    readonly kind: CreateFailure,
    message: string
  ) {
    super(message)
    this.name = "CreateProjectError"
  }
}

export interface CreateOptions {
  hostPath: string
  /** The project's folder: created if missing; an existing one is adopted, its files kept */
  projectDir: string
  /** --name: the project's name (the host's default is the folder's name) */
  name?: string
  /**
   * --project-id: a UUID, or "from-path" to keep the asset UUIDs the folder's assets had before projects had ids
   * (adopting an existing folder). The host's default is a new random id.
   */
  projectId?: string
  timeoutMs?: number
  spawn?: SpawnFunction
  /** Called as soon as the process is spawned, with a function that kills it (the editor quits meanwhile) */
  onSpawned?: (kill: () => void) => void
}

/** What creating needs from the engine */
export const CreateNeedsEngine = "Creating a project needs an N2EditorHost with --create (engine #90)"

/** The host's own error line(s), without the "N2EditorHost --create: " it starts them with */
function createReason(stderr: string[], stdout: string[]): string {
  const lines = (stderr.length > 0 ? stderr : stdout).map((line) => line.replace(/\r$/, "")).filter((l) => l !== "")
  return lines.map((line) => line.replace(/^N2EditorHost --create: /, "")).join("\n")
}

/**
 * Creates a project with the host (engine #90): `N2EditorHost --create <folder> [--name <name>]
 * [--project-id <uuid> | --project-id from-path]`, which writes project.n2proj and the project's layout, without
 * starting the engine. The editor never writes the project file itself.
 *
 * - Exit code 0: created; stdout has one line, `N2EditorHost created projectId=<uuid> startupScene=<res path>`,
 *   which this resolves with.
 * - Exit code 2: the folder already has a project.n2proj (nothing was changed): a CreateProjectError
 *   "alreadyAProject", with the host's message.
 * - Exit code 1 (or anything else): a CreateProjectError "failed", with the host's reason from stderr.
 * - A host without --create (older than engine #90) ignores the flag and starts serving: its ready line is a
 *   CreateProjectError "unsupported", and it is killed. Editors check first (probeHostCapabilities), so this is a
 *   fallback.
 */
export function createProjectWithHost(options: CreateOptions): Promise<CreatedProject> {
  const spawn = options.spawn ?? nodeSpawn
  const timeoutMs = options.timeoutMs ?? DefaultCreateTimeoutMs
  const args = ["--create", options.projectDir]
  if (options.name !== undefined) args.push("--name", options.name)
  if (options.projectId !== undefined) args.push("--project-id", options.projectId)

  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(options.hostPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
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
    let created: CreatedProject | null = null
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
        resolve(created!)
      }
    }

    const timer = setTimeout(
      () =>
        finish(new CreateProjectError("failed", `N2EditorHost --create didn't finish within ${timeoutMs / 1000} s`)),
      timeoutMs
    )

    const stdout = new LineSplitter()
    const onStdoutLines = (lines: string[]): void => {
      pushLast(stdoutLines, lines)
      for (const line of lines) {
        created ??= parseCreatedLine(line)
        if (parseReadyLine(line) !== null) {
          finish(
            new CreateProjectError(
              "unsupported",
              `This N2EditorHost has no --create (it started an editor host instead). ${CreateNeedsEngine}.`
            )
          )
        }
      }
    }
    child.stdout?.on("data", (chunk: Buffer) => onStdoutLines(stdout.push(chunk)))
    child.stdout?.on("end", () => onStdoutLines(stdout.end()))
    const stderr = new LineSplitter()
    child.stderr?.on("data", (chunk: Buffer) => pushLast(stderrLines, stderr.push(chunk)))
    child.stderr?.on("end", () => pushLast(stderrLines, stderr.end()))

    child.on("error", (e) => finish(new Error(`Couldn't start ${options.hostPath}: ${e.message}`)))
    child.on("close", (code, signal) => {
      const reason = createReason(stderrLines, stdoutLines)
      if (code === 0) {
        finish(created ? null : new CreateProjectError("failed", "N2EditorHost --create reported no created project"))
      } else if (code === CreateExitAlreadyAProject) {
        finish(
          new CreateProjectError("alreadyAProject", reason || `${options.projectDir} already has a project.n2proj`)
        )
      } else {
        finish(
          new CreateProjectError(
            "failed",
            reason
              ? `Couldn't create the project: ${reason}`
              : `N2EditorHost --create ${describeExit({ code, signal })}`
          )
        )
      }
    })
  })
}

/** What a host can do, from its --help text */
export interface HostCapabilities {
  /** It has --create (engine #90) */
  create: boolean
}

/** How long `N2EditorHost --help` may take: it only prints the usage */
export const DefaultProbeTimeoutMs = 10000

export interface ProbeOptions {
  hostPath: string
  timeoutMs?: number
  spawn?: SpawnFunction
  onSpawned?: (kill: () => void) => void
}

/**
 * Asks the host what it can do: `N2EditorHost --help` prints the usage and exits 0 without starting the engine
 * (--help wins over every other argument). The usage names --create when the host has it (engine #90). A failure
 * to start, a non-zero exit or a timeout rejects. The editor never boots a full host just to find out.
 */
export function probeHostCapabilities(options: ProbeOptions): Promise<HostCapabilities> {
  const spawn = options.spawn ?? nodeSpawn
  const timeoutMs = options.timeoutMs ?? DefaultProbeTimeoutMs

  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(options.hostPath, ["--help"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    } catch (e) {
      reject(new Error(`Couldn't start ${options.hostPath}: ${e instanceof Error ? e.message : String(e)}`))
      return
    }
    const kill = (): void => {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }
    options.onSpawned?.(kill)

    let usage = ""
    let settled = false
    const finish = (result: HostCapabilities | Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (result instanceof Error) {
        kill()
        reject(result)
      } else {
        resolve(result)
      }
    }
    const timer = setTimeout(
      () => finish(new Error(`N2EditorHost --help didn't finish within ${timeoutMs / 1000} s`)),
      timeoutMs
    )

    const decoder = new TextDecoder("utf-8")
    child.stdout?.on("data", (chunk: Buffer) => {
      usage += decoder.decode(chunk, { stream: true })
      // A host that ignores --help would start serving: never let it run
      if (usage.split("\n").some((line) => parseReadyLine(line) !== null)) {
        finish(new Error("N2EditorHost started serving instead of printing its usage for --help"))
      }
    })
    child.stderr?.resume()
    child.on("error", (e) => finish(new Error(`Couldn't start ${options.hostPath}: ${e.message}`)))
    child.on("close", (code, signal) => {
      if (code !== 0) {
        finish(new Error(`N2EditorHost --help ${describeExit({ code, signal })}`))
        return
      }
      finish({ create: /(^|\s)--create\b/m.test(usage) })
    })
  })
}
