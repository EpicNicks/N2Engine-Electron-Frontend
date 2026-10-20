// Small building blocks the panels share: the store's context, a panel frame, splitters, the prompt dialog and the
// context menu.
import { ComponentChildren, createContext } from "preact"
import { useContext, useEffect, useRef } from "preact/hooks"
import { signal } from "@preact/signals"
import { PanelFrameContext } from "./layout/panel-frame"
import type { EditorStore } from "./store"
import type { SceneState } from "./scene-state"
import type { AssetsState } from "./assets-state"
import type { AudioController } from "./audio-controller"
import type { HierarchyState } from "./hierarchy-state"
import type { InspectorState } from "./inspector-state"
import type { PlayController } from "./play-controller"
import type { ViewportController } from "./viewport-controller"
import type { UnsavedChoice } from "./store"
import type { AutosaveChoice } from "./autosave"

/** What every component can reach: the editor's store and the page's other state */
export interface AppState {
  store: EditorStore
  scene: SceneState
  assets: AssetsState
  hierarchy: HierarchyState
  inspector: InspectorState
  viewport: ViewportController
  audio: AudioController
  play: PlayController
}

export const AppContext = createContext<AppState | null>(null)

export function useApp(): AppState {
  const app = useContext(AppContext)
  if (!app) throw new Error("useApp outside AppContext")
  return app
}

// ==================== Errors ====================

/** The last failure, until dismissed (a command the host denied shows the host's own message) */
export function ErrorBanner() {
  const { store } = useApp()
  const error = store.error.value
  if (!error) return null
  return (
    <div class="error-banner" role="alert">
      <pre>{error}</pre>
      <button class="secondary" onClick={() => store.dismissError()} aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}

// ==================== Panel ====================

export function Panel(props: {
  title: string
  icon?: string
  actions?: ComponentChildren
  class?: string
  contentClass?: string
  children?: ComponentChildren
}) {
  // In a layout (layout/layout-view.tsx) the header drags the panel to another stack or region and has its menu
  const frame = useContext(PanelFrameContext)
  return (
    <section class={`panel ${props.class ?? ""}`}>
      <div
        class="panel-header"
        draggable={frame !== null ? true : undefined}
        onDragStart={frame?.dragStart}
        onDragEnd={frame?.dragEnd}
        onContextMenu={frame?.contextMenu}
      >
        {props.icon && <span aria-hidden="true">{props.icon}</span>}
        <span>{props.title}</span>
        {props.actions && <span class="panel-actions">{props.actions}</span>}
      </div>
      <div class={`panel-content ${props.contentClass ?? ""}`}>{props.children}</div>
    </section>
  )
}

/** A placeholder line in an empty panel */
export function Empty(props: { children: ComponentChildren; error?: boolean }) {
  return <p class={props.error ? "empty error" : "empty"}>{props.children}</p>
}

// ==================== Splitter ====================

/**
 * A bar between two panes that resizes one of them: onDrag gets the pointer's movement since the last call, along
 * the splitter's axis (x for a vertical bar, y for a horizontal one)
 */
export function Splitter(props: { direction: "vertical" | "horizontal"; onDrag: (delta: number) => void }) {
  const vertical = props.direction === "vertical"
  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault()
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    let last = vertical ? e.clientX : e.clientY
    const move = (m: PointerEvent) => {
      const position = vertical ? m.clientX : m.clientY
      props.onDrag(position - last)
      last = position
    }
    const up = () => {
      target.removeEventListener("pointermove", move)
      target.removeEventListener("pointerup", up)
      target.removeEventListener("pointercancel", up)
      document.body.classList.remove("resizing")
    }
    document.body.classList.add("resizing")
    target.addEventListener("pointermove", move)
    target.addEventListener("pointerup", up)
    target.addEventListener("pointercancel", up)
  }
  return <div class={`splitter ${props.direction}`} onPointerDown={onPointerDown} role="separator" />
}

// ==================== Prompt ====================

interface PromptRequest {
  title: string
  value: string
  resolve: (value: string | null) => void
}

const promptRequest = signal<PromptRequest | null>(null)

/** Asks for a line of text; null when cancelled or empty */
export function prompt(title: string, defaultValue: string): Promise<string | null> {
  promptRequest.value?.resolve(null)
  return new Promise((resolve) => {
    promptRequest.value = { title, value: defaultValue, resolve }
  })
}

export function PromptDialog() {
  const request = promptRequest.value
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [request])
  if (!request) return null

  const close = (value: string | null) => {
    promptRequest.value = null
    request.resolve(value)
  }
  const ok = () => close(input.current?.value.trim() || null)

  return (
    <div class="modal-overlay" onClick={(e) => e.target === e.currentTarget && close(null)}>
      <div class="modal" role="dialog" aria-label={request.title}>
        <label>
          {request.title}
          <input
            ref={input}
            type="text"
            defaultValue={request.value}
            onKeyDown={(e) => {
              if (e.key === "Enter") ok()
              if (e.key === "Escape") close(null)
            }}
          />
        </label>
        <div class="modal-buttons">
          <button class="secondary" onClick={() => close(null)}>
            Cancel
          </button>
          <button onClick={ok}>OK</button>
        </div>
      </div>
    </div>
  )
}

// ==================== Confirm ====================

interface ConfirmRequest {
  message: string
  okLabel: string
  resolve: (ok: boolean) => void
}

const confirmRequest = signal<ConfirmRequest | null>(null)

/** Asks a yes or no question; the message can have several lines */
export function confirmDialog(message: string, okLabel: string): Promise<boolean> {
  confirmRequest.value?.resolve(false)
  return new Promise((resolve) => {
    confirmRequest.value = { message, okLabel, resolve }
  })
}

export function ConfirmDialog() {
  const request = confirmRequest.value
  const ok = useRef<HTMLButtonElement>(null)
  useEffect(() => ok.current?.focus(), [request])
  if (!request) return null

  const close = (answer: boolean) => {
    confirmRequest.value = null
    request.resolve(answer)
  }
  return (
    <div class="modal-overlay" onClick={(e) => e.target === e.currentTarget && close(false)}>
      <div
        class="modal"
        role="alertdialog"
        aria-label={request.okLabel}
        onKeyDown={(e) => e.key === "Escape" && close(false)}
      >
        <p class="modal-message">{request.message}</p>
        <div class="modal-buttons">
          <button class="secondary" onClick={() => close(false)}>
            Cancel
          </button>
          <button ref={ok} onClick={() => close(true)}>
            {request.okLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ==================== Context menu ====================

export type MenuItem =
  | { label: string; action: () => void; disabled?: boolean }
  /** A line between groups of items */
  | { separator: true }

interface OpenMenu {
  x: number
  y: number
  items: MenuItem[]
  /** Opened from the keyboard: the menu takes the focus (and gives it back), and its first item is marked */
  keyboard: boolean
  opener: HTMLElement | null
}

const menu = signal<OpenMenu | null>(null)
/** The item the arrow keys marked (an index into items), or -1 */
const menuMark = signal(-1)
let menuElement: HTMLElement | null = null

/** Indexes of the items a key can choose */
function choosable(items: MenuItem[]): number[] {
  return items.flatMap((item, i) => ("separator" in item || item.disabled ? [] : [i]))
}

export function showContextMenu(x: number, y: number, items: MenuItem[], options: { keyboard?: boolean } = {}): void {
  const keyboard = options.keyboard === true
  menuMark.value = keyboard ? (choosable(items)[0] ?? -1) : -1
  menu.value =
    items.length > 0 ? { x, y, items, keyboard, opener: document.activeElement as HTMLElement | null } : null
}

/** Closes the menu; one that had the focus gives it back to what opened it */
function closeMenu(): void {
  const current = menu.value
  if (!current) return
  const refocus = current.keyboard && menuElement !== null && menuElement.contains(document.activeElement)
  menu.value = null
  if (refocus) current.opener?.focus?.()
}

export function ContextMenu() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const current = menu.value
      if (!current) return
      const items = choosable(current.items)
      const at = items.indexOf(menuMark.value)
      // The arrow keys mark an item, Enter chooses it; any other key closes the menu, as it always did
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
        e.preventDefault()
        if (items.length === 0) return
        if (e.key === "Home") menuMark.value = items[0]
        else if (e.key === "End") menuMark.value = items[items.length - 1]
        else if (e.key === "ArrowDown") menuMark.value = items[(at + 1) % items.length]
        else menuMark.value = items[(at - 1 + items.length) % items.length]
      } else if ((e.key === "Enter" || e.key === " ") && at >= 0) {
        e.preventDefault()
        const item = current.items[items[at]]
        closeMenu()
        if (!("separator" in item)) item.action()
      } else {
        closeMenu()
      }
    }
    const hide = () => closeMenu()
    document.addEventListener("click", hide)
    document.addEventListener("keydown", onKeyDown)
    window.addEventListener("blur", hide)
    return () => {
      document.removeEventListener("click", hide)
      document.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("blur", hide)
    }
  }, [])
  const current = menu.value
  useEffect(() => {
    if (current?.keyboard) menuElement?.focus()
  }, [current])
  if (!current) return null
  // Kept inside the window (an item is about 28px high and the menu about 260px wide)
  const left = Math.max(0, Math.min(current.x, window.innerWidth - 260))
  const top = Math.max(0, Math.min(current.y, window.innerHeight - current.items.length * 28 - 12))
  return (
    <div
      class="context-menu"
      style={{ left: `${left}px`, top: `${top}px` }}
      role="menu"
      tabIndex={-1}
      ref={(el) => {
        menuElement = el
      }}
    >
      {current.items.map((item, i) =>
        "separator" in item ? (
          <div class="context-menu-separator" role="separator" key={i} />
        ) : (
          <div
            class={`context-menu-item${item.disabled ? " disabled" : ""}${menuMark.value === i ? " marked" : ""}`}
            role="menuitem"
            aria-disabled={item.disabled === true}
            key={item.label}
            onClick={(e) => {
              if (item.disabled) return e.stopPropagation() // the menu stays
              closeMenu()
              item.action()
            }}
          >
            {item.label}
          </div>
        )
      )}
    </div>
  )
}

/** Whether a dialog (prompt, confirm, unsaved changes, autosave) is open: keys meant for the editor mustn't act then */
export function modalOpen(): boolean {
  return (
    promptRequest.value !== null ||
    confirmRequest.value !== null ||
    unsavedRequest.value !== null ||
    autosaveRequest.value !== null
  )
}

// ==================== Unsaved changes ====================

interface UnsavedRequest {
  message: string
  discardLabel: string
  resolve: (choice: UnsavedChoice) => void
}

const unsavedRequest = signal<UnsavedRequest | null>(null)

/** Asks what to do with a scene's unsaved changes: save them, discard them (discardLabel) or cancel */
export function unsavedDialog(message: string, discardLabel: string): Promise<UnsavedChoice> {
  unsavedRequest.value?.resolve("cancel")
  return new Promise((resolve) => {
    unsavedRequest.value = { message, discardLabel, resolve }
  })
}

export function UnsavedDialog() {
  const request = unsavedRequest.value
  const save = useRef<HTMLButtonElement>(null)
  useEffect(() => save.current?.focus(), [request])
  if (!request) return null

  const close = (choice: UnsavedChoice) => {
    unsavedRequest.value = null
    request.resolve(choice)
  }
  return (
    <div class="modal-overlay" onClick={(e) => e.target === e.currentTarget && close("cancel")}>
      <div
        class="modal"
        role="alertdialog"
        aria-label="Unsaved changes"
        onKeyDown={(e) => e.key === "Escape" && close("cancel")}
      >
        <p class="modal-message">{request.message}</p>
        <div class="modal-buttons">
          <button class="secondary" onClick={() => close("cancel")}>
            Cancel
          </button>
          <button class="danger" onClick={() => close("discard")}>
            {request.discardLabel}
          </button>
          <button ref={save} onClick={() => close("save")}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ==================== Autosave recovery ====================

interface AutosaveRequest {
  message: string
  resolve: (choice: AutosaveChoice) => void
}

const autosaveRequest = signal<AutosaveRequest | null>(null)

/** Asks what to do with the autosave a crash left: restore it, discard it, or decide later (also what Escape does) */
export function dismissAutosaveDialog(): void {
  const request = autosaveRequest.value
  autosaveRequest.value = null
  request?.resolve("later")
}

export function autosaveDialog(message: string): Promise<AutosaveChoice> {
  autosaveRequest.value?.resolve("later")
  return new Promise((resolve) => {
    autosaveRequest.value = { message, resolve }
  })
}

export function AutosaveDialog() {
  const request = autosaveRequest.value
  const restore = useRef<HTMLButtonElement>(null)
  useEffect(() => restore.current?.focus(), [request])
  if (!request) return null

  const close = (choice: AutosaveChoice) => {
    autosaveRequest.value = null
    request.resolve(choice)
  }
  return (
    <div class="modal-overlay">
      <div
        class="modal"
        role="alertdialog"
        aria-label="Recover the autosave"
        onKeyDown={(e) => e.key === "Escape" && close("later")}
      >
        <p class="modal-message">{request.message}</p>
        <div class="modal-buttons">
          <button class="secondary" onClick={() => close("later")}>
            Decide later
          </button>
          <button class="danger" onClick={() => close("discard")}>
            Discard
          </button>
          <button ref={restore} onClick={() => close("restore")}>
            Restore
          </button>
        </div>
      </div>
    </div>
  )
}
