// Import this first in a DOM test: it puts a jsdom window on globalThis (dom-globals.ts, which has to come before
// Testing Library is loaded) and unmounts what each test rendered. jsdom has no layout, canvas, ResizeObserver or
// DataTransfer (see the README).
import "./dom-globals"
import { afterEach } from "node:test"
import { cleanup } from "@testing-library/preact"
import { keymap } from "../renderer/keymap"

afterEach(() => {
  cleanup()
  // The page's one keyboard dispatcher (installed by a test through helpers.tsx) doesn't outlive the test
  keymap.uninstall()
  keymap.resetAll()
})
