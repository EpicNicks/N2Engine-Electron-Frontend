// Host stats for the Profiler panel (protocol 1.28.0: GetEngineStats {sinceFrame} -> EngineStats). The host keeps its
// last 240 frame records and sends the ones after sinceFrame; the client keeps a longer history of its own. This holds
// the capability name, the shape check of the answer (the generated decoder only parses the JSON), the client-side
// history (merging polled records), the summary maths over it and the words and numbers the panel shows. No DOM.
import type { EngineFrameRecord, EngineStats } from "./protocol.generated"

/** The Hello capability of a host that answers GetEngineStats */
export const EngineStatsCapability = "engineStats"

/** How often the Profiler polls while it is shown (the host turns its timers off after 10 s without a request) */
export const EngineStatsPollMs = 250

/** How many frame records the client keeps: about 20 s at 60 fps (the host keeps 240) */
export const FrameHistoryCapacity = 1200

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === "string"

/** The numeric fields of a frame record besides frame: absent ones read as 0 (a newer host may add more, an older one fewer) */
const RecordFields = [
  "intervalMs",
  "tickMs",
  "fixedMs",
  "fixedTicks",
  "physicsMs",
  "updateMs",
  "audioMs",
  "renderMs",
  "commandsMs",
  "renderRequestMs",
  "readbackMs",
] as const satisfies ReadonlyArray<keyof EngineFrameRecord>

function recordOf(v: unknown, index: number): EngineFrameRecord {
  if (!isObject(v) || !isNumber(v.frame)) throw new Error(`The engine stats answer's frames[${index}] must be an object with a frame number`)
  const record = { frame: v.frame } as EngineFrameRecord
  for (const field of RecordFields) {
    const value = v[field]
    if (value !== undefined && !isNumber(value)) throw new Error(`The engine stats answer's frames[${index}].${field} must be a number`)
    record[field] = value ?? 0
  }
  return record
}

/** A block the host may leave out: absent, or an object whose listed fields are numbers (optional ones may be absent) */
function checkBlock(value: Record<string, unknown>, name: string, required: string[], optional: string[] = []): void {
  const block = value[name]
  if (block === undefined) return
  if (!isObject(block)) throw new Error(`The engine stats answer's ${name} must be an object`)
  for (const key of required) {
    if (!isNumber(block[key])) throw new Error(`The engine stats answer's ${name}.${key} must be a number`)
  }
  for (const key of optional) {
    if (block[key] !== undefined && !isNumber(block[key])) throw new Error(`The engine stats answer's ${name}.${key} must be a number`)
  }
}

/** Returns the answer when it has the documented shape (records with absent numbers filled with 0); throws an Error naming the problem otherwise */
export function validateEngineStats(value: unknown): EngineStats {
  if (!isObject(value)) throw new Error("The engine stats answer must be an object")
  const host = value.host
  if (!isObject(host) || !isString(host.kind) || !isString(host.state)) {
    throw new Error("The engine stats answer's host must have a kind and a state")
  }
  if (!isNumber(value.frame)) throw new Error("The engine stats answer's frame must be a number")
  if (!Array.isArray(value.frames)) throw new Error("The engine stats answer's frames must be a list")
  const frames = value.frames.map(recordOf)
  const summary = value.summary
  if (summary !== undefined && !isObject(summary)) throw new Error("The engine stats answer's summary must be an object")
  checkBlock(value, "render", ["drawCalls", "triangles", "vertices"], ["framesRendered", "width", "height"])
  checkBlock(value, "scene", ["objects"], ["activeObjects", "components", "luaComponents"])
  checkBlock(value, "lua", ["memoryBytes"], ["memoryCapBytes"])
  checkBlock(value, "physics", [], ["bodies", "staticBodies", "activeBodies"])
  checkBlock(value, "process", ["workingSetBytes"], ["peakWorkingSetBytes"])
  return { ...(value as unknown as EngineStats), frames }
}

/**
 * The frame records the client has seen, oldest first, at most capacity. The host sends the records after sinceFrame;
 * the client asks from the frame before its newest (sinceFor), so the newest record comes again and its command times,
 * which can still grow after it was sent, are replaced with their final values.
 */
export class FrameHistory {
  private list: EngineFrameRecord[] = []
  /** Frames between two answers that never arrived (the host's ring wrapped before the client asked) */
  missed = 0

  constructor(readonly capacity = FrameHistoryCapacity) {}

  get records(): readonly EngineFrameRecord[] {
    return this.list
  }

  /** The newest frame held; 0 when none */
  get lastFrame(): number {
    return this.list.length === 0 ? 0 : this.list[this.list.length - 1].frame
  }

  /** The sinceFrame of the next request: the frame before the newest held (0, the whole ring, when none) */
  sinceFor(): number {
    return Math.max(0, this.lastFrame - 1)
  }

  clear(): void {
    this.list = []
    this.missed = 0
  }

  /**
   * Adds an answer's records. An answer whose newest frame is behind the newest held is a new play session: the history
   * starts again from it. Returns whether it started again.
   */
  merge(frame: number, records: readonly EngineFrameRecord[]): boolean {
    let reset = false
    if (this.list.length > 0 && frame < this.lastFrame) {
      this.clear()
      reset = true
    }
    const sorted = [...records].sort((a, b) => a.frame - b.frame)
    for (const record of sorted) {
      const last = this.lastFrame
      if (this.list.length > 0 && record.frame <= last) {
        // A record the client has: the newest one again (its command times may have grown), or an overlap
        const at = this.list.findIndex((r) => r.frame === record.frame)
        if (at >= 0) this.list[at] = record
        continue
      }
      if (this.list.length > 0 && record.frame > last + 1) this.missed += record.frame - last - 1
      this.list.push(record)
    }
    if (this.list.length > this.capacity) this.list.splice(0, this.list.length - this.capacity)
    return reset
  }
}

/** avg, p95 and max of some numbers; null when there are none */
export interface Timing {
  avg: number
  p95: number
  max: number
}

export function timingOf(values: readonly number[]): Timing | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((total, v) => total + v, 0)
  // Nearest rank: the smallest value at least 95% of the values are at or below
  const rank = Math.max(1, Math.ceil(0.95 * sorted.length))
  return { avg: sum / sorted.length, p95: sorted[rank - 1], max: sorted[sorted.length - 1] }
}

/** The parts of a frame the panel shows, in the order they stack (bottom first) */
export type SectionId = "fixed" | "physics" | "update" | "audio" | "render" | "otherTick" | "renderRequest" | "readback" | "otherCommands"

export interface Section {
  id: SectionId
  label: string
  /** The milliseconds of this part in a record (never below 0) */
  of(record: EngineFrameRecord): number
  /** Only a play host has command times: the part is left out where every record has 0 */
  playOnly?: boolean
}

const positive = (n: number): number => (n > 0 ? n : 0)

export const Sections: readonly Section[] = [
  // fixedMs holds physicsMs: the rest is FixedUpdate and attach
  { id: "fixed", label: "Fixed ticks", of: (r) => positive(r.fixedMs - r.physicsMs) },
  { id: "physics", label: "Physics", of: (r) => positive(r.physicsMs) },
  { id: "update", label: "Update", of: (r) => positive(r.updateMs) },
  { id: "audio", label: "Audio", of: (r) => positive(r.audioMs) },
  { id: "render", label: "Render", of: (r) => positive(r.renderMs) },
  { id: "otherTick", label: "Other (in the frame)", of: (r) => positive(r.tickMs - r.fixedMs - r.updateMs - r.audioMs - r.renderMs) },
  { id: "renderRequest", label: "Render request", of: (r) => positive(r.renderRequestMs), playOnly: true },
  { id: "readback", label: "Readback", of: (r) => positive(r.readbackMs), playOnly: true },
  {
    id: "otherCommands",
    label: "Other commands",
    of: (r) => positive(r.commandsMs - r.renderRequestMs - r.readbackMs),
    playOnly: true,
  },
]

/** A record's whole height in the graph: the frame and the commands after it */
export const frameTotalMs = (r: EngineFrameRecord): number => positive(r.tickMs) + positive(r.commandsMs)

export interface HistorySummary {
  frames: number
  /** 1000 over the average interval of the records that have one (0 is the first frame after the timers came on or a pause) */
  fps: number | null
  intervalMs: Timing | null
  tickMs: Timing | null
  commandsMs: Timing | null
  fixedTicks: Timing | null
  sections: Array<{ section: Section; timing: Timing }>
}

/** The breakdown of the records: each part's avg, p95 and max (parts only a play host has are left out when all are 0) */
export function summarise(records: readonly EngineFrameRecord[]): HistorySummary {
  const intervals = records.map((r) => r.intervalMs).filter((v) => v > 0)
  const intervalMs = timingOf(intervals)
  const hasCommands = records.some((r) => r.commandsMs > 0 || r.renderRequestMs > 0 || r.readbackMs > 0)
  const sections: HistorySummary["sections"] = []
  for (const section of Sections) {
    if (section.playOnly && !hasCommands) continue
    const timing = timingOf(records.map(section.of))
    if (timing) sections.push({ section, timing })
  }
  return {
    frames: records.length,
    fps: intervalMs && intervalMs.avg > 0 ? 1000 / intervalMs.avg : null,
    intervalMs,
    tickMs: timingOf(records.map((r) => r.tickMs)),
    commandsMs: hasCommands ? timingOf(records.map((r) => r.commandsMs)) : null,
    fixedTicks: timingOf(records.map((r) => r.fixedTicks)),
    sections,
  }
}

/** Absent values are shown as this, as the client statistics do */
export const Absent = "—"

export function formatMs(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return Absent
  return `${n < 10 ? n.toFixed(2) : n.toFixed(1)} ms`
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return Absent
  return Math.round(n).toLocaleString("en-US")
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return Absent
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

/** Lua memory above this share of its cap is shown in the warning colour */
export const LuaMemoryWarnShare = 0.8

/** Lua memory as a share of its cap (0..1, more when over); null without a cap */
export function luaMemoryShare(stats: EngineStats): number | null {
  const lua = stats.lua
  if (!lua || !isNumber(lua.memoryCapBytes) || lua.memoryCapBytes <= 0) return null
  return lua.memoryBytes / lua.memoryCapBytes
}

/** The words for the host's physics backend ("physx", "jolt"; anything else as sent) */
export function physicsBackendLabel(id: string): string {
  switch (id.toLowerCase()) {
    case "physx":
      return "PhysX"
    case "jolt":
      return "Jolt"
    default:
      return id
  }
}
