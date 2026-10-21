// The built-in sections' logic: what each section's drafts mean as a patch (see project-settings-schema.ts), in the
// shape the registry takes (SectionLogic), so the panel's model treats them like any section a later change registers.
import type { SectionLogic } from "./project-settings-registry"
import {
  DeterminismFields,
  JsonKey,
  MathFields,
  NothingBuilt,
  PhysicsFields,
  RenderingFields,
  buildFieldsPatch,
  buildInputPatch,
  buildLayersPatch,
  buildRawPatch,
  collisionMatrixOf,
  fieldById,
  jsonText,
  layerNames,
  pairText,
  parsePairKey,
  readPath,
  rowsCollide,
  textOfValue,
  type FieldSpec,
} from "./project-settings-schema"

/** A form section over a field table */
export function fieldsLogic(fields: readonly FieldSpec[]): SectionLogic {
  return {
    build: ({ settings, edits }) => buildFieldsPatch(fields, settings, edits),
    textOf: ({ settings }, key) => {
      const spec = fieldById(key)
      return spec === undefined ? "" : textOfValue(spec, readPath(settings, spec.path))
    },
  }
}

export const PhysicsLogic = fieldsLogic(PhysicsFields)
export const RenderingLogic = fieldsLogic(RenderingFields)
export const MathLogic = fieldsLogic(MathFields)
export const DeterminismLogic = fieldsLogic(DeterminismFields)

export const StartupSceneKey = "startupScene"

/** General: the startup scene, set with SetStartupScene (the rest of the section is read-only) */
export const GeneralLogic: SectionLogic = {
  build: ({ info, edits }) => {
    if (!(StartupSceneKey in edits)) return NothingBuilt
    const path = edits[StartupSceneKey]
    if (path === info.project.startupScene) return NothingBuilt
    return { patch: null, startupScene: path, errors: {}, changed: [StartupSceneKey], restart: [] }
  },
  textOf: ({ info }) => info.project.startupScene,
}

export const LayersLogic: SectionLogic = {
  build: ({ settings, edits }) => buildLayersPatch(settings, edits),
  textOf: ({ settings }, key) => {
    const pair = parsePairKey(key)
    if (pair !== null) return pairText(rowsCollide(collisionMatrixOf(settings).rows, pair[0], pair[1]))
    return layerNames(settings)[Number(key.split(".")[1])] ?? ""
  },
}

export const InputLogic: SectionLogic = {
  build: ({ settings, edits }) => buildInputPatch(settings, edits),
  textOf: ({ settings }) => jsonText(readPath(settings, ["input"])),
  snapshotKeys: [JsonKey],
}

export const RawLogic: SectionLogic = {
  build: ({ settings, edits, isAdmin }) => buildRawPatch(settings, edits, isAdmin),
  textOf: ({ settings }) => jsonText(settings),
  snapshotKeys: [JsonKey],
  confirm: {
    message: (built) =>
      `Write the raw settings to project.n2proj?\n\nThis merge patch is sent:\n${JSON.stringify(built.patch, null, 2)}\n\nThe host checks the blocks it knows and refuses the whole change if one is wrong; blocks it does not know are kept exactly as written here. Settings are not part of the undo history.`,
    okLabel: "Write settings",
  },
}

export { JsonKey }
