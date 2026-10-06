// Registers IPC handlers that only answer the editor window and return IpcResults (errors as data)
import { IpcMain, IpcMainInvokeEvent, WebContents } from "electron"
import type { IpcResult } from "../shared/api"

export type Handler = (...args: unknown[]) => unknown

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * handle() for a channel whose result is wrapped in an IpcResult. Calls from anything but the editor window's
 * main frame are refused.
 */
export function handleResult(
  ipcMain: IpcMain,
  channel: string,
  getEditor: () => WebContents | null,
  handler: Handler
): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<IpcResult<unknown>> => {
    const editor = getEditor()
    if (!editor || event.sender !== editor || event.senderFrame !== editor.mainFrame) {
      return { ok: false, error: `${channel}: not allowed from this frame` }
    }
    try {
      return { ok: true, value: await handler(...args) }
    } catch (e) {
      return { ok: false, error: errorMessage(e) }
    }
  })
}
