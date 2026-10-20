import "./setup"
import { test } from "node:test"
import * as assert from "node:assert/strict"
import { signal } from "@preact/signals"
import { screen, waitFor } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import type { DirectRemoteSettings, PinInspection } from "../shared/api"
import type { EditorStore } from "../renderer/store"
import { Welcome } from "../renderer/welcome"
import { renderWithApp, stubApp } from "./helpers"

const FINGERPRINT = "ab".repeat(32)
const PINNED = "cd".repeat(32)
// Shown in groups of 4, for comparing with the host's ready line
const SHOWN = Array(16).fill("abab").join(" ")
const PINNED_SHOWN = Array(16).fill("cdcd").join(" ")

interface Harness {
  connects: Array<{ settings: DirectRemoteSettings; token: string }>
  inspected: Array<{ host: string; port: number }>
  forgotten: Array<{ host: string; port: number }>
  user: ReturnType<typeof userEvent.setup>
}

/** The welcome screen on the Direct address form, over a store that answers an inspection with `inspection` */
async function openDirectForm(inspection: PinInspection | undefined): Promise<Harness> {
  const h: Harness = { connects: [], inspected: [], forgotten: [], user: userEvent.setup() }
  renderWithApp(<Welcome />, {
    store: {
      busy: signal<string | null>(null),
      busyRetry: signal(null),
      cancelBusyRetry: () => {},
      welcomeMode: signal<"local" | "remote">("remote"),
      recentRemotes: signal([]),
      inspectDirect: async (host, port) => {
        h.inspected.push({ host, port })
        return inspection
      },
      connectDirect: async (settings, token) => {
        h.connects.push({ settings, token })
        return true
      },
      forgetPin: async (host, port) => {
        h.forgotten.push({ host, port })
      },
    } satisfies Partial<EditorStore>,
  })
  await h.user.click(screen.getByRole("tab", { name: /Direct address/ }))
  return h
}

async function fill(h: Harness, host: string, port: string, token: string): Promise<void> {
  await h.user.type(screen.getByPlaceholderText("host name or IP address"), host)
  await h.user.type(screen.getByPlaceholderText(/--port/), port)
  await h.user.type(screen.getByPlaceholderText(/N2_EDITOR_TOKEN/), token)
}

test("the stub app throws on state the test did not provide", () => {
  const app = stubApp({ store: { busy: signal<string | null>(null) } })
  assert.equal(app.store.busy.value, null)
  assert.throws(() => app.store.recent, /did not provide store\.recent/)
  assert.throws(() => app.scene, /did not provide app\.scene/)
})

test("an unknown host shows its fingerprint and connects only after the user trusts it", async () => {
  const h = await openDirectForm({ kind: "unknown", fingerprint: FINGERPRINT })
  await fill(h, "10.0.0.5", "7000", "secret")
  await h.user.click(screen.getByRole("button", { name: "Connect" }))

  await screen.findByText(/isn't trusted yet/)
  assert.ok(screen.getByText(SHOWN))
  assert.deepEqual(h.inspected, [{ host: "10.0.0.5", port: 7000 }])
  // Nothing is sent to the host (the token included) before the user confirms the fingerprint
  assert.equal(h.connects.length, 0)

  await h.user.click(screen.getByRole("button", { name: "Trust this fingerprint and connect" }))
  await waitFor(() => assert.equal(h.connects.length, 1))
  assert.deepEqual(h.connects[0], {
    settings: { host: "10.0.0.5", port: 7000, tls: true, fingerprint: FINGERPRINT },
    token: "secret",
  })
})

test("cancelling the fingerprint prompt connects to nothing", async () => {
  const h = await openDirectForm({ kind: "unknown", fingerprint: FINGERPRINT })
  await fill(h, "10.0.0.5", "7000", "secret")
  await h.user.click(screen.getByRole("button", { name: "Connect" }))
  await screen.findByText(/isn't trusted yet/)
  await h.user.click(screen.getByRole("button", { name: "Cancel" }))
  assert.equal(screen.queryByText(/isn't trusted yet/), null)
  assert.equal(h.connects.length, 0)
})

test("plaintext to a computer that is not this one is refused", async () => {
  const h = await openDirectForm({ kind: "unknown", fingerprint: FINGERPRINT })
  await fill(h, "10.0.0.5", "7000", "secret")
  assert.equal(screen.queryByText(/Plaintext is only allowed to this computer/), null)

  await h.user.click(screen.getByRole("checkbox"))
  assert.ok(screen.getByText(/Plaintext is only allowed to this computer/))
  const connect = screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement
  assert.equal(connect.disabled, true)
  // Not even by submitting the form with Enter
  await h.user.type(screen.getByPlaceholderText(/N2_EDITOR_TOKEN/), "{Enter}")
  assert.equal(h.inspected.length, 0)
  assert.equal(h.connects.length, 0)
})

test("plaintext to this computer connects without a fingerprint", async () => {
  const h = await openDirectForm(undefined)
  await fill(h, "127.0.0.1", "7000", "secret")
  await h.user.click(screen.getByRole("checkbox"))
  assert.equal(screen.queryByText(/Plaintext is only allowed to this computer/), null)
  await h.user.click(screen.getByRole("button", { name: "Connect" }))
  await waitFor(() => assert.equal(h.connects.length, 1))
  assert.deepEqual(h.connects[0].settings, { host: "127.0.0.1", port: 7000, tls: false, fingerprint: undefined })
  assert.equal(h.inspected.length, 0)
})

test("a changed fingerprint shows what was pinned and what is presented, and is not connected to", async () => {
  const h = await openDirectForm({ kind: "changed", fingerprint: FINGERPRINT, pinned: PINNED, firstSeen: "2026-01-02T03:04:05Z" })
  await fill(h, "10.0.0.5", "7000", "secret")
  await h.user.click(screen.getByRole("button", { name: "Connect" }))

  await screen.findByText(/has changed since it was first trusted/)
  assert.ok(screen.getByText(PINNED_SHOWN))
  assert.ok(screen.getByText(SHOWN))
  assert.ok(screen.getByText(/Pinned:/))
  assert.ok(screen.getByText(/Now presented:/))
  assert.equal(screen.queryByRole("button", { name: /Trust this fingerprint/ }), null)
  assert.equal(h.connects.length, 0)

  // Two Forget pin buttons are on screen (the prompt's and the form's); both forget this host's pin
  const forget = screen.getAllByRole("button", { name: "Forget pin" })
  await h.user.click(forget[0])
  await waitFor(() => assert.deepEqual(h.forgotten, [{ host: "10.0.0.5", port: 7000 }]))
  await waitFor(() => assert.equal(screen.queryByText(/has changed since it was first trusted/), null))
  assert.equal(h.connects.length, 0)
})

test("Forget pin is there with TLS on and no prompt, and gone with TLS off", async () => {
  const h = await openDirectForm(undefined)
  const forget = screen.getByRole("button", { name: "Forget pin" }) as HTMLButtonElement
  // It needs a host and a port to forget
  assert.equal(forget.disabled, true)
  await h.user.type(screen.getByPlaceholderText("host name or IP address"), "10.0.0.5")
  await h.user.type(screen.getByPlaceholderText(/--port/), "7000")
  assert.equal(forget.disabled, false)
  await h.user.click(forget)
  await waitFor(() => assert.deepEqual(h.forgotten, [{ host: "10.0.0.5", port: 7000 }]))

  await h.user.click(screen.getByRole("checkbox"))
  assert.equal(screen.queryByRole("button", { name: "Forget pin" }), null)
})

test("the typed token is cleared out of the form once it is sent", async () => {
  const h = await openDirectForm({ kind: "trusted", fingerprint: FINGERPRINT })
  await fill(h, "10.0.0.5", "7000", "secret")
  const token = screen.getByPlaceholderText(/N2_EDITOR_TOKEN/) as HTMLInputElement
  assert.equal(token.type, "password")
  assert.equal(token.value, "secret")

  await h.user.click(screen.getByRole("button", { name: "Connect" }))
  await waitFor(() => assert.equal(h.connects.length, 1))
  // A pinned host connects at once, with the pinned fingerprint
  assert.deepEqual(h.connects[0], {
    settings: { host: "10.0.0.5", port: 7000, tls: true, fingerprint: FINGERPRINT },
    token: "secret",
  })
  await waitFor(() => assert.equal(token.value, ""))
})

test("a typed user is sent with the token and the fingerprint; without one the settings carry no user", async () => {
  const h = await openDirectForm({ kind: "trusted", fingerprint: FINGERPRINT })
  await fill(h, "10.0.0.5", "7000", "secret")
  await h.user.type(screen.getByPlaceholderText(/the user the token was made for/), "  alice ")
  await h.user.click(screen.getByRole("button", { name: "Connect" }))
  await waitFor(() => assert.equal(h.connects.length, 1))
  assert.deepEqual(h.connects[0], {
    settings: { host: "10.0.0.5", port: 7000, tls: true, fingerprint: FINGERPRINT, user: "alice" },
    token: "secret",
  })
})

test("the user field is a plain text field, so it is not the token", async () => {
  await openDirectForm(undefined)
  const user = screen.getByPlaceholderText(/the user the token was made for/) as HTMLInputElement
  assert.equal(user.type, "text")
  assert.equal((screen.getByPlaceholderText(/N2_EDITOR_TOKEN/) as HTMLInputElement).type, "password")
})
