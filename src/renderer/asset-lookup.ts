// The assets an asset field can name, by UUID and by res:// path: what project.listAssets() returns, and the meshes
// the engine has without a file (they load by their fixed UUIDs, so a field can hold one without any registration).
// The host's commands name assets only by UUID, so this is how a file dropped from the Files panel, or one picked
// from the list, becomes the value of an asset field.
import type { FieldSchema } from "../protocol/protocol.generated"
import type { AssetEntry } from "../shared/api"
import type { Checked } from "./inspector-fields"

/** The engine's built-in meshes (Mesh::GetBuiltinUUID: fixed, "never change them") */
export const BuiltinMeshes: readonly AssetEntry[] = [
  { uuid: "6e32656e-6d65-5348-0001-000000000001", path: "builtin://mesh/Cube", resourceType: "Mesh" },
  { uuid: "6e32656e-6d65-5348-0001-000000000002", path: "builtin://mesh/Sphere", resourceType: "Mesh" },
  { uuid: "6e32656e-6d65-5348-0001-000000000003", path: "builtin://mesh/Quad", resourceType: "Mesh" },
]

/** Whether the entry is one of the engine's own (it has no file) */
export const isBuiltinAsset = (entry: AssetEntry): boolean => entry.path.startsWith("builtin://")

/**
 * A short name for an asset: its file name, with a model's sub-asset after it (robot.glb > Body), and a built-in's own
 * name ("Cube (built-in)")
 */
export function assetName(entry: AssetEntry): string {
  if (isBuiltinAsset(entry)) return `${entry.path.slice(entry.path.lastIndexOf("/") + 1)} (built-in)`
  const hash = entry.path.indexOf("#")
  const file = hash < 0 ? entry.path : entry.path.slice(0, hash)
  const name = file.slice(file.lastIndexOf("/") + 1)
  if (hash < 0) return name
  const key = entry.path.slice(hash + 1)
  return `${name} > ${key.slice(key.lastIndexOf("/") + 1)}`
}

export class AssetLookup {
  private readonly byUuidMap = new Map<string, AssetEntry>()
  private readonly byPathMap = new Map<string, AssetEntry>()
  readonly entries: readonly AssetEntry[]

  /** caseInsensitive: res:// paths compare without regard to case (the host's file system does not), else exactly */
  constructor(
    entries: readonly AssetEntry[],
    private readonly caseInsensitive = false
  ) {
    const all = [...BuiltinMeshes, ...entries]
    this.entries = all
    for (const entry of all) {
      this.byUuidMap.set(entry.uuid.toLowerCase(), entry)
      this.byPathMap.set(this.pathKey(entry.path), entry)
    }
  }

  private pathKey(resPath: string): string {
    return this.caseInsensitive ? resPath.toLowerCase() : resPath
  }

  byUuid(uuid: string): AssetEntry | undefined {
    return this.byUuidMap.get(uuid.toLowerCase())
  }

  /** The asset of a res:// path (a file, or a model's sub-asset spelled path#key) */
  byPath(resPath: string): AssetEntry | undefined {
    return this.byPathMap.get(this.pathKey(resPath))
  }

  /** The assets a field can hold (its assetType), by path; all of them for a field that names no type */
  ofType(assetType: string | undefined): AssetEntry[] {
    const matching = this.entries.filter((entry) => !assetType || entry.resourceType === assetType)
    return matching.sort((a, b) => a.path.localeCompare(b.path))
  }

  /**
   * The UUID to store for an asset in a field, or why it can't go there: an asset of another type is refused with the
   * words the engine uses ("... is a Texture; field 'Font' expects Font")
   */
  check(field: FieldSchema, entry: AssetEntry): Checked<string> {
    if (field.assetType && entry.resourceType !== field.assetType) {
      return {
        ok: false,
        error: `${assetName(entry)} is ${/^[AEIOU]/i.test(entry.resourceType) ? "an" : "a"} ${entry.resourceType || "Unknown"}; ${field.displayName} expects ${field.assetType}`,
      }
    }
    return { ok: true, value: entry.uuid.toLowerCase() }
  }

  /** What a field holds, as a name for the person: the asset's, or a short UUID for one the index doesn't know */
  label(uuid: string): { text: string; known: boolean } {
    const entry = this.byUuid(uuid)
    return entry ? { text: assetName(entry), known: true } : { text: `${uuid.slice(0, 8)}... (not found)`, known: false }
  }
}
