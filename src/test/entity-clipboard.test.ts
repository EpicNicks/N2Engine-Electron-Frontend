import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import {
  ClipboardFormat,
  ClipboardHeader,
  MaxClipboardChars,
  clipboardText,
  parseClipboardText,
} from "../protocol/entity-clipboard"

const payload = { format: ClipboardFormat, version: 1, objectCount: 1, entities: [{ uuid: "u", name: "A" }] }

describe("entity clipboard text", () => {
  test("the text is a header line and the payload; parsing gives the payload's JSON back", () => {
    const text = clipboardText(payload)
    assert.equal(text.split("\n")[0], ClipboardHeader)
    assert.deepEqual(JSON.parse(parseClipboardText(text)!), payload)
  })

  test("text that is not ours gives null: no header, not JSON, the wrong shape, no objects", () => {
    for (const text of [
      "hello",
      "",
      JSON.stringify(payload),
      `${ClipboardHeader}\n`,
      `${ClipboardHeader}\nnot json`,
      `${ClipboardHeader}\n[1]`,
      `${ClipboardHeader}\nnull`,
      `${ClipboardHeader}\n${JSON.stringify({ ...payload, format: "other" })}`,
      `${ClipboardHeader}\n${JSON.stringify({ ...payload, entities: [] })}`,
      `${ClipboardHeader}\n${JSON.stringify({ ...payload, entities: "x" })}`,
    ]) {
      assert.equal(parseClipboardText(text), null, text)
    }
    for (const value of [null, undefined, 5, {}]) assert.equal(parseClipboardText(value), null)
  })

  test("text over the host's limit is not sent", () => {
    const text = `${ClipboardHeader}\n${JSON.stringify({ ...payload, entities: [{ pad: "x".repeat(MaxClipboardChars) }] })}`
    assert.equal(parseClipboardText(text), null)
  })
})
