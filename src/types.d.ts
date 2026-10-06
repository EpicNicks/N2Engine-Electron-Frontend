interface SceneData {
  sceneJson: string
}

interface SubsystemStatus {
  name: string
  state: string
  detail: string
}

interface EngineHealth {
  healthy: boolean
  count: number
  subsystems: SubsystemStatus[]
}

interface AudioSamples {
  sampleRate: number
  channels: number
  sampleFormat: "float32" | "int16"
  frameCount: number
  droppedFrames: number
  samples: Float32Array
}

interface EngineAPI {
  // Connection
  connect(host?: string, port?: number): Promise<void>
  disconnect(): void
  isConnected(): boolean

  // Rendering
  renderFrame(): Promise<{ width: number; height: number; pixels: Uint8Array }>
  setViewportSize(width: number, height: number): Promise<void>
  getAudio(): Promise<AudioSamples | null>

  // Camera
  setCameraPosition(x: number, y: number, z: number): Promise<void>
  getCameraPosition(): Promise<{ x: number; y: number; z: number }>

  // Scene management
  createScene(name: string): Promise<SceneData>
  loadScene(sceneJson: string): Promise<void>
  saveScene(): Promise<SceneData>
  deleteScene(sceneName: string): Promise<void>
  getCurrentScene(): Promise<SceneData | null>

  createScript(name: string): Promise<string>
  rescanAssets(): Promise<void>

  // Diagnostics
  getEngineHealth(): Promise<EngineHealth>

  // Entity management
  createEntity(name: string): Promise<string>
  destroyEntity(entityId: string): Promise<void>
  getAllEntities(): Promise<Array<{ id: string; name: string }>>
  setEntityTransform(
    entityId: string,
    position: { x: number; y: number; z: number },
    rotation: { x: number; y: number; z: number },
    scale: { x: number; y: number; z: number }
  ): Promise<void>
  getEntityTransform(entityId: string): Promise<{
    position: { x: number; y: number; z: number }
    rotation: { x: number; y: number; z: number }
    scale: { x: number; y: number; z: number }
  }>
}

interface AudioStatus {
  state: "stopped" | "playing" | "muted" | "suspended" | "unavailable" | "error"
  message: string
  bufferedMs: number
  sampleRate: number
  channels: number
  sampleFormat: string
  underruns: number
  gaps: number
  serverDroppedFrames: number
}

interface AudioAPI {
  start(): void
  stop(): void
  setMuted(muted: boolean): void
  isMuted(): boolean
  onStatus(listener: (status: AudioStatus) => void): void
}

interface FileInfo {
  name: string
  path: string
  isDirectory: boolean
  children?: FileInfo[]
}

interface FileSystemAPI {
  openProjectDialog(): Promise<string | null>
  createProjectDialog(): Promise<string | null>
  getRecentProjects(): Promise<string[]>

  readDirectory(dirPath: string): FileInfo[]
  readFile(filePath: string): string
  writeFile(filePath: string, content: string): void
  createFile(filePath: string): void
  createDirectory(dirPath: string): void
  deleteFile(filePath: string): void
  deleteDirectory(dirPath: string): void
  rename(oldPath: string, newPath: string): void
  exists(filePath: string): boolean
  isDirectory(filePath: string): boolean

  join(...paths: string[]): string
  dirname(filePath: string): string
  basename(filePath: string): string
  extname(filePath: string): string
}

interface Window {
  engine: EngineAPI
  audio: AudioAPI
  fileSystem: FileSystemAPI
}
