// Bundles the n2-mcp bridge (mcp/src/main.ts) into ONE file, dist/n2-mcp.mjs, which runs with plain Node >= 22 and needs
// no node_modules (the MCP SDK and zod are inlined). With --tests it bundles the bridge's tests (mcp/test/*.test.ts)
// into dist/mcp-test/*.test.mjs for node --test instead. The Electron app's build (tsc, scripts/bundle.js) doesn't touch
// mcp/ and this doesn't touch the app: they only share src/protocol and src/main/host-launcher.ts, which are Node-only.
const esbuild = require("esbuild")
const fs = require("fs")
const path = require("path")

const root = path.join(__dirname, "..")

// ESM output; a dependency's own require() of a Node built-in goes through this
const requireShim = "import { createRequire as __n2CreateRequire } from 'node:module'; const require = __n2CreateRequire(import.meta.url);"

const common = {
  absWorkingDir: root,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
  legalComments: "none",
}

async function main() {
  if (process.argv.includes("--tests")) {
    const outdir = path.join(root, "dist", "mcp-test")
    // A test deleted from mcp/test is not left behind in dist
    fs.rmSync(outdir, { recursive: true, force: true })
    const testsDir = path.join(root, "mcp", "test")
    const entryPoints = fs
      .readdirSync(testsDir)
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => path.join("mcp", "test", name))
    await esbuild.build({
      ...common,
      entryPoints,
      outdir,
      outExtension: { ".js": ".mjs" },
      banner: { js: requireShim },
      sourcemap: "linked",
    })
    return
  }
  await esbuild.build({
    ...common,
    entryPoints: ["mcp/src/main.ts"],
    outfile: "dist/n2-mcp.mjs",
    banner: { js: "#!/usr/bin/env node\n" + requireShim },
  })
}

main().catch(() => process.exit(1))
