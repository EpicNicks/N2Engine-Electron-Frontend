import { test, describe, beforeEach, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { PinStore, inspectPin, pinKey } from "../main/pin-store"

const A = "a".repeat(64)
const B = "b".repeat(64)

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "n2-pins-"))
  file = path.join(dir, "pinned-fingerprints.json")
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("pinKey", () => {
  test("is the lower-cased host and the port, with an IPv6 address in brackets", () => {
    assert.equal(pinKey("Example.COM", 7000), "example.com:7000")
    assert.equal(pinKey("10.0.0.5", 1), "10.0.0.5:1")
    assert.equal(pinKey("::1", 7000), "[::1]:7000")
  })
})

describe("PinStore", () => {
  test("first use: nothing is pinned, then pinning stores the fingerprint and when it was first seen", () => {
    const store = new PinStore(file)
    assert.equal(store.get("host", 7000), undefined)
    const now = new Date("2026-10-10T12:00:00Z")
    assert.deepEqual(store.pin("host", 7000, A, now), { fingerprint: A, firstSeen: "2026-10-10T12:00:00.000Z" })
    assert.deepEqual(new PinStore(file).get("host", 7000), { fingerprint: A, firstSeen: "2026-10-10T12:00:00.000Z" })
    assert.equal(store.get("host", 7001), undefined, "another port is another host")
    assert.equal(store.get("other", 7000), undefined)
  })

  test("match: pinning the same fingerprint again keeps the first-seen time", () => {
    const store = new PinStore(file)
    store.pin("host", 7000, A, new Date("2026-01-01T00:00:00Z"))
    const again = store.pin("HOST", 7000, A.toUpperCase(), new Date("2026-06-01T00:00:00Z"))
    assert.equal(again.firstSeen, "2026-01-01T00:00:00.000Z")
  })

  test("mismatch: a different fingerprint is refused, and the pin stays as it was", () => {
    const store = new PinStore(file)
    store.pin("host", 7000, A)
    assert.throws(() => store.pin("host", 7000, B), /forget the pin first/)
    assert.equal(store.get("host", 7000)?.fingerprint, A)
  })

  test("forget removes the pin, and a new fingerprint can be pinned after", () => {
    const store = new PinStore(file)
    store.pin("host", 7000, A)
    store.pin("other", 7000, B)
    store.forget("host", 7000)
    assert.equal(store.get("host", 7000), undefined)
    assert.equal(store.get("other", 7000)?.fingerprint, B, "other pins are kept")
    store.pin("host", 7000, B)
    assert.equal(store.get("host", 7000)?.fingerprint, B)
    store.forget("nothing", 1) // nothing to forget is no error
  })

  test("only a fingerprint is stored: nothing secret, whatever the caller passes", () => {
    const store = new PinStore(file)
    store.pin("host", 7000, A)
    const text = fs.readFileSync(file, "utf-8")
    assert.deepEqual(Object.keys(JSON.parse(text)["host:7000"]).sort(), ["fingerprint", "firstSeen"])
    assert.throws(() => store.pin("host", 7001, "not a fingerprint"), /SHA-256/)
  })

  test("entries that aren't valid pins (a hand-edited file) are dropped when read; fingerprints are re-normalised", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        "good:1": { fingerprint: A.toUpperCase(), firstSeen: "2026-01-01T00:00:00Z" },
        "short:1": { fingerprint: "abc", firstSeen: "2026-01-01T00:00:00Z" },
        "notime:1": { fingerprint: A },
        "junk:1": "junk",
        "null:1": null,
      })
    )
    const store = new PinStore(file)
    assert.equal(store.get("good", 1)?.fingerprint, A)
    for (const host of ["short", "notime", "junk", "null"]) assert.equal(store.get(host, 1), undefined, host)
  })

  test("a malformed or missing file is no pins", () => {
    assert.equal(new PinStore(file).get("host", 1), undefined)
    const error = console.error
    console.error = () => undefined
    try {
      fs.writeFileSync(file, "{not json")
      assert.equal(new PinStore(file).get("host", 1), undefined)
      fs.writeFileSync(file, "[]")
      assert.equal(new PinStore(file).get("host", 1), undefined)
    } finally {
      console.error = error
    }
  })

  test("a pin that can't be saved is an error, not a silent success", () => {
    fs.mkdirSync(file) // a directory where the file should be
    assert.throws(() => new PinStore(file).pin("host", 1, A))
  })
})

describe("inspectPin", () => {
  test("unknown, trusted and changed, by what is pinned", () => {
    const store = new PinStore(file)
    assert.deepEqual(inspectPin(store, "host", 7000, A), { kind: "unknown", fingerprint: A })
    store.pin("host", 7000, A, new Date("2026-02-03T00:00:00Z"))
    assert.deepEqual(inspectPin(store, "host", 7000, A), { kind: "trusted", fingerprint: A })
    assert.deepEqual(inspectPin(store, "host", 7000, B), {
      kind: "changed",
      fingerprint: B,
      pinned: A,
      firstSeen: "2026-02-03T00:00:00.000Z",
    })
  })
})
