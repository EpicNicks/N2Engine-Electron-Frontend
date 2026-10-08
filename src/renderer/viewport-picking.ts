// The editor host's picking and bounds (protocol 1.8.0: PickEntity, GetEntityBounds) as the viewport controller's
// PickBackend, and the small pure helpers around them. No DOM; unit tested with a fake engine.
import type { EngineApi } from "../shared/api"
import { MaxEntityBoundsIds } from "../shared/api"
import type { EntityBounds } from "../protocol/protocol.generated"
import type { Bounds } from "./viewport-camera"
import type { PickBackend } from "./viewport-controller"

type PickingEngine = Pick<EngineApi, "pickEntity" | "getEntityBounds">

const finite = (v: { x: number; y: number; z: number } | undefined): boolean =>
  !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)

/** A box the host gave, if it is one (finite, min not above max); a malformed entry is dropped, not drawn */
export function validBounds(entry: EntityBounds): Bounds | null {
  if (!finite(entry.min) || !finite(entry.max)) return null
  if (entry.min.x > entry.max.x || entry.min.y > entry.max.y || entry.min.z > entry.max.z) return null
  return { min: { ...entry.min }, max: { ...entry.max } }
}

/** The box around all of them; null for none */
export function unionBounds(boxes: Iterable<Bounds>): Bounds | null {
  let out: Bounds | null = null
  for (const b of boxes) {
    out = out
      ? {
          min: { x: Math.min(out.min.x, b.min.x), y: Math.min(out.min.y, b.min.y), z: Math.min(out.min.z, b.min.z) },
          max: { x: Math.max(out.max.x, b.max.x), y: Math.max(out.max.y, b.max.y), z: Math.max(out.max.z, b.max.z) },
        }
      : { min: { ...b.min }, max: { ...b.max } }
  }
  return out
}

/** Whether a host speaking this protocol version has PickEntity and GetEntityBounds (1.8.0 added them) */
export function hostHasPicking(protocolVersion: string | null | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(protocolVersion ?? "")
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 1 || (major === 1 && minor >= 8)
}

/**
 * Where a click on the picture lands in the host's viewport when the host was resized since that frame was rendered:
 * the vertical field of view is fixed, so a pixel's offset from the centre scales by the heights' ratio
 * (x' = w'/2 + (x - w/2) h'/h, y' = h'/2 + (y - h/2) h'/h). The same size maps to itself.
 */
export function remapToHostViewport(
  pixel: { x: number; y: number },
  shown: { width: number; height: number },
  host: { width: number; height: number }
): { x: number; y: number } {
  if (shown.width === host.width && shown.height === host.height) return pixel
  const k = host.height / shown.height
  return { x: host.width / 2 + (pixel.x - shown.width / 2) * k, y: host.height / 2 + (pixel.y - shown.height / 2) * k }
}

/** The same box moved by delta */
export const translateBounds = (b: Bounds, delta: { x: number; y: number; z: number }): Bounds => ({
  min: { x: b.min.x + delta.x, y: b.min.y + delta.y, z: b.min.z + delta.z },
  max: { x: b.max.x + delta.x, y: b.max.y + delta.y, z: b.max.z + delta.z },
})

/**
 * PickBackend over the engine API. pick: "" (a miss) is null. bounds: ids are asked in batches of at most
 * MaxEntityBoundsIds (one call for any realistic selection); only the entries for ids that were asked are kept.
 */
export function createPickBackend(engine: PickingEngine): PickBackend {
  return {
    async pick(x, y, includeInactive) {
      const result = await engine.pickEntity(x, y, includeInactive)
      return result.entityId === "" ? null : result.entityId
    },
    async bounds(entityIds) {
      const asked = new Set(entityIds)
      const unique = [...asked]
      const out = new Map<string, Bounds>()
      for (let i = 0; i < unique.length; i += MaxEntityBoundsIds) {
        const response = await engine.getEntityBounds(unique.slice(i, i + MaxEntityBoundsIds))
        for (const entry of response.bounds) {
          const box = asked.has(entry.id) ? validBounds(entry) : null
          if (box) out.set(entry.id, box)
        }
      }
      return out
    },
  }
}
