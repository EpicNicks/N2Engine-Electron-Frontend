// Physics backend picker (protocol 1.20.0: GetPhysicsBackends, SetPhysicsBackend). The host lists the backends its build
// knows with what each declares, and sets the project's physics.backend. The host checks the setter; this holds the
// capability name, the shape check for the answer (the generated decoder only parses the JSON) and the words the UI uses.
import type { PhysicsBackendInfo, PhysicsBackendsInfo } from "./protocol.generated"

/** The Hello capability of a host with the two physics backend commands */
export const PhysicsBackendsCapability = "physicsBackends"

/** Said wherever a backend is chosen: the running host keeps the backend it created at start */
export const PhysicsBackendTakesEffectNote = "Takes effect at the next play session or host start."

const isString = (v: unknown): v is string => typeof v === "string"
const isBool = (v: unknown): v is boolean => typeof v === "boolean"

function isBackend(v: unknown): v is PhysicsBackendInfo {
  if (typeof v !== "object" || v === null) return false
  const b = v as Record<string, unknown>
  return (
    isString(b.id) &&
    isString(b.displayName) &&
    isBool(b.compiledIn) &&
    isString(b.determinism) &&
    isString(b.determinismDefault) &&
    Array.isArray(b.features) &&
    b.features.every(isString) &&
    Array.isArray(b.missingFeatures) &&
    b.missingFeatures.every(isString) &&
    isBool(b.supportsSnapshot) &&
    isBool(b.supportsSetState) &&
    isBool(b.deterministicSelectable) &&
    (b.note === undefined || isString(b.note))
  )
}

/** Returns the answer when it has the documented shape; throws an Error naming the problem otherwise */
export function validatePhysicsBackendsInfo(value: unknown): PhysicsBackendsInfo {
  if (typeof value !== "object" || value === null) throw new Error("The physics backends answer must be an object")
  const v = value as Record<string, unknown>
  if (!isString(v.current) || !isString(v.active) || !isString(v.networkPreset)) {
    throw new Error("The physics backends answer's current, active and networkPreset must be strings")
  }
  if (!isBool(v.configured) || !isBool(v.restartRequired)) {
    throw new Error("The physics backends answer's configured and restartRequired must be booleans")
  }
  if (!Array.isArray(v.backends) || !v.backends.every(isBackend)) {
    throw new Error("The physics backends answer's backends must be a list of backend descriptions")
  }
  return value as PhysicsBackendsInfo
}

/** The words for a DeterminismLevel name the host sends ("None", "SameBinary", "CrossPlatform"; anything else as sent) */
export function determinismLabel(level: string): string {
  switch (level.toLowerCase()) {
    case "none":
      return "None (not reproducible)"
    case "samebinary":
      return "Same binary (reproducible on the same build only)"
    case "crossplatform":
      return "Cross-platform (reproducible across platforms)"
    default:
      return level
  }
}

/** Why a backend can't be chosen now, from the host's description and the project's network preset; null when it can */
export function backendBlockReason(backend: PhysicsBackendInfo, networkPreset: string): string | null {
  if (!backend.compiledIn) return `${backend.displayName} is not compiled into this host, so it can't be chosen.`
  if (networkPreset.toLowerCase() === "deterministic" && !backend.deterministicSelectable) {
    return `The network preset is Deterministic, which needs a backend that declares cross-platform determinism and implements every feature group. ${backend.displayName} does not, so the host refuses it.`
  }
  return null
}
