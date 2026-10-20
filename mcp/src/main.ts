// n2-mcp: the stdio MCP server for N2Engine editor hosts. stdout carries MCP messages and nothing else; the log goes to
// stderr, scrubbed (the access token and the host's paths never appear). The host is reached lazily, on the first
// tool call, so a client that only probes the server (server/discover, tools/list) neither holds the host's one session
// nor starts a host.
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { Bridge } from "./bridge"
import { CliError, parseArgs, readToken, Usage, type Cli } from "./cli"
import { connectConnector, launchConnector, type HostConnector } from "./host"
import { Scrubber } from "./scrub"
import { createServer } from "./server"
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
      })
    } else {
      const token = readToken(cli, process.env)
      scrubber.addSecret(token)
      connector = connectConnector({ host: cli.host, port: cli.port, fingerprint: cli.fingerprint, token, user: cli.user })
    }
  } catch (e) {
    return fail(e instanceof CliError ? e.message : "could not start")
  }

  const bridge = new Bridge({
    connector,
    scrubber,
    allowAdmin: cli.allowAdmin,
    busyWaitMs: cli.busyWaitMs,
    callTimeoutMs: cli.callTimeoutMs,
    log,
  })
  const handle = serveStdio(() => createServer(bridge), { onerror: (e) => log(`transport error: ${e.message}`) })
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
