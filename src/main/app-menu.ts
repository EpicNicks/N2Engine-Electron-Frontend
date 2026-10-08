// The application menu on macOS. There the menu bar's Edit items own Cmd+Z and Cmd+Shift+Z (Electron's default menu binds
// them to the web contents' own undo, which never reaches the editor's history), so the Edit menu is ours: Undo and Redo
// send the command to the page, which runs the host's undo, or the focused text field's own when one has the focus
// (editor.tsx). Windows and Linux have no menu bar here, and the page handles the keys itself. Pure data, so it is unit
// tested without Electron.
import type { MenuItemConstructorOptions } from "electron"
import type { EditCommand } from "../shared/api"

export function buildAppMenuTemplate(appName: string, send: (command: EditCommand) => void): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", click: () => send("undo") },
        { label: "Redo", accelerator: "Shift+CmdOrCtrl+Z", click: () => send("redo") },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }] },
  ]
}
