// A jsdom window on globalThis, which Preact and Testing Library expect. It imports nothing of Testing Library's, and
// setup.ts imports it first: Testing Library reads the global document when it is loaded (for its `screen`), so the
// window has to exist before then.
import { JSDOM } from "jsdom"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" })
const win = dom.window as unknown as Record<string, unknown>
const target = globalThis as unknown as Record<string, unknown>

const names = [
  "window", "document", "navigator", "location", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
  "Window", "Node", "Element", "HTMLElement", "SVGElement", "HTMLInputElement", "HTMLButtonElement", "HTMLTextAreaElement",
  "HTMLSelectElement", "HTMLFormElement", "HTMLLabelElement", "HTMLAnchorElement", "DocumentFragment", "Text", "Comment",
  "Event", "CustomEvent", "UIEvent", "MouseEvent", "PointerEvent", "KeyboardEvent", "FocusEvent", "InputEvent",
  "MutationObserver", "DOMException", "Range", "Selection",
]
for (const name of names) {
  const value = name === "window" ? dom.window : win[name]
  // A property Node has already (navigator) is replaced, not skipped
  if (value !== undefined) Object.defineProperty(target, name, { value, configurable: true, writable: true })
}

// jsdom does not implement scrollIntoView, which panels call to keep a row visible
dom.window.HTMLElement.prototype.scrollIntoView = () => {}

// CodeMirror measures selection/cursor rectangles on animation frames. jsdom has no layout;
// supply empty geometry and asynchronous frames while still running the real editor view.
dom.window.requestAnimationFrame = fn => setTimeout(() => fn(Date.now()), 0) as unknown as number
dom.window.cancelAnimationFrame = id => clearTimeout(id)
Object.defineProperty(dom.window.Range.prototype, "getClientRects", { value: () => [] })
Object.defineProperty(dom.window.Range.prototype, "getBoundingClientRect", { value: () => new dom.window.DOMRect() })
