// Running an extension's menu item or inspector button, as the editor does it (design lua-editor-extensions 4.3, decision D9): the
// editor's own half-finished edits are made real and its edit groups are ended first (the host refuses an item while
// one is open, and an extension's step must never be merged into a gesture), then the item's confirm question and
// its parameter form, then InvokeMenuItem (or, for an inspector button, InvokeInspectorAction). What comes back is shown as text, the objects the item asks to select are
// selected, and the panels follow the host's events as after an undo. No DOM and no store: it is given the pieces or
// fakes, so it is unit tested in Node. Everything an extension says (message, warnings, its errors) is untrusted text.
import type {
  ExtensionErrorKind,
  ExtensionMenuItem,
  ExtensionEdit,
  ExtensionResult,
  ExtensionsResult,
  InspectorButton,
  InvokeResult,
} from "../protocol/extensions"
import { MaxInvokeSelection } from "../protocol/extensions"
import type { JsonObject } from "../shared/api"

/** How a run ended */
export type RunOutcome =
  /** The item ran: one undo step, or none if it changed nothing */
  | "ok"
  /** Not sent: the editor can't run it now (a refusal with a message) */
  | "refused"
  /** The user answered No to the confirm question or Cancel to the form */
  | "cancelled"
  /** The host refused or the item failed (the failure was reported) */
  | "failed"

/** What a run needs to know of what it runs: a menu item and an inspector button (its label is the title) both fit */
export type Runnable = Pick<ExtensionMenuItem, "id" | "title" | "confirm" | "form">

/** Where the run was started from: the wording of a refusal differs */
export type Surface = "menu" | "inspector"

/** An inspector button as something to run */
export function runnableOf(button: InspectorButton): Runnable {
  return { id: button.id, title: button.label, form: button.form }
}

/** What the run needs of the page: each is the real thing in the editor and a fake in tests */
export interface RunDeps {
  invoke(itemId: string, selection: string[], params: JsonObject, uiRevision: number): Promise<ExtensionsResult<InvokeResult>>
  /** InvokeInspectorAction: an inspector button, on one component */
  invokeInspector(componentId: string, actionId: string, params: JsonObject, uiRevision: number): Promise<ExtensionsResult<InvokeResult>>
  /** The selected objects' ids, now */
  selection(): string[]
  /** Why an item can't be run now (read-only, viewer, no scene, ...), or null */
  blockedReason(): string | null
  /** Sends what the inspector and the hierarchy hold back, and waits for what is running (as before an undo) */
  settle(): Promise<void>
  /** Ends the edit groups the editor still has open */
  closeGroups(): Promise<void>
  /** How many edit groups are open (after closeGroups) */
  openGroups(): number
  /** The item's confirm question; true for yes */
  confirm(message: string, okLabel: string): Promise<boolean>
  /** The item's form dialog: the checked params, null when cancelled */
  askForm(item: Runnable): Promise<JsonObject | null>
  /** Marks the item (or none) as running, for the spinner and for disabling the menu */
  setRunning(itemId: string | null): void
  /** The host's events are polled and the history read, so the panels show what the item did */
  syncAfterEdit(): Promise<void>
  /** Takes the answer's revisions as the scene's (undoing back to the saved state clears the unsaved marker) */
  applyEdit(edit: ExtensionEdit): void
  /** Selects these objects once the hierarchy has been read again */
  applySelection(ids: string[]): Promise<void>
  /** The editor's own notes in the console, and the result for the notice */
  note(level: "info" | "warn" | "error", message: string): void
  showResult(item: Pick<Runnable, "title">, result: ExtensionResult): void
  /** A failure for the error banner; code is the host's ErrorCoded code when it gave one, surface where the run started */
  fail(what: string, message: string, code?: string, surface?: Surface): void
  /** The menu and the extension list are fetched again (the host's UI changed under the editor) */
  refreshUi(): Promise<void>
}

/** What a failed InvokeMenuItem means to the person, and whether the editor's copy of the UI is out of date */
export function describeInvokeFailure(
  kind: ExtensionErrorKind,
  hostMessage: string,
  item: Pick<Runnable, "title">,
  surface: Surface = "menu"
): { text: string; refreshUi: boolean; syncScene: boolean } {
  switch (kind) {
    case "staleUi":
      return {
        text:
          surface === "menu"
            ? "The extensions changed since the Tools menu was built, so nothing ran. The menu was refreshed: run the item again if you still want it."
            : "The extensions changed since this section was built, so nothing ran. The inspector was refreshed: press the button again if you still want it.",
        refreshUi: true,
        syncScene: false,
      }
    case "editGroupOpen":
      return { text: "An edit is still in progress, so nothing ran. Finish it, then run the item again.", refreshUi: false, syncScene: false }
    case "failed":
      // The host's text says the changes were taken back, and why (with no host path)
      return { text: hostMessage, refreshUi: true, syncScene: true }
    case "faulted":
      return {
        text: `${item.title} did not run: its extension is disabled until it is reloaded. An admin can reload it in Project Settings, Extensions.`,
        refreshUi: true,
        syncScene: false,
      }
    case "disabled":
      return { text: "Editor extensions are not enabled on this host, so nothing ran.", refreshUi: true, syncScene: false }
    case "forbidden":
      return { text: `Your role may not run ${item.title}: ${hostMessage}`, refreshUi: false, syncScene: false }
    case "readOnly":
      return { text: `${item.title} did not run: ${hostMessage}`, refreshUi: false, syncScene: false }
    default:
      return { text: hostMessage, refreshUi: false, syncScene: false }
  }
}

/**
 * Runs one menu item: settle, close the groups, confirm, form, InvokeMenuItem, then show the result. uiRevision is the
 * one of the GetEditorUi the menu was built from, so a host whose extensions changed since refuses it (staleUi). Never
 * throws: a failure is reported through deps and the outcome says so.
 */
export async function runMenuItem(item: ExtensionMenuItem, uiRevision: number, deps: RunDeps): Promise<RunOutcome> {
  const refuse = (message: string): RunOutcome => {
    deps.fail(item.title, message, undefined, "menu")
    return "refused"
  }
  const blocked = deps.blockedReason()
  if (blocked !== null) return refuse(`It can't run now: ${blocked}`)
  // What is selected when the item is chosen is what it runs on, whatever happens while the dialogs are open
  const selection = deps.selection()
  if (selection.length > MaxInvokeSelection) {
    return refuse(`It runs on at most ${MaxInvokeSelection} objects, and ${selection.length} are selected.`)
  }
  return runAction(item, "menu", deps, (params) => deps.invoke(item.id, selection, params, uiRevision))
}

/**
 * Runs one button of an inspector section on one component: the same steps as a menu item (settle, close the groups,
 * form, the host's call, the result), with InvokeInspectorAction as the call. componentId is the component the inspector
 * showed when the button was pressed; uiRevision the one of the GetEditorUi the section was built from.
 */
export async function runInspectorButton(
  button: InspectorButton,
  componentId: string,
  uiRevision: number,
  deps: RunDeps
): Promise<RunOutcome> {
  const item = runnableOf(button)
  const blocked = deps.blockedReason()
  if (blocked !== null) {
    deps.fail(item.title, `It can't run now: ${blocked}`, undefined, "inspector")
    return "refused"
  }
  return runAction(item, "inspector", deps, (params) => deps.invokeInspector(componentId, button.id, params, uiRevision))
}

/** The steps both share, from the settled editor to the shown result; send makes the host's call with the form's params */
async function runAction(
  item: Runnable,
  surface: Surface,
  deps: RunDeps,
  send: (params: JsonObject) => Promise<ExtensionsResult<InvokeResult>>
): Promise<RunOutcome> {
  const refuse = (message: string): RunOutcome => {
    deps.fail(item.title, message, undefined, surface)
    return "refused"
  }
  deps.setRunning(item.id)
  try {
    await deps.settle()
    await deps.closeGroups()
    if (deps.openGroups() > 0) return refuse("An edit is still in progress. Finish it, then run the item again.")

    if (item.confirm !== undefined && !(await deps.confirm(item.confirm, "Run"))) return "cancelled"
    let params: JsonObject = {}
    if (item.form !== undefined && item.form.fields.length > 0) {
      const asked = await deps.askForm(item)
      if (asked === null) return "cancelled"
      params = asked
    }
    // The dialogs took time: the host may have become read-only, the scene been closed, or a play session started
    const blockedNow = deps.blockedReason()
    if (blockedNow !== null) return refuse(`It can't run now: ${blockedNow}`)

    const answer = await send(params)
    if (answer.status === "unsupported") {
      return refuse(
        surface === "menu"
          ? "This host can't run menu items (they need protocol 1.15.0)."
          : "This host can't run inspector buttons (they need protocol 1.16.0)."
      )
    }
    if (answer.status === "error") {
      const failure = describeInvokeFailure(answer.kind, answer.message, item, surface)
      deps.fail(item.title, failure.text, answer.code, surface)
      deps.note("error", `${item.title}: ${failure.text}`)
      // A failed item took its changes back, and the scene's revision moved there and back: the panels hear of it
      if (failure.syncScene) await deps.syncAfterEdit().catch(() => undefined)
      if (failure.refreshUi) await deps.refreshUi().catch(() => undefined)
      return "failed"
    }

    const { result, edit } = answer.value
    deps.applyEdit(edit)
    await deps.syncAfterEdit().catch(() => undefined)
    if (result.select.length > 0) await deps.applySelection(result.select).catch(() => undefined)
    deps.showResult(item, result)
    deps.note("info", `${item.title}: ${result.message === "" ? "done" : result.message}`)
    for (const warning of result.warnings) deps.note("warn", `${item.title}: ${warning}`)
    return "ok"
  } finally {
    deps.setRunning(null)
  }
}
