// The system clipboard as text, for copy and paste. In Electron it is the main process's (window.systemClipboard, the
// preload's): the page's own navigator.clipboard is refused there, because the editor grants no permission. A page
// without the preload (a browser, a test) uses navigator.clipboard. No DOM types needed: unit tested in Node.
import type { SystemClipboardApi } from "../shared/api"

/** The clipboard to use: the preload's when there is one, else the browser's, else none (undefined) */
export function systemClipboardOf(scope: {
  systemClipboard?: SystemClipboardApi
  navigator?: { clipboard?: SystemClipboardApi }
}): SystemClipboardApi | undefined {
  return scope.systemClipboard ?? scope.navigator?.clipboard ?? undefined
}
