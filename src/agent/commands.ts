// Which editor protocol commands an AI agent may send through the editor's agent endpoint (MCP6), and what kind each is.
// The endpoint speaks the editor protocol's own framing; this table is its allowlist: a command that is not here is
// refused whatever the client says. Node only (no Electron), shared by the editor's main process and the n2-mcp bridge.
//
// Kept out on purpose, so an agent can never reach them through the editor: Hello's own handling (the endpoint answers it
// itself), Shutdown, the play commands (a game is the bridge's own second host, never the editor's), the Lua editor
// extension commands (they run code on the host), and everything the n2-mcp tools do not need (prefab files, physics and
// network settings, audio, legacy scene and camera commands, the editor view's wireframe).
import { CommandType } from "../protocol/protocol.generated"

type Name = keyof typeof CommandType

/**
 * - read: answers from the scene or the project; nothing changes
 * - view: the editor view's size or camera, and rendering with them (the endpoint saves and restores the person's view)
 * - write: changes the scene; it runs inside an edit group labelled "AI: ..." (the endpoint makes one when the agent did not)
 * - file: makes a file or folder; not part of the undo history
 * - irreversible: cannot be taken back from the editor's undo: the person confirms it in a native dialog first
 * - history: Undo and Redo (confirmed natively when the step is not the agent's own)
 * - group: BeginEditGroup and EndEditGroup
 */
export type AgentCommandClass = "read" | "view" | "write" | "file" | "irreversible" | "history" | "group"

const table: Array<[AgentCommandClass, Name[]]> = [
  [
    "read",
    [
      "PollEvents",
      "GetCameraPosition",
      "GetEditorCamera",
      "PickEntity",
      "GetEntityBounds",
      "GetOpenScene",
      "GetHierarchy",
      "GetEntityTransform",
      "GetEntity",
      "SerializeEntities",
      "GetEngineHealth",
      "GetComponentTypes",
      "GetComponent",
      "GetLuaFields",
      "GetProjectInfo",
      "GetHistory",
      "GetAutosave",
      "ListAssets",
      "GetAssetInfo",
      "ReadTextAsset",
      "CheckLuaSyntax",
      "GetAssetPreview",
    ],
  ],
  ["view", ["SetViewportSize", "SetEditorCamera", "RenderFrame", "RenderFrameIfChanged"]],
  [
    "write",
    [
      "CreateEntityEx",
      "DestroyEntity",
      "SetEntityParent",
      "SetEntityProperties",
      "DuplicateEntity",
      "SetLocalTransform",
      "AddComponent",
      "RemoveComponent",
      "SetComponentFields",
    ],
  ],
  ["file", ["CreateScriptAsset", "CreateFolder", "RescanAssets"]],
  [
    "irreversible",
    ["SaveSceneToFile", "OpenScene", "NewScene", "SetProjectSettings", "SetStartupScene", "SetImportSettings", "WriteTextAsset", "RestoreAutosave", "DiscardAutosave"],
  ],
  ["history", ["Undo", "Redo"]],
  ["group", ["BeginEditGroup", "EndEditGroup"]],
]

const classes = new Map<number, AgentCommandClass>()
for (const [cls, names] of table) for (const name of names) classes.set(CommandType[name], cls)

const names = new Map<number, string>(Object.entries(CommandType).map(([name, id]) => [id, name]))

/** The class of a command id, or undefined when an agent may not send it */
export function agentClassOf(type: number): AgentCommandClass | undefined {
  return classes.get(type)
}

/** The command's protocol name ("SetViewportSize"), or "command 0x.." for an id this editor does not know */
export function commandName(type: number): string {
  return names.get(type) ?? `command 0x${type.toString(16)}`
}

/** Classes that change the project or the scene: a viewer, or a read-only editor, may not send them */
export function needsWriteRights(cls: AgentCommandClass): boolean {
  return cls === "write" || cls === "file" || cls === "irreversible" || cls === "history" || cls === "group"
}

/** The ErrorCoded codes the endpoint answers with, beside the host's own "readOnly" and "forbidden" */
export const AgentCodes = {
  /** The person said no in the native dialog (or did not answer in time) */
  declined: "confirmationDeclined",
  /** Too many requests queued, or the editor stayed busy with the person's own work */
  busy: "editorBusy",
  rateLimited: "rateLimited",
  tooLarge: "tooLarge",
  /** EndEditGroup with no group of the agent open */
  noGroup: "noGroup",
  /** The command is not one an agent may send through the editor */
  notAllowed: "forbidden",
  readOnly: "readOnly",
} as const

/** Every edit group label the agent's steps get starts with this (the person sees these in the Edit menu and history) */
export const AgentLabelPrefix = "AI: "

/** The host's longest edit label, in bytes */
export const MaxLabelBytes = 100

/** A label that starts with "AI: " and is at most MaxLabelBytes bytes long */
export function agentLabel(label: string): string {
  const text = label.startsWith(AgentLabelPrefix) ? label : AgentLabelPrefix + label
  let out = text
  while (Buffer.byteLength(out, "utf8") > MaxLabelBytes) out = out.slice(0, -1)
  return out
}

export const isAgentLabel = (label: string): boolean => label.startsWith(AgentLabelPrefix)
