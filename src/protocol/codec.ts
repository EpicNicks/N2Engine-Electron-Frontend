// Request encoders and response decoders, one spec per command. This is the only file that knows payload layouts:
// EngineClient just sends spec.command with spec.encode(request) and decodes the reply with spec.decode.
//
// These are hand-written against protocol.json. When the engine's TypeScript generator emits codecs (N2Engine
// E1a), each spec's encode/decode is replaced by the generated function; the specs, and everything using them,
// stay as they are.

import {
  CommandType,
  ResponseType,
  CameraPositionResponse,
  CreateEntityRequest,
  CreateSceneRequest,
  CreateScriptRequest,
  DeleteSceneRequest,
  DestroyEntityRequest,
  EngineHealthResponse,
  EntityCreatedResponse,
  EntityInfo,
  EntityListResponse,
  EntityTransformResponse,
  FrameDataResponse,
  GetEntityTransformRequest,
  LoadSceneRequest,
  SceneDataResponse,
  ScriptDataResponse,
  SetCameraPositionRequest,
  SetEntityTransformRequest,
  SetViewportSizeRequest,
  SubsystemStatus,
} from "./protocol.generated"
import { PayloadReader, PayloadWriter } from "./serialization"
import { AudioSamples, decodeAudioSamples } from "../audio-stream"

/** A request with no fields */
export type Empty = Record<string, never>

/** One command: its id, the response type it succeeds with, and how each side's payload is laid out */
export interface CommandSpec<Request, Response> {
  name: string
  command: CommandType
  response: ResponseType
  encode(request: Request): Buffer
  decode(payload: Buffer): Response
}

const noPayload = (): Buffer => Buffer.alloc(0)
const ok = (): void => undefined

function spec<Request, Response>(
  name: string,
  command: CommandType,
  response: ResponseType,
  encode: (request: Request) => Buffer,
  decode: (payload: Buffer) => Response
): CommandSpec<Request, Response> {
  return { name, command, response, encode, decode }
}

const reader = (payload: Buffer, what: string): PayloadReader => new PayloadReader(payload, what)

/** An Error response's payload is the message as raw UTF-8 (no length prefix), the documented special case */
export function decodeError(payload: Buffer): string {
  return payload.toString("utf-8")
}

export const Commands = {
  // ==================== Rendering ====================
  RenderFrame: spec<Empty, FrameDataResponse>(
    "RenderFrame",
    CommandType.RenderFrame,
    ResponseType.FrameData,
    noPayload,
    (payload) => {
      const r = reader(payload, "FrameData")
      const width = r.uint32()
      const height = r.uint32()
      const rest = r.rest()
      // A payload that owns its whole buffer (FrameReader assembled it from several chunks) is used in place. One
      // that is a view of a socket chunk is copied, since the chunk can hold other frames and would be kept alive
      // (and sent over IPC whole) along with the pixels.
      const ownsBuffer = payload.byteOffset === 0 && payload.byteLength === payload.buffer.byteLength
      const pixels = ownsBuffer ? new Uint8Array(rest.buffer, rest.byteOffset, rest.byteLength) : new Uint8Array(rest)
      return { width, height, pixels }
    }
  ),
  SetViewportSize: spec<SetViewportSizeRequest, void>(
    "SetViewportSize",
    CommandType.SetViewportSize,
    ResponseType.Ok,
    (req) => new PayloadWriter().int32(req.width).int32(req.height).finish(),
    ok
  ),
  GetAudio: spec<Empty, AudioSamples>(
    "GetAudio",
    CommandType.GetAudio,
    ResponseType.AudioSamples,
    noPayload,
    (payload) => decodeAudioSamples(payload)
  ),

  // ==================== Camera ====================
  SetCameraPosition: spec<SetCameraPositionRequest, void>(
    "SetCameraPosition",
    CommandType.SetCameraPosition,
    ResponseType.Ok,
    (req) => new PayloadWriter().float32(req.x).float32(req.y).float32(req.z).finish(),
    ok
  ),
  GetCameraPosition: spec<Empty, CameraPositionResponse>(
    "GetCameraPosition",
    CommandType.GetCameraPosition,
    ResponseType.CameraPosition,
    noPayload,
    (payload) => reader(payload, "CameraPosition").vec3()
  ),

  // ==================== Scenes ====================
  CreateScene: spec<CreateSceneRequest, SceneDataResponse>(
    "CreateScene",
    CommandType.CreateScene,
    ResponseType.SceneData,
    (req) => new PayloadWriter().string(req.name).finish(),
    decodeSceneData
  ),
  LoadScene: spec<LoadSceneRequest, void>(
    "LoadScene",
    CommandType.LoadScene,
    ResponseType.Ok,
    (req) => new PayloadWriter().string(req.sceneJson).finish(),
    ok
  ),
  SaveScene: spec<Empty, SceneDataResponse>(
    "SaveScene",
    CommandType.SaveScene,
    ResponseType.SceneData,
    noPayload,
    decodeSceneData
  ),
  DeleteScene: spec<DeleteSceneRequest, void>(
    "DeleteScene",
    CommandType.DeleteScene,
    ResponseType.Ok,
    (req) => new PayloadWriter().string(req.sceneName).finish(),
    ok
  ),
  GetCurrentScene: spec<Empty, SceneDataResponse>(
    "GetCurrentScene",
    CommandType.GetCurrentScene,
    ResponseType.SceneData,
    noPayload,
    decodeSceneData
  ),

  // ==================== Entities ====================
  CreateEntity: spec<CreateEntityRequest, EntityCreatedResponse>(
    "CreateEntity",
    CommandType.CreateEntity,
    ResponseType.EntityCreated,
    (req) => new PayloadWriter().string(req.name).finish(),
    (payload) => ({ entityId: reader(payload, "EntityCreated").string() })
  ),
  DestroyEntity: spec<DestroyEntityRequest, void>(
    "DestroyEntity",
    CommandType.DestroyEntity,
    ResponseType.Ok,
    (req) => new PayloadWriter().string(req.entityId).finish(),
    ok
  ),
  SetEntityTransform: spec<SetEntityTransformRequest, void>(
    "SetEntityTransform",
    CommandType.SetEntityTransform,
    ResponseType.Ok,
    (req) =>
      new PayloadWriter().string(req.entityId).vec3(req.position).vec3(req.rotation).vec3(req.scale).finish(),
    ok
  ),
  GetEntityTransform: spec<GetEntityTransformRequest, EntityTransformResponse>(
    "GetEntityTransform",
    CommandType.GetEntityTransform,
    ResponseType.EntityTransform,
    (req) => new PayloadWriter().string(req.entityId).finish(),
    (payload) => {
      const r = reader(payload, "EntityTransform")
      return { position: r.vec3(), rotation: r.vec3(), scale: r.vec3() }
    }
  ),
  GetAllEntities: spec<Empty, EntityListResponse>(
    "GetAllEntities",
    CommandType.GetAllEntities,
    ResponseType.EntityList,
    noPayload,
    (payload) => {
      const r = reader(payload, "EntityList")
      const count = r.uint32()
      const entities: EntityInfo[] = []
      for (let i = 0; i < count; i++) {
        entities.push({ id: r.string(), name: r.string() })
      }
      return { count, entities }
    }
  ),

  // ==================== Assets ====================
  CreateScript: spec<CreateScriptRequest, ScriptDataResponse>(
    "CreateScript",
    CommandType.CreateScript,
    ResponseType.ScriptData,
    (req) => new PayloadWriter().string(req.name).finish(),
    (payload) => ({ scriptTemplate: reader(payload, "ScriptData").string() })
  ),
  RescanAssets: spec<Empty, void>("RescanAssets", CommandType.RescanAssets, ResponseType.Ok, noPayload, ok),

  // ==================== Diagnostics ====================
  GetEngineHealth: spec<Empty, EngineHealthResponse>(
    "GetEngineHealth",
    CommandType.GetEngineHealth,
    ResponseType.EngineHealth,
    noPayload,
    (payload) => {
      const r = reader(payload, "EngineHealth")
      const healthy = r.bool()
      const count = r.uint32()
      const subsystems: SubsystemStatus[] = []
      for (let i = 0; i < count; i++) {
        subsystems.push({ name: r.string(), state: r.string(), detail: r.string() })
      }
      return { healthy, count, subsystems }
    }
  ),

  // ==================== Session ====================
  Shutdown: spec<Empty, void>("Shutdown", CommandType.Shutdown, ResponseType.Ok, noPayload, ok),
} as const

function decodeSceneData(payload: Buffer): SceneDataResponse {
  return { sceneJson: reader(payload, "SceneData").string() }
}
