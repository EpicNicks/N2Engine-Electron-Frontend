// The system clipboard through the main process (clipboard-ipc.ts): the page's navigator.clipboard is refused in
// Electron (main.ts grants no permission), so copy and paste read and write Electron's clipboard over IPC.
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import type { IpcMain } from "electron"
import { MaxClipboardTextLength, registerClipboardIpc } from "../main/clipboard-ipc"
import { Channels, type SystemClipboardApi } from "../shared/api"
import { systemClipboardOf } from "../renderer/system-clipboard"

function rig() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const frame = { url: "file:///app/src/index.html" }
  const editor = { mainFrame: frame }
  const board = { text: "" }
  registerClipboardIpc(
    { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn) } as unknown as IpcMain,
    {
      page: { getEditor: () => editor as never, url: frame.url },
      clipboard: {
        readText: () => board.text,
        writeText: (text) => {
          board.text = text
        },
      },
    }
  )
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: editor, senderFrame: frame }, ...args)
  return { handlers, editor, frame, board, invoke }
}

describe("the clipboard IPC", () => {
  test("writes and reads the system clipboard's text", async () => {
    const r = rig()
    assert.deepEqual(await r.invoke(Channels.clipboardWriteText, '{"format":"n2engine.entities"}'), { ok: true, value: undefined })
    assert.equal(r.board.text, '{"format":"n2engine.entities"}')
    r.board.text = "from another window"
    assert.deepEqual(await r.invoke(Channels.clipboardReadText), { ok: true, value: "from another window" })
  })

  test("only text, and not too much of it, is written", async () => {
    const r = rig()
    r.board.text = "kept"
    for (const bad of [42, null, { text: "x" }, "x".repeat(MaxClipboardTextLength + 1)]) {
      const result = (await r.invoke(Channels.clipboardWriteText, bad)) as { ok: boolean }
      assert.equal(result.ok, false)
    }
    assert.equal(r.board.text, "kept")
  })

  test("a call from anything but the editor page is refused, and reads nothing", async () => {
    const r = rig()
    r.board.text = "secret"
    const other = { url: "file:///elsewhere.html" }
    const fromFrame = (await r.handlers.get(Channels.clipboardReadText)!({ sender: r.editor, senderFrame: other })) as { ok: boolean; value?: unknown }
    assert.equal(fromFrame.ok, false)
    assert.equal(fromFrame.value, undefined)
    const fromSender = (await r.handlers.get(Channels.clipboardWriteText)!({ sender: {}, senderFrame: r.frame }, "x")) as { ok: boolean }
    assert.equal(fromSender.ok, false)
    assert.equal(r.board.text, "secret")
  })
})

describe("the page's clipboard", () => {
  const api = (name: string): SystemClipboardApi & { name: string } => ({ name, readText: async () => name, writeText: async () => {} })

  test("is the preload's when there is one (Electron), else the browser's, else none", () => {
    const preload = api("preload")
    const browser = api("browser")
    assert.equal(systemClipboardOf({ systemClipboard: preload, navigator: { clipboard: browser } }), preload)
    assert.equal(systemClipboardOf({ navigator: { clipboard: browser } }), browser)
    assert.equal(systemClipboardOf({ navigator: {} }), undefined)
    assert.equal(systemClipboardOf({}), undefined)
  })
})
