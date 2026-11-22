// The inspector's prefab overrides (protocol 1.33.0 and 1.34.0): the changes of the prefab instance the object is in, each
// with Revert and Apply to one prefab of its link path, the prefabs of that path to open, and the labels of overridden
// fields, bold, with the same Revert and Apply on a right-click. The logic is in prefab-overrides-state.ts and
// prefab-overrides.ts (tested in Node).
import type { ComponentChildren } from "preact"
import { useState } from "preact/hooks"
import { OverrideRow, describeRow, isFieldOverridden, prefabLabel, rowsForField, sharedLevels } from "../protocol/prefab-overrides"
import { MenuItem, showContextMenu, useApp } from "./ui"

/** The menu of Revert and Apply for some rows (one field, one change, or all of them) */
function overrideMenu(
  rows: readonly OverrideRow[] | "all",
  levels: readonly { level: number; prefab: string; path: string }[],
  actions: { revert(): void; apply(level: number): void },
  canApply: boolean
): MenuItem[] {
  const items: MenuItem[] = [{ label: rows === "all" ? "Revert All" : "Revert", action: actions.revert }]
  if (canApply) {
    for (const level of levels) {
      items.push({ label: `Apply to ${prefabLabel(level)}`, action: () => actions.apply(level.level) })
    }
  }
  return items
}

/**
 * A field's label: bold when the field differs from the prefab (1.34.0's overrides lists), with Revert and Apply to each
 * prefab of the field's link path on a right-click
 */
export function OverrideLabel(props: {
  text: ComponentChildren
  title?: string
  /** The overridden paths of the object (componentId null) or of the component */
  overrides: readonly string[] | undefined
  /** The field's path among them ("name", "isActive", "positionable.localScale", a component value's key) */
  field: string
  objectId: string
  componentId: string | null
}) {
  const { store, inspector } = useApp()
  const state = inspector.prefabOverrides
  const overridden = isFieldOverridden(props.overrides, props.field)
  if (!overridden) return <label title={props.title}>{props.text}</label>
  const fail = (what: string) => (e: unknown) => store.reportError(what, e)
  const onContextMenu = (e: MouseEvent) => {
    const rows = rowsForField(state.rows.value, props.objectId, props.componentId, props.field)
    if (rows.length === 0 || inspector.readOnly.value) return
    e.preventDefault()
    e.stopPropagation()
    showContextMenu(
      e.clientX,
      e.clientY,
      overrideMenu(
        rows,
        sharedLevels(rows),
        {
          revert: () => void state.revert(rows).catch(fail("Failed to revert the override")),
          apply: (level) => void state.apply(rows, level).catch(fail("Failed to apply the override")),
        },
        state.canApply
      )
    )
  }
  return (
    <label
      class="overridden"
      title={`${props.title ? `${props.title}\n` : ""}Differs from the prefab. Right-click to revert or apply it.`}
      onContextMenu={onContextMenu}
    >
      {props.text}
    </label>
  )
}

/** The prefabs the object's links name, outer to inner, each opened for editing on a click */
function LinkPath() {
  const { store, inspector } = useApp()
  const path = inspector.prefabOverrides.linkPath.value
  if (path.length === 0) return null
  return (
    <div class="prefab-links">
      <span class="hint">Open prefab:</span>
      {path.map((level, i) => (
        <button
          key={`${i}:${level.rootId}`}
          class="link"
          disabled={level.path === ""}
          title={level.path === "" ? "The prefab is not in the assets list" : `Edit ${level.path} (the open scene is parked)`}
          onClick={() => void store.openPrefabStage(level.path, "isolated")}
        >
          {prefabLabel(level)}
        </button>
      ))}
    </div>
  )
}

/** The changes of the instance the object is in, with Revert and Apply for each and for all */
export function PrefabOverridesSection() {
  const { store, inspector, hierarchy } = useApp()
  const state = inspector.prefabOverrides
  const [open, setOpen] = useState(false)
  const info = state.info.value
  const problem = state.problem.value
  const header = inspector.header.value
  if (!header || (header.linkDepth ?? 0) <= 0) return null
  if (problem !== null) return <div class="field-error">The prefab overrides couldn't be read: {problem}</div>
  if (info === null) return null
  const rows = state.rows.value
  const readOnly = inspector.readOnly.value
  const fail = (what: string) => (e: unknown) => store.reportError(what, e)
  const nodes = hierarchy.tree.value.nodes
  const components = new Map(inspector.components.value.map((c) => [c.id, c.type]))
  const names = {
    object: (id: string) => nodes.get(id)?.name ?? null,
    component: (id: string) => components.get(id) ?? null,
  }
  const root = nodes.get(info.rootId)?.name ?? "the instance"
  const linkPath = state.linkPath.value
  const showMenu = (e: MouseEvent, items: MenuItem[]) => {
    const target = e.currentTarget as HTMLElement
    const box = target.getBoundingClientRect()
    showContextMenu(box.left, box.bottom, items)
  }
  return (
    <div class="prefab-overrides" data-testid="prefab-overrides">
      <div class="override-row">
        <span class="override-label" title={`The changes of ${root} (the outermost prefab instance this object is in)`}>
          {rows.length === 0 ? `No overrides on ${root}` : `${rows.length} override${rows.length === 1 ? "" : "s"} on ${root}`}
        </span>
        {rows.length > 0 && (
          <button class="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Show"}
          </button>
        )}
      </div>
      <LinkPath />
      {open && rows.length > 0 && (
        <>
          {rows.map((row, i) => (
            <div class="override-row" key={i}>
              <span class="override-label" title={describeRow(row, names)}>
                {describeRow(row, names)}
              </span>
              {!readOnly && (
                <>
                  <button class="secondary" onClick={() => void state.revert([row]).catch(fail("Failed to revert the override"))}>
                    Revert
                  </button>
                  {state.canApply && row.levels.length > 0 && (
                    <button
                      class="secondary"
                      onClick={(e) =>
                        showMenu(
                          e,
                          row.levels.map((level) => ({
                            label: `Apply to ${prefabLabel(level)}`,
                            action: () => void state.apply([row], level.level).catch(fail("Failed to apply the override")),
                          }))
                        )
                      }
                    >
                      Apply ▾
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
          {!readOnly && (
            <div class="override-actions">
              <button class="secondary" onClick={() => void state.revert("all").catch(fail("Failed to revert the overrides"))}>
                Revert All
              </button>
              {state.canApply && (
                <button
                  class="secondary"
                  onClick={(e) =>
                    showMenu(e, [
                      ...(linkPath.length > 0
                        ? [
                            {
                              label: `Apply All to ${prefabLabel(linkPath[0])}`,
                              action: () => void state.apply("all", 0).catch(fail("Failed to apply the overrides")),
                            },
                          ]
                        : []),
                      {
                        label: "Apply All, each to its innermost prefab",
                        action: () => void state.apply("all", -1).catch(fail("Failed to apply the overrides")),
                      },
                    ])
                  }
                >
                  Apply All ▾
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
