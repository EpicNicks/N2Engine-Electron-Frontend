// The lines Lua editor extensions write with Editor.Log while a menu item runs (the extensionOutput event, protocol
// 1.15.0): parsed defensively and kept in a bounded ring that other code can subscribe to. There is no UI here.
//
// Every string in a line is UNTRUSTED text from project code. It is kept as plain text and must be shown as text
// (textContent, a text node, a Preact child), never put into HTML.
import type { EditorEvent } from "./protocol.generated"

export type ExtensionOutputLevel = "info" | "warn" | "error"

export interface ExtensionOutputLine {
  /** Counts the lines this log has added, from 1: a subscriber can tell what it has seen */
  id: number
  /** The extension's name as the host sent it (untrusted text) */
  extension: string
  /** An unknown level counts as info */
  level: ExtensionOutputLevel
  /** Untrusted text */
  message: string
  /** Host time in Unix milliseconds, 0 when missing */
  time: number
}

/** The lines kept; the oldest go first (the host sends at most 1000 per call, and also logs each as an Admin line) */
export const MaxExtensionOutputLines = 500

/** The longest text kept for a message or an extension name (the host cuts a message at 1024 bytes already) */
export const MaxExtensionOutputChars = 2048

/** Control characters other than a tab become "?" (the host does the same; this is for a host that did not) */
const ControlChars = /[\u0000-\u0008\u000a-\u001f\u007f]/g

function cleanText(value: string): string {
  const cut = value.length > MaxExtensionOutputChars ? value.slice(0, MaxExtensionOutputChars) + "..." : value
  return cut.replace(ControlChars, "?")
}

/** What an extensionOutput event says, or null when it is no such event or has no message (never throws) */
export function parseExtensionOutput(event: EditorEvent): Omit<ExtensionOutputLine, "id"> | null {
  if (typeof event !== "object" || event === null || event.kind !== "extensionOutput") return null
  if (typeof event.message !== "string") return null
  const level = event.level === "warn" || event.level === "error" ? event.level : "info"
  const time = typeof event.time === "number" && Number.isFinite(event.time) && event.time >= 0 ? event.time : 0
  return {
    extension: typeof event.extension === "string" ? cleanText(event.extension) : "",
    level,
    message: cleanText(event.message),
    time,
  }
}

/** A bounded, observable log of extension output */
export class ExtensionOutputLog {
  private items: ExtensionOutputLine[] = []
  private nextId = 1
  private readonly listeners = new Set<() => void>()

  constructor(private readonly capacity = MaxExtensionOutputLines) {}

  /** The lines, oldest first (a new array after every change, so it can be compared by identity) */
  get lines(): readonly ExtensionOutputLine[] {
    return this.items
  }

  /** Adds the event's line when it is an extensionOutput event; whether a line was added */
  addEvent(event: EditorEvent): boolean {
    const parsed = parseExtensionOutput(event)
    if (parsed === null) return false
    const next = [...this.items, { id: this.nextId++, ...parsed }]
    this.items = next.length > this.capacity ? next.slice(next.length - this.capacity) : next
    this.notify()
    return true
  }

  clear(): void {
    if (this.items.length === 0) return
    this.items = []
    this.notify()
  }

  /** Calls listener after every change; returns the function that stops it. A throwing listener affects no other. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // One listener's failure is not the host's event or another listener's problem
      }
    }
  }
}
