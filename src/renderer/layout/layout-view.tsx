import { showPreferences } from "../preferences-request"
// The editor's panels on screen: the four regions, each a column of tab stacks, with splitters between the regions, a
// Window menu, and tabs that can be dragged to another stack or region (or moved from their menu, for the keyboard).
// The arrangement itself is the layout model (layout-model.ts); this file is the DOM glue over LayoutController.
import { ComponentChildren, ComponentType } from "preact"
import { RegionId, PanelRegistry, RegionIds, RegionTitles, DefaultSizing } from "./panel-registry"
import { MoveTarget, TabGroup, isDynamicId, locate } from "./layout-model"
import { LayoutController } from "./layout-controller"
import { PanelDragType, PanelFrame, PanelFrameContext } from "./panel-frame"
import { dragHas } from "../drag-types"
import { keymap } from "../keymap"
import { Empty, MenuItem, Splitter, showContextMenu, showShortcutsDialog } from "../ui"

/** A tab that isn't a panel: an open text file. The page says what it is called and shows (editor.tsx) */
export interface DynamicTab {
  /** "text:<path>" (DynamicPrefix) */
  id: string
  label: string
  title?: string
  dirty: boolean
  render(): ComponentChildren
  /** Closes it (it may ask first); the page then removes the tab from the layout */
  close(): void
  /** It became the shown tab of its stack */
  activate?(): void
}

type PanelComponent = ComponentType<Record<string, never>>

interface Info {
  label: string
  title?: string
  icon?: string
  dirty: boolean
  closable: boolean
  /** Can be dragged and moved to another region (text files stay at the bottom) */
  movable: boolean
}

interface ViewProps {
  controller: LayoutController
  dynamic: ReadonlyMap<string, DynamicTab>
}

function registryOf(controller: LayoutController): PanelRegistry<PanelComponent> {
  // The page registers components (builtin-panels.tsx); the model doesn't care what the component is
  return controller.registry as PanelRegistry<PanelComponent>
}

function infoOf({ controller, dynamic }: ViewProps, id: string): Info | null {
  const def = registryOf(controller).get(id)
  if (def) return { label: def.title, icon: def.icon, dirty: false, closable: def.closable, movable: true }
  const tab = dynamic.get(id)
  if (tab) return { label: tab.label, title: tab.title, dirty: tab.dirty, closable: true, movable: false }
  return null
}

/** Focuses a tab once the layout has been drawn again (after a move from the keyboard, so the user keeps their place) */
function focusTabSoon(id: string): void {
  setTimeout(() => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-tab-id]"))) {
      if (el.dataset.tabId === id) return el.focus()
    }
  }, 0)
}

/** The menu of a panel or a tab: where it can go, and Close */
function panelMenu(props: ViewProps, id: string): MenuItem[] {
  const { controller, dynamic } = props
  const info = infoOf(props, id)
  const at = locate(controller.layout.peek(), id)
  if (!info || !at) return []
  const items: MenuItem[] = []
  if (info.movable) {
    for (const region of RegionIds) {
      if (region === at.region) continue
      items.push({
        label: `Move to ${RegionTitles[region]}`,
        action: () => {
          controller.move(id, { region })
          focusTabSoon(id)
        },
      })
    }
  }
  if (info.closable) {
    if (items.length > 0) items.push({ separator: true })
    items.push({
      label: "Close",
      action: () => (isDynamicId(id) ? dynamic.get(id)?.close() : controller.close(id)),
    })
  }
  return items
}

// ==================== Drag and drop ====================

function dropHandlers(controller: LayoutController, key: string, target: MoveTarget) {
  return {
    onDragOver: (e: DragEvent) => {
      if (!dragHas(e, PanelDragType)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
      if (controller.dropHover.peek() !== key) controller.dropHover.value = key
    },
    onDragLeave: (e: DragEvent) => {
      // Moving onto a child of the zone also leaves it: only leaving for something outside it clears the highlight
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null) && controller.dropHover.peek() === key) {
        controller.dropHover.value = null
      }
    },
    onDrop: (e: DragEvent) => {
      if (!dragHas(e, PanelDragType)) return
      e.preventDefault()
      e.stopPropagation()
      // What was dropped comes from a drag: movePanel only moves a panel the layout knows
      const id = e.dataTransfer?.getData(PanelDragType)
      controller.dropHover.value = null
      controller.dragging.value = null
      if (id) controller.move(id, target)
    },
  }
}

function frameOf(props: ViewProps, id: string): PanelFrame {
  const { controller } = props
  return {
    id,
    dragStart: (e) => {
      if (!e.dataTransfer) return
      e.dataTransfer.setData(PanelDragType, id)
      e.dataTransfer.effectAllowed = "move"
      controller.dragging.value = id
    },
    dragEnd: () => {
      controller.dragging.value = null
      controller.dropHover.value = null
    },
    contextMenu: (e) => {
      const items = panelMenu(props, id)
      if (items.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      showContextMenu(e.clientX, e.clientY, items)
    },
  }
}

// ==================== Tabs ====================

function TabBar(props: ViewProps & { region: RegionId; groupIndex: number; tabs: string[]; active: string }) {
  const { controller, dynamic, region, groupIndex, tabs, active } = props
  const domId = (i: number) => `layout-${region}-${groupIndex}-tab-${i}`
  const registry = registryOf(controller)
  // A hidden panel that is unmounted has no tabpanel element for aria-controls to name
  const hasPanel = (id: string) => id === active || !(registry.get(id)?.unmountWhenHidden || isDynamicId(id))

  const activate = (id: string) => {
    controller.activate(id)
    dynamic.get(id)?.activate?.()
  }
  const close = (id: string) => (isDynamicId(id) ? dynamic.get(id)?.close() : controller.close(id))

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const id = tabs[index]
    let to: number | null = null
    if (e.key === "ArrowRight") to = (index + 1) % tabs.length
    else if (e.key === "ArrowLeft") to = (index - 1 + tabs.length) % tabs.length
    else if (e.key === "Home") to = 0
    else if (e.key === "End") to = tabs.length - 1
    if (to !== null) {
      e.preventDefault()
      activate(tabs[to])
      focusTabSoon(tabs[to])
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      activate(id)
    } else if (e.key === "Delete") {
      if (infoOf(props, id)?.closable) {
        e.preventDefault()
        close(id)
      }
    } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault()
      e.stopPropagation()
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      showContextMenu(rect.left, rect.bottom, panelMenu(props, id), { keyboard: true })
    }
  }

  return (
    <div
      class="tab-bar"
      role="tablist"
      aria-label={`${RegionTitles[region]} panels`}
      {...dropHandlers(controller, `${region}/${groupIndex}`, { region, group: groupIndex })}
    >
      {tabs.map((id, i) => {
        const info = infoOf(props, id)!
        const frame = frameOf(props, id)
        const selected = id === active
        return (
          <div
            class={selected ? "tab active" : "tab"}
            role="tab"
            id={domId(i)}
            data-tab-id={id}
            aria-selected={selected}
            aria-controls={hasPanel(id) ? `layout-${region}-${groupIndex}-panel-${i}` : undefined}
            tabIndex={selected ? 0 : -1}
            title={info.title}
            key={id}
            draggable={info.movable}
            onDragStart={info.movable ? frame.dragStart : undefined}
            onDragEnd={info.movable ? frame.dragEnd : undefined}
            onClick={() => activate(id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            onContextMenu={frame.contextMenu}
            {...(info.movable ? dropHandlers(controller, `${region}/${groupIndex}`, { region, group: groupIndex, before: id }) : {})}
          >
            {info.icon && <span aria-hidden="true">{info.icon}</span>}
            <span>
              {info.label}
              {info.dirty ? " •" : ""}
            </span>
            {info.closable && (
              <span
                class="close"
                role="button"
                aria-label={`Close ${info.label}`}
                onClick={(e) => {
                  e.stopPropagation()
                  close(id)
                }}
              >
                ×
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** One stack: a tab bar (when it has more than one tab, or its panel always has one) over the panels, only one shown */
function Stack(props: ViewProps & { region: RegionId; groupIndex: number; group: TabGroup }) {
  const { controller, dynamic, region, groupIndex, group } = props
  const registry = registryOf(controller)
  const tabs = group.tabs.filter((id) => registry.has(id) || dynamic.has(id))
  if (tabs.length === 0) return null
  const active = tabs.includes(group.active) ? group.active : tabs[0]
  const showBar = tabs.length > 1 || tabs.some((id) => isDynamicId(id) || registry.get(id)?.tabBar === "always")
  const sizing = registry.get(active)?.sizing ?? DefaultSizing
  const hover = controller.dropHover.value === `${region}/${groupIndex}`

  return (
    <div
      class={hover ? "panel-group drop-hover" : "panel-group"}
      data-region={region}
      style={{ flex: sizing.flex, maxHeight: sizing.maxHeight }}
      {...dropHandlers(controller, `${region}/${groupIndex}`, { region, group: groupIndex })}
    >
      {showBar && <TabBar {...props} tabs={tabs} active={active} />}
      {tabs.map((id, i) => {
        const shown = id === active
        const def = registry.get(id)
        // A panel with a loop to stop (the viewport) or a view that was never kept (the console, a text file) isn't
        // mounted while another tab is shown; the others stay, hidden, with their state
        if (!shown && (def?.unmountWhenHidden || isDynamicId(id))) return null
        const Component = def?.component
        return (
          <div
            class="tab-panel"
            hidden={!shown}
            role={showBar ? "tabpanel" : undefined}
            id={`layout-${region}-${groupIndex}-panel-${i}`}
            aria-labelledby={showBar ? `layout-${region}-${groupIndex}-tab-${i}` : undefined}
            key={id}
          >
            {Component ? (
              <PanelFrameContext.Provider value={frameOf(props, id)}>
                <Component />
              </PanelFrameContext.Provider>
            ) : (
              dynamic.get(id)?.render()
            )}
          </div>
        )
      })}
    </div>
  )
}

// ==================== Regions ====================

function Stacks(props: ViewProps & { region: RegionId }) {
  const groups = props.controller.layout.value.regions[props.region].groups
  return (
    <>
      {groups.map((group, i) => (
        <Stack {...props} groupIndex={i} group={group} key={group.id} />
      ))}
    </>
  )
}

/** Where a tab dragged to an empty region lands: shown only while a tab is being dragged */
function DropZone(props: ViewProps & { region: RegionId }) {
  const { controller, region } = props
  const hover = controller.dropHover.value === `${region}/zone`
  return (
    <div
      class={hover ? `drop-zone ${region} drop-hover` : `drop-zone ${region}`}
      {...dropHandlers(controller, `${region}/zone`, { region })}
    >
      <span>{RegionTitles[region]}</span>
    </div>
  )
}

/** The arrangement of the open project: assets | viewport over console and text files | hierarchy, inspector, engine */
export function EditorLayout(props: ViewProps) {
  const { controller } = props
  const layout = controller.layout.value
  const dragging = controller.dragging.value !== null
  const size = (region: RegionId) => layout.regions[region].size
  const has = (region: RegionId) => layout.regions[region].groups.length > 0
  const grow = (region: RegionId, delta: number) => controller.setSize(region, controller.layout.peek().regions[region].size + delta)

  return (
    <div class="main-container">
      {has("left") ? (
        <>
          <aside class="left-panel" style={{ width: `${size("left")}px` }}>
            <Stacks {...props} region="left" />
          </aside>
          <Splitter direction="vertical" onDrag={(dx) => grow("left", dx)} />
        </>
      ) : (
        dragging && <DropZone {...props} region="left" />
      )}
      <div class="center-panel">
        <div class="center-region">
          {has("center") ? <Stacks {...props} region="center" /> : <Empty>No panel here: open one from the Window menu</Empty>}
          {!has("center") && dragging && <DropZone {...props} region="center" />}
        </div>
        {has("bottom") ? (
          <>
            <Splitter direction="horizontal" onDrag={(dy) => grow("bottom", -dy)} />
            <div class="bottom-panel" style={{ height: `${size("bottom")}px` }}>
              <Stacks {...props} region="bottom" />
            </div>
          </>
        ) : (
          dragging && <DropZone {...props} region="bottom" />
        )}
      </div>
      {has("right") ? (
        <>
          <Splitter direction="vertical" onDrag={(dx) => grow("right", -dx)} />
          <aside class="right-panel" style={{ width: `${size("right")}px` }}>
            <Stacks {...props} region="right" />
          </aside>
        </>
      ) : (
        dragging && <DropZone {...props} region="right" />
      )}
    </div>
  )
}

// ==================== The Window menu ====================

const Checked = "✓ "
const Unchecked = "  "

/** Window: every registered panel (shown ones checked; choosing one shows it or, if it can be closed, closes it), then the layout's own items */
export function windowMenuItems(controller: LayoutController): MenuItem[] {
  const registry = registryOf(controller)
  const layout = controller.layout.value
  const items: MenuItem[] = registry.list().map((def) => {
    const shown = locate(layout, def.id) !== null
    return {
      label: `${shown ? Checked : Unchecked}${def.title}`,
      action: () => (shown && def.closable ? controller.close(def.id) : controller.open(def.id)),
    }
  })
  items.push({ separator: true })
  items.push({ label: "Reset layout", action: () => controller.reset() })
  items.push({ label: "Save layout as the default for new projects", action: () => controller.saveAsUserDefault() })
  if (controller.hasUserDefault.value) {
    items.push({ label: "Forget the saved default layout", action: () => controller.forgetUserDefault() })
  }
  items.push({ separator: true })
  items.push({ label: "Preferences...", action: showPreferences })
  items.push({ label: "Keyboard shortcuts", action: () => showShortcutsDialog(keymap.describe()) })
  return items
}

export function WindowButton(props: { controller: LayoutController }) {
  return (
    <button
      class="secondary"
      title="Show or hide panels, and reset the layout"
      aria-haspopup="menu"
      onClick={(e) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        e.stopPropagation()
        // detail 0: a click made by the keyboard (Enter or Space on the button)
        showContextMenu(rect.left, rect.bottom, windowMenuItems(props.controller), { keyboard: e.detail === 0 })
      }}
    >
      Window
    </button>
  )
}
