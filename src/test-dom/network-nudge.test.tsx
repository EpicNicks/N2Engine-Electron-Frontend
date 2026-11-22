// The inspector's network nudge (#381 item 8): shown with the host's hint, it opens Project Settings at Network, or is
// dismissed
import "./setup"
import { test } from "node:test"
import * as assert from "node:assert/strict"
import { fireEvent, screen } from "@testing-library/preact"
import { signal } from "@preact/signals-core"
import { NetworkNudge } from "../renderer/inspector-panel"
import { renderWithApp } from "./helpers"

const Hint = "This scene has network objects but the project's network preset is none."

function harness(initial: string | null) {
  const nudge = signal<string | null>(initial)
  const requests: Array<[string, string | undefined]> = []
  let dismissed = 0
  const inspector = {
    networkNudge: nudge,
    dismissNetworkNudge: () => {
      dismissed++
      nudge.value = null
    },
  }
  const store = {
    requestPanel: (id: string, section?: string) => void requests.push([id, section]),
  }
  return { inspector, store, requests, nudge, dismissed: () => dismissed }
}

test("no hint: nothing is shown", () => {
  const h = harness(null)
  const { container } = renderWithApp(<NetworkNudge />, { inspector: h.inspector as never, store: h.store as never })
  assert.equal(container.querySelector("[data-network-nudge]"), null)
})

test("the hint is shown, and its button opens Project Settings at Network and closes it", () => {
  const h = harness(Hint)
  const { container } = renderWithApp(<NetworkNudge />, { inspector: h.inspector as never, store: h.store as never })
  assert.ok(container.querySelector("[data-network-nudge]"))
  assert.ok(screen.getByText(Hint))
  fireEvent.click(screen.getByText("Open network settings"))
  assert.deepEqual(h.requests, [["projectSettings", "network"]])
  assert.equal(h.dismissed(), 1)
})

test("Dismiss closes it without opening anything", () => {
  const h = harness(Hint)
  renderWithApp(<NetworkNudge />, { inspector: h.inspector as never, store: h.store as never })
  fireEvent.click(screen.getByLabelText("Dismiss the network nudge"))
  assert.deepEqual(h.requests, [])
  assert.equal(h.dismissed(), 1)
})
