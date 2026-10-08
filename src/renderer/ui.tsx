// Small building blocks the panels share: the store's context, a panel frame, splitters, the prompt dialog and the
// context menu.
import { ComponentChildren, createContext } from "preact"
import { useContext, useEffect, useRef } from "preact/hooks"
import { signal } from "@preact/signals"
import type { EditorStore } from "./store"
import type { SceneState } from "./scene-state"
import type { AudioController } from "./audio-controller"

/** What every component can reach: the editor's store and the page's other state */
export interface AppState {
  store: EditorStore
  scene: SceneState
  audio: AudioController
}

export const AppContext = createContext<AppState | null>(null)

export function useApp(): AppState {
  const app = useContext(AppContext)
  if (!app) throw new Error("useApp outside AppContext")
  return app
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
  return (
    <section class={`panel ${props.class ?? ""}`}>
      <div class="panel-header">
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

export interface MenuItem {
  label: string
  action: () => void
}

const menu = signal<{ x: number; y: number; items: MenuItem[] } | null>(null)

export function showContextMenu(x: number, y: number, items: MenuItem[]): void {
  menu.value = items.length > 0 ? { x, y, items } : null
}

export function ContextMenu() {
  useEffect(() => {
    const hide = () => (menu.value = null)
    document.addEventListener("click", hide)
    document.addEventListener("keydown", hide)
    window.addEventListener("blur", hide)
    return () => {
      document.removeEventListener("click", hide)
      document.removeEventListener("keydown", hide)
      window.removeEventListener("blur", hide)
    }
  }, [])
  const current = menu.value
  if (!current) return null
  return (
    <div class="context-menu" style={{ left: `${current.x}px`, top: `${current.y}px` }} role="menu">
      {current.items.map((item) => (
        <div
          class="context-menu-item"
          role="menuitem"
          key={item.label}
          onClick={() => {
            menu.value = null
            item.action()
          }}
        >
          {item.label}
        </div>
      ))}
    </div>
  )
}
