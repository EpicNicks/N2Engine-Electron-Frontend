// The viewport's toolbar (roadmap FE4): the tool (select, move, rotate, scale), the space (world or local), the pivot
// (pivot or center) and the snap settings (a toggle and an increment per tool, relative or absolute for a move). It is
// part of the viewport panel, drawn over the picture, and holds no state of its own beyond what a field is being typed:
// everything is ViewportController's (viewport-controller.ts), whose signals this reads. DOM glue only; the maths and
// the validation are viewport-snap.ts and viewport-tool-settings.ts. Every control is disabled while the scene can't be
// edited (a read-only host, a viewer's session, play mode): the gizmo is not there then either.
import { useEffect, useState } from "preact/hooks"
import { keymap } from "./keymap"
import { GizmoMode, GizmoModeTitles, GizmoModes, ViewportController } from "./viewport-controller"
import { ModeActions, PivotAction, SpaceAction, chordHint, toolLabel } from "./viewport-keys"
import {
  SnapSettings,
  StepLimits,
  TranslateSnapKind,
  formatStep,
  parseStep,
} from "./viewport-snap"
import { GizmoPivotTitles, GizmoSpaceTitles } from "./viewport-tool-settings"

/** What the tool buttons are called (the tool's name where it is shown) */
const ToolTooltips: Readonly<Record<GizmoMode, string>> = {
  translate: "Move tool: drag the arrows or squares to move the selected objects",
  rotate: "Rotate tool: drag a ring to turn the selected objects about the pivot",
  scale: "Scale tool: drag a handle to scale the selected objects (the centre scales all three axes)",
  none: "Select only: no gizmo, a click selects",
}

interface StepFieldProps {
  label: string
  value: number
  limits: { min: number; max: number }
  disabled: boolean
  title: string
  onCommit(value: number): void
}

/**
 * An increment field: what is typed is kept as typed until it is a usable number (then it is the setting, at once) and
 * is marked invalid until then; leaving the field puts the setting back in it.
 */
function StepField({ label, value, limits, disabled, title, onCommit }: StepFieldProps) {
  const [draft, setDraft] = useState(formatStep(value))
  const [invalid, setInvalid] = useState(false)
  // The setting changed from elsewhere (restored preferences, another tool's button): the field shows it
  useEffect(() => {
    setDraft(formatStep(value))
    setInvalid(false)
  }, [value])
  return (
    <input
      class="viewport-step"
      type="text"
      inputMode="decimal"
      size={5}
      aria-label={label}
      aria-invalid={invalid ? "true" : undefined}
      title={invalid ? `${title}: a number from ${limits.min} to ${limits.max}` : title}
      value={draft}
      disabled={disabled}
      onInput={(e) => {
        const text = (e.target as HTMLInputElement).value
        setDraft(text)
        const parsed = parseStep(text, limits)
        setInvalid(parsed === null)
        if (parsed !== null && parsed !== value) onCommit(parsed)
      }}
      onBlur={() => {
        setDraft(formatStep(value))
        setInvalid(false)
      }}
    />
  )
}

export interface ViewportToolbarProps {
  viewport: ViewportController
  /** Whether the scene can be edited now; the controls are disabled when not */
  canEdit: boolean
  /** Called after a button was used, so the view takes the focus back (its keys keep working) */
  onUsed?(): void
}

export function ViewportToolbar({ viewport, canEdit, onUsed }: ViewportToolbarProps) {
  const mode = viewport.mode.value
  const space = viewport.space.value
  const pivot = viewport.pivot.value
  const snap = viewport.snap.value
  const off = !canEdit
  const used = (): void => onUsed?.()
  const change = (next: SnapSettings): void => viewport.setSnap(next)
  // Scale is always along the object's own axes and the select-only tool has no handles: the space is not a choice there
  const spaceApplies = mode === "translate" || mode === "rotate"
  const spaceName = GizmoSpaceTitles[space]
  const pivotName = GizmoPivotTitles[pivot]
  const spaceTip = chordHint(
    keymap,
    spaceApplies
      ? "Handle space: world axes or the selected object's own (local) axes"
      : mode === "scale"
        ? "Handle space: the scale handles always follow the object's own axes"
        : "Handle space: there are no handles with the select-only tool",
    SpaceAction
  )
  const pivotTip = chordHint(keymap, "Pivot: the primary object's origin, or the centre of the selection's bounds", PivotAction)
  return (
    <div class="viewport-toolbar" role="toolbar" aria-label="Viewport tools">
      {/* Read by a screen reader as the tool changes ("Tool: Rotate (E)"); the buttons below show it */}
      <span class="viewport-sr" role="status" aria-live="polite">
        {toolLabel(keymap, mode)}
      </span>
      <div class="viewport-group" role="group" aria-label="Tool">
        {GizmoModes.map((m) => (
          <button
            key={m}
            type="button"
            class={"secondary viewport-tool" + (m === mode ? " active" : "")}
            aria-pressed={m === mode}
            disabled={off}
            title={chordHint(keymap, ToolTooltips[m], ModeActions[m])}
            onClick={() => {
              viewport.setMode(m)
              used()
            }}
          >
            {GizmoModeTitles[m]}
          </button>
        ))}
      </div>
      <div class="viewport-group" role="group" aria-label="Space and pivot">
        <button
          type="button"
          class="secondary viewport-toggle"
          aria-label={`Space: ${spaceName}`}
          disabled={off || !spaceApplies}
          title={spaceTip}
          onClick={() => {
            viewport.toggleSpace()
            used()
          }}
        >
          {spaceName}
        </button>
        <button
          type="button"
          class="secondary viewport-toggle"
          aria-label={`Pivot: ${pivotName}`}
          disabled={off || mode === "none"}
          title={pivotTip}
          onClick={() => {
            viewport.togglePivot()
            used()
          }}
        >
          {pivotName}
        </button>
      </div>
      <div class="viewport-group" role="group" aria-label="Snapping">
        <label class="viewport-snap" title="Snap moves to a multiple of the increment. Ctrl inverts this while dragging.">
          <input
            type="checkbox"
            checked={snap.translate.enabled}
            disabled={off}
            aria-label="Snap moves"
            onChange={(e) => change({ ...snap, translate: { ...snap.translate, enabled: (e.target as HTMLInputElement).checked } })}
          />
          Move
        </label>
        <StepField
          label="Move snap increment"
          value={snap.translate.step}
          limits={StepLimits.translate}
          disabled={off}
          title="Move increment (world units)"
          onCommit={(step) => change({ ...snap, translate: { ...snap.translate, step } })}
        />
        <select
          class="viewport-kind"
          aria-label="Move snap kind"
          title="Relative: the move is rounded to the increment. Absolute: the position is rounded to the world grid (along the world axes; along an object's own axis it stays relative)."
          value={snap.translate.kind}
          disabled={off}
          onChange={(e) =>
            change({ ...snap, translate: { ...snap.translate, kind: (e.target as HTMLSelectElement).value as TranslateSnapKind } })
          }
        >
          <option value="relative">Relative</option>
          <option value="absolute">Grid</option>
        </select>
        <label class="viewport-snap" title="Snap rotations to a multiple of the increment. Ctrl inverts this while dragging.">
          <input
            type="checkbox"
            checked={snap.rotate.enabled}
            disabled={off}
            aria-label="Snap rotations"
            onChange={(e) => change({ ...snap, rotate: { ...snap.rotate, enabled: (e.target as HTMLInputElement).checked } })}
          />
          Rotate
        </label>
        <StepField
          label="Rotate snap increment"
          value={snap.rotate.stepDegrees}
          limits={StepLimits.rotateDegrees}
          disabled={off}
          title="Rotate increment (degrees)"
          onCommit={(stepDegrees) => change({ ...snap, rotate: { ...snap.rotate, stepDegrees } })}
        />
        <label class="viewport-snap" title="Snap scale ratios to a multiple of the increment. Ctrl inverts this while dragging.">
          <input
            type="checkbox"
            checked={snap.scale.enabled}
            disabled={off}
            aria-label="Snap scales"
            onChange={(e) => change({ ...snap, scale: { ...snap.scale, enabled: (e.target as HTMLInputElement).checked } })}
          />
          Scale
        </label>
        <StepField
          label="Scale snap increment"
          value={snap.scale.step}
          limits={StepLimits.scale}
          disabled={off}
          title="Scale increment (ratio)"
          onCommit={(step) => change({ ...snap, scale: { ...snap.scale, step } })}
        />
      </div>
    </div>
  )
}
