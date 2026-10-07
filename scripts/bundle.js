// Bundles the page script and the preload into dist/bundle. Both run where require() can't load our modules: the
// page is a plain browser context, and a sandboxed preload can require only "electron".
const esbuild = require("esbuild")
const path = require("path")

const root = path.join(__dirname, "..")

const common = {
  bundle: true,
  sourcemap: "linked",
  target: "chrome130",
  logLevel: "warning",
  absWorkingDir: root,
}

Promise.all([
  esbuild.build({
    ...common,
    entryPoints: ["src/renderer/renderer.ts"],
    outfile: "dist/bundle/renderer.js",
    platform: "browser",
    format: "iife",
  }),
  esbuild.build({
    ...common,
    entryPoints: ["src/preload/preload.ts"],
    outfile: "dist/bundle/preload.js",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
]).catch(() => process.exit(1))
