// The typed API between the page and the Electron main process. The page (sandboxed, no Node) sees window.engine
// and window.project; the preload forwards each call over IPC; the main process owns the engine connection and the
// project's files. Types and plain constants only: this file is imported by all three sides.

import type {
  CameraPositionResponse,
  EngineHealthResponse,
  EntityDataResponse,
  EventsResponse,
  FrameDataResponse,
  HierarchyResponse,
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
}

export type EngineCommandName = keyof EngineCommands

/**
 * The type of each argument of a forwarded command, checked by the main process before the call (the page is not
 * trusted to send what the TypeScript types say)
 */
export type ArgKind = "string" | "number" | "int32" | "uint32" | "bool" | "vec3" | "quat" | "jsonObject"

/** A plain JSON object (not an array): what a merge patch is */
export type JsonObject = { [key: string]: unknown }

/** Every forwarded command and its arguments; the main process refuses any other name */
export const EngineCommandArgs = {
  renderFrame: [],
  setViewportSize: ["int32", "int32"],
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
  readTextFile(filePath: string): Promise<string>
  writeTextFile(filePath: string, text: string): Promise<void>
  /** Creates the directory and any missing parents */
  createDirectory(dirPath: string): Promise<void>
  /** Deletes a file (never a directory); a file that doesn't exist is not an error */
  deleteFile(filePath: string): Promise<void>
}

export const ProjectTextExtensions: readonly string[] = [".scene", ".lua", ".json", ".txt"]

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

  /** () → IpcResult<HostState> */
  hostGetState: "host:getState",
  /** main → page: HostState */
  hostState: "host:state",
  hostRestart: "host:restart",
  hostStop: "host:stop",
  hostLocation: "host:location",
  hostLocate: "host:locate",

  projectOpenDialog: "project:openDialog",
  projectOpenFolder: "project:openFolder",
  projectPickNewFolder: "project:pickNewFolder",
  projectCreate: "project:create",
  projectOpenRecent: "project:openRecent",
  projectGetRecent: "project:getRecent",
  projectRemoveRecent: "project:removeRecent",
  projectClose: "project:close",
  projectListFiles: "project:listFiles",
  projectReadTextFile: "project:readTextFile",
  projectWriteTextFile: "project:writeTextFile",
  projectCreateDirectory: "project:createDirectory",
  projectDeleteFile: "project:deleteFile",
} as const
