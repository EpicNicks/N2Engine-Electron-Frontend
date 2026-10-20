// The tool list an agent sees is pinned to mcp/tool-schemas.golden.json: any change to a name, description, schema or
// annotation fails here until the file is regenerated (npm run mcp:golden) and the diff is reviewed and committed.
import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { currentToolSchemas, goldenText } from "../src/golden-gen"

// The bundled test is dist/mcp-test/golden.test.mjs: the repository is two folders up
const here = path.dirname(fileURLToPath(import.meta.url))

test("the live tool list equals mcp/tool-schemas.golden.json (npm run mcp:golden to change it on purpose)", async () => {
  const file = path.join(here, "..", "..", "mcp", "tool-schemas.golden.json")
  // A checkout with CRLF line endings (git's autocrlf) is the same file
  const onDisk = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")
  const live = goldenText(await currentToolSchemas())
  assert.equal(
    live,
    onDisk,
    "the tools' schemas changed: run `npm run mcp:golden`, review the diff of mcp/tool-schemas.golden.json, commit it"
  )
})

test("the golden file lists the tools in order, the error codes and the spec revisions", () => {
  const file = path.join(here, "..", "..", "mcp", "tool-schemas.golden.json")
  const golden = JSON.parse(fs.readFileSync(file, "utf8")) as { tools: Array<{ name: string }>; errorCodes: string[]; specRevisions: string[] }
  assert.equal(golden.tools.length, 11)
  assert.ok(golden.tools.every((t) => /^n2_[a-z_]+$/.test(t.name)))
  assert.ok(golden.errorCodes.includes("forbidden") && golden.errorCodes.includes("read_only") && golden.errorCodes.includes("busy"))
  assert.deepEqual(golden.specRevisions, ["2026-07-28", "2025-11-25"])
})
