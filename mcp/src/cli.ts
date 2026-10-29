// The command line. Strict on purpose: an unknown option is an error, and an access token is never accepted as an
// argument (arguments show up in process listings, shell history and MCP client configs): it comes from an environment
// variable (--token-env) or a file (--token-file), and is never printed.
import * as fs from "node:fs"
import { normaliseFingerprint } from "../../src/protocol/fingerprint"
import { DefaultBusyWaitMs, DefaultCallTimeoutMs, MaxBusyWaitMs, MaxWritesPerSession } from "./limits"
import { ReadTools } from "./tools"
import { WriteToolNames } from "./tools-write"
import { PlayToolNames } from "./play"
import { EditorUserDataEnv } from "./electron-backend"
import { BridgeName, BridgeVersion } from "./version"

export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CliError"
  }
}

export interface CommonOptions {
  allowAdmin: boolean
  /** --read-only: no write tool is listed or callable */
  readOnly: boolean
  /** --allow-irreversible: irreversible operations run without asking the person (the operator's consent) */
  allowIrreversible: boolean
  /** --max-writes: host write commands per agent session */
  maxWrites: number
  /** --write-tools: only these write tools are listed; null: all of them */
  writeTools: string[] | null
  /** --disable-tools: tools that are never listed */
  disableTools: string[]
  /** --keep-journal: the folder with the backups of overwritten files is not deleted at exit */
  keepJournal: boolean
  busyWaitMs: number
  callTimeoutMs: number
  /** Hello says `yield` (protocol 1.22: the bridge gives way to people); --no-yield turns it off */
  yield: boolean
}

export interface LaunchCli extends CommonOptions {
  mode: "launch"
  projectPath: string
  /** --host-path, else the N2ENGINE_HOST environment variable (the editor's own name for it) */
  hostPath: string
  renderer?: "opengl" | "software"
  readyTimeoutMs?: number
}

export interface ConnectCli extends CommonOptions {
  mode: "connect"
  host: string
  port: number
  /** 64 lowercase hex digits */
  fingerprint: string
  user?: string
  /** Where the token is read from: exactly one of these */
  tokenEnv?: string
  tokenFile?: string
}

export interface ElectronCli extends CommonOptions {
  mode: "electron"
  /** --project: the project folder whose editor endpoint to use; omitted: the only project that has one */
  projectPath?: string
  /** --user-data: the editor's user data folder, where its discovery files are */
  userData?: string
  /** --allow-irreversible was given: it has no effect with --electron (the editor's own dialog decides) */
  ignoredAllowIrreversible: boolean
}

export type Cli = LaunchCli | ConnectCli | ElectronCli | { mode: "help" } | { mode: "version" }

/** The environment variable that names the host executable (the editor's setting too) */
export const HostPathEnv = "N2ENGINE_HOST"

export const Usage = `${BridgeName} ${BridgeVersion}: an MCP server (stdio) for N2Engine editor hosts.

Usage:
  ${BridgeName} --launch <projectPath> [--host-path <N2EditorHost>] [--renderer opengl|software] [options]
  ${BridgeName} --connect <host:port> --fingerprint <sha256> (--token-env <VAR> | --token-file <path>) [--user <name>] [options]
  ${BridgeName} --electron [--project <projectPath>] [--user-data <editorUserDataFolder>] [options]

Backends:
  --launch <projectPath>   Start a host of this bridge's own for the project (loopback, a throwaway editor-role token).
                           The host is found with --host-path, else the ${HostPathEnv} environment variable.
                           Only this backend has the play tools (n2_play_*): the game is a second host it starts.
  --connect <host:port>    Connect to a running host over TLS. --fingerprint (the certificate's SHA-256, 64 hex digits)
                           is required: there is no trust on first use. The token comes from the environment variable
                           named by --token-env, or from the file --token-file (on POSIX not readable by group or others).
                           Tokens are never accepted as command line arguments.

  --electron               Work in the project the person has open in the N2Engine editor, at the same time as they do. The editor
                           must have "Allow AI agent for this project" turned on (a switch in its toolbar, off by default); it
                           then listens on a named pipe or Unix socket and puts a per-launch secret in a file in its user data
                           folder, which this reads. Your changes are undo steps labelled "AI: ...", the person's own edits come
                           first, and anything irreversible (save, open or create a scene, project settings, import settings,
                           overwriting a file, undoing the person's steps) asks the person in the editor's own dialog:
                           --allow-irreversible does not replace that, and --allow-admin does not apply (the role is an
                           editor's at most). The play tools are not available (the game would be a second host).
  --project <path>         The project folder, for --electron (default: the only project with an endpoint).
  --user-data <path>       The editor's user data folder, for --electron (default: $${EditorUserDataEnv}, else where Electron puts the
                           app's data: %APPDATA%\n2enginewebfrontend, ~/Library/Application Support/n2enginewebfrontend,
                           ~/.config/n2enginewebfrontend).

Options:
  --user <name>            The token's user in the host's tokens file (--connect).
  --renderer <name>        opengl or software, for --launch.
  --allow-admin            Serve even when the host gave this connection the admin role (refused by default).
  --read-only              List no write tool, whatever the host allows.
  --allow-irreversible     Let irreversible operations (save, open or create a scene over unsaved changes, project settings,
                           overwriting a text file, restoring files in a revert) run when the client cannot ask the person.
                           It is the operator's consent: nothing an agent sends can stand in for it. Without it such an
                           operation needs the client's confirmation (elicitation), and is refused when the client has none.
  --max-writes <n>         Host write commands one agent session may make (default ${MaxWritesPerSession}).
  --write-tools <a,b,...>  List only these write and play tools (names as n2_create_entity; the others are not listed).
  --disable-tools <a,b>    Never list these tools, read or write.
  --keep-journal           Keep the folder with the backups of overwritten files when the bridge exits (default: delete it).
  --no-yield               Do not say "yield" in Hello (protocol 1.22). By default the bridge yields: it is served only by an idle
                           host and is dropped when a person's editor connects. Without it the bridge can preempt or take over
                           a session by the host's usual rules, so use it only for a host no person shares.
  --busy-wait <ms>         How long to wait before one more try when the host is busy (default ${DefaultBusyWaitMs}, at most ${MaxBusyWaitMs}).
  --call-timeout <ms>      How long one tool call may wait for the host (default ${DefaultCallTimeoutMs}).
  --ready-timeout <ms>     How long a launched host may take to be ready (default 30000).
  --help, --version
`

function takeValue(args: string[], i: number, option: string): string {
  const value = args[i + 1]
  if (value === undefined || value.startsWith("--")) throw new CliError(`${option} needs a value`)
  return value
}

function parseMs(text: string, option: string, max: number): number {
  if (!/^\d{1,9}$/.test(text)) throw new CliError(`${option} must be a whole number of milliseconds`)
  const value = Number(text)
  if (value < 1 || value > max) throw new CliError(`${option} must be between 1 and ${max}`)
  return value
}

/** A comma separated list of tool names, each one a tool this bridge has */
function parseToolList(text: string, option: string, known: string[]): string[] {
  const names = text.split(",").map((n) => n.trim())
  if (names.length === 0 || names.some((n) => n === "")) throw new CliError(`${option} needs a comma separated list of tool names`)
  for (const name of names) {
    if (!known.includes(name)) throw new CliError(`${option}: no such tool ${name.slice(0, 40)}`)
  }
  return [...new Set(names)]
}

/** "host:port", "[::1]:9999" or "localhost:9999" */
export function parseHostPort(text: string): { host: string; port: number } {
  const match = /^(\[[^\]]+\]|[^:\s[\]]+):(\d{1,5})$/.exec(text)
  if (!match) throw new CliError("--connect needs host:port (for example editor.example.net:9999)")
  const port = Number(match[2])
  if (port < 1 || port > 65535) throw new CliError("--connect: the port must be 1 to 65535")
  return { host: match[1].replace(/^\[|\]$/g, ""), port }
}

export function parseArgs(args: string[], env: NodeJS.ProcessEnv): Cli {
  let launch: string | undefined
  let connect: string | undefined
  let electron = false
  let project: string | undefined
  let userData: string | undefined
  let hostPath: string | undefined
  let renderer: string | undefined
  let fingerprint: string | undefined
  let tokenEnv: string | undefined
  let tokenFile: string | undefined
  let user: string | undefined
  let allowAdmin = false
  let readOnly = false
  let allowIrreversible = false
  let maxWrites = MaxWritesPerSession
  let writeTools: string[] | null = null
  let disableTools: string[] = []
  let keepJournal = false
  let busyWaitMs = DefaultBusyWaitMs
  let callTimeoutMs = DefaultCallTimeoutMs
  let readyTimeoutMs: number | undefined
  let yieldToPeople = true

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--help" || arg === "-h") return { mode: "help" }
    if (arg === "--version" || arg === "-v") return { mode: "version" }
    if (arg === "--token" || arg.startsWith("--token=") || arg === "--password" || arg.startsWith("--password=")) {
      throw new CliError("an access token is never accepted as an argument: use --token-env <VARIABLE> or --token-file <path>")
    }
    switch (arg) {
      case "--allow-admin":
        allowAdmin = true
        continue
      case "--read-only":
        readOnly = true
        continue
      case "--allow-irreversible":
        allowIrreversible = true
        continue
      case "--keep-journal":
        keepJournal = true
        continue
      case "--no-yield":
        yieldToPeople = false
        continue
      case "--max-writes": {
        const text = takeValue(args, i++, arg)
        if (!/^\d{1,6}$/.test(text) || Number(text) < 1) throw new CliError("--max-writes must be a whole number from 1 to 999999")
        maxWrites = Number(text)
        continue
      }
      case "--write-tools":
        writeTools = parseToolList(takeValue(args, i++, arg), arg, [...WriteToolNames, ...PlayToolNames])
        continue
      case "--disable-tools":
        disableTools = parseToolList(takeValue(args, i++, arg), arg, [...ReadTools.map((t) => t.name), ...WriteToolNames, ...PlayToolNames])
        continue
      case "--launch":
        launch = takeValue(args, i++, arg)
        continue
      case "--connect":
        connect = takeValue(args, i++, arg)
        continue
      case "--electron":
        electron = true
        continue
      case "--project":
        project = takeValue(args, i++, arg)
        continue
      case "--user-data":
        userData = takeValue(args, i++, arg)
        continue
      case "--host-path":
        hostPath = takeValue(args, i++, arg)
        continue
      case "--renderer":
        renderer = takeValue(args, i++, arg)
        continue
      case "--fingerprint":
        fingerprint = takeValue(args, i++, arg)
        continue
      case "--token-env":
        tokenEnv = takeValue(args, i++, arg)
        continue
      case "--token-file":
        tokenFile = takeValue(args, i++, arg)
        continue
      case "--user":
        user = takeValue(args, i++, arg)
        continue
      case "--busy-wait":
        busyWaitMs = parseMs(takeValue(args, i++, arg), arg, MaxBusyWaitMs)
        continue
      case "--call-timeout":
        callTimeoutMs = parseMs(takeValue(args, i++, arg), arg, 600000)
        continue
      case "--ready-timeout":
        readyTimeoutMs = parseMs(takeValue(args, i++, arg), arg, 600000)
        continue
      default:
        throw new CliError(`unknown option ${arg.slice(0, 40)}`)
    }
  }

  const common: CommonOptions = { allowAdmin, readOnly, allowIrreversible, maxWrites, writeTools, disableTools, keepJournal, busyWaitMs, callTimeoutMs, yield: yieldToPeople }
  const chosen = [launch !== undefined, connect !== undefined, electron].filter(Boolean).length
  if (chosen > 1) throw new CliError("--launch, --connect and --electron can't be combined")
  if (chosen === 0) throw new CliError("give --launch <projectPath>, --connect <host:port> or --electron")
  if (!electron && (project !== undefined || userData !== undefined)) throw new CliError("--project and --user-data belong to --electron")

  if (electron) {
    if (fingerprint !== undefined || tokenEnv !== undefined || tokenFile !== undefined || user !== undefined) {
      throw new CliError("--fingerprint, --token-env, --token-file and --user belong to --connect: --electron uses the editor's own secret file")
    }
    if (hostPath !== undefined || renderer !== undefined || readyTimeoutMs !== undefined) {
      throw new CliError("--host-path, --renderer and --ready-timeout belong to --launch")
    }
    if (allowAdmin) throw new CliError("--allow-admin does not apply to --electron: the agent's role in the editor is an editor's at most")
    // The editor's own dialog is the only consent; the flag changes nothing, so it is not kept
    return { mode: "electron", projectPath: project, userData, ignoredAllowIrreversible: allowIrreversible, ...common, allowIrreversible: false }
  }

  if (launch !== undefined) {
    if (fingerprint !== undefined || tokenEnv !== undefined || tokenFile !== undefined || user !== undefined) {
      throw new CliError("--fingerprint, --token-env, --token-file and --user belong to --connect: --launch makes its own token")
    }
    if (renderer !== undefined && renderer !== "opengl" && renderer !== "software") throw new CliError("--renderer must be opengl or software")
    const resolved = hostPath ?? env[HostPathEnv]
    if (!resolved) throw new CliError(`--launch needs the host: pass --host-path <N2EditorHost> or set ${HostPathEnv}`)
    return { mode: "launch", projectPath: launch, hostPath: resolved, renderer: renderer as LaunchCli["renderer"], readyTimeoutMs, ...common }
  }

  if (hostPath !== undefined || renderer !== undefined || readyTimeoutMs !== undefined) {
    throw new CliError("--host-path, --renderer and --ready-timeout belong to --launch")
  }
  const { host, port } = parseHostPort(connect!)
  if (fingerprint === undefined) throw new CliError("--connect needs --fingerprint <sha256 of the host's certificate>: there is no trust on first use")
  const normalised = normaliseFingerprint(fingerprint)
  if (normalised === null) throw new CliError("--fingerprint must be a SHA-256 fingerprint (64 hex digits, colons allowed)")
  if ((tokenEnv === undefined) === (tokenFile === undefined)) throw new CliError("--connect needs exactly one of --token-env <VARIABLE> and --token-file <path>")
  if (tokenEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw new CliError("--token-env needs an environment variable's name, not a token")
  if (user !== undefined && !/^[A-Za-z0-9._@-]{1,64}$/.test(user)) throw new CliError("--user: 1 to 64 characters of A-Z a-z 0-9 . _ @ -")
  return { mode: "connect", host, port, fingerprint: normalised, user, tokenEnv, tokenFile, ...common }
}

/**
 * The access token from where --connect says. An environment variable is removed from the process's environment once
 * read (nothing the bridge starts inherits it); a file must not be readable by group or others on POSIX (the host's own
 * rule for its tokens file). An empty or missing token is an error naming the source, never the value.
 */
export function readToken(cli: ConnectCli, env: NodeJS.ProcessEnv, removeFromEnv: boolean = true): string {
  let token: string | undefined
  if (cli.tokenEnv !== undefined) {
    token = env[cli.tokenEnv]
    if (removeFromEnv) delete env[cli.tokenEnv]
    if (token === undefined || token.trim() === "") throw new CliError(`the environment variable ${cli.tokenEnv} is not set or is empty`)
  } else {
    const file = cli.tokenFile!
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      throw new CliError("the token file can't be read")
    }
    if (!stat.isFile()) throw new CliError("the token file is not a file")
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new CliError("the token file is readable by group or others: chmod 600 it")
    }
    try {
      token = fs.readFileSync(file, "utf8")
    } catch {
      throw new CliError("the token file can't be read")
    }
    if (token.trim() === "") throw new CliError("the token file is empty")
  }
  return token.trim()
}
