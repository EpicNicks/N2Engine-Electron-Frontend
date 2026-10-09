import { test, describe, beforeEach, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { MaxRecentRemotes, RecentRemotes } from "../main/recent-remotes"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "n2-remotes-"))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("RecentRemotes", () => {
  test("keeps remotes newest first, one per address and ports", () => {
    const recent = new RecentRemotes(path.join(dir, "recent-remotes.json"))
    assert.deepEqual(recent.list(), [])
    recent.add({ target: "a@x", hostPort: 1 })
    recent.add({ target: "b@x", sshPort: 2222, identityFile: "/k", hostPort: 2 })
    recent.add({ target: "a@x", hostPort: 1, identityFile: "/new" })
    assert.deepEqual(recent.list(), [
      { target: "a@x", hostPort: 1, identityFile: "/new" },
      { target: "b@x", sshPort: 2222, identityFile: "/k", hostPort: 2 },
    ])
    recent.remove({ target: "b@x", sshPort: 2222, hostPort: 2 })
    assert.deepEqual(recent.list(), [{ target: "a@x", hostPort: 1, identityFile: "/new" }])
  })

  test("saves only the settings: no token, whatever the caller passes", () => {
    const file = path.join(dir, "recent-remotes.json")
    new RecentRemotes(file).add({ target: "a@x", hostPort: 1, token: "s3cret", password: "p" } as never)
    const text = fs.readFileSync(file, "utf-8")
    assert.ok(!text.includes("s3cret") && !text.includes("password"))
    assert.deepEqual(JSON.parse(text), [{ target: "a@x", hostPort: 1 }])
  })

  test("entries that aren't valid remotes (a hand-edited file) are dropped when read", () => {
    const file = path.join(dir, "recent-remotes.json")
    fs.writeFileSync(
      file,
      JSON.stringify([
        { target: "-oProxyCommand=x@y", hostPort: 1 },
        { target: "ok@host", hostPort: 5 },
        "junk",
        null,
        { target: "ok@h", hostPort: 0 },
      ])
    )
    assert.deepEqual(new RecentRemotes(file).list(), [{ target: "ok@host", hostPort: 5 }])
  })

  test("a malformed or missing file is an empty list", () => {
    const file = path.join(dir, "recent-remotes.json")
    assert.deepEqual(new RecentRemotes(file).list(), [])
    fs.writeFileSync(file, "{not json")
    const error = console.error
    console.error = () => {}
    try {
      assert.deepEqual(new RecentRemotes(file).list(), [])
    } finally {
      console.error = error
    }
    fs.writeFileSync(file, JSON.stringify({ a: 1 }))
    assert.deepEqual(new RecentRemotes(file).list(), [])
  })

  test(`keeps at most ${MaxRecentRemotes}`, () => {
    const recent = new RecentRemotes(path.join(dir, "recent-remotes.json"))
    for (let i = 0; i < MaxRecentRemotes + 4; i++) recent.add({ target: `u@h${i}`, hostPort: 1 })
    const list = recent.list()
    assert.equal(list.length, MaxRecentRemotes)
    assert.equal(list[0].target, `u@h${MaxRecentRemotes + 3}`)
  })

  test("add refuses invalid settings", () => {
    const recent = new RecentRemotes(path.join(dir, "recent-remotes.json"))
    assert.throws(() => recent.add({ target: "-x@y", hostPort: 1 }), /can't start with '-'/)
  })
})
