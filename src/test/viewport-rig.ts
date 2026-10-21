import type { EntityDataResponse, Quat, Vec3 } from "../protocol/protocol.generated"
import { PickBackend, ViewportController, ViewportDeps } from "../renderer/viewport-controller"
import { IdentityQuat, mat4Compose, vec3 } from "../renderer/viewport-math"

// A viewport controller over fakes, for the tests of the gizmo's tools (the Node tests and the DOM ones): the host has
// the entities given, and the edit groups and the transforms sent are logged.

export const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

export interface Entity {
  position: Vec3
  rotation?: Quat
  scale?: Vec3
  parentId?: string
}

export function entityData(id: string, e: Entity): EntityDataResponse {
  const rotation = e.rotation ?? IdentityQuat
  const scale = e.scale ?? vec3(1, 1, 1)
  return {
    entity: {
      header: { id, parentId: e.parentId ?? "", index: 0, name: id === "a" ? "Cube" : id, active: true, activeInHierarchy: true, layer: 0, tag: "" },
      transform: { position: e.position, rotation, scale },
      components: [],
    },
    worldMatrix: mat4Compose(e.position, rotation, scale),
  }
}

/** A controller over fakes: the host has the entities given, the edit groups and the transforms are logged */
export function rig(options: { entities?: Record<string, Entity>; selection?: string[]; canEdit?: boolean; picking?: PickBackend } = {}) {
  const entities = options.entities ?? { a: { position: vec3(1, 2, 3) } }
  const selection = options.selection ?? ["a"]
  const log: string[] = []
  const sets: Array<{ id: string; position: Vec3; rotation: Quat; scale: Vec3 }> = []
  const errors: string[] = []
  const selected: Array<string | null> = []
  let frames = 0
  let canEdit = options.canEdit ?? true
  const deps: ViewportDeps = {
    engine: {
      isConnected: () => true,
      setEditorCamera: async () => {},
      getEditorCamera: async () => ({
        position: vec3(0, 0, 10),
        rotation: IdentityQuat,
        fovY: 60,
        orthographic: false,
        orthoSize: 5,
        nearPlane: 0.1,
        farPlane: 1000,
        view: new Array(16).fill(0),
        projection: new Array(16).fill(0),
      }),
      getEntity: async (id) => entityData(id, entities[id] ?? { position: vec3(0, 0, 0) }),
      setLocalTransform: async (id, position, rotation, scale) => {
        log.push(`set ${id}`)
        sets.push({ id, position, rotation, scale })
      },
    },
    groups: {
      begin: async (label) => {
        log.push(`begin ${label}`)
        return 1
      },
      end: async () => {
        log.push("end")
      },
    },
    picking: options.picking ?? null,
    onError: (what) => errors.push(what),
    onNote: () => {},
    canEdit: () => canEdit,
    selected: () => selection[0] ?? null,
    moveIds: () => selection,
    selectionIds: () => selection,
    select: (id) => selected.push(id),
  }
  const controller = new ViewportController(deps)
  controller.onFrameNeeded(() => frames++)
  controller.setSize({ width: 800, height: 600 })
  return {
    controller,
    log,
    sets,
    errors,
    selected,
    frames: () => frames,
    setCanEdit: (value: boolean) => (canEdit = value),
    /** Connects and reads the targets; the gizmo is then where the primary object is */
    async ready() {
      await controller.connected()
      await settle()
    },
  }
}

