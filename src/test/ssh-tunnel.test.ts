import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import * as net from "node:net"
import { ChildProcess, SpawnOptions } from "node:child_process"
import {
  RemoteSettings,
  SpawnFunction,
  SshTunnel,
  buildSshArgs,
  describeRemote,
  identityProblem,
  parseRemoteSettings,
  pickFreePort,
  portProblem,
  quoteStderr,
  targetProblem,
  tryConnect,
  waitForForward,
} from "../main/ssh-tunnel"

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** An ssh process whose stderr, exit and kill the test controls */
class FakeSsh extends EventEmitter {
  stdout = null
  stdin = null
  stderr = new PassThrough()
  pid = 777
  killed = 0
  private closed = false
  kill(): boolean {
    this.killed++
    setImmediate(() => this.exit(null, "SIGTERM"))
    return true
  }
  /** Ends stderr, then reports the exit as Node does ("exit", then "close") */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return
    this.closed = true
    this.stderr.end()
    this.emit("exit", code, signal)
    setImmediate(() => this.emit("close", code, signal))
  }
}

function fakeSpawn() {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions; child: FakeSsh }> = []
  const spawn: SpawnFunction = (command, args, options) => {
    const child = new FakeSsh()
    calls.push({ command, args, options, child })
    return child as unknown as ChildProcess
  }
  return { calls, spawn }
}

const remote: RemoteSettings = { target: "dev@cloud.example.com", hostPort: 7777 }

describe("remote settings validation", () => {
  test("user@host forms are accepted", () => {
    for (const target of [
      "dev@cloud.example.com",
      "a@b",
      "ubuntu@10.0.0.5",
      "me_1@host-2.local",
      "root@fe80::1",
      "x@2001:db8::1",
    ]) {
      assert.equal(targetProblem(target), null, target)
    }
  })

  test("anything that could be an ssh option or a second argument is refused", () => {
    for (const target of [
      "-oProxyCommand=calc@host",
      "-o",
      "dev@-oProxyCommand=x",
      "@host",
      "dev@",
      "dev",
      "",
      "dev@host name",
      "dev@host;rm -rf",
      "dev@host\nProxyCommand x",
      "a@b@c",
      "dev@ho$(st)",
      "d ev@host",
      "dev@host,other",
    ]) {
      assert.notEqual(targetProblem(target), null, JSON.stringify(target))
    }
    assert.notEqual(targetProblem(42), null)
    assert.notEqual(targetProblem(undefined), null)
    assert.notEqual(targetProblem("a@" + "h".repeat(300)), null)
  })

  test("a host name that starts with - is refused after the @ too", () => {
    assert.notEqual(targetProblem("dev@-host"), null)
  })

  test("ports are whole numbers from 1 to 65535", () => {
    for (const port of [1, 22, 65535]) assert.equal(portProblem(port, "p"), null)
    for (const port of [0, -1, 65536, 1.5, NaN, "22", null, undefined]) assert.notEqual(portProblem(port, "p"), null)
  })

  test("an identity file can't start with - or hold control characters", () => {
    assert.equal(identityProblem("C:\\Users\\me\\.ssh\\id_ed25519"), null)
    assert.equal(identityProblem("/home/me/my key"), null)
    for (const file of ["-oProxyCommand=x", "", "a\nb", "a\0b", 5]) assert.notEqual(identityProblem(file), null)
  })

  test("parseRemoteSettings keeps only the known fields, treats empty optional fields as unset and trims", () => {
    assert.deepEqual(
      parseRemoteSettings({
        target: " dev@host ",
        sshPort: "",
        identityFile: "  ",
        hostPort: 7000,
        token: "leak",
        extra: 1,
      }),
      { target: "dev@host", hostPort: 7000 }
    )
    assert.deepEqual(parseRemoteSettings({ target: "dev@host", sshPort: 2222, identityFile: "/k/id", hostPort: 7000 }), {
      target: "dev@host",
      sshPort: 2222,
      identityFile: "/k/id",
      hostPort: 7000,
    })
  })

  test("parseRemoteSettings refuses what isn't valid", () => {
    assert.throws(() => parseRemoteSettings(null), /Invalid remote settings/)
    assert.throws(() => parseRemoteSettings([]), /Invalid remote settings/)
    assert.throws(() => parseRemoteSettings({ target: "-x@y", hostPort: 1 }), /can't start with '-'/)
    assert.throws(() => parseRemoteSettings({ target: "a@b" }), /host's port/)
    assert.throws(() => parseRemoteSettings({ target: "a@b", hostPort: 99999 }), /host's port/)
    assert.throws(() => parseRemoteSettings({ target: "a@b", hostPort: 1, sshPort: 0 }), /SSH port/)
    assert.throws(() => parseRemoteSettings({ target: "a@b", hostPort: 1, identityFile: "-i" }), /identity file/)
  })

  test("describeRemote", () => {
    assert.equal(describeRemote(remote), "dev@cloud.example.com:7777")
  })
})

describe("buildSshArgs", () => {
  test("forwards a loopback port to the host's loopback port, never asks anything, and ends the options before the target", () => {
    assert.deepEqual(buildSshArgs(remote, 50123), [
      "-N",
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-L",
      "127.0.0.1:50123:127.0.0.1:7777",
      "--",
      "dev@cloud.example.com",
    ])
  })

  test("the ssh port and identity file are separate arguments", () => {
    const args = buildSshArgs({ ...remote, sshPort: 2222, identityFile: "C:\\keys\\my key" }, 50123)
    assert.deepEqual(args.slice(args.indexOf("-p"), args.indexOf("--")), [
      "-p",
      "2222",
      "-i",
      "C:\\keys\\my key",
      "-o",
      "IdentitiesOnly=yes",
    ])
    assert.equal(args[args.length - 1], "dev@cloud.example.com")
  })

  test("refuses settings an address could inject options with", () => {
    assert.throws(() => buildSshArgs({ target: "-oProxyCommand=x@y", hostPort: 1 }, 5000), /can't start with '-'/)
    assert.throws(() => buildSshArgs(remote, 0), /local port/)
  })

  test("nothing in the arguments looks like a token (the token is never given to this module)", () => {
    const args = buildSshArgs(remote, 5000).join(" ")
    assert.ok(!/token/i.test(args))
  })
})

describe("pickFreePort, tryConnect and waitForForward", () => {
  test("pickFreePort gives a port nothing listens on, and tryConnect sees a listener", async () => {
    const port = await pickFreePort()
    assert.ok(port >= 1 && port <= 65535)
    assert.equal(await tryConnect(port), false)
    const server = net.createServer((socket) => socket.destroy())
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
    try {
      assert.equal(await tryConnect(port), true)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test("waitForForward polls until the connection works", async () => {
    let tries = 0
    await waitForForward(5000, { timeoutMs: 1000, intervalMs: 1, connect: async () => ++tries >= 4 })
    assert.equal(tries, 4)
  })

  test("waitForForward gives up after the timeout", async () => {
    await assert.rejects(
      waitForForward(5000, { timeoutMs: 20, intervalMs: 5, connect: async () => false }),
      /wasn't ready within 0.02 s/
    )
  })

  test("waitForForward stops when aborted, with the reason", async () => {
    const abort = new AbortController()
    let tries = 0
    const waiting = waitForForward(5000, {
      timeoutMs: 10000,
      intervalMs: 1,
      signal: abort.signal,
      connect: async () => {
        if (++tries === 3) abort.abort(new Error("ssh ended"))
        return false
      },
    })
    await assert.rejects(waiting, /ssh ended/)
    assert.equal(tries, 3)
  })
})

describe("quoteStderr", () => {
  test("quotes the lines without blanks and carriage returns, or nothing", () => {
    assert.equal(quoteStderr(["a\r", "", "  ", "b"]), ":\na\nb")
    assert.equal(quoteStderr([]), "")
  })
})

describe("SshTunnel.open", () => {
  const open = (extra: Partial<Parameters<typeof SshTunnel.open>[0]> = {}) => {
    const spawned = fakeSpawn()
    const options = {
      settings: remote,
      spawn: spawned.spawn,
      pickPort: async () => 50123,
      pollIntervalMs: 1,
      env: { SSH_AUTH_SOCK: "/agent" } as NodeJS.ProcessEnv,
      ...extra,
    }
    return { spawned, opening: SshTunnel.open(options) }
  }

  test("spawns ssh without a shell, with the arguments as an array, and resolves once the forward accepts connections", async () => {
    let up = false
    const { spawned, opening } = open({ connect: async (port) => (port === 50123 ? up : false) })
    await settle()
    const [call] = spawned.calls
    assert.equal(call.command, "ssh")
    assert.deepEqual(call.args, buildSshArgs(remote, 50123))
    assert.ok(!call.options.shell, "no shell")
    assert.deepEqual(call.options.stdio, ["ignore", "ignore", "pipe"])
    assert.deepEqual(call.options.env, { SSH_AUTH_SOCK: "/agent" })
    up = true
    const tunnel = await opening
    assert.equal(tunnel.localPort, 50123)
    assert.equal(tunnel.pid, 777)
    assert.equal(tunnel.exited, false)
  })

  test("ssh ending first fails with its exit and stderr", async () => {
    const { spawned, opening } = open({ connect: async () => false })
    await settle()
    spawned.calls[0].child.stderr.write("dev@cloud: Permission denied (publickey).\n")
    spawned.calls[0].child.exit(255)
    await assert.rejects(
      opening,
      /ssh exited with code 255 before the tunnel was up:\ndev@cloud: Permission denied \(publickey\)\./
    )
  })

  test("a forward that never comes up times out, kills ssh and quotes what it said", async () => {
    const { spawned, opening } = open({ connect: async () => false, readyTimeoutMs: 30 })
    await settle()
    spawned.calls[0].child.stderr.write("Warning: something\n")
    await assert.rejects(opening, /wasn't ready within 0.03 s:\nWarning: something/)
    assert.equal(spawned.calls[0].child.killed, 1)
  })

  test("a missing ssh says so", async () => {
    const { spawned, opening } = open({ connect: async () => false })
    await settle()
    const error = Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" })
    spawned.calls[0].child.emit("error", error)
    await assert.rejects(opening, /Couldn't start ssh: spawn ssh ENOENT \(is the OpenSSH client installed\?\)/)
  })

  test("a spawn that throws is reported", async () => {
    await assert.rejects(
      SshTunnel.open({
        settings: remote,
        pickPort: async () => 5000,
        spawn: () => {
          throw new Error("EACCES")
        },
      }),
      /Couldn't start ssh: EACCES/
    )
  })

  test("refuses invalid settings before spawning anything", async () => {
    const spawned = fakeSpawn()
    await assert.rejects(
      SshTunnel.open({
        settings: { target: "-oProxyCommand=x@y", hostPort: 1 },
        spawn: spawned.spawn,
        pickPort: async () => 5000,
      }),
      /can't start with '-'/
    )
    assert.equal(spawned.calls.length, 0)
  })

  test("onSpawned's kill ends a tunnel that is still opening", async () => {
    let kill: (() => void) | null = null
    const { spawned, opening } = open({ connect: async () => false, onSpawned: (k) => (kill = k) })
    await settle()
    kill!()
    await assert.rejects(opening, /ssh was ended by SIGTERM before the tunnel was up/)
    assert.equal(spawned.calls[0].child.killed, 1)
  })

  test("once open, a tunnel's death is reported with ssh's last stderr lines, and kill() after it does nothing", async () => {
    const exits: Array<[unknown, SshTunnel]> = []
    const { spawned, opening } = open({ connect: async () => true, onExit: (exit, tunnel) => exits.push([exit, tunnel]) })
    const tunnel = await opening
    const child = spawned.calls[0].child
    for (let i = 1; i <= 12; i++) child.stderr.write(`line ${i}\n`)
    child.stderr.write("Timeout, server cloud not responding.\n")
    child.exit(255)
    await settle()
    await settle()
    assert.equal(tunnel.exited, true)
    assert.deepEqual(tunnel.exit, { code: 255, signal: null })
    assert.equal(exits.length, 1)
    assert.equal(exits[0][1], tunnel)
    const lines = tunnel.lastOutput.split("\n")
    assert.equal(lines[0], ":")
    assert.equal(lines.length, 9, "the last 8 lines")
    assert.equal(lines[lines.length - 1], "Timeout, server cloud not responding.")
    tunnel.kill()
    assert.equal(child.killed, 0, "already gone")
  })

  test("kill() ends a running tunnel", async () => {
    const { spawned, opening } = open({ connect: async () => true })
    const tunnel = await opening
    const exited = new Promise<void>((resolve) => tunnel.onExit(() => resolve()))
    tunnel.kill()
    await exited
    assert.equal(spawned.calls[0].child.killed, 1)
    assert.equal(tunnel.exit?.signal, "SIGTERM")
  })
})
