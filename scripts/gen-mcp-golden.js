// Writes mcp/tool-schemas.golden.json: the tool list exactly as an MCP client gets it (tools/list from the real server),
// with keys sorted. The golden test (mcp/test/golden.test.ts) compares the live list with this file, so a change to
// what agents see is a reviewed change: run `npm run mcp:golden`, read the diff, commit it.
const esbuild = require("esbuild")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { pathToFileURL } = require("url")

const root = path.join(__dirname, "..")

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "n2-mcp-golden-"))
  try {
    const out = path.join(temp, "golden-gen.mjs")
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: ["mcp/src/golden-gen.ts"],
      outfile: out,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      logLevel: "warning",
      banner: {
        js: "import { createRequire as __n2CreateRequire } from 'node:module'; const require = __n2CreateRequire(import.meta.url);",
      },
    })
    const { currentToolSchemas, goldenText } = await import(pathToFileURL(out).href)
    const text = goldenText(await currentToolSchemas())
    fs.writeFileSync(path.join(root, "mcp", "tool-schemas.golden.json"), text)
    console.log(`wrote mcp/tool-schemas.golden.json (${text.length} bytes)`)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
