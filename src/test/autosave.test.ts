import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { describeAutosave, formatBytes, sceneKey, shouldOfferAutosave } from "../renderer/autosave"

const scene = (revision: number, savedRevision: number) => ({
  path: "res://scenes/Main.scene",
  name: "Main",
  uuid: "u1",
  revision,
  savedRevision,
})

describe("autosave recovery", () => {
  test("sizes are read as people read them", () => {
    assert.equal(formatBytes(0), "0 B")
    assert.equal(formatBytes(512), "512 B")
    assert.equal(formatBytes(1536), "1.5 KB")
    assert.equal(formatBytes(20 * 1024), "20 KB")
    assert.equal(formatBytes(3.2 * 1024 * 1024), "3.2 MB")
    assert.equal(formatBytes(5 * 1024 ** 3), "5.0 GB")
    assert.equal(formatBytes(2048 * 1024 ** 3), "2048 GB")
    assert.equal(formatBytes(-1), "unknown size")
    assert.equal(formatBytes(NaN), "unknown size")
  })

  test("it is offered for a scene with no unsaved changes, and for no other", () => {
    assert.equal(shouldOfferAutosave(scene(3, 3), { exists: true }), true)
    assert.equal(shouldOfferAutosave(scene(5, 3), { exists: true }), false, "the host's own copy of what is open")
    assert.equal(shouldOfferAutosave(scene(3, 3), { exists: false }), false)
  })

  test("the question names the scene, when and how large, and what deciding later means", () => {
    const text = describeAutosave("Main", { exists: true, size: 2048, modified: 1000 }, (ms) => `at ${ms}`)
    assert.match(text, /^Main has an autosave from a session that ended with unsaved changes \(written at 1000, 2\.0 KB\)\./)
    assert.match(text, /Restore it \(one step, which Undo takes back\), or discard it\?/)
    assert.match(text, /no new autosave/)
  })

  test("it copes with an autosave that has no size or time, and a scene with no name", () => {
    assert.match(describeAutosave("", { exists: true }), /^Untitled has an autosave from a session that ended with unsaved changes\./)
    assert.match(describeAutosave("Main", { exists: true, size: 10 }), /\(10 B\)/)
    assert.match(describeAutosave("Main", { exists: true, modified: 5 }, () => "t"), /\(written t\)/)
  })

  test("a scene is the same one by its file and its UUID", () => {
    assert.equal(sceneKey(scene(1, 1)), sceneKey(scene(9, 2)))
    assert.notEqual(sceneKey(scene(1, 1)), sceneKey({ ...scene(1, 1), uuid: "u2" }))
    assert.notEqual(sceneKey(scene(1, 1)), sceneKey({ ...scene(1, 1), path: "" }))
  })
})

describe("autosave wording", () => {
  test("a time of 0 is unknown: no 1970 date", () => {
    const text = describeAutosave("Main", { exists: true, size: 10, modified: 0 }, () => "1970")
    assert.doesNotMatch(text, /written|1970/)
    assert.match(text, /\(10 B\)/)
  })

  test("an untitled scene's autosave may be another untitled scene's, and the question says so", () => {
    const text = describeAutosave("", { exists: true, size: 10 }, undefined, true)
    assert.match(text, /^The untitled scene has an autosave, which may be of another untitled scene/)
    assert.match(text, /refused\), from a session that ended with unsaved changes \(10 B\)\./)
  })
})
