// Moving assets between folders in the Assets panel (protocol 1.24.0, MoveAsset): which moves a drop makes, whether the
// drop is allowed (for the feedback while dragging), and where a path held by the panel goes when its asset moves. The host
// stays the authority (it refuses a collision, a path outside the assets, the open scene's file); the checks here only
// give the person an answer before the drop and keep a bad call from being sent. No DOM, so it is unit tested in Node.
import type { AssetMove } from "../protocol/protocol.generated"
import { AssetListing, RootFolder, childPath, nameOf, parentOf } from "./asset-tree"

/** What a drop of some paths on a folder does */
export interface MovePlan {
  /** The moves to send: `to` is the new full path of each (the folder plus the name), in the order of the sources */
  moves: AssetMove[]
  /** Sources left out because they need no move: already in the folder, or inside a folder that moves with them */
  skipped: string[]
  /** Why the drop is refused, in the person's terms; null when it is allowed (or has nothing to do: moves is empty) */
  problem: string | null
}

/** More indexed assets than this under the moved folders ask once before the move (design: asset-move.md section 6) */
export const ConfirmMoveAssets = 200

/** Whether a path is the folder or inside it (a file, a subfolder, a part of a model of a file in it) */
export function isInside(path: string, folder: string): boolean {
  if (folder === RootFolder) return path.startsWith(RootFolder)
  return path === folder || path.startsWith(`${folder}/`) || path.startsWith(`${folder}#`)
}

/** A name as the host compares it for a collision: ASCII case-insensitively, on every platform */
const foldName = (name: string): string => name.replace(/[A-Z]/g, (c) => c.toLowerCase())

/** The folders and files directly in a folder of the listing, by their folded names */
function namesIn(listing: AssetListing, folder: string): Set<string> {
  const names = new Set<string>()
  for (const f of listing.folders) if (parentOf(f) === folder && f !== folder) names.add(foldName(nameOf(f)))
  for (const a of listing.assets) if (parentOf(a.path) === folder) names.add(foldName(nameOf(a.path)))
  return names
}

/**
 * The moves that dropping `sources` (res:// paths of files and folders) on `folder` makes. A model's part, the root and
 * anything the listing does not hold are not movable and are ignored. `openScene` is the loaded scene's file: the host
 * refuses to move it, or a folder that holds it, so the drop is refused here with the host's advice.
 */
export function planMove(
  listing: AssetListing,
  sources: readonly string[],
  folder: string,
  openScene: string | null,
): MovePlan {
  const known = new Set<string>([...listing.folders, ...listing.assets.map((a) => a.path)])
  const unique = [...new Set(sources)].filter((s) => s !== RootFolder && !s.includes("#") && known.has(s))
  const skipped: string[] = []
  // A source inside another source moves with it
  const roots = unique.filter((s) => {
    const inside = unique.some((other) => other !== s && isInside(s, other))
    if (inside) skipped.push(s)
    return !inside
  })
  const refused = (problem: string): MovePlan => ({ moves: [], skipped, problem })
  if (folder !== RootFolder && !listing.folders.includes(folder)) return refused(`There is no folder ${folder}`)
  for (const s of roots) {
    if (listing.folders.includes(s) && isInside(folder, s))
      return refused(`Can't move the folder ${nameOf(s)} into itself`)
  }
  const wanted = roots.filter((s) => {
    const already = parentOf(s) === folder
    if (already) skipped.push(s)
    return !already
  })
  if (openScene !== null) {
    const holder = wanted.find((s) => isInside(openScene, s))
    if (holder) return refused(`The open scene is in ${nameOf(holder)}: save the scene elsewhere first`)
  }
  const taken = namesIn(listing, folder)
  const placed = new Set<string>()
  for (const s of wanted) {
    const folded = foldName(nameOf(s))
    if (taken.has(folded) || placed.has(folded))
      return refused(`${nameOf(s)} already exists in ${folder === RootFolder ? "the root" : nameOf(folder)}`)
    placed.add(folded)
  }
  return { moves: wanted.map((from) => ({ from, to: childPath(folder, nameOf(from)) })), skipped, problem: null }
}

/** Whether a drop on the folder would move something: the drop is allowed and not a no-op (the feedback while dragging) */
export const canDrop = (plan: MovePlan): boolean => plan.problem === null && plan.moves.length > 0

/** How many indexed assets the moves carry: each file moved, and every file under a folder moved */
export function assetsMoving(listing: AssetListing, moves: readonly AssetMove[]): number {
  let count = 0
  for (const asset of listing.assets) if (moves.some((m) => isInside(asset.path, m.from))) count++
  return count
}

/**
 * Where a path held by the panel (a selection, an open file, an open folder, a model's part) is after the moves: the
 * moved path itself, or its place under a moved folder. A path no move touches comes back as it was. The moves of one
 * call never overlap, so the first that matches is the one.
 */
export function remapPath(path: string, moves: readonly { from: string; to: string }[]): string {
  for (const move of moves) {
    if (path === move.from) return move.to
    if (path.startsWith(`${move.from}/`) || path.startsWith(`${move.from}#`))
      return move.to + path.slice(move.from.length)
  }
  return path
}
