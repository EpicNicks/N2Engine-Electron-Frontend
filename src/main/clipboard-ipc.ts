// The system clipboard for the page, as text (window.systemClipboard). The page's navigator.clipboard needs the
// clipboard-read and clipboard-sanitized-write permissions, which the editor refuses with every other permission
// (main.ts); Electron's own clipboard module, in the main process, needs none. Only the editor page may call it.
import type { IpcMain } from "electron"
import { Channels } from "../shared/api"
import { handleResult, type EditorPage } from "./ipc"

/** The most text (UTF-16 code units) the page may put on the clipboard: well above the host's 16 MiB for copied objects */
export const MaxClipboardTextLength = 64 * 1024 * 1024

/** What this reads and writes: Electron's clipboard module, or a fake */
export interface TextClipboard {
  readText(): string
  writeText(text: string): void
}

export function registerClipboardIpc(ipc: IpcMain, deps: { page: EditorPage; clipboard: TextClipboard }): void {
  handleResult(ipc, Channels.clipboardReadText, deps.page, () => deps.clipboard.readText())
  handleResult(ipc, Channels.clipboardWriteText, deps.page, (text) => {
    if (typeof text !== "string") throw new Error("The clipboard text must be a string")
    if (text.length > MaxClipboardTextLength) throw new Error("The text is too long for the clipboard")
    deps.clipboard.writeText(text)
  })
}
