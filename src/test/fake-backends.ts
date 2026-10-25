// Backend descriptions as a 1.20.0 host answers them, for the picker tests
import type { PhysicsBackendInfo } from "../protocol/protocol.generated"

/** A backend description as the host answers it: PhysX compiled in, SameBinary, no deterministic selection */
export function fakeBackend(overrides: Partial<PhysicsBackendInfo> & { id: string }): PhysicsBackendInfo {
  return {
    displayName: overrides.id,
    compiledIn: true,
    determinism: "SameBinary",
    determinismDefault: "None",
    features: ["layers", "triggers", "events", "queries"],
    missingFeatures: [],
    supportsSnapshot: true,
    supportsSetState: true,
    deterministicSelectable: false,
    ...overrides,
  }
}

export const DefaultBackends: PhysicsBackendInfo[] = [
  fakeBackend({ id: "physx", displayName: "PhysX" }),
  fakeBackend({ id: "jolt", displayName: "Jolt", determinism: "CrossPlatform", missingFeatures: ["events"], deterministicSelectable: false, note: "Jolt in this build" }),
]
