// What the viewport toolbar remembers, in the preferences store (prefs.ts; every access is guarded there, corrupt or
// foreign entries give the defaults): the tool, space and pivot per USER (global to this machine, as Unity keeps them),
// and the snap toggles, increments and kind per PROJECT (roadmap section 4: "Stored per project"), since a grid that
// suits one project's scale does not suit another's. Validation is field by field: a value that is missing, of the wrong
// type or out of range takes its default, so a stored entry of an older or newer shape still gives usable settings.
import { effect } from "@preact/signals-core"
import type { GizmoMode, ViewportController } from "./viewport-controller"
import { PrefDef, PrefScopeView, definePref, isRecord, v } from "./prefs"
import {
  DefaultSnapSettings,
  SnapSettings,
  StepLimits,
  TranslateSnapKind,
  TranslateSnapKinds,
  validStep,
} from "./viewport-snap"
import { GizmoPivot, GizmoPivots, GizmoSpace, GizmoSpaces } from "./viewport-tool-settings"

const Modes = ["translate", "rotate", "scale", "none"] as const satisfies readonly GizmoMode[]

export interface ViewportToolPrefValue {
  mode: GizmoMode
  space: GizmoSpace
  pivot: GizmoPivot
}

export const DefaultViewportTool: ViewportToolPrefValue = { mode: "translate", space: "world", pivot: "pivot" }

export const ViewportToolPref: PrefDef<ViewportToolPrefValue, "user"> = definePref({
  key: "viewport.tool",
  scope: "user",
  default: DefaultViewportTool,
  validate: (raw) => {
    if (!isRecord(raw)) return undefined
    return {
      mode: v.oneOf<GizmoMode>(Modes)(raw.mode) ?? DefaultViewportTool.mode,
      space: v.oneOf<GizmoSpace>(GizmoSpaces)(raw.space) ?? DefaultViewportTool.space,
      pivot: v.oneOf<GizmoPivot>(GizmoPivots)(raw.pivot) ?? DefaultViewportTool.pivot,
    }
  },
})

/** A stored snap value turned into settings: each field that is not valid takes its default */
export function validateSnapSettings(raw: unknown): SnapSettings | undefined {
  if (!isRecord(raw)) return undefined
  const d = DefaultSnapSettings
  const part = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})
  const t = part(raw.translate)
  const r = part(raw.rotate)
  const s = part(raw.scale)
  const step = (value: unknown, limits: { min: number; max: number }, fallback: number): number =>
    validStep(value, limits) ? value : fallback
  return {
    translate: {
      enabled: v.boolean(t.enabled) ?? d.translate.enabled,
      step: step(t.step, StepLimits.translate, d.translate.step),
      kind: v.oneOf<TranslateSnapKind>(TranslateSnapKinds)(t.kind) ?? d.translate.kind,
    },
    rotate: {
      enabled: v.boolean(r.enabled) ?? d.rotate.enabled,
      stepDegrees: step(r.stepDegrees, StepLimits.rotateDegrees, d.rotate.stepDegrees),
    },
    scale: {
      enabled: v.boolean(s.enabled) ?? d.scale.enabled,
      step: step(s.step, StepLimits.scale, d.scale.step),
    },
  }
}

export const ViewportSnapPref: PrefDef<SnapSettings, "project"> = definePref({
  key: "viewport.snap",
  scope: "project",
  default: DefaultSnapSettings as SnapSettings,
  validate: validateSnapSettings,
})

/** Loads the saved tool, space and pivot into the viewport, then saves every change of them. Returns the detach. */
export function attachViewportToolPrefs(viewport: ViewportController, scope: PrefScopeView<"user">): () => void {
  const saved = scope.get(ViewportToolPref)
  viewport.setMode(saved.mode)
  viewport.setSpace(saved.space)
  viewport.setPivot(saved.pivot)
  let first = true
  return effect(() => {
    const value: ViewportToolPrefValue = { mode: viewport.mode.value, space: viewport.space.value, pivot: viewport.pivot.value }
    if (first) {
      first = false
      return
    }
    scope.set(ViewportToolPref, value)
  })
}

/** Loads the project's saved snap settings into the viewport, then saves every change of them. Returns the detach. */
export function attachViewportSnapPrefs(viewport: ViewportController, scope: PrefScopeView<"project">): () => void {
  viewport.setSnap(scope.get(ViewportSnapPref))
  let first = true
  return effect(() => {
    const value = viewport.snap.value
    if (first) {
      first = false
      return
    }
    scope.set(ViewportSnapPref, value)
  })
}
