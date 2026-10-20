import "./setup"
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { screen, waitFor } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import { ipcError } from "../shared/api"
import type { RemoteSettings } from "../shared/api"
import type { ConnectRetryOptions } from "../renderer/connect-retry"
import { ConnectionLostNotice } from "../renderer/connection-notices"
import { Welcome } from "../renderer/welcome"
import { settle } from "../test/fake-store-api"
import { renderWithStore } from "./helpers"

const SETTINGS: RemoteSettings = { target: "me@cloud", hostPort: 7000 }
const TOKEN = "s3cret-token-value"
const BUSY_TEXT = "The host is busy with another session (a viewer session)"

/** The retry's clock and timers: a timer fires only when the test says so, and the clock moves to its due time */
class Clock {
  time = 0
  private next = 1
  readonly pending = new Map<number, { callback: () => void; ms: number }>()
  /** Every delay a timer was set with, in order */
  readonly delays: number[] = []
  options: ConnectRetryOptions = {
    timers: {
      setTimeout: (callback, ms) => {
        const handle = this.next++
        this.pending.set(handle, { callback, ms })
        this.delays.push(ms)
        return handle
      },
      clearTimeout: (handle) => {
        this.pending.delete(handle as number)
      },
    },
    now: () => this.time,
    random: () => 1, // no jitter: the schedule is 1, 2, 4, 8, 15, 15 ... seconds
  }
  async fire(): Promise<void> {
    const [handle, timer] = [...this.pending.entries()][0]
    this.pending.delete(handle)
    this.time += timer.ms
    timer.callback()
    await settle()
  }
}

/** A connect that fails the way the main process reports it: a message, and the host's code when it sent one */
const refused = (error: string, code?: string) => async (): Promise<string> => {
  throw ipcError({ error, code })
}

async function welcomeOnRemoteTab(clock: Clock, outcomes: Array<() => Promise<string>>) {
  const h = await renderWithStore(
    <Welcome />,
    (api) => {
      api.remote.connect = async (settings: RemoteSettings, token: string): Promise<string> => {
        api.calls.push(`connect ${token}`)
        const outcome = outcomes.shift()
        if (!outcome) throw new Error("the test ran out of outcomes")
        const name = await outcome()
        return name || `${settings.target}:${settings.hostPort}`
      }
    },
    {},
    clock.options
  )
  h.store.welcomeMode.value = "remote"
  return h
}

const connectAttempts = (calls: string[]): number => calls.filter((c) => c.startsWith("connect ")).length

describe("a host that answers busy", () => {
  test("shows a calm message, retries with a capped exponential backoff, and connects when the host frees up", async () => {
    const clock = new Clock()
    const busy = refused(BUSY_TEXT, "busy")
    const h = await welcomeOnRemoteTab(clock, [busy, busy, busy, busy, busy, busy, async () => "me@cloud:7000"])

    await h.store.connectRemote(SETTINGS, TOKEN)
    await screen.findByText(/The host is busy with another session \(a viewer session\)\./)
    assert.ok(screen.getByText(/It will try again in 1 s/))
    assert.equal(h.store.error.value, null, "a busy host is not shown as an error")
    assert.equal(h.store.projectPath.value, null)

    for (let i = 0; i < 6; i++) await clock.fire()
    assert.deepEqual(clock.delays, [1000, 2000, 4000, 8000, 15000, 15000])
    assert.equal(connectAttempts(h.api.calls), 7)
    assert.equal(h.store.projectPath.value, "me@cloud:7000")
    assert.equal(h.store.busyRetry.value, null)
    assert.equal(clock.pending.size, 0, "no timer is left")
  })

  test("every retry uses the same token, and the token is never in what the screen or the store holds", async () => {
    const clock = new Clock()
    const busy = refused(BUSY_TEXT, "busy")
    const h = await welcomeOnRemoteTab(clock, [busy, busy, async () => "x"])
    await h.store.connectRemote(SETTINGS, TOKEN)
    await clock.fire()
    await clock.fire()
    assert.deepEqual(
      h.api.calls.filter((c) => c.startsWith("connect ")),
      [`connect ${TOKEN}`, `connect ${TOKEN}`, `connect ${TOKEN}`]
    )
    assert.ok(!document.body.textContent?.includes(TOKEN))
    assert.ok(!JSON.stringify(h.store.busyRetry.value).includes(TOKEN))
    assert.ok(!String(h.store.error.value).includes(TOKEN))
  })

  test("the jitter only shortens a wait, by at most half, and no wait passes the cap", async () => {
    const { backoffDelayMilliseconds } = await import("../renderer/connect-retry")
    for (let attempt = 0; attempt < 12; attempt++) {
      const ceiling = Math.min(15000, 1000 * 2 ** attempt)
      assert.equal(backoffDelayMilliseconds(attempt, () => 1), ceiling)
      assert.equal(backoffDelayMilliseconds(attempt, () => 0), Math.round(ceiling / 2))
    }
  })

  test("Cancel stops the retry at once: no timer, no more attempts, nothing kept", async () => {
    const clock = new Clock()
    const busy = refused(BUSY_TEXT, "busy")
    const h = await welcomeOnRemoteTab(clock, [busy, busy, busy])
    const user = userEvent.setup()
    await h.store.connectRemote(SETTINGS, TOKEN)
    await screen.findByText(/It will try again/)
    assert.equal(clock.pending.size, 1)

    await user.click(screen.getByRole("button", { name: "Cancel" }))

    assert.equal(h.store.busyRetry.value, null)
    assert.equal(clock.pending.size, 0)
    assert.equal(screen.queryByText(/The host is busy/), null)
    assert.equal(connectAttempts(h.api.calls), 1)
  })

  test("leaving the connect screen cancels the retry too (no leaked timer)", async () => {
    const clock = new Clock()
    const h = await welcomeOnRemoteTab(clock, [refused(BUSY_TEXT, "busy")])
    await h.store.connectRemote(SETTINGS, TOKEN)
    await screen.findByText(/It will try again/)
    h.store.welcomeMode.value = "local" // the remote form unmounts
    await waitFor(() => assert.equal(clock.pending.size, 0))
    assert.equal(h.store.busyRetry.value, null)
  })

  test("it gives up after about two minutes and offers Retry, which starts over with the same connect", async () => {
    const clock = new Clock()
    const busy = refused(BUSY_TEXT, "busy")
    const outcomes = Array.from({ length: 40 }, () => busy)
    outcomes.push(async () => "me@cloud:7000")
    const h = await welcomeOnRemoteTab(clock, outcomes)
    const user = userEvent.setup()

    await h.store.connectRemote(SETTINGS, TOKEN)
    while (h.store.busyRetry.value?.phase === "waiting") await clock.fire()

    assert.equal(h.store.busyRetry.value?.phase, "gaveUp")
    assert.ok(clock.time <= 120000, "it never waited past the limit")
    assert.ok(clock.time > 100000, "it kept trying for about two minutes")
    assert.equal(clock.pending.size, 0)
    await screen.findByText(/stopped trying/)
    const attempts = connectAttempts(h.api.calls)

    // Nothing more happens by itself
    assert.equal(connectAttempts(h.api.calls), attempts)

    // Retry: a fresh schedule from the first wait; the host answers busy until the outcomes run out
    clock.delays.length = 0
    outcomes.length = 0
    outcomes.push(refused(BUSY_TEXT, "busy"), async () => "me@cloud:7000")
    await user.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => assert.equal(h.store.busyRetry.value?.phase, "waiting"))
    assert.deepEqual(clock.delays, [1000])
    await clock.fire()
    assert.equal(h.store.projectPath.value, "me@cloud:7000")
    assert.ok(h.api.calls.filter((c) => c.startsWith("connect ")).every((c) => c === `connect ${TOKEN}`))
  })

  test("an attempt in flight when Cancel is pressed is ignored, and a connection it got is closed again", async () => {
    const clock = new Clock()
    let release: () => void = () => {}
    const inFlight = new Promise<void>((resolve) => (release = resolve))
    const h = await welcomeOnRemoteTab(clock, [
      refused(BUSY_TEXT, "busy"),
      async () => {
        await inFlight
        return "me@cloud:7000"
      },
    ])
    await h.store.connectRemote(SETTINGS, TOKEN)
    await clock.fire() // the second attempt is now waiting on inFlight
    assert.equal(h.store.busyRetry.value?.phase, "trying")

    h.store.cancelBusyRetry()
    release()
    await settle()

    assert.equal(h.store.projectPath.value, null, "the cancelled connect did not open the editor")
    assert.ok(h.api.calls.includes("close"), "and its connection was closed")
  })
})

describe("failures that are not busy are never retried", () => {
  for (const [name, error, code] of [
    ["a wrong token", "The editor host refused Hello: Invalid access token", undefined],
    ["a pin mismatch", "The host's certificate is not the pinned one", undefined],
    ["a denial code", "The role may not do that", "forbidden"],
    ["an unreachable host", "connect ECONNREFUSED 10.0.0.5:7000", undefined],
  ] as const) {
    test(`${name} is shown once and no timer is set`, async () => {
      const clock = new Clock()
      const h = await welcomeOnRemoteTab(clock, [refused(error, code)])
      await h.store.connectRemote(SETTINGS, TOKEN)
      assert.equal(h.store.error.value, error)
      assert.equal(h.store.busyRetry.value, null)
      assert.equal(clock.pending.size, 0)
      assert.equal(connectAttempts(h.api.calls), 1)
    })
  }

  test("a retry that fails some other way stops retrying and shows that error", async () => {
    const clock = new Clock()
    const h = await welcomeOnRemoteTab(clock, [
      refused(BUSY_TEXT, "busy"),
      refused("The editor host refused Hello: Invalid access token"),
    ])
    await h.store.connectRemote(SETTINGS, TOKEN)
    await clock.fire()
    assert.equal(h.store.error.value, "The editor host refused Hello: Invalid access token")
    assert.equal(h.store.busyRetry.value, null)
    assert.equal(clock.pending.size, 0)
    assert.equal(connectAttempts(h.api.calls), 2)
  })

  test("the host's text is shown as text, never as markup", async () => {
    const clock = new Clock()
    const h = await welcomeOnRemoteTab(clock, [refused("The host is busy <img src=x onerror=alert(1)>", "busy")])
    await h.store.connectRemote(SETTINGS, TOKEN)
    await screen.findByText(/<img src=x/)
    assert.equal(document.querySelector("img"), null)
  })
})

describe("a session the host closed", () => {
  async function inRemoteSession(clock: Clock) {
    const h = await renderWithStore(<ConnectionLostNotice />, (api) => {
      api.hostState = { status: "running", mode: "remote", launch: 1, projectPath: "me@cloud:7000", message: null }
    }, {}, clock.options)
    h.store.projectPath.value = "me@cloud:7000"
    return h
  }

  test("is not shown while connected", async () => {
    const h = await inRemoteSession(new Clock())
    h.api.pushConnection(true)
    await settle()
    assert.equal(screen.queryByText(/The host closed the connection/), null)
  })

  test("says the host closed it and another client may have taken over, and does not reconnect by itself", async () => {
    const clock = new Clock()
    const h = await inRemoteSession(clock)
    h.api.pushConnection(true)
    h.api.pushConnection(false)

    await screen.findByText(/The host closed the connection/)
    assert.ok(screen.getByText(/took\s+this session over/))
    assert.equal(clock.pending.size, 0)
    assert.equal(connectAttempts(h.api.calls), 0)
  })

  test("Reconnect goes back to the remote connect screen, asking for the token again", async () => {
    const h = await inRemoteSession(new Clock())
    h.api.pushConnection(true)
    h.api.pushConnection(false)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Reconnect" }))
    await waitFor(() => assert.equal(h.store.projectPath.value, null))
    assert.equal(h.store.welcomeMode.value, "remote")
    assert.equal(connectAttempts(h.api.calls), 0, "no connect without the user giving the token")
  })
})
