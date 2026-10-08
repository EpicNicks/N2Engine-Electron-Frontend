// The hierarchy panel: the scene's objects as a tree, with selection, drag-and-drop reparenting and reordering, rename,
// the active toggle, creating objects from presets, duplicate, delete, a context menu and keyboard shortcuts. The
// logic is in hierarchy-state.ts and hierarchy-tree.ts (tested in Node); this is the DOM around it.
import { useEffect, useRef } from "preact/hooks"
import { signal } from "@preact/signals"
import { CreatePresets } from "./hierarchy-state"
import { DropPosition, DropTarget, RootId, canDrop, resolveDrop } from "./hierarchy-tree"
import { Empty, MenuItem, Panel, showContextMenu, useApp } from "./ui"

/** What the drag in progress carries (empty when none, or when it isn't one of ours) */
const dragging = signal<string[]>([])
/** Where the drop would go: a line before or after the row, or the row itself; id null is the end of the roots */
const indicator = signal<{ id: string | null; position: DropPosition } | null>(null)

function clearDrag(): void {
  dragging.value = []
  indicator.value = null
}

function RenameInput({ id, name }: { id: string; name: string }) {
  const { store, hierarchy } = useApp()
  const input = useRef<HTMLInputElement>(null)
  const finished = useRef(false)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const finish = (commit: boolean) => {
    if (finished.current) return
    finished.current = true
    // The keys (F2, Delete, ...) work on the list: keep the focus there once the field is gone
    input.current?.closest<HTMLElement>(".hierarchy-list")?.focus()
    if (commit) {
      hierarchy
        .commitRename(id, input.current?.value ?? name)
        .catch((e) => store.reportError("Failed to rename the object", e))
    } else hierarchy.cancelRename()
  }
  return (
    <input
      ref={input}
      class="hierarchy-rename"
      type="text"
      defaultValue={name}
      aria-label="Name"
      onClick={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Enter") finish(true)
        else if (e.key === "Escape") finish(false)
      }}
      onBlur={() => finish(true)}
    />
  )
}

function positionOver(e: DragEvent): DropPosition {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const y = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5
  return y < 0.25 ? "before" : y > 0.75 ? "after" : "inside"
}

function useCreateItems() {
  const { store, hierarchy } = useApp()
  return (parentId: string): MenuItem[] =>
    CreatePresets.map(({ label, preset }) => ({
      label: parentId === RootId ? `Create ${label}` : `Create ${label} Child`,
      action: () =>
        hierarchy.create(preset, parentId).catch((e) => store.reportError("Failed to create the object", e)),
    }))
}

export function HierarchyPanel() {
  const { store, hierarchy } = useApp()
  const list = useRef<HTMLDivElement>(null)
  const createItems = useCreateItems()

  const connected = store.connected.value
  const sceneInfo = store.scene.value
  const rows = hierarchy.rows.value
  const tree = hierarchy.tree.value
  const expanded = hierarchy.expanded.value
  const selection = hierarchy.selection.value
  const renaming = hierarchy.renaming.value
  const drop = indicator.value
  const hasObjects = tree.order.length > 0

  const fail = (what: string) => (e: unknown) => store.reportError(what, e)
  const duplicate = () => hierarchy.duplicateSelected().catch(fail("Failed to duplicate"))
  const remove = () => hierarchy.deleteSelected().catch(fail("Failed to delete"))

  const rowMenu = (id: string): MenuItem[] => [
    { label: "Rename (F2)", action: () => hierarchy.beginRename(id) },
    { label: "Duplicate (Ctrl+D)", action: duplicate },
    { label: "Delete (Del)", action: remove },
    { separator: true },
    ...createItems(id),
  ]

  const onKeyDown = (e: KeyboardEvent) => {
    // Only the name being typed keeps its keys (the active checkbox, say, doesn't take them from the list)
    if ((e.target as HTMLElement).classList.contains("hierarchy-rename")) return
    const ctrl = e.ctrlKey || e.metaKey
    const isDelete = e.key === "Delete"
    const isDuplicate = ctrl && e.key.toLowerCase() === "d"
    // A held key would repeat the action on whatever is selected next
    if (e.repeat && (isDelete || isDuplicate)) return void e.preventDefault()
    if (e.key === "F2") hierarchy.beginRename()
    else if (isDelete) void remove()
    else if (isDuplicate) void duplicate()
    else if (e.key === "ArrowDown") hierarchy.step(1, e.shiftKey)
    else if (e.key === "ArrowUp") hierarchy.step(-1, e.shiftKey)
    else if (e.key === "ArrowRight") hierarchy.expandPrimary()
    else if (e.key === "ArrowLeft") hierarchy.collapsePrimary()
    else return
    e.preventDefault()
  }

  /** The drop a drag over a row (or the empty space) means, or null when it isn't allowed or isn't our drag */
  const dropAt = (overId: string | null, position: DropPosition): DropTarget | null => {
    if (dragging.value.length === 0) return null
    const target = resolveDrop(tree, overId, position, expanded)
    return target && canDrop(tree, dragging.value, target) ? target : null
  }

  const onDragOver = (e: DragEvent, overId: string | null, position: DropPosition) => {
    // A row's drag doesn't go on to the list behind it, which would take it for the empty space
    if (overId !== null) e.stopPropagation()
    const target = dropAt(overId, position)
    if (target === null) {
      if (indicator.value !== null) indicator.value = null
      return
    }
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
    if (drop?.id !== overId || drop?.position !== position) indicator.value = { id: overId, position }
  }

  const onDrop = (e: DragEvent, overId: string | null, position: DropPosition) => {
    if (overId !== null) e.stopPropagation()
    const target = dropAt(overId, position)
    const ids = dragging.value
    clearDrag()
    if (target === null) return
    e.preventDefault()
    hierarchy.move(ids, target).catch(fail("Failed to move"))
  }

  let content
  if (!connected) content = <Empty>Not connected</Empty>
  else if (!sceneInfo) content = <Empty>No scene loaded</Empty>
  else if (!hasObjects)
    content = <Empty>No objects in {sceneInfo.name || "the scene"}. Right-click to create one.</Empty>
  else
    content = rows.map((row) => {
      const node = tree.nodes.get(row.id)!
      const classes = ["hierarchy-item"]
      if (selection.ids.has(row.id)) classes.push("selected")
      if (!node.activeInHierarchy) classes.push("inactive")
      if (dragging.value.includes(row.id)) classes.push("dragging")
      if (drop?.id === row.id) classes.push(`drop-${drop.position}`)
      return (
        <div
          class={classes.join(" ")}
          key={row.id}
          data-id={row.id}
          style={{ paddingLeft: `${row.depth * 14 + 4}px` }}
          draggable={renaming !== row.id}
          title={`${node.components.join(", ") || "No components"}\nTag: ${node.tag || "(none)"}, layer ${node.layer}`}
          role="treeitem"
          aria-selected={selection.ids.has(row.id)}
          aria-expanded={row.hasChildren ? row.expanded : undefined}
          onClick={(e) => hierarchy.click(row.id, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey })}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            hierarchy.contextClick(row.id)
            showContextMenu(e.clientX, e.clientY, rowMenu(row.id))
          }}
          onDragStart={(e) => {
            if (!selection.ids.has(row.id)) hierarchy.click(row.id)
            dragging.value = hierarchy.dragIds(row.id)
            if (e.dataTransfer) {
              e.dataTransfer.effectAllowed = "move"
              e.dataTransfer.setData("text/plain", node.name)
            }
          }}
          onDragEnd={clearDrag}
          onDragOver={(e) => onDragOver(e, row.id, positionOver(e))}
          onDrop={(e) => onDrop(e, row.id, positionOver(e))}
        >
          <span
            class={row.hasChildren ? "arrow" : "arrow empty"}
            onClick={(e) => {
              e.stopPropagation()
              if (row.hasChildren) hierarchy.toggleExpanded(row.id)
            }}
          >
            {row.hasChildren ? (row.expanded ? "▾" : "▸") : ""}
          </span>
          <input
            type="checkbox"
            class="hierarchy-active"
            checked={node.active}
            title="Active"
            aria-label={`${node.name} active`}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) =>
              hierarchy
                .setActive(row.id, (e.currentTarget as HTMLInputElement).checked)
                .catch(fail("Failed to change the active flag"))
            }
          />
          {renaming === row.id ? (
            <RenameInput id={row.id} name={node.name} />
          ) : (
            <span class="hierarchy-name" onDblClick={() => hierarchy.beginRename(row.id)}>
              {node.name}
            </span>
          )}
        </div>
      )
    })

  // The primary row stays in view when the arrow keys move it
  const primary = selection.primary
  useEffect(() => {
    if (primary === null) return
    const rows = list.current?.querySelectorAll<HTMLElement>(".hierarchy-item")
    for (const row of rows ?? []) if (row.dataset.id === primary) row.scrollIntoView({ block: "nearest" })
  }, [primary])

  const canCreate = connected && sceneInfo !== null
  return (
    <Panel
      title={sceneInfo ? `Hierarchy: ${store.sceneLabel.value}` : "Hierarchy"}
      icon="🎬"
      class="hierarchy-panel"
      actions={
        <button
          disabled={!canCreate}
          onClick={(e) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
            e.stopPropagation()
            showContextMenu(rect.left, rect.bottom, createItems(RootId))
          }}
        >
          + Add
        </button>
      }
    >
      <div
        class={drop?.id === null && drop ? "hierarchy-list drop-end" : "hierarchy-list"}
        ref={list}
        tabIndex={0}
        role="tree"
        aria-multiselectable="true"
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          e.preventDefault()
          if (canCreate) showContextMenu(e.clientX, e.clientY, createItems(RootId))
        }}
        onDragOver={(e) => onDragOver(e, null, "inside")}
        onDrop={(e) => onDrop(e, null, "inside")}
      >
        {content}
      </div>
    </Panel>
  )
}
