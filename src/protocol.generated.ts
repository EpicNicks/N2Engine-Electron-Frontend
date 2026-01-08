// Auto-generated from protocol.json - do not edit

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface EntityInfo {
  id: string
  name: string
}

export const CommandType = {
  RenderFrame: 0x01,
  SetViewportSize: 0x02,
  SetCameraPosition: 0x10,
  GetCameraPosition: 0x12,
  CreateScene: 0x20,
  LoadScene: 0x21,
  SaveScene: 0x22,
  DeleteScene: 0x23,
  GetCurrentScene: 0x24,
  CreateEntity: 0x30,
  DestroyEntity: 0x31,
  SetEntityTransform: 0x32,
  GetEntityTransform: 0x33,
  GetAllEntities: 0x34,
  CreateScript: 0x40,
  RescanAssets: 0x41,
  Shutdown: 0xff,
} as const

export type CommandType = (typeof CommandType)[keyof typeof CommandType]

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
} as const

export type ResponseType = (typeof ResponseType)[keyof typeof ResponseType]

export interface SetViewportSizeRequest {
  width: number
  height: number
}

export interface SetCameraPositionRequest {
  x: number
  y: number
  z: number
}

export interface CreateSceneRequest {
  name: string
}

export interface LoadSceneRequest {
  sceneJson: string
}

export interface DeleteSceneRequest {
  sceneName: string
}

export interface CreateEntityRequest {
  name: string
}

export interface DestroyEntityRequest {
  entityId: string
}

export interface SetEntityTransformRequest {
  entityId: string
  position: Vec3
  rotation: Vec3
  scale: Vec3
}

export interface GetEntityTransformRequest {
  entityId: string
}

export interface CreateScriptRequest {
  name: string
}

export interface FrameDataResponse {
  width: number
  height: number
  pixels: Uint8Array
}

export interface CameraPositionResponse {
  x: number
  y: number
  z: number
}

export interface SceneDataResponse {
  sceneJson: string
}

export interface EntityCreatedResponse {
  entityId: string
}

export interface EntityTransformResponse {
  position: Vec3
  rotation: Vec3
  scale: Vec3
}

export interface EntityListResponse {
  count: number
  entities: EntityInfo[]
}

export interface ScriptDataResponse {
  scriptTemplate: string
}
