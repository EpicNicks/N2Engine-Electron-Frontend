// Registers IPC handlers that only answer the editor window and return IpcResults (errors as data)
import { IpcMain, IpcMainInvokeEvent, WebContents } from "electron"
import type { IpcResult } from "../shared/api"

export type Handler = (...args: unknown[]) => unknown

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * The ErrorCoded code of an EngineError (the host's denial: "readOnly", "forbidden") or of a HostBusyError ("busy",
 * the answer to a Hello); undefined for any other error
 */
export function errorCode(e: unknown): string | undefined {
  if (!(e instanceof Error) || (e.name !== "EngineError" && e.name !== "HostBusyError")) return undefined
  const code = (e as { code?: unknown }).code
  return typeof code === "string" && code !== "" ? code : undefined
}

/** The page allowed to call the IPC API: the editor window's main frame, showing the editor's own index.html */
export interface EditorPage {
  getEditor(): WebContents | null
  /** The page's file:// URL (without query or fragment) */
  url: string
}

/** Whether an IPC call comes from the editor page: the right window, its main frame, and the expected URL */
export function isFromEditorPage(
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  page: EditorPage
): boolean {
  const editor = page.getEditor()
  const frame = event.senderFrame
  if (!editor || event.sender !== editor || !frame || frame !== editor.mainFrame) return false
  return frame.url.split(/[?#]/)[0] === page.url
}

/** handle() for a channel whose result is wrapped in an IpcResult. Calls from anything but the editor page fail. */
export function handleResult(ipcMain: IpcMain, channel: string, page: EditorPage, handler: Handler): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<IpcResult<unknown>> => {
    if (!isFromEditorPage(event, page)) {
      return { ok: false, error: `${channel}: not allowed from this frame` }
    }
    try {
      return { ok: true, value: await handler(...args) }
    } catch (e) {
      const code = errorCode(e)
      return code === undefined ? { ok: false, error: errorMessage(e) } : { ok: false, error: errorMessage(e), code }
    }
  })
}
