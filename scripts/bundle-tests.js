// Bundles the DOM tests (src/test-dom/*.test.tsx) into dist/test-dom for node --test. The tests import the page's
// components (.tsx), which tsc does not compile (tsconfig.json excludes them), so esbuild does it, the same way as for
// the page (scripts/bundle.js): our sources are inlined, npm packages stay external and are loaded from node_modules.
const esbuild = require("esbuild")
const fs = require("fs")
const path = require("path")

const root = path.join(__dirname, "..")
const outdir = path.join(root, "dist", "test-dom")
const testsDir = path.join(root, "src", "test-dom")

// A test deleted from src is not left behind in dist
fs.rmSync(outdir, { recursive: true, force: true })

const entryPoints = fs
  .readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.tsx") || name.endsWith(".test.ts"))
  .map((name) => path.join("src", "test-dom", name))

esbuild
  .build({
    entryPoints,
    outdir,
    absWorkingDir: root,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    jsxImportSource: "preact",
    sourcemap: "linked",
    logLevel: "warning",
  })
  .catch(() => process.exit(1))
