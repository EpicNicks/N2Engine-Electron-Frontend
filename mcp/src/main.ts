// n2-mcp: the stdio MCP server for N2Engine editor hosts. stdout carries MCP messages and nothing else; the log goes to
// stderr, scrubbed (the access token and the host's paths never appear). The host is reached lazily, on the first
// tool call, so a client that only probes the server (server/discover, tools/list) neither holds the host's one session
// nor starts a host.
import { Bridge } from "./bridge"
import { CliError, parseArgs, readToken, Usage, type Cli } from "./cli"
import { connectConnector, launchConnector, type HostConnector } from "./host"
import type { Policy } from "./policy"
import { Scrubber } from "./scrub"
import { serveBridge } from "./server"
import { SessionManager, createBackupStore } from "./session"
import { BridgeName, BridgeVersion } from "./version"

function fail(message: string): never {
  process.stderr.write(`${BridgeName}: ${message}\n`)
  process.exit(2)
}

function main(): void {
  const scrubber = new Scrubber()
  const log = (message: string): void => {
    process.stderr.write(`[${BridgeName}] ${scrubber.message(message, 1000)}\n`)
  }
  // Nothing may write to stdout but the MCP transport: a stray console.log would corrupt the stream
  console.log = console.error
  console.info = console.error

  let cli: Cli
  try {
    cli = parseArgs(process.argv.slice(2), process.env)
  } catch (e) {
    process.stderr.write(`${BridgeName}: ${e instanceof CliError ? e.message : "bad arguments"}\n\n${Usage}`)
    process.exit(2)
  }
  if (cli.mode === "help") {
    process.stdout.write(Usage)
    process.exit(0)
  }
  if (cli.mode === "version") {
    process.stdout.write(`${BridgeName} ${BridgeVersion}\n`)
    process.exit(0)
  }

  let connector: HostConnector
  try {
    if (cli.mode === "launch") {
      connector = launchConnector({
        hostPath: cli.hostPath,
        projectPath: cli.projectPath,
        renderer: cli.renderer,
        readyTimeoutMs: cli.readyTimeoutMs,
        scrubber,
        log,
        yield: cli.yield,
      })
    } else {
      const token = readToken(cli, process.env)
      scrubber.addSecret(token)
      connector = connectConnector({ host: cli.host, port: cli.port, fingerprint: cli.fingerprint, token, user: cli.user, yield: cli.yield })
    }
  } catch (e) {
    return fail(e instanceof CliError ? e.message : "could not start")
  }

  const policy: Policy = {
    readOnly: cli.readOnly,
    allowIrreversible: cli.allowIrreversible,
    maxWrites: cli.maxWrites,
    writeTools: cli.writeTools === null ? null : new Set(cli.writeTools),
    disabledTools: new Set(cli.disableTools),
    keepJournal: cli.keepJournal,
  }
  const bridge = new Bridge({
    connector,
    scrubber,
    allowAdmin: cli.allowAdmin,
    policy,
    sessions: new SessionManager({ maxWrites: policy.maxWrites, store: createBackupStore({ keep: policy.keepJournal }) }),
    busyWaitMs: cli.busyWaitMs,
    callTimeoutMs: cli.callTimeoutMs,
    log,
    // The play tools: a game of the bridge's own, from the same host, project and renderer (--launch only, design M9)
    ...(cli.mode === "launch"
      ? { play: { hostPath: cli.hostPath, projectPath: cli.projectPath, renderer: cli.renderer, readyTimeoutMs: cli.readyTimeoutMs } }
      : {}),
  })
  const handle = serveBridge(bridge, { onerror: (e) => log(`transport error: ${e.message}`) })
  log(`${BridgeVersion} serving on stdio (${cli.mode})`)

  let closing = false
  const shutdown = (code: number): void => {
    if (closing) return
    closing = true
    bridge.dispose()
    const force = setTimeout(() => process.exit(code), 1500)
    force.unref()
    handle.close().then(
      () => process.exit(code),
      () => process.exit(code)
    )
  }
  process.stdin.on("end", () => shutdown(0))
  process.stdin.on("close", () => shutdown(0))
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => shutdown(0))
  // Last resort, synchronous: the launched host and its token file must not outlive this process
  process.on("exit", () => bridge.dispose())
}

main()
