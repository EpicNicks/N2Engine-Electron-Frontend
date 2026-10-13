import "./setup"
import { test } from "node:test"
import * as assert from "node:assert/strict"
import { screen } from "@testing-library/preact"
import userEvent from "@testing-library/user-event"
import type { FieldSchema } from "../protocol/protocol.generated"
import { FieldEditor } from "../renderer/inspector-editors"
import { PassListTypeName, TextPass, addPass } from "../renderer/inspector-fields"
import { renderWithApp } from "./helpers"

// PassListEditor is not exported: it is reached the way the inspector reaches it, through FieldEditor, by the type
const field: FieldSchema = {
  name: "passes",
  displayName: "Passes",
  kind: "Json",
  typeName: PassListTypeName,
  hidden: false,
  readOnly: false,
}

const first: TextPass = addPass([])[0]
const second: TextPass = { ...first, width: 2 }
const third: TextPass = { ...first, width: 3 }

interface Committed {
  value: unknown
  immediate: boolean
}

function renderField(value: unknown, disabled = false) {
  const commits: Committed[] = []
  renderWithApp(
    <FieldEditor
      field={field}
      value={value}
      disabled={disabled}
      commit={(v, immediate) => commits.push({ value: v, immediate })}
      invalid={() => {}}
    />
  )
  return { commits, user: userEvent.setup() }
}

const widths = (value: unknown) => (value as TextPass[]).map((p) => p.width)

test("Move down commits the reordered array, at once", async () => {
  const { commits, user } = renderField([first, second, third])
  await user.click(screen.getAllByLabelText("Move down")[0])
  assert.equal(commits.length, 1)
  assert.deepEqual(widths(commits[0].value), [2, 0, 3])
  assert.equal(commits[0].immediate, true)
})

test("the first Move up and the last Move down are disabled", async () => {
  const { commits, user } = renderField([first, second, third])
  const up = screen.getAllByLabelText("Move up") as HTMLButtonElement[]
  const down = screen.getAllByLabelText("Move down") as HTMLButtonElement[]
  assert.deepEqual(up.map((b) => b.disabled), [true, false, false])
  assert.deepEqual(down.map((b) => b.disabled), [false, false, true])
  await user.click(up[0])
  await user.click(down[2])
  assert.equal(commits.length, 0)
  await user.click(up[1])
  assert.deepEqual(widths(commits[0].value), [2, 0, 3])
})

test("Remove commits the array without that pass", async () => {
  const { commits, user } = renderField([first, second, third])
  await user.click(screen.getAllByLabelText("Remove the pass")[1])
  assert.equal(commits.length, 1)
  assert.deepEqual(widths(commits[0].value), [0, 3])
})

test("Add pass commits the whole array with a default pass added", async () => {
  const { commits, user } = renderField([first, second])
  await user.click(screen.getByText("Add pass"))
  assert.equal(commits.length, 1)
  assert.deepEqual(commits[0].value, [first, second, addPass([])[0]])
})

test("an empty list says so and can still get a pass", async () => {
  const { commits, user } = renderField([])
  assert.ok(screen.getByText("No passes"))
  await user.click(screen.getByText("Add pass"))
  assert.deepEqual(commits[0].value, [addPass([])[0]])
})

test("disabled hides the buttons", () => {
  renderField([first, second], true)
  assert.equal(screen.queryAllByLabelText("Move up").length, 0)
  assert.equal(screen.queryAllByLabelText("Move down").length, 0)
  assert.equal(screen.queryAllByLabelText("Remove the pass").length, 0)
  assert.equal(screen.queryByText("Add pass"), null)
})

test("a value that is not a pass list falls back to the JSON editor", () => {
  renderField({ not: "a list" })
  assert.equal(screen.queryByText("Add pass"), null)
  assert.equal(screen.queryAllByLabelText("Move up").length, 0)
  assert.ok(screen.getByRole("textbox"))
})
