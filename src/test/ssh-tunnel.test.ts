import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { ChildProcess, SpawnOptions } from "node:child_process"
import {
  RemoteSettings,
  SpawnFunction,
  SshTunnel,
  buildSshArgs,
  describeRemote,
  identityProblem,
  parseAllocatedPort,
  parseRemoteSettings,
  portProblem,
  quoteStderr,
  resolveSshPath,
  sshHint,
  targetProblem,
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
      "dev@my_alias",
      "dev@build_box.internal",
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

  test("host:port forms are refused with a pointer to the port field", () => {
    for (const target of ["dev@1.2.3.4:22", "dev@cloud.example.com:2222", "dev@host:"]) {
      assert.match(targetProblem(target) ?? "", /Put the port in the SSH port field/, target)
    }
  })

  test("domain users are refused, and the message says so", () => {
    assert.match(targetProblem("CORP\\alice@host") ?? "", /Domain users \(DOMAIN\\user\) aren't supported/)
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
      { target: "dev@host", hostPort: 7000 },
    )
    assert.deepEqual(
      parseRemoteSettings({ target: "dev@host", sshPort: 2222, identityFile: "/k/id", hostPort: 7000 }),
      {
        target: "dev@host",
        sshPort: 2222,
        identityFile: "/k/id",
        hostPort: 7000,
      },
    )
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
  test("lets ssh pick the loopback port, never asks anything, keeps a ControlMaster out, and ends the options before the target", () => {
    assert.deepEqual(buildSshArgs(remote), [
      "-N",
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "-o",
      "LogLevel=INFO",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-L",
      "127.0.0.1:0:127.0.0.1:7777",
      "--",
      "dev@cloud.example.com",
    ])
  })

  test("the ssh port and identity file are separate arguments", () => {
    const args = buildSshArgs({ ...remote, sshPort: 2222, identityFile: "C:\\keys\\my key" })
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
    assert.throws(() => buildSshArgs({ target: "-oProxyCommand=x@y", hostPort: 1 }), /can't start with '-'/)
  })

  test("nothing in the arguments looks like a token (the token is never given to this module)", () => {
    const args = buildSshArgs(remote).join(" ")
    assert.ok(!/token/i.test(args))
  })
})

describe("parseAllocatedPort", () => {
  test("reads ssh's line, with or without a carriage return", () => {
    assert.equal(parseAllocatedPort("Allocated port 50123 for local forward to 127.0.0.1:7777"), 50123)
    assert.equal(parseAllocatedPort("Allocated port 50123 for local forward to 127.0.0.1:7777\r"), 50123)
  })

  test("anything else isn't it", () => {
    for (const line of [
      "",
      "Allocated port 0 for local forward to 127.0.0.1:7777",
      "Allocated port 99999 for local forward to x",
      "Allocated port 5 for remote forward to x",
      "debug1: Allocated port 50123 for local forward to 127.0.0.1:7777",
      "Warning: Permanently added 'host' to the list of known hosts.",
    ]) {
      assert.equal(parseAllocatedPort(line), null, line)
    }
  })
})

describe("resolveSshPath", () => {
  test("on Windows, the system's OpenSSH when it exists", () => {
    const system = "C:\\Windows\\System32\\OpenSSH\\ssh.exe"
    assert.equal(
      resolveSshPath("win32", { SystemRoot: "C:\\Windows" }, (f) => f === system),
      system,
    )
    assert.equal(
      resolveSshPath("win32", { windir: "C:\\Windows" }, (f) => f === system),
      system,
    )
  })

  test("else ssh from the PATH", () => {
    assert.equal(
      resolveSshPath("win32", { SystemRoot: "C:\\Windows" }, () => false),
      "ssh",
    )
    assert.equal(
      resolveSshPath("win32", {}, () => true),
      "ssh",
    )
    assert.equal(
      resolveSshPath("linux", { SystemRoot: "C:\\Windows" }, () => true),
      "ssh",
    )
    assert.equal(
      resolveSshPath("darwin", {}, () => true),
      "ssh",
    )
  })
})

describe("sshHint", () => {
  test("an unknown host key says which ssh to run once, with the port and target", () => {
    const hint = sshHint(["Host key verification failed."], "C:\\Windows\\System32\\OpenSSH\\ssh.exe", {
      ...remote,
      sshPort: 2222,
    })
    assert.match(hint, /C:\\Windows\\System32\\OpenSSH\\ssh\.exe -p 2222 dev@cloud\.example\.com/)
    assert.match(hint, /Windows' OpenSSH and Git's ssh keep separate known_hosts/)
    assert.match(
      sshHint(["Host key verification failed."], "C:\\Program Files\\ssh.exe", remote),
      /"C:\\Program Files\\ssh\.exe" dev@/,
    )
  })

  test("other failures have no hint", () => {
    assert.equal(sshHint(["Permission denied (publickey)."], "ssh", remote), "")
    assert.equal(sshHint([], "ssh", remote), "")
  })
})

describe("quoteStderr", () => {
  test("quotes the lines without blanks and carriage returns, or nothing", () => {
    assert.equal(quoteStderr(["a\r", "", "  ", "b"]), ":\na\nb")
    assert.equal(quoteStderr([]), "")
  })
})

const allocated = "Allocated port 50123 for local forward to 127.0.0.1:7777\n"

describe("SshTunnel.open", () => {
  const open = (extra: Partial<Parameters<typeof SshTunnel.open>[0]> = {}) => {
    const spawned = fakeSpawn()
    const options = {
      settings: remote,
      spawn: spawned.spawn,
      sshPath: "ssh",
      env: { SSH_AUTH_SOCK: "/agent" } as NodeJS.ProcessEnv,
      ...extra,
    }
    return { spawned, opening: SshTunnel.open(options) }
  }

  test("spawns ssh without a shell, with the arguments as an array, and resolves only once ssh says its forward listens", async () => {
    const { spawned, opening } = open()
    let resolved = false
    void opening.then(() => (resolved = true))
    await settle()
    const [call] = spawned.calls
    assert.equal(call.command, "ssh")
    assert.deepEqual(call.args, buildSshArgs(remote))
    assert.ok(!call.options.shell, "no shell")
    assert.deepEqual(call.options.stdio, ["ignore", "ignore", "pipe"])
    assert.deepEqual(call.options.env, { SSH_AUTH_SOCK: "/agent" })
    // Chatter, and a banner that isn't the line: not ready
    call.child.stderr.write("Warning: Permanently added 'cloud' to the list of known hosts.\n")
    await settle()
    assert.equal(resolved, false, "nothing but ssh's own line makes it ready")
    call.child.stderr.write(allocated)
    const tunnel = await opening
    assert.equal(tunnel.localPort, 50123, "the port ssh allocated")
    assert.equal(tunnel.pid, 777)
    assert.equal(tunnel.exited, false)
    assert.ok(!tunnel.lastOutput.includes("Allocated"), "the line isn't an error to quote")
    assert.match(tunnel.lastOutput, /known hosts/)
  })

  test("a line split across chunks is still read", async () => {
    const { spawned, opening } = open()
    await settle()
    spawned.calls[0].child.stderr.write("Allocated port 50")
    await settle()
    spawned.calls[0].child.stderr.write("123 for local forward to 127.0.0.1:7777\r\n")
    assert.equal((await opening).localPort, 50123)
  })

  test("ssh ending first fails with its exit and stderr", async () => {
    const { spawned, opening } = open()
    await settle()
    spawned.calls[0].child.stderr.write("dev@cloud: Permission denied (publickey).\n")
    spawned.calls[0].child.exit(255)
    await assert.rejects(
      opening,
      /ssh exited with code 255 before the tunnel was up:\ndev@cloud: Permission denied \(publickey\)\./,
    )
  })

  test("an unknown host key adds the hint with the ssh that was run", async () => {
    const { spawned, opening } = open({ sshPath: "C:\\Windows\\System32\\OpenSSH\\ssh.exe" })
    await settle()
    spawned.calls[0].child.stderr.write("Host key verification failed.\n")
    spawned.calls[0].child.exit(255)
    await assert.rejects(
      opening,
      /Host key verification failed\.\nssh doesn't trust this host's key[^]*C:\\Windows\\System32\\OpenSSH\\ssh\.exe dev@cloud\.example\.com/,
    )
  })

  test("ssh that never says its forward is up times out, is killed and quotes what it said", async () => {
    const { spawned, opening } = open({ readyTimeoutMs: 30 })
    await settle()
    spawned.calls[0].child.stderr.write("Warning: something\n")
    await assert.rejects(opening, /didn't report its forward within 0.03 s[^]*Allocated port[^]*:\nWarning: something/)
    assert.equal(spawned.calls[0].child.killed, 1)
  })

  test("a port that merely accepts connections is not enough: no listener is probed", async () => {
    // Another process listening where ssh was meant to be would be trusted by a probe; here only ssh's line counts
    const { spawned, opening } = open({ readyTimeoutMs: 20 })
    await assert.rejects(opening, /didn't report its forward/)
    assert.equal(spawned.calls.length, 1)
  })

  test("a missing ssh says so", async () => {
    const { spawned, opening } = open()
    await settle()
    const error = Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" })
    spawned.calls[0].child.emit("error", error)
    await assert.rejects(opening, /Couldn't start ssh: spawn ssh ENOENT \(is the OpenSSH client installed\?\)/)
  })

  test("a spawn that throws is reported", async () => {
    await assert.rejects(
      SshTunnel.open({
        settings: remote,
        sshPath: "ssh",
        spawn: () => {
          throw new Error("EACCES")
        },
      }),
      /Couldn't start ssh: EACCES/,
    )
  })

  test("refuses invalid settings before spawning anything", async () => {
    const spawned = fakeSpawn()
    await assert.rejects(
      SshTunnel.open({ settings: { target: "-oProxyCommand=x@y", hostPort: 1 }, spawn: spawned.spawn }),
      /can't start with '-'/,
    )
    assert.equal(spawned.calls.length, 0)
  })

  test("an already aborted signal spawns nothing", async () => {
    const spawned = fakeSpawn()
    const abort = new AbortController()
    abort.abort()
    await assert.rejects(
      SshTunnel.open({ settings: remote, spawn: spawned.spawn, signal: abort.signal }),
      /^Error: Cancelled:/,
    )
    assert.equal(spawned.calls.length, 0, "no orphan ssh after quitting")
  })

  test("aborting while ssh connects kills it and rejects as cancelled", async () => {
    const abort = new AbortController()
    const { spawned, opening } = open({ signal: abort.signal })
    await settle()
    abort.abort()
    await assert.rejects(opening, /Cancelled: the tunnel was closed while it opened/)
    assert.equal(spawned.calls[0].child.killed, 1)
  })

  test("aborting after the tunnel is up does nothing to it", async () => {
    const abort = new AbortController()
    const { spawned, opening } = open({ signal: abort.signal })
    await settle()
    spawned.calls[0].child.stderr.write(allocated)
    const tunnel = await opening
    abort.abort()
    await settle()
    assert.equal(tunnel.exited, false)
    assert.equal(spawned.calls[0].child.killed, 0)
  })

  test("onSpawned's kill ends a tunnel that is still opening", async () => {
    let kill: (() => void) | null = null
    const { spawned, opening } = open({ onSpawned: (k) => (kill = k) })
    await settle()
    kill!()
    await assert.rejects(opening, /ssh was ended by SIGTERM before the tunnel was up/)
    assert.equal(spawned.calls[0].child.killed, 1)
  })

  test("once open, a tunnel's death is reported with ssh's last stderr lines, and kill() after it does nothing", async () => {
    const exits: Array<[unknown, SshTunnel]> = []
    const { spawned, opening } = open({ onExit: (exit, tunnel) => exits.push([exit, tunnel]) })
    await settle()
    const child = spawned.calls[0].child
    child.stderr.write(allocated)
    const tunnel = await opening
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
    const { spawned, opening } = open()
    await settle()
    spawned.calls[0].child.stderr.write(allocated)
    const tunnel = await opening
    const exited = new Promise<void>((resolve) => tunnel.onExit(() => resolve()))
    tunnel.kill()
    await exited
    assert.equal(spawned.calls[0].child.killed, 1)
    assert.equal(tunnel.exit?.signal, "SIGTERM")
  })
})
