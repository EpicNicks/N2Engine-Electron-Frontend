// The physics backend picker's state, without a DOM (protocol 1.20.0): the host's GetPhysicsBackends answer, the choice
// (SetPhysicsBackend) and why choosing is off. Given its pieces (or fakes), so it is unit tested in Node; the Physics
// backend section of Project Settings (project-settings-sections.tsx) draws it.
//
// The rules it keeps:
//  - nothing is read or offered without the physicsBackends capability (an older host has neither command);
//  - choosing is off while a game runs, on a read-only host and for a viewer (readOnlyReason), and for a backend the host
//    would refuse (not compiled in; under the Deterministic preset, not deterministicSelectable) - with the reason shown;
//  - the host's answer replaces what is shown, and a refusal is shown as the host said it;
//  - the newest read wins.
import { signal, type ReadonlySignal } from "@preact/signals-core"
import { backendBlockReason } from "../protocol/physics-backends"
import type { PhysicsBackendInfo, PhysicsBackendsInfo } from "../protocol/protocol.generated"
import { errorTextOf } from "../shared/api"

export interface PhysicsBackendsDeps {
  /** GetPhysicsBackends */
  getPhysicsBackends(): Promise<PhysicsBackendsInfo>
  /** SetPhysicsBackend */
  setPhysicsBackend(backend: string): Promise<PhysicsBackendsInfo>
  connected: ReadonlySignal<boolean>
  /** Whether Hello lists the physicsBackends capability */
  supported: ReadonlySignal<boolean>
  /** EditorStore.readOnlyReason: a play session, a read-only host, a viewer; null when writes work */
  readOnlyReason: ReadonlySignal<string | null>
}

export const UnsupportedReason = "This host does not have the physicsBackends capability (it is older than protocol 1.20.0), so the backend can't be listed or changed here."

export class PhysicsBackendsModel {
  /** The host's last answer; null until read, when not connected and when unsupported */
  readonly info = signal<PhysicsBackendsInfo | null>(null)
  readonly loadError = signal<string | null>(null)
  /** The host's refusal of the last choice, until the next try */
  readonly error = signal<string | null>(null)
  /** The backend the host last took, until the next try (the note that it takes effect later) */
  readonly lastChosen = signal<string | null>(null)
  /** The backend id whose choice is on its way */
  readonly choosing = signal<string | null>(null)

  private reads = 0

  constructor(private readonly deps: PhysicsBackendsDeps) {}

  get supported(): boolean {
    return this.deps.supported.value
  }

  /** Why no backend can be chosen now (not connected, unsupported, read-only), or null */
  get disabledReason(): string | null {
    if (!this.deps.connected.value) return "Not connected"
    if (!this.deps.supported.value) return UnsupportedReason
    const readOnly = this.deps.readOnlyReason.value
    if (readOnly !== null) return `Read-only: ${readOnly}`
    return null
  }

  /** Why this backend can't be chosen now (the global reason, else the backend's own), or null. The current backend can't be chosen again. */
  blockReason(backend: PhysicsBackendInfo): string | null {
    const global = this.disabledReason
    if (global !== null) return global
    const info = this.info.value
    if (info === null) return "The backends are not read yet"
    return backendBlockReason(backend, info.networkPreset)
  }

  /** GetPhysicsBackends; the newest read wins. Does nothing (and clears the answer) when not connected or unsupported. */
  async refresh(): Promise<void> {
    const read = ++this.reads
    if (!this.deps.connected.value || !this.deps.supported.value) {
      this.info.value = null
      this.loadError.value = null
      return
    }
    try {
      const info = await this.deps.getPhysicsBackends()
      if (read !== this.reads) return
      this.info.value = info
      this.loadError.value = null
    } catch (e) {
      if (read !== this.reads) return
      console.error("Failed to get the physics backends:", e)
      this.loadError.value = errorTextOf(e)
    }
  }

  /** SetPhysicsBackend; true when the host took it. The answer replaces what is shown. */
  async choose(id: string): Promise<boolean> {
    const info = this.info.value
    const backend = info?.backends.find((b) => b.id === id)
    if (!backend || this.choosing.value !== null || this.blockReason(backend) !== null) return false
    this.error.value = null
    this.lastChosen.value = null
    this.choosing.value = id
    try {
      const answer = await this.deps.setPhysicsBackend(id)
      this.reads++ // an older read must not overwrite this answer
      this.info.value = answer
      this.loadError.value = null
      this.lastChosen.value = id
      return true
    } catch (e) {
      console.error("Failed to set the physics backend:", e)
      this.error.value = errorTextOf(e)
      return false
    } finally {
      this.choosing.value = null
    }
  }
}
