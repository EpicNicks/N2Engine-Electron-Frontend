import "./setup"
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import { screen, waitFor, within } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import type { HostLocation } from "../shared/api"
import { Welcome } from "../renderer/welcome"
import type { FakeApi } from "../test/fake-store-api"
import { renderWithStore } from "./helpers"

const location = (change: Partial<HostLocation>): HostLocation => ({
  path: "C:\\N2EditorHost.exe",
  source: "setting",
  problem: null,
  canCreate: true,
  ...change,
})

/** The fake's host answers with this location */
const hostAt = (api: FakeApi, loc: HostLocation): void => {
  api.host.location = async () => loc
}

const recentNames = (): string[] =>
  Array.from(document.querySelectorAll(".recent .recent-name")).map((el) => el.textContent ?? "")

describe("Welcome over a real store: recent projects", () => {
  test("lists the store's recent projects with their paths", async () => {
    await renderWithStore(<Welcome />)
    assert.deepEqual(recentNames(), ["A", "B"])
    assert.ok(screen.getByText("C:\\Games\\A"))
    assert.ok(screen.getByText("C:\\Games\\B"))
    assert.equal(screen.queryByText("No recent projects"), null)
  })

  test("Remove takes that project off the list, through the API, and keeps the others", async () => {
    const h = await renderWithStore(<Welcome />)
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Remove A from the list" }))

    await waitFor(() => assert.deepEqual(recentNames(), ["B"]))
    assert.deepEqual(h.api.recentList, ["C:\\Games\\B"])
    assert.deepEqual(h.store.recent.value, ["C:\\Games\\B"])
    assert.equal(screen.queryByRole("button", { name: "Remove A from the list" }), null)
    assert.ok(screen.getByRole("button", { name: "Remove B from the list" }))
  })

  test("removing the last one shows the empty state", async () => {
    const h = await renderWithStore(<Welcome />, (api) => {
      api.recentList = ["C:\\Games\\Only"]
    })
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Remove Only from the list" }))

    await screen.findByText("No recent projects")
    assert.deepEqual(h.api.recentList, [])
    assert.deepEqual(recentNames(), [])
  })

  test("shows the empty state when there are no recent projects", async () => {
    await renderWithStore(<Welcome />, (api) => {
      api.recentList = []
    })
    assert.ok(screen.getByText("No recent projects"))
    assert.deepEqual(recentNames(), [])
  })

  test("clicking a recent project opens it through the API", async () => {
    const h = await renderWithStore(<Welcome />)
    const user = userEvent.setup()

    await user.click(screen.getByTitle("C:\\Games\\B"))

    await waitFor(() => assert.ok(h.api.calls.includes("openRecent C:\\Games\\B")))
    await waitFor(() => assert.equal(h.store.view.value, "editor"))
    assert.equal(h.store.projectPath.value, "C:\\Games\\B")
  })
})

describe("Welcome over a real store: Open Project and the host's location", () => {
  test("Open Project is enabled when the host is usable, and clicking it opens the dialog", async () => {
    const h = await renderWithStore(<Welcome />)
    const open = screen.getByRole("button", { name: "Open Project" })
    assert.equal((open as HTMLButtonElement).disabled, false)

    await userEvent.setup().click(open)

    await waitFor(() => assert.ok(h.api.calls.includes("openDialog")))
    await waitFor(() => assert.equal(h.store.projectPath.value, "C:\\Games\\C"))
  })

  test("Open Project and the recent projects are disabled while hostLocation.problem is set", async () => {
    const h = await renderWithStore(<Welcome />, (api) => {
      hostAt(api, location({ problem: "N2EditorHost.exe was not found there", canCreate: null }))
    })
    const open = screen.getByRole("button", { name: "Open Project" }) as HTMLButtonElement
    assert.equal(open.disabled, true)
    assert.equal((screen.getByTitle("C:\\Games\\A") as HTMLButtonElement).disabled, true)
    assert.ok(screen.getByText("N2EditorHost.exe was not found there"))

    await userEvent.setup().click(open)
    assert.equal(h.api.calls.includes("openDialog"), false)
    // The list can still be tidied: Remove does not need a usable host
    assert.equal((screen.getByRole("button", { name: "Remove A from the list" }) as HTMLButtonElement).disabled, false)
  })

  test("Open Project is disabled when no host is set, and the line says so", async () => {
    await renderWithStore(<Welcome />, (api) => {
      hostAt(api, location({ path: null, source: null, canCreate: null }))
    })
    assert.equal((screen.getByRole("button", { name: "Open Project" }) as HTMLButtonElement).disabled, true)
    assert.ok(screen.getByText(/N2EditorHost isn't set/))
  })

  test("a problem arriving later disables Open Project, and clearing it enables it again", async () => {
    const h = await renderWithStore(<Welcome />)
    const open = () => screen.getByRole("button", { name: "Open Project" }) as HTMLButtonElement
    assert.equal(open().disabled, false)

    hostAt(h.api, location({ problem: "Not a valid N2EditorHost" }))
    await h.store.refreshHostLocation()
    await waitFor(() => assert.equal(open().disabled, true))

    hostAt(h.api, location({}))
    await h.store.refreshHostLocation()
    await waitFor(() => assert.equal(open().disabled, false))
  })
})

describe("Welcome over a real store: recent remotes", () => {
  const showRemote = async (): Promise<void> => {
    await userEvent.setup().click(screen.getByRole("tab", { name: "Remote engine" }))
    await screen.findByPlaceholderText("user@host")
  }

  test("lists the recent remotes on the SSH form, and picking one fills the form", async () => {
    await renderWithStore(<Welcome />, (api) => {
      api.remoteRecent = [
        { target: "me@cloud", hostPort: 7000 },
        { target: "dev@lab", hostPort: 7100, sshPort: 2222, identityFile: "~/.ssh/lab" },
      ]
    })
    await showRemote()
    assert.deepEqual(recentNames(), ["me@cloud", "dev@lab"])

    await userEvent.setup().click(screen.getByTitle("~/.ssh/lab"))

    assert.equal((screen.getByPlaceholderText("user@host") as HTMLInputElement).value, "dev@lab")
    assert.equal((screen.getByPlaceholderText("22") as HTMLInputElement).value, "2222")
    assert.equal((screen.getByPlaceholderText("~/.ssh/id_ed25519") as HTMLInputElement).value, "~/.ssh/lab")
  })

  test("Remove takes a recent remote off the list, through the API", async () => {
    const h = await renderWithStore(<Welcome />, (api) => {
      api.remoteRecent = [
        { target: "me@cloud", hostPort: 7000 },
        { target: "dev@lab", hostPort: 7100 },
      ]
    })
    await showRemote()

    await userEvent.setup().click(screen.getByRole("button", { name: "Remove me@cloud from the list" }))

    await waitFor(() => assert.deepEqual(recentNames(), ["dev@lab"]))
    assert.deepEqual(
      h.api.remoteRecent.map((r) => r.target),
      ["dev@lab"]
    )
    assert.deepEqual(
      h.store.recentRemotes.value.map((r) => r.target),
      ["dev@lab"]
    )
    assert.ok(within(document.querySelector(".recent") as HTMLElement).getByText("dev@lab"))
  })

  test("with no recent remotes the list is not shown", async () => {
    await renderWithStore(<Welcome />, (api) => {
      api.remoteRecent = []
    })
    await showRemote()
    assert.equal(screen.queryByText("Recent Remotes"), null)
  })
})
