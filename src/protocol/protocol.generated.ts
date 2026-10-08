// Auto-generated from protocol.json by generate_typescript.py - do not edit

/** protocol.json's version (major.minor.patch); Hello sends it, and the server answers with its own */
export const PROTOCOL_VERSION = "1.10.0";

// ==================== Types ====================

/** 16 numbers, column-major (element col * 4 + row) for column vectors: the translation is elements 12, 13, 14 */
export type Mat4 = number[];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface EntityInfo {
  id: string;
  name: string;
}

export interface SubsystemStatus {
  name: string;
  state: string;
  detail: string;
}

// ==================== JSON shapes (jsonTypes) ====================

export interface EditorEvent {
  seq: number;
  kind: string;
  level?: string;
  message?: string;
  time?: number;
  revision?: number;
  savedRevision?: number;
  path?: string;
  entityIds?: string[];
  full?: boolean;
  added?: string[];
  removed?: string[];
  modified?: string[];
  canUndo?: boolean;
  canRedo?: boolean;
  label?: string;
  redoLabel?: string;
  undoCount?: number;
  redoCount?: number;
  state?: string;
  frame?: number;
}

export interface InputEvent {
  type: string;
  key?: string;
  button?: string;
  down?: boolean;
  x?: number;
  y?: number;
}

export interface HistoryEntry {
  label: string;
  bytes: number;
}

export interface AutosaveInfo {
  exists: boolean;
  path?: string;
  size?: number;
  modified?: number;
}

export interface SubAssetInfo {
  key: string;
  uuid: string;
  type: string;
}

export interface AssetInfo {
  path: string;
  uuid: string;
  type: string;
  size: number;
  modified: number;
  subAssets?: SubAssetInfo[];
}

export interface AssetDetails {
  path: string;
  uuid: string;
  type: string;
  size: number;
  modified: number;
  subAssets?: SubAssetInfo[];
  customData: unknown;
  loaded: boolean;
}

export interface ProjectFile {
  formatVersion: number;
  name: string;
  projectId: string;
  engineVersion: string;
  startupScene: string;
  scenes: string[];
  settings: unknown;
}

export interface HierarchyNode {
  id: string;
  parentId: string;
  index: number;
  name: string;
  active: boolean;
  activeInHierarchy: boolean;
  layer: number;
  tag: string;
  components: string[];
}

export interface EntityHeader {
  id: string;
  parentId: string;
  index: number;
  name: string;
  active: boolean;
  activeInHierarchy: boolean;
  layer: number;
  tag: string;
}

export interface JsonVec3 {
  x: number;
  y: number;
  z: number;
}

export interface JsonQuat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface EntityBounds {
  id: string;
  min: JsonVec3;
  max: JsonVec3;
}

export interface LocalTransform {
  position: JsonVec3;
  rotation: JsonQuat;
  scale: JsonVec3;
}

export interface EntityComponent {
  type: string;
  uuid: string;
  values: unknown;
}

export interface EntityDetails {
  header: EntityHeader;
  transform?: LocalTransform;
  components: EntityComponent[];
}

export interface FieldSchema {
  name: string;
  displayName: string;
  kind: string;
  typeName: string;
  hidden: boolean;
  readOnly: boolean;
  enumOptions?: string[];
  assetType?: string;
  min?: number;
  max?: number;
  tooltip?: string;
  container?: string;
}

export interface ComponentSchema {
  typeName: string;
  singleton: boolean;
  fields: FieldSchema[];
  defaults?: unknown;
}

// ==================== Ids ====================

export const CommandType = {
  RenderFrame: 0x01,
  SetViewportSize: 0x02,
  GetAudio: 0x03,
  Hello: 0x04,
  PollEvents: 0x05,
  RenderFrameIfChanged: 0x06,
  SetCameraPosition: 0x10,
  GetCameraPosition: 0x12,
  SetEditorCamera: 0x13,
  GetEditorCamera: 0x14,
  PickEntity: 0x15,
  GetEntityBounds: 0x16,
  CreateScene: 0x20,
  LoadScene: 0x21,
  SaveScene: 0x22,
  DeleteScene: 0x23,
  GetCurrentScene: 0x24,
  OpenScene: 0x25,
  SaveSceneToFile: 0x26,
  NewScene: 0x27,
  GetHierarchy: 0x28,
  GetOpenScene: 0x29,
  CreateEntity: 0x30,
  DestroyEntity: 0x31,
  SetEntityTransform: 0x32,
  GetEntityTransform: 0x33,
  GetAllEntities: 0x34,
  CreateEntityEx: 0x35,
  SetEntityParent: 0x36,
  SetEntityProperties: 0x37,
  DuplicateEntity: 0x38,
  GetEntity: 0x39,
  SetLocalTransform: 0x3A,
  CreateScript: 0x40,
  RescanAssets: 0x41,
  ListAssets: 0xA0,
  GetAssetInfo: 0xA1,
  SetImportSettings: 0xA2,
  ReadTextAsset: 0xA3,
  WriteTextAsset: 0xA4,
  CreateScriptAsset: 0xA5,
  CreateFolder: 0xA6,
  GetEngineHealth: 0x50,
  GetComponentTypes: 0x60,
  AddComponent: 0x61,
  RemoveComponent: 0x62,
  SetComponentFields: 0x63,
  GetComponent: 0x64,
  GetLuaFields: 0x65,
  GetProjectInfo: 0x70,
  SetProjectSettings: 0x71,
  SetStartupScene: 0x72,
  Undo: 0x90,
  Redo: 0x91,
  BeginEditGroup: 0x92,
  EndEditGroup: 0x93,
  GetHistory: 0x94,
  GetAutosave: 0x95,
  RestoreAutosave: 0x96,
  DiscardAutosave: 0x97,
  WritePlaySnapshot: 0xB0,
  SetPaused: 0xB1,
  Step: 0xB2,
  GetPlayState: 0xB3,
  SendInput: 0xB4,
  Shutdown: 0xFF,
} as const;

export type CommandType = typeof CommandType[keyof typeof CommandType];

export const ResponseType = {
  Ok: 0x00,
  Error: 0x01,
  FrameData: 0x02,
  CameraPosition: 0x03,
  EntityTransform: 0x04,
  EntityList: 0x05,
  EntityCreated: 0x06,
  SceneData: 0x07,
  ScriptData: 0x08,
  EngineHealth: 0x09,
  AudioSamples: 0x0A,
  ServerInfo: 0x0B,
  Events: 0x0C,
  SceneInfo: 0x0D,
  ProjectInfo: 0x0E,
  Hierarchy: 0x0F,
  EntityData: 0x10,
  ComponentTypes: 0x11,
  ComponentAdded: 0x12,
  ComponentData: 0x13,
  LuaFields: 0x14,
  EditResult: 0x15,
  History: 0x16,
  Autosave: 0x17,
  FrameUpdate: 0x18,
  EditorCamera: 0x19,
  PickResult: 0x1A,
  Bounds: 0x1B,
  AssetList: 0xA0,
  AssetDetail: 0xA1,
  TextData: 0xA2,
  AssetCreated: 0xA3,
  PlaySnapshot: 0xB0,
  PlayState: 0xB1,
} as const;

export type ResponseType = typeof ResponseType[keyof typeof ResponseType];

/** The response each command answers with when it succeeds (any command may answer Error instead) */
export const CommandResponse = {
  RenderFrame: "FrameData",
  SetViewportSize: "Ok",
  GetAudio: "AudioSamples",
  Hello: "ServerInfo",
  PollEvents: "Events",
  RenderFrameIfChanged: "FrameUpdate",
  SetCameraPosition: "Ok",
  GetCameraPosition: "CameraPosition",
  SetEditorCamera: "Ok",
  GetEditorCamera: "EditorCamera",
  PickEntity: "PickResult",
  GetEntityBounds: "Bounds",
  CreateScene: "SceneData",
  LoadScene: "Ok",
  SaveScene: "SceneData",
  DeleteScene: "Ok",
  GetCurrentScene: "SceneData",
  OpenScene: "SceneInfo",
  SaveSceneToFile: "SceneInfo",
  NewScene: "SceneInfo",
  GetHierarchy: "Hierarchy",
  GetOpenScene: "SceneInfo",
  CreateEntity: "EntityCreated",
  DestroyEntity: "Ok",
  SetEntityTransform: "Ok",
  GetEntityTransform: "EntityTransform",
  GetAllEntities: "EntityList",
  CreateEntityEx: "EntityCreated",
  SetEntityParent: "Ok",
  SetEntityProperties: "Ok",
  DuplicateEntity: "EntityCreated",
  GetEntity: "EntityData",
  SetLocalTransform: "Ok",
  CreateScript: "ScriptData",
  RescanAssets: "Ok",
  ListAssets: "AssetList",
  GetAssetInfo: "AssetDetail",
  SetImportSettings: "Ok",
  ReadTextAsset: "TextData",
  WriteTextAsset: "Ok",
  CreateScriptAsset: "AssetCreated",
  CreateFolder: "Ok",
  GetEngineHealth: "EngineHealth",
  GetComponentTypes: "ComponentTypes",
  AddComponent: "ComponentAdded",
  RemoveComponent: "Ok",
  SetComponentFields: "ComponentData",
  GetComponent: "ComponentData",
  GetLuaFields: "LuaFields",
  GetProjectInfo: "ProjectInfo",
  SetProjectSettings: "ProjectInfo",
  SetStartupScene: "ProjectInfo",
  Undo: "EditResult",
  Redo: "EditResult",
  BeginEditGroup: "Ok",
  EndEditGroup: "Ok",
  GetHistory: "History",
  GetAutosave: "Autosave",
  RestoreAutosave: "SceneInfo",
  DiscardAutosave: "Ok",
  WritePlaySnapshot: "PlaySnapshot",
  SetPaused: "Ok",
  Step: "Ok",
  GetPlayState: "PlayState",
  SendInput: "Ok",
  Shutdown: "Ok",
} as const;

// ==================== Messages ====================

export interface SetViewportSizeRequest {
  width: number;
  height: number;
}

export interface HelloRequest {
  clientName: string;
  protocolVersion: string;
  token: string;
}

export interface PollEventsRequest {
  epoch: number;
  afterSeq: number;
  maxEvents: number;
}

export interface RenderFrameIfChangedRequest {
  sinceRevision: number;
}

export interface SetCameraPositionRequest {
  x: number;
  y: number;
  z: number;
}

export interface SetEditorCameraRequest {
  position: Vec3;
  rotation: Quat;
  fovY: number;
  orthographic: boolean;
  orthoSize: number;
  nearPlane: number;
  farPlane: number;
}

export interface PickEntityRequest {
  x: number;
  y: number;
  includeInactive: boolean;
}

export interface GetEntityBoundsRequest {
  entityIds: string[];
}

export interface CreateSceneRequest {
  name: string;
}

export interface LoadSceneRequest {
  sceneJson: string;
}

export interface DeleteSceneRequest {
  sceneName: string;
}

export interface OpenSceneRequest {
  path: string;
}

export interface SaveSceneToFileRequest {
  path: string;
}

export interface NewSceneRequest {
  path: string;
  name: string;
}

export interface CreateEntityRequest {
  name: string;
}

export interface DestroyEntityRequest {
  entityId: string;
}

export interface SetEntityTransformRequest {
  entityId: string;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export interface GetEntityTransformRequest {
  entityId: string;
}

export interface CreateEntityExRequest {
  name: string;
  parentId: string;
  siblingIndex: number;
  preset: string;
}

export interface SetEntityParentRequest {
  entityId: string;
  parentId: string;
  siblingIndex: number;
  keepWorldTransform: boolean;
}

export interface SetEntityPropertiesRequest {
  entityId: string;
  properties: unknown;
}

export interface DuplicateEntityRequest {
  entityId: string;
}

export interface GetEntityRequest {
  entityId: string;
}

export interface SetLocalTransformRequest {
  entityId: string;
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

export interface CreateScriptRequest {
  name: string;
}

export interface ListAssetsRequest {
  folder: string;
  recursive: boolean;
}

export interface GetAssetInfoRequest {
  uuidOrPath: string;
}

export interface SetImportSettingsRequest {
  path: string;
  customData: unknown;
}

export interface ReadTextAssetRequest {
  path: string;
}

export interface WriteTextAssetRequest {
  path: string;
  text: string;
}

export interface CreateScriptAssetRequest {
  path: string;
  className: string;
}

export interface CreateFolderRequest {
  path: string;
}

export interface AddComponentRequest {
  entityId: string;
  typeName: string;
}

export interface RemoveComponentRequest {
  entityId: string;
  componentId: string;
}

export interface SetComponentFieldsRequest {
  entityId: string;
  componentId: string;
  values: unknown;
}

export interface GetComponentRequest {
  entityId: string;
  componentId: string;
}

export interface GetLuaFieldsRequest {
  entityId: string;
  componentId: string;
}

export interface SetProjectSettingsRequest {
  settings: unknown;
}

export interface SetStartupSceneRequest {
  path: string;
}

export interface BeginEditGroupRequest {
  label: string;
}

export interface WritePlaySnapshotRequest {
  scenePath: string;
}

export interface SetPausedRequest {
  paused: boolean;
}

export interface StepRequest {
  frames: number;
}

export interface SendInputRequest {
  events: InputEvent[];
}

/** Ok has no payload */
export type OkResponse = Record<string, never>;

/** Error's payload is the message's raw UTF-8 bytes (not a length-prefixed string) */
export interface ErrorResponse {
  message: string;
}

export interface FrameDataResponse {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface AudioSamplesResponse {
  sampleRate: number;
  channels: number;
  sampleFormat: string;
  frameCount: number;
  droppedFrames: number;
  samples: Uint8Array;
}

export interface ServerInfoResponse {
  protocolVersion: string;
  engineVersion: string;
  capabilities: string[];
  projectLoaded: boolean;
}

export interface EventsResponse {
  epoch: number;
  nextSeq: number;
  dropped: number;
  events: EditorEvent[];
}

export interface FrameUpdateResponse {
  revision: number;
  modified: boolean;
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface CameraPositionResponse {
  x: number;
  y: number;
  z: number;
}

export interface EditorCameraResponse {
  position: Vec3;
  rotation: Quat;
  fovY: number;
  orthographic: boolean;
  orthoSize: number;
  nearPlane: number;
  farPlane: number;
  view: Mat4;
  projection: Mat4;
}

export interface PickResultResponse {
  entityId: string;
  point: Vec3;
  distance: number;
}

export interface BoundsResponse {
  bounds: EntityBounds[];
}

export interface SceneDataResponse {
  sceneJson: string;
}

export interface SceneInfoResponse {
  path: string;
  name: string;
  uuid: string;
  revision: number;
  savedRevision: number;
}

export interface HierarchyResponse {
  revision: number;
  nodes: HierarchyNode[];
}

export interface EntityCreatedResponse {
  entityId: string;
}

export interface EntityTransformResponse {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export interface EntityListResponse {
  count: number;
  entities: EntityInfo[];
}

export interface EntityDataResponse {
  entity: EntityDetails;
  worldMatrix: Mat4;
}

export interface ScriptDataResponse {
  scriptTemplate: string;
}

export interface AssetListResponse {
  folders: string[];
  assets: AssetInfo[];
}

export interface AssetDetailResponse {
  info: AssetDetails;
}

export interface TextDataResponse {
  text: string;
}

export interface AssetCreatedResponse {
  path: string;
  uuid: string;
}

export interface EngineHealthResponse {
  healthy: boolean;
  count: number;
  subsystems: SubsystemStatus[];
}

export interface ComponentTypesResponse {
  types: ComponentSchema[];
}

export interface ComponentAddedResponse {
  componentId: string;
  values: unknown;
}

export interface ComponentDataResponse {
  values: unknown;
}

export interface LuaFieldsResponse {
  schema: ComponentSchema;
}

export interface ProjectInfoResponse {
  rootPath: string;
  userDataPath: string;
  project: ProjectFile;
}

export interface EditResultResponse {
  label: string;
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
  savedRevision: number;
}

export interface HistoryResponse {
  cursor: number;
  entries: HistoryEntry[];
}

export interface AutosaveResponse {
  info: AutosaveInfo;
}

export interface PlaySnapshotResponse {
  file: string;
}

export interface PlayStateResponse {
  state: string;
  frame: number;
  time: number;
}

// ==================== Codec runtime ====================

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Builds a payload: little-endian numbers, uint32-length-prefixed UTF-8 strings */
export class ProtocolWriter {
  private buffer: Uint8Array = new Uint8Array(64);
  private view: DataView = new DataView(this.buffer.buffer);
  private length = 0;

  u8(value: number): void {
    checkInteger(value, 0, 0xff, "uint8");
    this.reserve(1);
    this.view.setUint8(this.length, value);
    this.length += 1;
  }

  u32(value: number): void {
    checkInteger(value, 0, 0xffffffff, "uint32");
    this.reserve(4);
    this.view.setUint32(this.length, value, true);
    this.length += 4;
  }

  i32(value: number): void {
    checkInteger(value, -0x80000000, 0x7fffffff, "int32");
    this.reserve(4);
    this.view.setInt32(this.length, value, true);
    this.length += 4;
  }

  /** Rounded to the nearest float32 */
  f32(value: number): void {
    this.reserve(4);
    this.view.setFloat32(this.length, value, true);
    this.length += 4;
  }

  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }

  string(value: string): void {
    const bytes = textEncoder.encode(value);
    this.u32(bytes.length);
    this.bytes(bytes);
  }

  /** JSON.stringify's text, as a string */
  json(value: unknown): void {
    const text = JSON.stringify(value);
    if (text === undefined) {
      throw new TypeError("Value has no JSON representation");
    }
    this.string(text);
  }

  /** 16 numbers, column-major */
  mat4(value: Mat4): void {
    if (value.length !== 16) {
      throw new RangeError(`A mat4 has 16 elements, not ${value.length}`);
    }
    for (const element of value) {
      this.f32(element);
    }
  }

  /** Raw bytes, no length prefix */
  bytes(value: Uint8Array): void {
    this.reserve(value.length);
    this.buffer.set(value, this.length);
    this.length += value.length;
  }

  /** The bytes written so far (a copy) */
  finish(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }

  private reserve(count: number): void {
    const needed = this.length + count;
    if (needed <= this.buffer.length) {
      return;
    }
    let size = this.buffer.length * 2;
    while (size < needed) {
      size *= 2;
    }
    const grown = new Uint8Array(size);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
    this.view = new DataView(grown.buffer);
  }
}

/** Reads a payload; reading past its end throws a RangeError, as the server's BufferReader does */
export class ProtocolReader {
  private readonly data: Uint8Array;
  private readonly view: DataView;
  private offset = 0;

  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining(): number {
    return this.data.length - this.offset;
  }

  u8(): number {
    this.require(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u32(): number {
    this.require(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i32(): number {
    this.require(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f32(): number {
    this.require(4);
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  /** Any non-zero byte is true */
  bool(): boolean {
    return this.u8() !== 0;
  }

  string(): string {
    const length = this.u32();
    return textDecoder.decode(this.take(length));
  }

  /** A string holding JSON text, parsed */
  json(): unknown {
    return JSON.parse(this.string());
  }

  mat4(): Mat4 {
    const value: number[] = [];
    for (let i = 0; i < 16; i++) {
      value.push(this.f32());
    }
    return value;
  }

  /** The rest of the payload: a view into it, not a copy */
  rest(): Uint8Array {
    return this.take(this.remaining);
  }

  private take(count: number): Uint8Array {
    this.require(count);
    const value = this.data.subarray(this.offset, this.offset + count);
    this.offset += count;
    return value;
  }

  private require(count: number): void {
    if (count > this.remaining) {
      throw new RangeError(`Malformed payload: read of ${count} bytes with ${this.remaining} remaining`);
    }
  }
}

function checkInteger(value: number, min: number, max: number, type: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${value} is not a ${type}`);
  }
}

function readArray<T>(reader: ProtocolReader, count: number, read: (reader: ProtocolReader) => T): T[] {
  const values: T[] = [];
  for (let i = 0; i < count; i++) {
    values.push(read(reader));
  }
  return values;
}

/** Bytes in a frame header: [type: uint8][payload length: uint32] */
export const FRAME_HEADER_BYTES = 5;

/** A whole frame: the header, then the payload */
export function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
  const writer = new ProtocolWriter();
  writer.u8(type);
  writer.u32(payload.length);
  writer.bytes(payload);
  return writer.finish();
}

/**
 * The first complete frame at the start of data, and its size in bytes; null until all of it has arrived.
 * The payload is a view into data, not a copy.
 */
export function decodeFrame(data: Uint8Array): { type: number; payload: Uint8Array; size: number } | null {
  if (data.length < FRAME_HEADER_BYTES) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const length = view.getUint32(1, true);
  const size = FRAME_HEADER_BYTES + length;
  if (data.length < size) {
    return null;
  }
  return { type: view.getUint8(0), payload: data.subarray(FRAME_HEADER_BYTES, size), size };
}

/** major.minor.patch as numbers; null for anything else */
export function parseProtocolVersion(version: string): { major: number; minor: number; patch: number } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Whether a server speaking version can talk to this client: the same major version. A server with a newer minor
 * version has commands this client doesn't know; one with an older minor version lacks some this client knows.
 */
export function isProtocolCompatible(version: string): boolean {
  const theirs = parseProtocolVersion(version);
  const ours = parseProtocolVersion(PROTOCOL_VERSION);
  return theirs !== null && ours !== null && theirs.major === ours.major;
}

// ==================== Codecs ====================

export function writeVec3(writer: ProtocolWriter, value: Vec3): void {
  writer.f32(value.x);
  writer.f32(value.y);
  writer.f32(value.z);
}

export function readVec3(reader: ProtocolReader): Vec3 {
  return { x: reader.f32(), y: reader.f32(), z: reader.f32() };
}

export function writeQuat(writer: ProtocolWriter, value: Quat): void {
  writer.f32(value.x);
  writer.f32(value.y);
  writer.f32(value.z);
  writer.f32(value.w);
}

export function readQuat(reader: ProtocolReader): Quat {
  return { x: reader.f32(), y: reader.f32(), z: reader.f32(), w: reader.f32() };
}

export function writeEntityInfo(writer: ProtocolWriter, value: EntityInfo): void {
  writer.string(value.id);
  writer.string(value.name);
}

export function readEntityInfo(reader: ProtocolReader): EntityInfo {
  return { id: reader.string(), name: reader.string() };
}

export function writeSubsystemStatus(writer: ProtocolWriter, value: SubsystemStatus): void {
  writer.string(value.name);
  writer.string(value.state);
  writer.string(value.detail);
}

export function readSubsystemStatus(reader: ProtocolReader): SubsystemStatus {
  return { name: reader.string(), state: reader.string(), detail: reader.string() };
}

/** SetViewportSize's request payload (without the frame header) */
export function encodeSetViewportSizeRequest(value: SetViewportSizeRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.i32(value.width);
  writer.i32(value.height);
  return writer.finish();
}

/** Reads SetViewportSize's request payload; bytes after the last field are ignored */
export function decodeSetViewportSizeRequest(payload: Uint8Array): SetViewportSizeRequest {
  const reader = new ProtocolReader(payload);
  const width = reader.i32();
  const height = reader.i32();
  return { width, height };
}

/** Hello's request payload (without the frame header) */
export function encodeHelloRequest(value: HelloRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.clientName);
  writer.string(value.protocolVersion);
  writer.string(value.token);
  return writer.finish();
}

/** Reads Hello's request payload; bytes after the last field are ignored */
export function decodeHelloRequest(payload: Uint8Array): HelloRequest {
  const reader = new ProtocolReader(payload);
  const clientName = reader.string();
  const protocolVersion = reader.string();
  const token = reader.string();
  return { clientName, protocolVersion, token };
}

/** PollEvents's request payload (without the frame header) */
export function encodePollEventsRequest(value: PollEventsRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.u32(value.epoch);
  writer.u32(value.afterSeq);
  writer.u32(value.maxEvents);
  return writer.finish();
}

/** Reads PollEvents's request payload; bytes after the last field are ignored */
export function decodePollEventsRequest(payload: Uint8Array): PollEventsRequest {
  const reader = new ProtocolReader(payload);
  const epoch = reader.u32();
  const afterSeq = reader.u32();
  const maxEvents = reader.u32();
  return { epoch, afterSeq, maxEvents };
}

/** RenderFrameIfChanged's request payload (without the frame header) */
export function encodeRenderFrameIfChangedRequest(value: RenderFrameIfChangedRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.u32(value.sinceRevision);
  return writer.finish();
}

/** Reads RenderFrameIfChanged's request payload; bytes after the last field are ignored */
export function decodeRenderFrameIfChangedRequest(payload: Uint8Array): RenderFrameIfChangedRequest {
  const reader = new ProtocolReader(payload);
  const sinceRevision = reader.u32();
  return { sinceRevision };
}

/** SetCameraPosition's request payload (without the frame header) */
export function encodeSetCameraPositionRequest(value: SetCameraPositionRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.f32(value.x);
  writer.f32(value.y);
  writer.f32(value.z);
  return writer.finish();
}

/** Reads SetCameraPosition's request payload; bytes after the last field are ignored */
export function decodeSetCameraPositionRequest(payload: Uint8Array): SetCameraPositionRequest {
  const reader = new ProtocolReader(payload);
  const x = reader.f32();
  const y = reader.f32();
  const z = reader.f32();
  return { x, y, z };
}

/** SetEditorCamera's request payload (without the frame header) */
export function encodeSetEditorCameraRequest(value: SetEditorCameraRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writeVec3(writer, value.position);
  writeQuat(writer, value.rotation);
  writer.f32(value.fovY);
  writer.bool(value.orthographic);
  writer.f32(value.orthoSize);
  writer.f32(value.nearPlane);
  writer.f32(value.farPlane);
  return writer.finish();
}

/** Reads SetEditorCamera's request payload; bytes after the last field are ignored */
export function decodeSetEditorCameraRequest(payload: Uint8Array): SetEditorCameraRequest {
  const reader = new ProtocolReader(payload);
  const position = readVec3(reader);
  const rotation = readQuat(reader);
  const fovY = reader.f32();
  const orthographic = reader.bool();
  const orthoSize = reader.f32();
  const nearPlane = reader.f32();
  const farPlane = reader.f32();
  return { position, rotation, fovY, orthographic, orthoSize, nearPlane, farPlane };
}

/** PickEntity's request payload (without the frame header) */
export function encodePickEntityRequest(value: PickEntityRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.f32(value.x);
  writer.f32(value.y);
  writer.bool(value.includeInactive);
  return writer.finish();
}

/** Reads PickEntity's request payload; bytes after the last field are ignored */
export function decodePickEntityRequest(payload: Uint8Array): PickEntityRequest {
  const reader = new ProtocolReader(payload);
  const x = reader.f32();
  const y = reader.f32();
  const includeInactive = reader.bool();
  return { x, y, includeInactive };
}

/** GetEntityBounds's request payload (without the frame header) */
export function encodeGetEntityBoundsRequest(value: GetEntityBoundsRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.json(value.entityIds);
  return writer.finish();
}

/** Reads GetEntityBounds's request payload; bytes after the last field are ignored */
export function decodeGetEntityBoundsRequest(payload: Uint8Array): GetEntityBoundsRequest {
  const reader = new ProtocolReader(payload);
  const entityIds = reader.json() as string[];
  return { entityIds };
}

/** CreateScene's request payload (without the frame header) */
export function encodeCreateSceneRequest(value: CreateSceneRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.name);
  return writer.finish();
}

/** Reads CreateScene's request payload; bytes after the last field are ignored */
export function decodeCreateSceneRequest(payload: Uint8Array): CreateSceneRequest {
  const reader = new ProtocolReader(payload);
  const name = reader.string();
  return { name };
}

/** LoadScene's request payload (without the frame header) */
export function encodeLoadSceneRequest(value: LoadSceneRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.sceneJson);
  return writer.finish();
}

/** Reads LoadScene's request payload; bytes after the last field are ignored */
export function decodeLoadSceneRequest(payload: Uint8Array): LoadSceneRequest {
  const reader = new ProtocolReader(payload);
  const sceneJson = reader.string();
  return { sceneJson };
}

/** DeleteScene's request payload (without the frame header) */
export function encodeDeleteSceneRequest(value: DeleteSceneRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.sceneName);
  return writer.finish();
}

/** Reads DeleteScene's request payload; bytes after the last field are ignored */
export function decodeDeleteSceneRequest(payload: Uint8Array): DeleteSceneRequest {
  const reader = new ProtocolReader(payload);
  const sceneName = reader.string();
  return { sceneName };
}

/** OpenScene's request payload (without the frame header) */
export function encodeOpenSceneRequest(value: OpenSceneRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.path);
  return writer.finish();
}

/** Reads OpenScene's request payload; bytes after the last field are ignored */
export function decodeOpenSceneRequest(payload: Uint8Array): OpenSceneRequest {
  const reader = new ProtocolReader(payload);
  const path = reader.string();
  return { path };
}

/** SaveSceneToFile's request payload (without the frame header) */
export function encodeSaveSceneToFileRequest(value: SaveSceneToFileRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.path);
  return writer.finish();
}

/** Reads SaveSceneToFile's request payload; bytes after the last field are ignored */
export function decodeSaveSceneToFileRequest(payload: Uint8Array): SaveSceneToFileRequest {
  const reader = new ProtocolReader(payload);
  const path = reader.string();
  return { path };
}

/** NewScene's request payload (without the frame header) */
export function encodeNewSceneRequest(value: NewSceneRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.path);
  writer.string(value.name);
  return writer.finish();
}

/** Reads NewScene's request payload; bytes after the last field are ignored */
export function decodeNewSceneRequest(payload: Uint8Array): NewSceneRequest {
  const reader = new ProtocolReader(payload);
  const path = reader.string();
  const name = reader.string();
  return { path, name };
}

/** CreateEntity's request payload (without the frame header) */
export function encodeCreateEntityRequest(value: CreateEntityRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.name);
  return writer.finish();
}

/** Reads CreateEntity's request payload; bytes after the last field are ignored */
export function decodeCreateEntityRequest(payload: Uint8Array): CreateEntityRequest {
  const reader = new ProtocolReader(payload);
  const name = reader.string();
  return { name };
}

/** DestroyEntity's request payload (without the frame header) */
export function encodeDestroyEntityRequest(value: DestroyEntityRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.entityId);
  return writer.finish();
}

/** Reads DestroyEntity's request payload; bytes after the last field are ignored */
export function decodeDestroyEntityRequest(payload: Uint8Array): DestroyEntityRequest {
  const reader = new ProtocolReader(payload);
  const entityId = reader.string();
  return { entityId };
}

/** SetEntityTransform's request payload (without the frame header) */
export function encodeSetEntityTransformRequest(value: SetEntityTransformRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.entityId);
  writeVec3(writer, value.position);
  writeVec3(writer, value.rotation);
  writeVec3(writer, value.scale);
  return writer.finish();
}

/** Reads SetEntityTransform's request payload; bytes after the last field are ignored */
export function decodeSetEntityTransformRequest(payload: Uint8Array): SetEntityTransformRequest {
  const reader = new ProtocolReader(payload);
  const entityId = reader.string();
  const position = readVec3(reader);
  const rotation = readVec3(reader);
  const scale = readVec3(reader);
  return { entityId, position, rotation, scale };
}

/** GetEntityTransform's request payload (without the frame header) */
export function encodeGetEntityTransformRequest(value: GetEntityTransformRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.entityId);
  return writer.finish();
}

/** Reads GetEntityTransform's request payload; bytes after the last field are ignored */
export function decodeGetEntityTransformRequest(payload: Uint8Array): GetEntityTransformRequest {
  const reader = new ProtocolReader(payload);
  const entityId = reader.string();
  return { entityId };
}

/** CreateEntityEx's request payload (without the frame header) */
export function encodeCreateEntityExRequest(value: CreateEntityExRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.name);
  writer.string(value.parentId);
  writer.i32(value.siblingIndex);
  writer.string(value.preset);
  return writer.finish();
}

/** Reads CreateEntityEx's request payload; bytes after the last field are ignored */
export function decodeCreateEntityExRequest(payload: Uint8Array): CreateEntityExRequest {
  const reader = new ProtocolReader(payload);
  const name = reader.string();
  const parentId = reader.string();
  const siblingIndex = reader.i32();
  const preset = reader.string();
  return { name, parentId, siblingIndex, preset };
}

/** SetEntityParent's request payload (without the frame header) */
export function encodeSetEntityParentRequest(value: SetEntityParentRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.entityId);
  writer.string(value.parentId);
  writer.i32(value.siblingIndex);
  writer.bool(value.keepWorldTransform);
  return writer.finish();
}

/** Reads SetEntityParent's request payload; bytes after the last field are ignored */
export function decodeSetEntityParentRequest(payload: Uint8Array): SetEntityParentRequest {
  const reader = new ProtocolReader(payload);
  const entityId = reader.string();
  const parentId = reader.string();
  const siblingIndex = reader.i32();
  const keepWorldTransform = reader.bool();
  return { entityId, parentId, siblingIndex, keepWorldTransform };
}

/** SetEntityProperties's request payload (without the frame header) */
export function encodeSetEntityPropertiesRequest(value: SetEntityPropertiesRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.entityId);
  writer.json(value.properties);
  return writer.finish();
}

/** Reads SetEntityProperties's request payload; bytes after the last field are ignored */
export function decodeSetEntityPropertiesRequest(payload: Uint8Array): SetEntityPropertiesRequest {
  const reader = new ProtocolReader(payload);
  const entityId = reader.string();
  const properties = reader.json() as unknown;
  return { entityId, properties };
}

/** DuplicateEntity's request payload (without the frame header) */
export function encodeDuplicateEntityRequest(value: DuplicateEntityRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.entityId);
  return writer.finish();
}

/** Reads DuplicateEntity's request payload; bytes after the last field are ignored */
export function decodeDuplicateEntityRequest(payload: Uint8Array): DuplicateEntityRequest {
  const reader = new ProtocolReader(payload);
  const entityId = reader.string();
  return { entityId };
}

/** GetEntity's request payload (without the frame header) */
export function encodeGetEntityRequest(value: GetEntityRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.entityId);
  return writer.finish();
}

/** Reads GetEntity's request payload; bytes after the last field are ignored */
export function decodeGetEntityRequest(payload: Uint8Array): GetEntityRequest {
  const reader = new ProtocolReader(payload);
  const entityId = reader.string();
  return { entityId };
}

/** SetLocalTransform's request payload (without the frame header) */
export function encodeSetLocalTransformRequest(value: SetLocalTransformRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.entityId);
  writeVec3(writer, value.position);
  writeQuat(writer, value.rotation);
  writeVec3(writer, value.scale);
  return writer.finish();
}

/** Reads SetLocalTransform's request payload; bytes after the last field are ignored */
export function decodeSetLocalTransformRequest(payload: Uint8Array): SetLocalTransformRequest {
  const reader = new ProtocolReader(payload);
  const entityId = reader.string();
  const position = readVec3(reader);
  const rotation = readQuat(reader);
  const scale = readVec3(reader);
  return { entityId, position, rotation, scale };
}

/** CreateScript's request payload (without the frame header) */
export function encodeCreateScriptRequest(value: CreateScriptRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.name);
  return writer.finish();
}

/** Reads CreateScript's request payload; bytes after the last field are ignored */
export function decodeCreateScriptRequest(payload: Uint8Array): CreateScriptRequest {
  const reader = new ProtocolReader(payload);
  const name = reader.string();
  return { name };
}

/** ListAssets's request payload (without the frame header) */
export function encodeListAssetsRequest(value: ListAssetsRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.folder);
  writer.bool(value.recursive);
  return writer.finish();
}

/** Reads ListAssets's request payload; bytes after the last field are ignored */
export function decodeListAssetsRequest(payload: Uint8Array): ListAssetsRequest {
  const reader = new ProtocolReader(payload);
  const folder = reader.string();
  const recursive = reader.bool();
  return { folder, recursive };
}

/** GetAssetInfo's request payload (without the frame header) */
export function encodeGetAssetInfoRequest(value: GetAssetInfoRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.uuidOrPath);
  return writer.finish();
}

/** Reads GetAssetInfo's request payload; bytes after the last field are ignored */
export function decodeGetAssetInfoRequest(payload: Uint8Array): GetAssetInfoRequest {
  const reader = new ProtocolReader(payload);
  const uuidOrPath = reader.string();
  return { uuidOrPath };
}

/** SetImportSettings's request payload (without the frame header) */
export function encodeSetImportSettingsRequest(value: SetImportSettingsRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.path);
  writer.json(value.customData);
  return writer.finish();
}

/** Reads SetImportSettings's request payload; bytes after the last field are ignored */
export function decodeSetImportSettingsRequest(payload: Uint8Array): SetImportSettingsRequest {
  const reader = new ProtocolReader(payload);
  const path = reader.string();
  const customData = reader.json() as unknown;
  return { path, customData };
}

/** ReadTextAsset's request payload (without the frame header) */
export function encodeReadTextAssetRequest(value: ReadTextAssetRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.path);
  return writer.finish();
}

/** Reads ReadTextAsset's request payload; bytes after the last field are ignored */
export function decodeReadTextAssetRequest(payload: Uint8Array): ReadTextAssetRequest {
  const reader = new ProtocolReader(payload);
  const path = reader.string();
  return { path };
}

/** WriteTextAsset's request payload (without the frame header) */
export function encodeWriteTextAssetRequest(value: WriteTextAssetRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.path);
  writer.string(value.text);
  return writer.finish();
}

/** Reads WriteTextAsset's request payload; bytes after the last field are ignored */
export function decodeWriteTextAssetRequest(payload: Uint8Array): WriteTextAssetRequest {
  const reader = new ProtocolReader(payload);
  const path = reader.string();
  const text = reader.string();
  return { path, text };
}

/** CreateScriptAsset's request payload (without the frame header) */
export function encodeCreateScriptAssetRequest(value: CreateScriptAssetRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.path);
  writer.string(value.className);
  return writer.finish();
}

/** Reads CreateScriptAsset's request payload; bytes after the last field are ignored */
export function decodeCreateScriptAssetRequest(payload: Uint8Array): CreateScriptAssetRequest {
  const reader = new ProtocolReader(payload);
  const path = reader.string();
  const className = reader.string();
  return { path, className };
}

/** CreateFolder's request payload (without the frame header) */
export function encodeCreateFolderRequest(value: CreateFolderRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.path);
  return writer.finish();
}

/** Reads CreateFolder's request payload; bytes after the last field are ignored */
export function decodeCreateFolderRequest(payload: Uint8Array): CreateFolderRequest {
  const reader = new ProtocolReader(payload);
  const path = reader.string();
  return { path };
}

/** AddComponent's request payload (without the frame header) */
export function encodeAddComponentRequest(value: AddComponentRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.entityId);
  writer.string(value.typeName);
  return writer.finish();
}

/** Reads AddComponent's request payload; bytes after the last field are ignored */
export function decodeAddComponentRequest(payload: Uint8Array): AddComponentRequest {
  const reader = new ProtocolReader(payload);
  const entityId = reader.string();
  const typeName = reader.string();
  return { entityId, typeName };
}

/** RemoveComponent's request payload (without the frame header) */
export function encodeRemoveComponentRequest(value: RemoveComponentRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.entityId);
  writer.string(value.componentId);
  return writer.finish();
}

/** Reads RemoveComponent's request payload; bytes after the last field are ignored */
export function decodeRemoveComponentRequest(payload: Uint8Array): RemoveComponentRequest {
  const reader = new ProtocolReader(payload);
  const entityId = reader.string();
  const componentId = reader.string();
  return { entityId, componentId };
}

/** SetComponentFields's request payload (without the frame header) */
export function encodeSetComponentFieldsRequest(value: SetComponentFieldsRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.entityId);
  writer.string(value.componentId);
  writer.json(value.values);
  return writer.finish();
}

/** Reads SetComponentFields's request payload; bytes after the last field are ignored */
export function decodeSetComponentFieldsRequest(payload: Uint8Array): SetComponentFieldsRequest {
  const reader = new ProtocolReader(payload);
  const entityId = reader.string();
  const componentId = reader.string();
  const values = reader.json() as unknown;
  return { entityId, componentId, values };
}

/** GetComponent's request payload (without the frame header) */
export function encodeGetComponentRequest(value: GetComponentRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.entityId);
  writer.string(value.componentId);
  return writer.finish();
}

/** Reads GetComponent's request payload; bytes after the last field are ignored */
export function decodeGetComponentRequest(payload: Uint8Array): GetComponentRequest {
  const reader = new ProtocolReader(payload);
  const entityId = reader.string();
  const componentId = reader.string();
  return { entityId, componentId };
}

/** GetLuaFields's request payload (without the frame header) */
export function encodeGetLuaFieldsRequest(value: GetLuaFieldsRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.entityId);
  writer.string(value.componentId);
  return writer.finish();
}

/** Reads GetLuaFields's request payload; bytes after the last field are ignored */
export function decodeGetLuaFieldsRequest(payload: Uint8Array): GetLuaFieldsRequest {
  const reader = new ProtocolReader(payload);
  const entityId = reader.string();
  const componentId = reader.string();
  return { entityId, componentId };
}

/** SetProjectSettings's request payload (without the frame header) */
export function encodeSetProjectSettingsRequest(value: SetProjectSettingsRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.json(value.settings);
  return writer.finish();
}

/** Reads SetProjectSettings's request payload; bytes after the last field are ignored */
export function decodeSetProjectSettingsRequest(payload: Uint8Array): SetProjectSettingsRequest {
  const reader = new ProtocolReader(payload);
  const settings = reader.json() as unknown;
  return { settings };
}

/** SetStartupScene's request payload (without the frame header) */
export function encodeSetStartupSceneRequest(value: SetStartupSceneRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.path);
  return writer.finish();
}

/** Reads SetStartupScene's request payload; bytes after the last field are ignored */
export function decodeSetStartupSceneRequest(payload: Uint8Array): SetStartupSceneRequest {
  const reader = new ProtocolReader(payload);
  const path = reader.string();
  return { path };
}

/** BeginEditGroup's request payload (without the frame header) */
export function encodeBeginEditGroupRequest(value: BeginEditGroupRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.label);
  return writer.finish();
}

/** Reads BeginEditGroup's request payload; bytes after the last field are ignored */
export function decodeBeginEditGroupRequest(payload: Uint8Array): BeginEditGroupRequest {
  const reader = new ProtocolReader(payload);
  const label = reader.string();
  return { label };
}

/** WritePlaySnapshot's request payload (without the frame header) */
export function encodeWritePlaySnapshotRequest(value: WritePlaySnapshotRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.scenePath);
  return writer.finish();
}

/** Reads WritePlaySnapshot's request payload; bytes after the last field are ignored */
export function decodeWritePlaySnapshotRequest(payload: Uint8Array): WritePlaySnapshotRequest {
  const reader = new ProtocolReader(payload);
  const scenePath = reader.string();
  return { scenePath };
}

/** SetPaused's request payload (without the frame header) */
export function encodeSetPausedRequest(value: SetPausedRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.bool(value.paused);
  return writer.finish();
}

/** Reads SetPaused's request payload; bytes after the last field are ignored */
export function decodeSetPausedRequest(payload: Uint8Array): SetPausedRequest {
  const reader = new ProtocolReader(payload);
  const paused = reader.bool();
  return { paused };
}

/** Step's request payload (without the frame header) */
export function encodeStepRequest(value: StepRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.u32(value.frames);
  return writer.finish();
}

/** Reads Step's request payload; bytes after the last field are ignored */
export function decodeStepRequest(payload: Uint8Array): StepRequest {
  const reader = new ProtocolReader(payload);
  const frames = reader.u32();
  return { frames };
}

/** SendInput's request payload (without the frame header) */
export function encodeSendInputRequest(value: SendInputRequest): Uint8Array {
  const writer = new ProtocolWriter();
  writer.json(value.events);
  return writer.finish();
}

/** Reads SendInput's request payload; bytes after the last field are ignored */
export function decodeSendInputRequest(payload: Uint8Array): SendInputRequest {
  const reader = new ProtocolReader(payload);
  const events = reader.json() as InputEvent[];
  return { events };
}

/** Ok's (empty) payload */
export function encodeOkResponse(_value: OkResponse): Uint8Array {
  const writer = new ProtocolWriter();
  return writer.finish();
}

/** Ok has no fields */
export function decodeOkResponse(_payload: Uint8Array): OkResponse {
  return {};
}

/** Error's payload: the message's raw UTF-8 bytes */
export function encodeErrorResponse(value: ErrorResponse): Uint8Array {
  return textEncoder.encode(value.message);
}

/** Error's message: the whole payload as UTF-8 */
export function decodeErrorResponse(payload: Uint8Array): ErrorResponse {
  return { message: textDecoder.decode(payload) };
}

/** FrameData's payload (without the frame header) */
export function encodeFrameDataResponse(value: FrameDataResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.u32(value.width);
  writer.u32(value.height);
  writer.bytes(value.pixels);
  return writer.finish();
}

/** Reads FrameData's payload; bytes after the last field are ignored */
export function decodeFrameDataResponse(payload: Uint8Array): FrameDataResponse {
  const reader = new ProtocolReader(payload);
  const width = reader.u32();
  const height = reader.u32();
  const pixels = reader.rest();
  return { width, height, pixels };
}

/** AudioSamples's payload (without the frame header) */
export function encodeAudioSamplesResponse(value: AudioSamplesResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.u32(value.sampleRate);
  writer.u32(value.channels);
  writer.string(value.sampleFormat);
  writer.u32(value.frameCount);
  writer.u32(value.droppedFrames);
  writer.bytes(value.samples);
  return writer.finish();
}

/** Reads AudioSamples's payload; bytes after the last field are ignored */
export function decodeAudioSamplesResponse(payload: Uint8Array): AudioSamplesResponse {
  const reader = new ProtocolReader(payload);
  const sampleRate = reader.u32();
  const channels = reader.u32();
  const sampleFormat = reader.string();
  const frameCount = reader.u32();
  const droppedFrames = reader.u32();
  const samples = reader.rest();
  return { sampleRate, channels, sampleFormat, frameCount, droppedFrames, samples };
}

/** ServerInfo's payload (without the frame header) */
export function encodeServerInfoResponse(value: ServerInfoResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.protocolVersion);
  writer.string(value.engineVersion);
  writer.json(value.capabilities);
  writer.bool(value.projectLoaded);
  return writer.finish();
}

/** Reads ServerInfo's payload; bytes after the last field are ignored */
export function decodeServerInfoResponse(payload: Uint8Array): ServerInfoResponse {
  const reader = new ProtocolReader(payload);
  const protocolVersion = reader.string();
  const engineVersion = reader.string();
  const capabilities = reader.json() as string[];
  const projectLoaded = reader.bool();
  return { protocolVersion, engineVersion, capabilities, projectLoaded };
}

/** Events's payload (without the frame header) */
export function encodeEventsResponse(value: EventsResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.u32(value.epoch);
  writer.u32(value.nextSeq);
  writer.u32(value.dropped);
  writer.json(value.events);
  return writer.finish();
}

/** Reads Events's payload; bytes after the last field are ignored */
export function decodeEventsResponse(payload: Uint8Array): EventsResponse {
  const reader = new ProtocolReader(payload);
  const epoch = reader.u32();
  const nextSeq = reader.u32();
  const dropped = reader.u32();
  const events = reader.json() as EditorEvent[];
  return { epoch, nextSeq, dropped, events };
}

/** FrameUpdate's payload (without the frame header) */
export function encodeFrameUpdateResponse(value: FrameUpdateResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.u32(value.revision);
  writer.bool(value.modified);
  writer.u32(value.width);
  writer.u32(value.height);
  writer.bytes(value.pixels);
  return writer.finish();
}

/** Reads FrameUpdate's payload; bytes after the last field are ignored */
export function decodeFrameUpdateResponse(payload: Uint8Array): FrameUpdateResponse {
  const reader = new ProtocolReader(payload);
  const revision = reader.u32();
  const modified = reader.bool();
  const width = reader.u32();
  const height = reader.u32();
  const pixels = reader.rest();
  return { revision, modified, width, height, pixels };
}

/** CameraPosition's payload (without the frame header) */
export function encodeCameraPositionResponse(value: CameraPositionResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.f32(value.x);
  writer.f32(value.y);
  writer.f32(value.z);
  return writer.finish();
}

/** Reads CameraPosition's payload; bytes after the last field are ignored */
export function decodeCameraPositionResponse(payload: Uint8Array): CameraPositionResponse {
  const reader = new ProtocolReader(payload);
  const x = reader.f32();
  const y = reader.f32();
  const z = reader.f32();
  return { x, y, z };
}

/** EditorCamera's payload (without the frame header) */
export function encodeEditorCameraResponse(value: EditorCameraResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writeVec3(writer, value.position);
  writeQuat(writer, value.rotation);
  writer.f32(value.fovY);
  writer.bool(value.orthographic);
  writer.f32(value.orthoSize);
  writer.f32(value.nearPlane);
  writer.f32(value.farPlane);
  writer.mat4(value.view);
  writer.mat4(value.projection);
  return writer.finish();
}

/** Reads EditorCamera's payload; bytes after the last field are ignored */
export function decodeEditorCameraResponse(payload: Uint8Array): EditorCameraResponse {
  const reader = new ProtocolReader(payload);
  const position = readVec3(reader);
  const rotation = readQuat(reader);
  const fovY = reader.f32();
  const orthographic = reader.bool();
  const orthoSize = reader.f32();
  const nearPlane = reader.f32();
  const farPlane = reader.f32();
  const view = reader.mat4();
  const projection = reader.mat4();
  return { position, rotation, fovY, orthographic, orthoSize, nearPlane, farPlane, view, projection };
}

/** PickResult's payload (without the frame header) */
export function encodePickResultResponse(value: PickResultResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.entityId);
  writeVec3(writer, value.point);
  writer.f32(value.distance);
  return writer.finish();
}

/** Reads PickResult's payload; bytes after the last field are ignored */
export function decodePickResultResponse(payload: Uint8Array): PickResultResponse {
  const reader = new ProtocolReader(payload);
  const entityId = reader.string();
  const point = readVec3(reader);
  const distance = reader.f32();
  return { entityId, point, distance };
}

/** Bounds's payload (without the frame header) */
export function encodeBoundsResponse(value: BoundsResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.json(value.bounds);
  return writer.finish();
}

/** Reads Bounds's payload; bytes after the last field are ignored */
export function decodeBoundsResponse(payload: Uint8Array): BoundsResponse {
  const reader = new ProtocolReader(payload);
  const bounds = reader.json() as EntityBounds[];
  return { bounds };
}

/** SceneData's payload (without the frame header) */
export function encodeSceneDataResponse(value: SceneDataResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.sceneJson);
  return writer.finish();
}

/** Reads SceneData's payload; bytes after the last field are ignored */
export function decodeSceneDataResponse(payload: Uint8Array): SceneDataResponse {
  const reader = new ProtocolReader(payload);
  const sceneJson = reader.string();
  return { sceneJson };
}

/** SceneInfo's payload (without the frame header) */
export function encodeSceneInfoResponse(value: SceneInfoResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.path);
  writer.string(value.name);
  writer.string(value.uuid);
  writer.u32(value.revision);
  writer.u32(value.savedRevision);
  return writer.finish();
}

/** Reads SceneInfo's payload; bytes after the last field are ignored */
export function decodeSceneInfoResponse(payload: Uint8Array): SceneInfoResponse {
  const reader = new ProtocolReader(payload);
  const path = reader.string();
  const name = reader.string();
  const uuid = reader.string();
  const revision = reader.u32();
  const savedRevision = reader.u32();
  return { path, name, uuid, revision, savedRevision };
}

/** Hierarchy's payload (without the frame header) */
export function encodeHierarchyResponse(value: HierarchyResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.u32(value.revision);
  writer.json(value.nodes);
  return writer.finish();
}

/** Reads Hierarchy's payload; bytes after the last field are ignored */
export function decodeHierarchyResponse(payload: Uint8Array): HierarchyResponse {
  const reader = new ProtocolReader(payload);
  const revision = reader.u32();
  const nodes = reader.json() as HierarchyNode[];
  return { revision, nodes };
}

/** EntityCreated's payload (without the frame header) */
export function encodeEntityCreatedResponse(value: EntityCreatedResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.entityId);
  return writer.finish();
}

/** Reads EntityCreated's payload; bytes after the last field are ignored */
export function decodeEntityCreatedResponse(payload: Uint8Array): EntityCreatedResponse {
  const reader = new ProtocolReader(payload);
  const entityId = reader.string();
  return { entityId };
}

/** EntityTransform's payload (without the frame header) */
export function encodeEntityTransformResponse(value: EntityTransformResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writeVec3(writer, value.position);
  writeVec3(writer, value.rotation);
  writeVec3(writer, value.scale);
  return writer.finish();
}

/** Reads EntityTransform's payload; bytes after the last field are ignored */
export function decodeEntityTransformResponse(payload: Uint8Array): EntityTransformResponse {
  const reader = new ProtocolReader(payload);
  const position = readVec3(reader);
  const rotation = readVec3(reader);
  const scale = readVec3(reader);
  return { position, rotation, scale };
}

/** EntityList's payload (without the frame header) */
export function encodeEntityListResponse(value: EntityListResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.u32(value.entities.length);
  for (const element of value.entities) { writeEntityInfo(writer, element); }
  return writer.finish();
}

/** Reads EntityList's payload; bytes after the last field are ignored */
export function decodeEntityListResponse(payload: Uint8Array): EntityListResponse {
  const reader = new ProtocolReader(payload);
  const count = reader.u32();
  const entities = readArray(reader, count, readEntityInfo);
  return { count, entities };
}

/** EntityData's payload (without the frame header) */
export function encodeEntityDataResponse(value: EntityDataResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.json(value.entity);
  writer.mat4(value.worldMatrix);
  return writer.finish();
}

/** Reads EntityData's payload; bytes after the last field are ignored */
export function decodeEntityDataResponse(payload: Uint8Array): EntityDataResponse {
  const reader = new ProtocolReader(payload);
  const entity = reader.json() as EntityDetails;
  const worldMatrix = reader.mat4();
  return { entity, worldMatrix };
}

/** ScriptData's payload (without the frame header) */
export function encodeScriptDataResponse(value: ScriptDataResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.scriptTemplate);
  return writer.finish();
}

/** Reads ScriptData's payload; bytes after the last field are ignored */
export function decodeScriptDataResponse(payload: Uint8Array): ScriptDataResponse {
  const reader = new ProtocolReader(payload);
  const scriptTemplate = reader.string();
  return { scriptTemplate };
}

/** AssetList's payload (without the frame header) */
export function encodeAssetListResponse(value: AssetListResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.json(value.folders);
  writer.json(value.assets);
  return writer.finish();
}

/** Reads AssetList's payload; bytes after the last field are ignored */
export function decodeAssetListResponse(payload: Uint8Array): AssetListResponse {
  const reader = new ProtocolReader(payload);
  const folders = reader.json() as string[];
  const assets = reader.json() as AssetInfo[];
  return { folders, assets };
}

/** AssetDetail's payload (without the frame header) */
export function encodeAssetDetailResponse(value: AssetDetailResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.json(value.info);
  return writer.finish();
}

/** Reads AssetDetail's payload; bytes after the last field are ignored */
export function decodeAssetDetailResponse(payload: Uint8Array): AssetDetailResponse {
  const reader = new ProtocolReader(payload);
  const info = reader.json() as AssetDetails;
  return { info };
}

/** TextData's payload (without the frame header) */
export function encodeTextDataResponse(value: TextDataResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.text);
  return writer.finish();
}

/** Reads TextData's payload; bytes after the last field are ignored */
export function decodeTextDataResponse(payload: Uint8Array): TextDataResponse {
  const reader = new ProtocolReader(payload);
  const text = reader.string();
  return { text };
}

/** AssetCreated's payload (without the frame header) */
export function encodeAssetCreatedResponse(value: AssetCreatedResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.path);
  writer.string(value.uuid);
  return writer.finish();
}

/** Reads AssetCreated's payload; bytes after the last field are ignored */
export function decodeAssetCreatedResponse(payload: Uint8Array): AssetCreatedResponse {
  const reader = new ProtocolReader(payload);
  const path = reader.string();
  const uuid = reader.string();
  return { path, uuid };
}

/** EngineHealth's payload (without the frame header) */
export function encodeEngineHealthResponse(value: EngineHealthResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.bool(value.healthy);
  writer.u32(value.subsystems.length);
  for (const element of value.subsystems) { writeSubsystemStatus(writer, element); }
  return writer.finish();
}

/** Reads EngineHealth's payload; bytes after the last field are ignored */
export function decodeEngineHealthResponse(payload: Uint8Array): EngineHealthResponse {
  const reader = new ProtocolReader(payload);
  const healthy = reader.bool();
  const count = reader.u32();
  const subsystems = readArray(reader, count, readSubsystemStatus);
  return { healthy, count, subsystems };
}

/** ComponentTypes's payload (without the frame header) */
export function encodeComponentTypesResponse(value: ComponentTypesResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.json(value.types);
  return writer.finish();
}

/** Reads ComponentTypes's payload; bytes after the last field are ignored */
export function decodeComponentTypesResponse(payload: Uint8Array): ComponentTypesResponse {
  const reader = new ProtocolReader(payload);
  const types = reader.json() as ComponentSchema[];
  return { types };
}

/** ComponentAdded's payload (without the frame header) */
export function encodeComponentAddedResponse(value: ComponentAddedResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.componentId);
  writer.json(value.values);
  return writer.finish();
}

/** Reads ComponentAdded's payload; bytes after the last field are ignored */
export function decodeComponentAddedResponse(payload: Uint8Array): ComponentAddedResponse {
  const reader = new ProtocolReader(payload);
  const componentId = reader.string();
  const values = reader.json() as unknown;
  return { componentId, values };
}

/** ComponentData's payload (without the frame header) */
export function encodeComponentDataResponse(value: ComponentDataResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.json(value.values);
  return writer.finish();
}

/** Reads ComponentData's payload; bytes after the last field are ignored */
export function decodeComponentDataResponse(payload: Uint8Array): ComponentDataResponse {
  const reader = new ProtocolReader(payload);
  const values = reader.json() as unknown;
  return { values };
}

/** LuaFields's payload (without the frame header) */
export function encodeLuaFieldsResponse(value: LuaFieldsResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.json(value.schema);
  return writer.finish();
}

/** Reads LuaFields's payload; bytes after the last field are ignored */
export function decodeLuaFieldsResponse(payload: Uint8Array): LuaFieldsResponse {
  const reader = new ProtocolReader(payload);
  const schema = reader.json() as ComponentSchema;
  return { schema };
}

/** ProjectInfo's payload (without the frame header) */
export function encodeProjectInfoResponse(value: ProjectInfoResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.rootPath);
  writer.string(value.userDataPath);
  writer.json(value.project);
  return writer.finish();
}

/** Reads ProjectInfo's payload; bytes after the last field are ignored */
export function decodeProjectInfoResponse(payload: Uint8Array): ProjectInfoResponse {
  const reader = new ProtocolReader(payload);
  const rootPath = reader.string();
  const userDataPath = reader.string();
  const project = reader.json() as ProjectFile;
  return { rootPath, userDataPath, project };
}

/** EditResult's payload (without the frame header) */
export function encodeEditResultResponse(value: EditResultResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.label);
  writer.u32(value.revision);
  writer.bool(value.canUndo);
  writer.bool(value.canRedo);
  writer.u32(value.savedRevision);
  return writer.finish();
}

/** Reads EditResult's payload; bytes after the last field are ignored */
export function decodeEditResultResponse(payload: Uint8Array): EditResultResponse {
  const reader = new ProtocolReader(payload);
  const label = reader.string();
  const revision = reader.u32();
  const canUndo = reader.bool();
  const canRedo = reader.bool();
  const savedRevision = reader.u32();
  return { label, revision, canUndo, canRedo, savedRevision };
}

/** History's payload (without the frame header) */
export function encodeHistoryResponse(value: HistoryResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.u32(value.cursor);
  writer.json(value.entries);
  return writer.finish();
}

/** Reads History's payload; bytes after the last field are ignored */
export function decodeHistoryResponse(payload: Uint8Array): HistoryResponse {
  const reader = new ProtocolReader(payload);
  const cursor = reader.u32();
  const entries = reader.json() as HistoryEntry[];
  return { cursor, entries };
}

/** Autosave's payload (without the frame header) */
export function encodeAutosaveResponse(value: AutosaveResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.json(value.info);
  return writer.finish();
}

/** Reads Autosave's payload; bytes after the last field are ignored */
export function decodeAutosaveResponse(payload: Uint8Array): AutosaveResponse {
  const reader = new ProtocolReader(payload);
  const info = reader.json() as AutosaveInfo;
  return { info };
}

/** PlaySnapshot's payload (without the frame header) */
export function encodePlaySnapshotResponse(value: PlaySnapshotResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.file);
  return writer.finish();
}

/** Reads PlaySnapshot's payload; bytes after the last field are ignored */
export function decodePlaySnapshotResponse(payload: Uint8Array): PlaySnapshotResponse {
  const reader = new ProtocolReader(payload);
  const file = reader.string();
  return { file };
}

/** PlayState's payload (without the frame header) */
export function encodePlayStateResponse(value: PlayStateResponse): Uint8Array {
  const writer = new ProtocolWriter();
  writer.string(value.state);
  writer.u32(value.frame);
  writer.f32(value.time);
  return writer.finish();
}

/** Reads PlayState's payload; bytes after the last field are ignored */
export function decodePlayStateResponse(payload: Uint8Array): PlayStateResponse {
  const reader = new ProtocolReader(payload);
  const state = reader.string();
  const frame = reader.u32();
  const time = reader.f32();
  return { state, frame, time };
}

/** Each command's request codecs, for commands with request fields */
export const RequestCodecs = {
  SetViewportSize: { encode: encodeSetViewportSizeRequest, decode: decodeSetViewportSizeRequest },
  Hello: { encode: encodeHelloRequest, decode: decodeHelloRequest },
  PollEvents: { encode: encodePollEventsRequest, decode: decodePollEventsRequest },
  RenderFrameIfChanged: { encode: encodeRenderFrameIfChangedRequest, decode: decodeRenderFrameIfChangedRequest },
  SetCameraPosition: { encode: encodeSetCameraPositionRequest, decode: decodeSetCameraPositionRequest },
  SetEditorCamera: { encode: encodeSetEditorCameraRequest, decode: decodeSetEditorCameraRequest },
  PickEntity: { encode: encodePickEntityRequest, decode: decodePickEntityRequest },
  GetEntityBounds: { encode: encodeGetEntityBoundsRequest, decode: decodeGetEntityBoundsRequest },
  CreateScene: { encode: encodeCreateSceneRequest, decode: decodeCreateSceneRequest },
  LoadScene: { encode: encodeLoadSceneRequest, decode: decodeLoadSceneRequest },
  DeleteScene: { encode: encodeDeleteSceneRequest, decode: decodeDeleteSceneRequest },
  OpenScene: { encode: encodeOpenSceneRequest, decode: decodeOpenSceneRequest },
  SaveSceneToFile: { encode: encodeSaveSceneToFileRequest, decode: decodeSaveSceneToFileRequest },
  NewScene: { encode: encodeNewSceneRequest, decode: decodeNewSceneRequest },
  CreateEntity: { encode: encodeCreateEntityRequest, decode: decodeCreateEntityRequest },
  DestroyEntity: { encode: encodeDestroyEntityRequest, decode: decodeDestroyEntityRequest },
  SetEntityTransform: { encode: encodeSetEntityTransformRequest, decode: decodeSetEntityTransformRequest },
  GetEntityTransform: { encode: encodeGetEntityTransformRequest, decode: decodeGetEntityTransformRequest },
  CreateEntityEx: { encode: encodeCreateEntityExRequest, decode: decodeCreateEntityExRequest },
  SetEntityParent: { encode: encodeSetEntityParentRequest, decode: decodeSetEntityParentRequest },
  SetEntityProperties: { encode: encodeSetEntityPropertiesRequest, decode: decodeSetEntityPropertiesRequest },
  DuplicateEntity: { encode: encodeDuplicateEntityRequest, decode: decodeDuplicateEntityRequest },
  GetEntity: { encode: encodeGetEntityRequest, decode: decodeGetEntityRequest },
  SetLocalTransform: { encode: encodeSetLocalTransformRequest, decode: decodeSetLocalTransformRequest },
  CreateScript: { encode: encodeCreateScriptRequest, decode: decodeCreateScriptRequest },
  ListAssets: { encode: encodeListAssetsRequest, decode: decodeListAssetsRequest },
  GetAssetInfo: { encode: encodeGetAssetInfoRequest, decode: decodeGetAssetInfoRequest },
  SetImportSettings: { encode: encodeSetImportSettingsRequest, decode: decodeSetImportSettingsRequest },
  ReadTextAsset: { encode: encodeReadTextAssetRequest, decode: decodeReadTextAssetRequest },
  WriteTextAsset: { encode: encodeWriteTextAssetRequest, decode: decodeWriteTextAssetRequest },
  CreateScriptAsset: { encode: encodeCreateScriptAssetRequest, decode: decodeCreateScriptAssetRequest },
  CreateFolder: { encode: encodeCreateFolderRequest, decode: decodeCreateFolderRequest },
  AddComponent: { encode: encodeAddComponentRequest, decode: decodeAddComponentRequest },
  RemoveComponent: { encode: encodeRemoveComponentRequest, decode: decodeRemoveComponentRequest },
  SetComponentFields: { encode: encodeSetComponentFieldsRequest, decode: decodeSetComponentFieldsRequest },
  GetComponent: { encode: encodeGetComponentRequest, decode: decodeGetComponentRequest },
  GetLuaFields: { encode: encodeGetLuaFieldsRequest, decode: decodeGetLuaFieldsRequest },
  SetProjectSettings: { encode: encodeSetProjectSettingsRequest, decode: decodeSetProjectSettingsRequest },
  SetStartupScene: { encode: encodeSetStartupSceneRequest, decode: decodeSetStartupSceneRequest },
  BeginEditGroup: { encode: encodeBeginEditGroupRequest, decode: decodeBeginEditGroupRequest },
  WritePlaySnapshot: { encode: encodeWritePlaySnapshotRequest, decode: decodeWritePlaySnapshotRequest },
  SetPaused: { encode: encodeSetPausedRequest, decode: decodeSetPausedRequest },
  Step: { encode: encodeStepRequest, decode: decodeStepRequest },
  SendInput: { encode: encodeSendInputRequest, decode: decodeSendInputRequest },
} as const;

/** Each response's codecs */
export const ResponseCodecs = {
  Ok: { encode: encodeOkResponse, decode: decodeOkResponse },
  Error: { encode: encodeErrorResponse, decode: decodeErrorResponse },
  FrameData: { encode: encodeFrameDataResponse, decode: decodeFrameDataResponse },
  AudioSamples: { encode: encodeAudioSamplesResponse, decode: decodeAudioSamplesResponse },
  ServerInfo: { encode: encodeServerInfoResponse, decode: decodeServerInfoResponse },
  Events: { encode: encodeEventsResponse, decode: decodeEventsResponse },
  FrameUpdate: { encode: encodeFrameUpdateResponse, decode: decodeFrameUpdateResponse },
  CameraPosition: { encode: encodeCameraPositionResponse, decode: decodeCameraPositionResponse },
  EditorCamera: { encode: encodeEditorCameraResponse, decode: decodeEditorCameraResponse },
  PickResult: { encode: encodePickResultResponse, decode: decodePickResultResponse },
  Bounds: { encode: encodeBoundsResponse, decode: decodeBoundsResponse },
  SceneData: { encode: encodeSceneDataResponse, decode: decodeSceneDataResponse },
  SceneInfo: { encode: encodeSceneInfoResponse, decode: decodeSceneInfoResponse },
  Hierarchy: { encode: encodeHierarchyResponse, decode: decodeHierarchyResponse },
  EntityCreated: { encode: encodeEntityCreatedResponse, decode: decodeEntityCreatedResponse },
  EntityTransform: { encode: encodeEntityTransformResponse, decode: decodeEntityTransformResponse },
  EntityList: { encode: encodeEntityListResponse, decode: decodeEntityListResponse },
  EntityData: { encode: encodeEntityDataResponse, decode: decodeEntityDataResponse },
  ScriptData: { encode: encodeScriptDataResponse, decode: decodeScriptDataResponse },
  AssetList: { encode: encodeAssetListResponse, decode: decodeAssetListResponse },
  AssetDetail: { encode: encodeAssetDetailResponse, decode: decodeAssetDetailResponse },
  TextData: { encode: encodeTextDataResponse, decode: decodeTextDataResponse },
  AssetCreated: { encode: encodeAssetCreatedResponse, decode: decodeAssetCreatedResponse },
  EngineHealth: { encode: encodeEngineHealthResponse, decode: decodeEngineHealthResponse },
  ComponentTypes: { encode: encodeComponentTypesResponse, decode: decodeComponentTypesResponse },
  ComponentAdded: { encode: encodeComponentAddedResponse, decode: decodeComponentAddedResponse },
  ComponentData: { encode: encodeComponentDataResponse, decode: decodeComponentDataResponse },
  LuaFields: { encode: encodeLuaFieldsResponse, decode: decodeLuaFieldsResponse },
  ProjectInfo: { encode: encodeProjectInfoResponse, decode: decodeProjectInfoResponse },
  EditResult: { encode: encodeEditResultResponse, decode: decodeEditResultResponse },
  History: { encode: encodeHistoryResponse, decode: decodeHistoryResponse },
  Autosave: { encode: encodeAutosaveResponse, decode: decodeAutosaveResponse },
  PlaySnapshot: { encode: encodePlaySnapshotResponse, decode: decodePlaySnapshotResponse },
  PlayState: { encode: encodePlayStateResponse, decode: decodePlayStateResponse },
} as const;
