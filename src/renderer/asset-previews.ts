// Previews of assets for the assets panel (protocol 1.17.0: GetAssetPreview): a texture's thumbnail and an audio
// clip's waveform. The host decodes on the CPU and keeps no preview cache, so this is the cache: least recently used,
// bounded in entries and bytes, with at most a few requests in flight, and every answer checked against the request
// before it is stored. An entry is valid for the file as the listing described it (modified time and size); a change
// event or a new connection drops entries, and an answer that arrives after that is not stored. No DOM.
import { signal } from "@preact/signals-core"
import { AssetPreview, MaxPreviewSize } from "../protocol/editor-tooling"
import type { EngineApi } from "../shared/api"

/** The resource types GetAssetPreview can preview (the host's names); anything else has no preview and is never asked */
export function previewKindOf(type: string): "texture" | "audio" | null {
  if (type === "Texture") return "texture"
  if (type === "AudioClip") return "audio"
  return null
}

/** What the cache needs to know of an asset: its AssetInfo from the listing */
export interface PreviewAsset {
  uuid: string
  path: string
  type: string
  size: number
  modified: number
}

export interface PreviewCacheOptions {
  /** Entries kept (successes and remembered failures) */
  maxEntries?: number
  /** Bytes of pixels kept */
  maxBytes?: number
  /** Requests in flight at once */
  concurrency?: number
  /** Whether the host can be asked now (connected, protocol 1.17.0 or later). Default: yes. */
  enabled?(): boolean
}

export const DefaultMaxEntries = 256
export const DefaultMaxBytes = 16 * 1024 * 1024
export const DefaultConcurrency = 2

interface Entry {
  /** What the listing said of the file when this was read: a different stamp is a different file */
  stamp: string
  path: string
  preview: AssetPreview | null
  /** Why there is none (a failure is remembered, so a corrupt file isn't asked for again at every draw) */
  error: string | null
  bytes: number
}

interface Job {
  key: string
  stamp: string
  asset: PreviewAsset
  size: number
  generation: number
  resolve(entry: Entry | null): void
  promise: Promise<Entry | null>
}

const stampOf = (asset: PreviewAsset): string => `${asset.modified}:${asset.size}`
const keyOf = (uuid: string, size: number): string => `${uuid.toLowerCase()}@${size}`
const sameText = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** Whether an answer is for the asset that was asked about (the host's own spelling of its path may differ in case) */
export function checkPreviewMatches(asset: PreviewAsset, preview: AssetPreview): void {
  if (!sameText(preview.uuid, asset.uuid)) throw new Error(`The preview is of another asset (${preview.uuid})`)
  if (!sameText(preview.path, asset.path)) throw new Error(`The preview is of another path (${preview.path})`)
  const kind = previewKindOf(asset.type)
  if (kind !== preview.kind) throw new Error(`A ${asset.type} asset came back as a ${preview.kind} preview`)
}

export type PreviewEngine = Partial<Pick<EngineApi, "getAssetPreview">>

export class AssetPreviewCache {
  /** Bumped when entries are dropped, so a view showing one asks again */
  readonly version = signal(0)
  private readonly entries = new Map<string, Entry>() // insertion order is recency (oldest first)
  private readonly inflight = new Map<string, Job>()
  private readonly queue: Job[] = []
  private running = 0
  private bytes = 0
  private generation = 0
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly concurrency: number

  constructor(
    private readonly engine: PreviewEngine,
    private readonly options: PreviewCacheOptions = {}
  ) {
    this.maxEntries = options.maxEntries ?? DefaultMaxEntries
    this.maxBytes = options.maxBytes ?? DefaultMaxBytes
    this.concurrency = options.concurrency ?? DefaultConcurrency
  }

  /** Whether previews can be asked for now */
  get enabled(): boolean {
    return typeof this.engine.getAssetPreview === "function" && (this.options.enabled?.() ?? true)
  }

  /** The asset's cached preview if there is a current one (marks it recently used); null otherwise. Asks nothing. */
  peek(asset: PreviewAsset, size: number): AssetPreview | null {
    const entry = this.entries.get(keyOf(asset.uuid, size))
    if (!entry || entry.stamp !== stampOf(asset)) return null
    this.touch(keyOf(asset.uuid, size), entry)
    return entry.preview
  }

  /**
   * The asset's preview at most `size` pixels (texture edge) or `2 * size` peaks: from the cache, or asked of the host
   * (requests for the same asset share one). Null for a type with no preview, when the host can't be asked, when the
   * host couldn't make one (the reason is in `failure`), or when the entry was dropped while it was on its way.
   */
  async request(asset: PreviewAsset, size: number): Promise<AssetPreview | null> {
    if (!Number.isInteger(size) || size < 1 || size > MaxPreviewSize) throw new Error("The preview size must be 1 to 256")
    if (previewKindOf(asset.type) === null || !this.enabled) return null
    const key = keyOf(asset.uuid, size)
    const stamp = stampOf(asset)
    const cached = this.entries.get(key)
    if (cached && cached.stamp === stamp) {
      this.touch(key, cached)
      return cached.preview
    }
    let job = this.inflight.get(key)
    if (!job || job.stamp !== stamp || job.generation !== this.generation) {
      job = this.enqueue(key, stamp, asset, size)
    }
    return (await job.promise)?.preview ?? null
  }

  /** Why the asset has no preview: what the host said last time, or null when it has one or was never asked */
  failure(asset: PreviewAsset, size: number): string | null {
    const entry = this.entries.get(keyOf(asset.uuid, size))
    return entry && entry.stamp === stampOf(asset) ? entry.error : null
  }

  /**
   * Drops what is known of these paths (an assetsChanged event named them) and ignores answers still on their way. The
   * views are told (version) unless notify is false: the caller tells them (notifyChanged) once the listing is read again.
   */
  invalidate(paths: Iterable<string>, notify = true): void {
    const wanted = new Set([...paths].map((p) => p.toLowerCase().split("#")[0]))
    let dropped = false
    for (const [key, entry] of [...this.entries]) {
      if (wanted.has(entry.path.toLowerCase())) {
        this.drop(key, entry)
        dropped = true
      }
    }
    // Requests for those paths already on their way would store an old file's answer
    for (const job of this.inflight.values()) {
      if (wanted.has(job.asset.path.toLowerCase())) {
        job.generation = -1
        dropped = true
      }
    }
    if (dropped && notify) this.version.value++
  }

  /** Tells the views that dropped entries are to be asked for again */
  notifyChanged(): void {
    this.version.value++
  }

  /** Drops everything (a new connection, or events were missed) and ignores answers still on their way */
  clear(notify = true): void {
    this.generation++
    this.entries.clear()
    this.bytes = 0
    for (const job of this.queue.splice(0)) {
      this.inflight.delete(job.key)
      job.resolve(null)
    }
    if (notify) this.version.value++
  }

  get size(): number {
    return this.entries.size
  }

  get byteSize(): number {
    return this.bytes
  }

  // ==================== Requests ====================

  private enqueue(key: string, stamp: string, asset: PreviewAsset, size: number): Job {
    let resolve!: (entry: Entry | null) => void
    const promise = new Promise<Entry | null>((r) => (resolve = r))
    const job: Job = { key, stamp, asset: { ...asset }, size, generation: this.generation, resolve, promise }
    this.inflight.set(key, job)
    this.queue.push(job)
    queueMicrotask(() => this.pump())
    return job
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!
      this.running++
      void this.run(job).finally(() => {
        this.running--
        this.pump()
      })
    }
  }

  private async run(job: Job): Promise<void> {
    let entry: Entry
    try {
      const preview = await this.engine.getAssetPreview!(job.asset.uuid, job.size)
      checkPreviewMatches(job.asset, preview)
      if (preview.kind === "texture" && (preview.width > job.size || preview.height > job.size)) {
        throw new Error("The preview is larger than asked")
      }
      if (preview.kind === "audio" && preview.peaks.length > 2 * job.size) throw new Error("The preview has too many peaks")
      entry = { stamp: job.stamp, path: job.asset.path, preview, error: null, bytes: preview.kind === "texture" ? preview.pixels.length : preview.peaks.length * 16 }
    } catch (e) {
      entry = { stamp: job.stamp, path: job.asset.path, preview: null, error: e instanceof Error ? e.message : String(e), bytes: 0 }
    }
    if (this.inflight.get(job.key) === job) this.inflight.delete(job.key)
    // Dropped meanwhile (a change event or a new connection): the answer is for a file that may be gone or different
    if (job.generation === this.generation) {
      this.store(job.key, entry)
      job.resolve(entry)
    } else {
      job.resolve(null)
    }
  }

  // ==================== The cache ====================

  private touch(key: string, entry: Entry): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
  }

  private store(key: string, entry: Entry): void {
    const old = this.entries.get(key)
    if (old) this.drop(key, old)
    this.entries.set(key, entry)
    this.bytes += entry.bytes
    // Least recently used first; the newest entry stays even when it alone is over the limit
    for (const [oldKey, oldEntry] of this.entries) {
      if (this.entries.size <= 1 || (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes)) break
      this.drop(oldKey, oldEntry)
    }
  }

  private drop(key: string, entry: Entry): void {
    if (this.entries.get(key) === entry) {
      this.entries.delete(key)
      this.bytes -= entry.bytes
    }
  }
}
