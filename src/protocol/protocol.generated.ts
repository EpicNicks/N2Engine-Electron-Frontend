// Auto-generated from protocol.json by generate_typescript.py - do not edit

/** protocol.json's version (major.minor.patch); Hello sends it, and the server answers with its own */
export const PROTOCOL_VERSION = "1.4.0";

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

// ==================== Ids ====================

export const CommandType = {
  RenderFrame: 0x01,
  SetViewportSize: 0x02,
  GetAudio: 0x03,
  Hello: 0x04,
  PollEvents: 0x05,
  SetCameraPosition: 0x10,
  GetCameraPosition: 0x12,
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
  GetEngineHealth: 0x50,
  GetProjectInfo: 0x70,
  SetProjectSettings: 0x71,
  SetStartupScene: 0x72,
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
} as const;

export type ResponseType = typeof ResponseType[keyof typeof ResponseType];

/** The response each command answers with when it succeeds (any command may answer Error instead) */
export const CommandResponse = {
  RenderFrame: "FrameData",
  SetViewportSize: "Ok",
  GetAudio: "AudioSamples",
  Hello: "ServerInfo",
  PollEvents: "Events",
  SetCameraPosition: "Ok",
  GetCameraPosition: "CameraPosition",
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
  GetEngineHealth: "EngineHealth",
  GetProjectInfo: "ProjectInfo",
  SetProjectSettings: "ProjectInfo",
  SetStartupScene: "ProjectInfo",
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

export interface SetCameraPositionRequest {
  x: number;
  y: number;
  z: number;
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

export interface SetProjectSettingsRequest {
  settings: unknown;
}

export interface SetStartupSceneRequest {
  path: string;
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

export interface CameraPositionResponse {
  x: number;
  y: number;
  z: number;
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

export interface EngineHealthResponse {
  healthy: boolean;
  count: number;
  subsystems: SubsystemStatus[];
}

export interface ProjectInfoResponse {
  rootPath: string;
  userDataPath: string;
  project: ProjectFile;
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

/** Each command's request codecs, for commands with request fields */
export const RequestCodecs = {
  SetViewportSize: { encode: encodeSetViewportSizeRequest, decode: decodeSetViewportSizeRequest },
  Hello: { encode: encodeHelloRequest, decode: decodeHelloRequest },
  PollEvents: { encode: encodePollEventsRequest, decode: decodePollEventsRequest },
  SetCameraPosition: { encode: encodeSetCameraPositionRequest, decode: decodeSetCameraPositionRequest },
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
  SetProjectSettings: { encode: encodeSetProjectSettingsRequest, decode: decodeSetProjectSettingsRequest },
  SetStartupScene: { encode: encodeSetStartupSceneRequest, decode: decodeSetStartupSceneRequest },
} as const;

/** Each response's codecs */
export const ResponseCodecs = {
  Ok: { encode: encodeOkResponse, decode: decodeOkResponse },
  Error: { encode: encodeErrorResponse, decode: decodeErrorResponse },
  FrameData: { encode: encodeFrameDataResponse, decode: decodeFrameDataResponse },
  AudioSamples: { encode: encodeAudioSamplesResponse, decode: decodeAudioSamplesResponse },
  ServerInfo: { encode: encodeServerInfoResponse, decode: decodeServerInfoResponse },
  Events: { encode: encodeEventsResponse, decode: decodeEventsResponse },
  CameraPosition: { encode: encodeCameraPositionResponse, decode: decodeCameraPositionResponse },
  SceneData: { encode: encodeSceneDataResponse, decode: decodeSceneDataResponse },
  SceneInfo: { encode: encodeSceneInfoResponse, decode: decodeSceneInfoResponse },
  Hierarchy: { encode: encodeHierarchyResponse, decode: decodeHierarchyResponse },
  EntityCreated: { encode: encodeEntityCreatedResponse, decode: decodeEntityCreatedResponse },
  EntityTransform: { encode: encodeEntityTransformResponse, decode: decodeEntityTransformResponse },
  EntityList: { encode: encodeEntityListResponse, decode: decodeEntityListResponse },
  EntityData: { encode: encodeEntityDataResponse, decode: decodeEntityDataResponse },
  ScriptData: { encode: encodeScriptDataResponse, decode: decodeScriptDataResponse },
  EngineHealth: { encode: encodeEngineHealthResponse, decode: decodeEngineHealthResponse },
  ProjectInfo: { encode: encodeProjectInfoResponse, decode: decodeProjectInfoResponse },
} as const;
