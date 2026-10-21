// The trust question for a project's editor extensions, as a native dialog of the main process (extension-trust.ts
// decides when to ask). It is a main-process dialog, not a page dialog, because its answer gates the host's
// arguments: the page cannot answer it for the user. "Not now" is the default button and what Escape and closing do.
import { BrowserWindow, dialog } from "electron"
import { EditorFolderScan, trustPromptText } from "./extension-trust"

/** The buttons, in order: the safe answer is the default (index 1) and the cancel answer */
export const TrustButtons = ["Trust", "Not now"] as const

/** Asks whether to trust the project's editor extensions; true only for the Trust button */
export async function askTrust(
  window: BrowserWindow | null,
  projectDir: string,
  scan: EditorFolderScan
): Promise<boolean> {
  const { message, detail } = trustPromptText(projectDir, scan)
  const options = {
    type: "warning" as const,
    buttons: [...TrustButtons],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: "Editor extensions",
    message,
    detail,
  }
  const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
  return result.response === 0
}
