// The typed API between the page and the Electron main process. The page (sandboxed, no Node) sees window.engine
// and window.project; the preload forwards each call over IPC; the main process owns the engine connection and the
// project's files. Types and plain constants only: this file is imported by all three sides.

import type {
  AutosaveInfo,
  CameraPositionResponse,
  EditResultResponse,
  EditorCameraResponse,
  PickResultResponse,
  BoundsResponse,
  ComponentSchema,
  EngineHealthResponse,
  EntityDataResponse,
  EventsResponse,
  FrameDataResponse,
  FrameUpdateResponse,
  HierarchyResponse,
  HistoryResponse,
  InputEvent,
  ProjectInfoResponse,
  SceneInfoResponse,
  ServerInfoResponse,
  Quat,
  Vec3,
} from "../protocol/protocol.generated"
import type { AudioSamples } from "../audio-stream"

/** Protocol commands, each forwarded to the EngineClient method of the same name in the main process */
export interface EngineCommands {
  renderFrame(): Promise<FrameDataResponse>
  setViewportSize(width: number, height: number): Promise<void>
  /**
   * The editor view's frame (RGBA, top row first) only when it changed since sinceRevision (0: whenever; protocol
   * 1.7.0): modified false carries the current revision and no pixels
   */
  renderFrameIfChanged(sinceRevision: number): Promise<FrameUpdateResponse>
  /** The editor camera's pose (protocol 1.7.0); the server owns it, it isn't saved and isn't part of undo */
  setEditorCamera(
    position: Vec3,
    rotation: Quat,
    fovY: number,
    orthographic: boolean,
    orthoSize: number,
    nearPlane: number,
    farPlane: number
  ): Promise<void>
  /** The editor camera as stored, with the view and projection matrices frames are rendered with */
  getEditorCamera(): Promise<EditorCameraResponse>
  /** The object under a pixel of the editor view (protocol 1.8.0; frame pixels, top-left origin); entityId "" is a miss */
  pickEntity(x: number, y: number, includeInactive: boolean): Promise<PickResultResponse>
  /** World boxes of objects (protocol 1.8.0; at most MaxEntityBoundsIds ids); an object that can't be measured has no entry */
  getEntityBounds(entityIds: string[]): Promise<BoundsResponse>
  /**
   * Drains the server's audio stream: only the page's AudioPlayer should call it, or the player loses audio.
   * Null when the server has no audio stream (not on a loopback device).
   */
  getAudio(): Promise<AudioSamples | null>

  setCameraPosition(x: number, y: number, z: number): Promise<void>
  getCameraPosition(): Promise<CameraPositionResponse>

  /** Scenes of the project (protocol 1.3): a scene is a .scene file, a path like res://assets/scenes/main.scene */
  openScene(path: string): Promise<SceneInfoResponse>
  /** Empty path: the scene's own file */
  saveSceneToFile(path: string): Promise<SceneInfoResponse>
  newScene(path: string, name: string): Promise<SceneInfoResponse>
  getOpenScene(): Promise<SceneInfoResponse>

  /** The project (protocol 1.3): project.n2proj and its settings */
  getProjectInfo(): Promise<ProjectInfoResponse>
  /** settings: a JSON merge patch object (RFC 7386: a null value removes the key) */
  setProjectSettings(settings: JsonObject): Promise<ProjectInfoResponse>
  setStartupScene(path: string): Promise<ProjectInfoResponse>

  createScript(name: string): Promise<string>
  rescanAssets(): Promise<void>

  getEngineHealth(): Promise<EngineHealthResponse>

  /**
   * PollEvents: the host's events after afterSeq in epoch (0, 0 for everything it still keeps), at most maxEvents
   * (the host caps a response at 1024). Poll again with the response's epoch and nextSeq (see EventPump).
   */
  pollEvents(epoch: number, afterSeq: number, maxEvents: number): Promise<EventsResponse>

  createEntity(name: string): Promise<string>
  destroyEntity(entityId: string): Promise<void>

  setEntityTransform(entityId: string, position: Vec3, rotation: Vec3, scale: Vec3): Promise<void>
  getEntityTransform(entityId: string): Promise<{ position: Vec3; rotation: Vec3; scale: Vec3 }>

  /**
   * The loaded scene's objects as one flat depth-first list (a parent before its children), and the scene revision
   * it was read at (protocol 1.4). Refetch it when a sceneChanged event moves the revision. Error with no scene.
   */
  getHierarchy(): Promise<HierarchyResponse>
  /**
   * Makes an object with a transform (protocol 1.4). preset: empty/Empty, Cube, Sphere, Quad, Light or
   * DirectionalLight, PointLight, SpotLight. An empty name is the preset's own. parentId empty: a root of the scene.
   * siblingIndex: its place among its siblings, -1 (or past the last) for the last. Answers the new object's id.
   */
  createEntityEx(name: string, parentId: string, siblingIndex: number, preset: string): Promise<string>
  /**
   * Moves an object under another (empty parentId: a root) at siblingIndex among its new siblings (-1 or past the
   * last: the last); also reorders within one parent. keepWorldTransform true keeps where it is in the world (its
   * local transform changes), false keeps its local transform. Error for a parent that is the object or under it.
   */
  setEntityParent(entityId: string, parentId: string, siblingIndex: number, keepWorldTransform: boolean): Promise<void>
  /**
   * Changes an object's own properties: any of name (string), active (boolean), tag (string), layer (integer 0 to
   * 31). An unknown key or a bad value is an Error and nothing changes.
   */
  setEntityProperties(entityId: string, properties: JsonObject): Promise<void>
  /** Copies an object and everything under it, right after the original among its siblings; answers the copy's id */
  duplicateEntity(entityId: string): Promise<string>
  /** One object in full: header, local transform, components' saved values, and its local-to-world matrix */
  getEntity(entityId: string): Promise<EntityDataResponse>
  /** Sets an object's transform relative to its parent; rotation is a quaternion (the host normalises it) */
  setLocalTransform(entityId: string, position: Vec3, rotation: Quat, scale: Vec3): Promise<void>

  /**
   * Every component type the host can create (protocol 1.5), sorted by name, each with its fields, whether an object
   * can have only one (singleton) and its defaults. Needs no scene; the types don't change while the host runs.
   */
  getComponentTypes(): Promise<ComponentSchema[]>
  /**
   * Adds a component of a listed type, with its default values, to an object. Answers its UUID and its values (what
   * getComponent gives). Error for an unknown type, or a singleton the object already has.
   */
  addComponent(entityId: string, typeName: string): Promise<{ componentId: string; values: unknown }>
  removeComponent(entityId: string, componentId: string): Promise<void>
  /**
   * Sets fields of one component from a partial of what getComponent returns, all or nothing (an Error names the
   * field that was refused). Answers the component's values as stored (a clamped number, an enum in its canonical
   * spelling). A request that changes scriptUUID mustn't also send scriptData.
   */
  setComponentFields(entityId: string, componentId: string, values: JsonObject): Promise<unknown>
  /** A component's saved values, the JSON getEntity lists under components */
  getComponent(entityId: string, componentId: string): Promise<unknown>
  /** A LuaComponent's fields as its script declares them (each with container "scriptData"); ask again after the script changes */
  getLuaFields(entityId: string, componentId: string): Promise<ComponentSchema>

  /**
   * Undoes the latest step that is done (protocol 1.6): answers its label, the scene revisions after it and what can
   * still be undone or redone. Error with nothing to undo, while an edit group is open, and outside edit mode.
   */
  undo(): Promise<EditResultResponse>
  /** Redoes the step undone last; the same errors */
  redo(): Promise<EditResultResponse>
  /**
   * Starts an edit group: every edit until the matching endEditGroup is one undo step named label. Groups nest (16
   * deep); the host ends a group its client left open when the connection closes and at the next Hello.
   */
  beginEditGroup(label: string): Promise<void>
  /** Ends the innermost edit group; Error when none is open */
  endEditGroup(): Promise<void>
  /** Every step, oldest first, and the cursor: the first cursor steps are done, the rest undone */
  getHistory(): Promise<HistoryResponse>
  /** Whether the open scene has an autosave (a crash left one), and where it is, how large and when it was written */
  getAutosave(): Promise<AutosaveInfo>
  /** Replaces the open scene's content with its autosave, as one undoable step; answers the scene */
  restoreAutosave(): Promise<SceneInfoResponse>
  /** Deletes the open scene's autosave; not an error when there is none */
  discardAutosave(): Promise<void>
}

export type EngineCommandName = keyof EngineCommands

/**
 * The type of each argument of a forwarded command, checked by the main process before the call (the page is not
 * trusted to send what the TypeScript types say)
 */
export type ArgKind = "inputEvents" | "string" | "number" | "int32" | "uint32" | "bool" | "vec3" | "quat" | "jsonObject" | "stringArray"

/** GetEntityBounds takes at most this many ids (the host refuses more) */
export const MaxEntityBoundsIds = 4096

/** A plain JSON object (not an array): what a merge patch is */
export type JsonObject = { [key: string]: unknown }

/** Every forwarded command and its arguments; the main process refuses any other name */
export const EngineCommandArgs = {
  renderFrame: [],
  setViewportSize: ["int32", "int32"],
  renderFrameIfChanged: ["uint32"],
  setEditorCamera: ["vec3", "quat", "number", "bool", "number", "number", "number"],
  getEditorCamera: [],
  pickEntity: ["number", "number", "bool"],
  getEntityBounds: ["stringArray"],
  getAudio: [],
  setCameraPosition: ["number", "number", "number"],
  getCameraPosition: [],

  openScene: ["string"],
  saveSceneToFile: ["string"],
  newScene: ["string", "string"],
  getOpenScene: [],
  getProjectInfo: [],
  setProjectSettings: ["jsonObject"],
  setStartupScene: ["string"],
  createScript: ["string"],
  rescanAssets: [],
  getEngineHealth: [],
  pollEvents: ["uint32", "uint32", "uint32"],
  createEntity: ["string"],
  destroyEntity: ["string"],

  setEntityTransform: ["string", "vec3", "vec3", "vec3"],
  getEntityTransform: ["string"],
  getHierarchy: [],
  createEntityEx: ["string", "string", "int32", "string"],
  setEntityParent: ["string", "string", "int32", "bool"],
  setEntityProperties: ["string", "jsonObject"],
  duplicateEntity: ["string"],
  getEntity: ["string"],
  setLocalTransform: ["string", "vec3", "quat", "vec3"],
  getComponentTypes: [],
  addComponent: ["string", "string"],
  removeComponent: ["string", "string"],
  setComponentFields: ["string", "string", "jsonObject"],
  getComponent: ["string", "string"],
  getLuaFields: ["string", "string"],

  undo: [],
  redo: [],
  beginEditGroup: ["string"],
  endEditGroup: [],
  getHistory: [],
  getAutosave: [],
  restoreAutosave: [],
  discardAutosave: [],
} as const satisfies { readonly [K in EngineCommandName]: readonly ArgKind[] }

export const EngineCommandNames = Object.keys(EngineCommandArgs) as EngineCommandName[]

// A compile-time check that each command's ArgKinds match its signature in EngineCommands
interface ArgKindTypes {
  string: string
  number: number
  int32: number
  uint32: number
  bool: boolean
  vec3: Vec3
  quat: Quat
  jsonObject: JsonObject
  stringArray: string[]
  inputEvents: InputEvent[]
}
type KindsToArgs<T extends readonly ArgKind[]> = { -readonly [I in keyof T]: ArgKindTypes[T[I]] }
type ArgsMatch = {
  [K in EngineCommandName]: [KindsToArgs<(typeof EngineCommandArgs)[K]>] extends [Parameters<EngineCommands[K]>]
    ? [Parameters<EngineCommands[K]>] extends [KindsToArgs<(typeof EngineCommandArgs)[K]>]
      ? true
      : K
    : K
}
/** Names a command whose ArgKinds don't match its signature */
export type MismatchedCommandArgs = Exclude<ArgsMatch[EngineCommandName], true>
export const engineCommandArgsMatchSignatures: [MismatchedCommandArgs] extends [never] ? true : MismatchedCommandArgs =
  true

/** The host's answer to Hello: its protocol and engine versions, capabilities, and whether it has a project */
export type ServerInfo = ServerInfoResponse

/** The engine connection as the main process last reported it; a higher epoch is newer */
export interface ConnectionState {
  connected: boolean
  epoch: number
  /** The connected host's answer to Hello; null when not connected */
  serverInfo: ServerInfo | null
}

/** window.engine */
export interface EngineApi extends EngineCommands {
  /**
   * Whether the editor is connected to the project's host (the last known state, kept up to date by the main
   * process, so it's synchronous). The main process connects once it has launched the host (window.host); the page
   * never picks a host, a port or a token.
   */
  isConnected(): boolean
  /** The connected host's answer to Hello (as last reported, like isConnected); null when not connected */
  serverInfo(): ServerInfo | null
  /** Called when the connection opens or closes, including when the host drops it */
  onConnectionChange(listener: (connected: boolean) => void): void
}

/** Where N2EditorHost is (HostSettings): the configured path, else N2ENGINE_HOST, or not set */
export interface HostLocation {
  path: string | null
  source: "env" | "setting" | null
  /** Why the path can't be used (missing, not a file); null when it can, or when there is no path */
  problem: string | null
  /**
   * Whether this host can create projects: its --help lists --create (engine #90). null when unknown: no usable
   * path, or asking it failed.
   */
  canCreate: boolean | null
}

/** What opening a folder did */
export type OpenProjectResult =
  /** It is open, its host running and connected */
  | { kind: "opened"; path: string }
  /**
   * The folder has no project.n2proj (engine #90 needs one), so no host was started: the editor can offer to make
   * it a project, keeping its files and its assets' UUIDs (create with adopt)
   */
  | { kind: "notAProject"; path: string; message: string }

/** What creating a project did */
export type CreateProjectResult =
  /** Created and opened */
  | { kind: "opened"; path: string }
  /** The folder already has a project.n2proj, and nothing was changed: the editor can offer to open it */
  | { kind: "alreadyAProject"; path: string; message: string }

/**
 * The project's editor host process, which the main process launches for the open project:
 * - stopped: none (no project, or it was stopped);
 * - starting: launched, waiting for its ready line and the connection;
 * - running: connected;
 * - exited: it ended on its own (crashed, or its session ended), see message;
 * - failed: it couldn't be launched or connected to, see message.
 */
export type HostStatus = "stopped" | "starting" | "running" | "exited" | "failed"

export interface HostState {
  status: HostStatus
  /** Counts launches: a higher one is a newer host process (the console starts a new log for it) */
  launch: number
  /** The project the host is (or was) for */
  projectPath: string | null
  /** Why it failed or exited, with its last output lines; null otherwise */
  message: string | null
}

/** window.host: the project's editor host process */
export interface HostApi {
  /** The last known state (pushed by the main process, so it's synchronous) */
  state(): HostState
  onStateChange(listener: (state: HostState) => void): void
  /** Stops the open project's host, if any, and launches a new one */
  restart(): Promise<void>
  /** Shuts the host down (the project stays open; restart() starts it again) */
  stop(): Promise<void>
  location(): Promise<HostLocation>
  /** Picks the N2EditorHost executable with a file dialog and saves it; null when cancelled */
  locate(): Promise<HostLocation | null>
}

/** An entry of the open project's file tree */
export interface FileInfo {
  name: string
  /** Absolute, in the platform's form */
  path: string
  isDirectory: boolean
  children?: FileInfo[]
}

/**
 * window.project: the open project's files. Paths are absolute (as listFiles returns them) and must lie inside
 * the open project; files are limited to the text types the editor uses (ProjectTextExtensions).
 */
export interface ProjectApi {
  /**
   * Picks a folder and opens it: launches its editor host and connects to it. Null when cancelled; rejects when the
   * host can't be launched (window.host says why too).
   */
  openDialog(): Promise<OpenProjectResult | null>
  /** Reopens one of getRecent's projects */
  openRecent(projectPath: string): Promise<OpenProjectResult>
  /** Opens a folder the editor offered: a result's path (notAProject, alreadyAProject) or a picked new folder */
  openFolder(folder: string): Promise<OpenProjectResult>
  /** Picks a folder for a new project (it needn't exist); null when cancelled */
  pickNewFolder(): Promise<string | null>
  /**
   * Makes a folder the editor offered a project, with N2EditorHost --create (engine #90), and opens it. name is the
   * project's name (empty: the folder's name). adopt keeps the asset UUIDs an existing folder's assets had
   * (--project-id from-path).
   */
  create(folder: string, name: string, adopt: boolean): Promise<CreateProjectResult>
  /** Recently opened projects' folders, newest first */
  getRecent(): Promise<string[]>
  removeRecent(projectPath: string): Promise<void>
  /** Closes the open project and stops its host */
  close(): Promise<void>

  /** The open project's tree (hidden entries skipped, 3 levels deep) */
  listFiles(): Promise<FileInfo[]>
  /**
   * The assets the host has indexed (what its .import/*.meta files say), with their UUIDs, for the inspector's asset
   * fields. A file added since the host's last scan isn't there until RescanAssets (an assetsChanged event follows).
   */
  listAssets(): Promise<AssetEntry[]>
  readTextFile(filePath: string): Promise<string>
  writeTextFile(filePath: string, text: string): Promise<void>
  /** Creates the directory and any missing parents */
  createDirectory(dirPath: string): Promise<void>
  /** Deletes a file (never a directory); a file that doesn't exist is not an error */
  deleteFile(filePath: string): Promise<void>
}

/** An asset the host indexed (a .meta under the project's .import folder), or a sub-asset of a model */
export interface AssetEntry {
  /** Lower-case UUID: what an asset field holds */
  uuid: string
  /** res://scenes/Main.scene; a sub-asset's is its model's path, #, and its key: res://models/robot.glb#mesh/Body */
  path: string
  /** The resource type the host gave it: Texture, Font, Mesh, Material, Model, AudioClip, LuaScript, Scene, ... ("Unknown") */
  resourceType: string
}

/** How deeply nested a JSON argument of an engine command may be: the main process refuses more (the host's own limit is 64) */
export const MaxJsonDepth = 32

/** How many values (every scalar, array and object counts) a JSON argument may hold (the host's own limit is 200000) */
export const MaxJsonNodes = 100_000

// ==================== Play mode ====================

/**
 * The play session (the game running in a second host process, launched by the main process):
 * - stopped: none (also after the user stopped it);
 * - starting: the snapshot is being written, the child launched and connected;
 * - playing, paused: connected and running or paused;
 * - exited: the child ended on its own (it crashed, or the game quit), see message;
 * - failed: it couldn't be started (a snapshot or launch failure), see message.
 */
export type PlayStatus = "stopped" | "starting" | "playing" | "paused" | "exited" | "failed"

export interface PlayState {
  status: PlayStatus
  /** Counts sessions: a higher one is a newer game */
  launch: number
  /** The game's frame count and time in seconds, as GetPlayState last said */
  frame: number
  time: number
  /** Why it failed or exited, with the child's last output lines; or a note on why it stopped; null otherwise */
  message: string | null
}

export const InitialPlayState: PlayState = Object.freeze({ status: "stopped", launch: 0, frame: 0, time: 0, message: null })

/** PlayState.message of a game that ended by itself with exit code 0 (the game quit): no failure */
export const GameEndedMessage = "The game ended"

/** An input event as SendInput takes it (protocol 1.10.0); the engine checks key and button names */
export type PlayInputEvent = InputEvent

/** SendInput takes at most this many events (the host refuses more) */
export const MaxInputEventsPerBatch = 1024

/** Step runs 1 to this many frames */
export const MaxStepFrames = 1000

/** What the page may ask of the play child's connection: each is forwarded to the child by the main process */
export interface PlayCommands {
  /** The game's picture (RGBA, top row first) at the viewport size; the only frame command a play host answers */
  renderFrame(): Promise<FrameDataResponse>
  setViewportSize(width: number, height: number): Promise<void>
  /** The child's audio stream; null when it has none */
  getAudio(): Promise<AudioSamples | null>
  pollEvents(epoch: number, afterSeq: number, maxEvents: number): Promise<EventsResponse>
  sendInput(events: PlayInputEvent[]): Promise<void>
}

export type PlayCommandName = keyof PlayCommands

/** Every forwarded play command and its arguments; the main process refuses any other name */
export const PlayCommandArgs = {
  renderFrame: [],
  setViewportSize: ["int32", "int32"],
  getAudio: [],
  pollEvents: ["uint32", "uint32", "uint32"],
  sendInput: ["inputEvents"],
} as const satisfies { readonly [K in PlayCommandName]: readonly ArgKind[] }

export const PlayCommandNames = Object.keys(PlayCommandArgs) as PlayCommandName[]

/** window.play: the play session */
export interface PlayApi extends PlayCommands {
  /** The last known state (pushed by the main process, so it's synchronous) */
  state(): PlayState
  onStateChange(listener: (state: PlayState) => void): void
  /**
   * Plays the open scene as it is in the editor host's memory, unsaved edits included: writes a snapshot, launches
   * the child, connects. Resolves once it is playing; rejects with the reason when it couldn't start.
   */
  start(): Promise<void>
  /** Shuts the child down (kills it after a grace period); not an error when none is running */
  stop(): Promise<void>
  setPaused(paused: boolean): Promise<void>
  /** Runs 1 to MaxStepFrames frames; only while paused */
  step(frames: number): Promise<void>
  /** Asks the child for its state (GetPlayState): the pause flag, frame and time */
  refresh(): Promise<PlayState>
}

export const ProjectTextExtensions: readonly string[] = [".scene", ".lua", ".json", ".txt"]

/** A command of the application menu (macOS), which the page runs: see main/app-menu.ts */
export type EditCommand = "undo" | "redo"

/** window.editMenu */
export interface EditMenuApi {
  /** Called when the application menu's Undo or Redo is chosen (macOS: Cmd+Z, Cmd+Shift+Z) */
  onCommand(listener: (command: EditCommand) => void): void
}

/** What an IPC handler returns: errors are carried as data so the page sees the original message */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string }

export const Channels = {
  /** (name: EngineCommandName, args: unknown[]) → IpcResult */
  engineCall: "engine:call",
  /**
   * () → IpcResult<ConnectionState>: a newly loaded page starts with no project, host or connection (closes any a
   * previous page left open)
   */
  engineAttach: "engine:attach",
  /** main → page: ConnectionState */
  engineState: "engine:state",
  /** main → page: EditCommand, from the application menu */
  editCommand: "edit:command",

  /** () → IpcResult<HostState> */
  hostGetState: "host:getState",
  /** main → page: HostState */
  hostState: "host:state",
  hostRestart: "host:restart",
  hostStop: "host:stop",
  hostLocation: "host:location",
  hostLocate: "host:locate",

  /** () → IpcResult<PlayState> */
  playGetState: "play:getState",
  /** main → page: PlayState */
  playState: "play:state",
  playStart: "play:start",
  playStop: "play:stop",
  playSetPaused: "play:setPaused",
  playStep: "play:step",
  playRefresh: "play:refresh",
  /** (name: PlayCommandName, args: unknown[]) → IpcResult */
  playCall: "play:call",

  projectOpenDialog: "project:openDialog",
  projectOpenFolder: "project:openFolder",
  projectPickNewFolder: "project:pickNewFolder",
  projectCreate: "project:create",
  projectOpenRecent: "project:openRecent",
  projectGetRecent: "project:getRecent",
  projectRemoveRecent: "project:removeRecent",
  projectClose: "project:close",
  projectListFiles: "project:listFiles",
  projectListAssets: "project:listAssets",
  projectReadTextFile: "project:readTextFile",
  projectWriteTextFile: "project:writeTextFile",
  projectCreateDirectory: "project:createDirectory",
  projectDeleteFile: "project:deleteFile",
} as const
