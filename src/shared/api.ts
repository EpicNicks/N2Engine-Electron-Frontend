// The typed API between the page and the Electron main process. The page (sandboxed, no Node) sees window.engine
// and window.project; the preload forwards each call over IPC; the main process owns the engine connection and the
// project's files. Types and plain constants only: this file is imported by all three sides.

import type {
  CameraPositionResponse,
  EngineHealthResponse,
  EntityInfo,
  FrameDataResponse,
  SceneDataResponse,
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

  createScene(name: string): Promise<SceneDataResponse>
  loadScene(sceneJson: string): Promise<void>
  saveScene(): Promise<SceneDataResponse>
  deleteScene(sceneName: string): Promise<void>
  getCurrentScene(): Promise<SceneDataResponse | null>

  createScript(name: string): Promise<string>
  rescanAssets(): Promise<void>

  getEngineHealth(): Promise<EngineHealthResponse>

  createEntity(name: string): Promise<string>
  destroyEntity(entityId: string): Promise<void>
  getAllEntities(): Promise<EntityInfo[]>
  setEntityTransform(entityId: string, position: Vec3, rotation: Vec3, scale: Vec3): Promise<void>
  getEntityTransform(entityId: string): Promise<{ position: Vec3; rotation: Vec3; scale: Vec3 }>
}

export type EngineCommandName = keyof EngineCommands

/**
 * The type of each argument of a forwarded command, checked by the main process before the call (the page is not
 * trusted to send what the TypeScript types say)
 */
export type ArgKind = "string" | "number" | "int32" | "vec3"

/** Every forwarded command and its arguments; the main process refuses any other name */
export const EngineCommandArgs = {
  renderFrame: [],
  setViewportSize: ["int32", "int32"],
  getAudio: [],
  setCameraPosition: ["number", "number", "number"],
  getCameraPosition: [],
  createScene: ["string"],
  loadScene: ["string"],
  saveScene: [],
  deleteScene: ["string"],
  getCurrentScene: [],
  createScript: ["string"],
  rescanAssets: [],
  getEngineHealth: [],
  createEntity: ["string"],
  destroyEntity: ["string"],
  getAllEntities: [],
  setEntityTransform: ["string", "vec3", "vec3", "vec3"],
  getEntityTransform: ["string"],
} as const satisfies { readonly [K in EngineCommandName]: readonly ArgKind[] }

export const EngineCommandNames = Object.keys(EngineCommandArgs) as EngineCommandName[]

// A compile-time check that each command's ArgKinds match its signature in EngineCommands
interface ArgKindTypes {
  string: string
  number: number
  int32: number
  vec3: Vec3
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

/** The engine connection as the main process last reported it; a higher epoch is newer */
export interface ConnectionState {
  connected: boolean
  epoch: number
}

/** window.engine */
export interface EngineApi extends EngineCommands {
  /** Connects to an editor host on this machine (localhost, 127.0.0.1 or ::1) */
  connect(host?: string, port?: number): Promise<void>
  /** Asks the host to shut down and closes the connection */
  disconnect(): Promise<void>
  /** The last known state (kept up to date by the main process, so it's synchronous) */
  isConnected(): boolean
  /** Called when the connection opens or closes, including when the host drops it */
  onConnectionChange(listener: (connected: boolean) => void): void
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
  /** Picks a folder and opens it; null when cancelled */
  openDialog(): Promise<string | null>
  /** Picks a location, creates a project there and opens it; null when cancelled */
  createDialog(): Promise<string | null>
  /** Reopens one of getRecent's projects */
  openRecent(projectPath: string): Promise<string>
  getRecent(): Promise<string[]>

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
  /** (host, port) → IpcResult<ConnectionState> */
  engineConnect: "engine:connect",
  /** () → IpcResult<ConnectionState> */
  engineDisconnect: "engine:disconnect",
  /** () → IpcResult<ConnectionState>: a newly loaded page starts without a connection (closes any open one) */
  engineAttach: "engine:attach",
  /** main → page: ConnectionState */
  engineState: "engine:state",

  projectOpenDialog: "project:openDialog",
  projectCreateDialog: "project:createDialog",
  projectOpenRecent: "project:openRecent",
  projectGetRecent: "project:getRecent",
  projectListFiles: "project:listFiles",
  projectReadTextFile: "project:readTextFile",
  projectWriteTextFile: "project:writeTextFile",
  projectCreateDirectory: "project:createDirectory",
  projectDeleteFile: "project:deleteFile",
} as const
