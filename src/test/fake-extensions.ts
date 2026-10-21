// A fake page for the extensions state (extensions-state.ts): an engine that answers ListEditorExtensions, GetEditorUi,
// ReloadEditorExtensions, InvokeMenuItem and InvokeInspectorAction as the test says, signals for the connection and the selection, and every
// step of a run recorded in `log` in the order it happened. Shared by the Node tests and the DOM tests.
import { signal, type Signal } from "@preact/signals-core"
import type { FieldSchema } from "../protocol/protocol.generated"
import type {
  ExtensionMenuItem,
  ExtensionSummary,
  ExtensionsInfo,
  ExtensionsResult,
  ExtensionsUi,
  InspectorButton,
  InspectorSection,
  InvokeResult,
} from "../protocol/extensions"
import type { JsonObject, ServerInfo } from "../shared/api"
import { ExtensionsState, type ExtensionsDeps } from "../renderer/extensions-state"
import type { HostRole } from "../renderer/store"

export const Uuid = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`

/** A menu item with the defaults the host gives */
export function menuItem(id: string, path: string, over: Partial<ExtensionMenuItem> = {}): ExtensionMenuItem {
  return {
    id,
    extension: "Align Tools",
    path,
    title: path.split("/").pop() ?? id,
    enabledWhen: { selection: "any" },
    minRole: "editor",
    ...over,
  }
}

/** A form field as the host's FieldSchema has it */
export function field(name: string, kind: string, over: Partial<FieldSchema> = {}): FieldSchema {
  return { name, displayName: name, kind, typeName: kind === "Int" ? "int" : kind === "Float" ? "float" : kind, hidden: false, readOnly: false, ...over }
}

/** An inspector button as the host declares it */
export function inspectorButton(id: string, label: string, over: Partial<InspectorButton> = {}): InspectorButton {
  return { id, label, minRole: "editor", ...over }
}

/** An inspector section for a component type, with the host's defaults */
export function inspectorSection(componentType: string, over: Partial<InspectorSection> = {}): InspectorSection {
  return { componentType, extension: "Align Tools", label: componentType + " tools", fields: [], buttons: [], ...over }
}

export function summary(over: Partial<ExtensionSummary> = {}): ExtensionSummary {
  return {
    id: "AlignTools.lua",
    name: "Align Tools",
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    apiVersion: 1,
    state: "loaded",
    capabilities: ["scene.read", "scene.write"],
    itemCount: 1,
    ...over,
  }
}

export function invokeResult(over: Partial<InvokeResult["result"]> = {}): InvokeResult {
  return {
    result: { message: "", select: [], warnings: [], ...over },
    edit: { label: "Snap", revision: 7, savedRevision: 3, canUndo: true, canRedo: false },
  }
}

export function serverInfo(over: Partial<ServerInfo> = {}): ServerInfo {
  return {
    protocolVersion: "1.16.0",
    engineVersion: "1.0.0",
    capabilities: ["editorExtensions"],
    projectLoaded: true,
    readOnly: false,
    user: "",
    role: "",
    ...over,
  }
}

export interface FakeExtensions {
  state: ExtensionsState
  /** The host's answers: change them, then call state.refresh() or bump changeCount */
  host: { info: ExtensionsInfo; ui: ExtensionsUi; listError: string | null; reloadAnswer: ExtensionsResult<ExtensionsInfo> | null }
  /** What InvokeMenuItem answers (a function sees the call) */
  invokeAnswer: ExtensionsResult<InvokeResult> | ((call: InvokeCall) => ExtensionsResult<InvokeResult> | Promise<ExtensionsResult<InvokeResult>>)
  invokes: InvokeCall[]
  /** What InvokeInspectorAction answers (a function sees the call) */
  inspectorAnswer:
    | ExtensionsResult<InvokeResult>
    | ((call: InspectorCall) => ExtensionsResult<InvokeResult> | Promise<ExtensionsResult<InvokeResult>>)
  inspectorInvokes: InspectorCall[]
  /** Calls to the engine, and every step of a run, in order */
  log: string[]
  connected: Signal<boolean>
  info: Signal<ServerInfo | null>
  changeCount: Signal<number>
  role: Signal<HostRole | null>
  openGroups: Signal<number>
  blocked: { reason: string | null }
  selection: { ids: string[] }
  components: Map<string, string[]>
  answers: { confirm: boolean; form: JsonObject | null }
  confirms: string[]
  forms: string[]
  selected: string[][]
  notes: Array<[string, string]>
  failures: Array<{ what: string; message: string; code?: string }>
  edits: Array<{ revision: number; savedRevision: number }>
  /** Groups the fake still has open after closeGroups (a group the editor can't end) */
  stuckGroups: { count: number }
  /** Runs while the form dialog is open (the world changes under the person) */
  hooks: { onForm: (() => void) | null }
}

export interface InspectorCall {
  componentId: string
  actionId: string
  params: JsonObject
  uiRevision: number
}

export interface InvokeCall {
  itemId: string
  selection: string[]
  params: JsonObject
  uiRevision: number
}

/** A state over a fake host that has extensions on and one item, "align.snap", at Tools/Align/Snap */
export function fakeExtensions(
  over: {
    items?: ExtensionMenuItem[]
    sections?: InspectorSection[]
    enabled?: boolean
    info?: ServerInfo | null
    role?: HostRole | null
    extensions?: ExtensionSummary[]
    /** Replaces some of the run's pieces (the DOM tests use the page's real confirm and form dialogs) */
    run?: Partial<ExtensionsDeps["run"]>
  } = {}
): FakeExtensions {
  const log: string[] = []
  const items = over.items ?? [menuItem("align.snap", "Tools/Align/Snap", { title: "Snap to grid" })]
  const connected = signal(true)
  const info = signal<ServerInfo | null>(over.info === undefined ? serverInfo() : over.info)
  const changeCount = signal(0)
  const role = signal<HostRole | null>(over.role === undefined ? "admin" : over.role)
  const openGroups = signal(0)
  const fake = {
    host: {
      info: { enabled: over.enabled ?? true, uiRevision: 4, extensions: over.extensions ?? [summary({ itemCount: items.length })] },
      ui: { uiRevision: 4, menuItems: items, inspectorSections: over.sections ?? [] } as ExtensionsUi,
      listError: null as string | null,
      reloadAnswer: null as ExtensionsResult<ExtensionsInfo> | null,
    },
    invokeAnswer: { status: "ok", value: invokeResult() } as FakeExtensions["invokeAnswer"],
    invokes: [] as InvokeCall[],
    inspectorAnswer: { status: "ok", value: invokeResult() } as FakeExtensions["inspectorAnswer"],
    inspectorInvokes: [] as InspectorCall[],
    log,
    connected,
    info,
    changeCount,
    role,
    openGroups,
    blocked: { reason: null as string | null },
    selection: { ids: [Uuid(1), Uuid(2)] },
    components: new Map<string, string[]>(),
    answers: { confirm: true, form: {} as JsonObject | null },
    confirms: [] as string[],
    forms: [] as string[],
    selected: [] as string[][],
    notes: [] as Array<[string, string]>,
    failures: [] as Array<{ what: string; message: string; code?: string }>,
    edits: [] as Array<{ revision: number; savedRevision: number }>,
    stuckGroups: { count: 0 },
    hooks: { onForm: null as (() => void) | null },
  }
  const state = new ExtensionsState({
    engine: {
      listEditorExtensions: async () => {
        log.push("list")
        return fake.host.listError === null
          ? { status: "ok", value: fake.host.info }
          : { status: "error", kind: "other", message: fake.host.listError }
      },
      getEditorUi: async () => {
        log.push("ui")
        return { status: "ok", value: fake.host.ui }
      },
      reloadEditorExtensions: async () => {
        log.push("reload")
        return fake.host.reloadAnswer ?? { status: "ok", value: fake.host.info }
      },
      invokeMenuItem: async (itemId, selection, params, uiRevision) => {
        log.push("invoke")
        const call = { itemId, selection, params, uiRevision }
        fake.invokes.push(call)
        return typeof fake.invokeAnswer === "function" ? await fake.invokeAnswer(call) : fake.invokeAnswer
      },
      invokeInspectorAction: async (componentId, actionId, params, uiRevision) => {
        log.push("invokeInspector")
        const call = { componentId, actionId, params, uiRevision }
        fake.inspectorInvokes.push(call)
        return typeof fake.inspectorAnswer === "function" ? await fake.inspectorAnswer(call) : fake.inspectorAnswer
      },
    },
    connected,
    serverInfo: info,
    changeCount,
    role,
    blockedReason: () => fake.blocked.reason,
    openGroups,
    selection: () => [...fake.selection.ids],
    componentsOf: (id) => fake.components.get(id),
    run: {
      settle: async () => void log.push("settle"),
      closeGroups: async () => {
        log.push("closeGroups")
        openGroups.value = fake.stuckGroups.count
      },
      confirm: async (message) => {
        log.push("confirm")
        fake.confirms.push(message)
        return fake.answers.confirm
      },
      askForm: async (item) => {
        log.push("form")
        fake.forms.push(item.id)
        fake.hooks.onForm?.()
        return fake.answers.form
      },
      syncAfterEdit: async () => void log.push("sync"),
      applyEdit: (edit) => {
        log.push("applyEdit")
        fake.edits.push({ revision: edit.revision, savedRevision: edit.savedRevision })
      },
      applySelection: async (ids) => {
        log.push("select")
        fake.selected.push(ids)
      },
      note: (level, message) => void fake.notes.push([level, message]),
      fail: (what, message, code) => void fake.failures.push({ what, message, code }),
      ...over.run,
    },
  })
  return Object.assign(fake, { state })
}
