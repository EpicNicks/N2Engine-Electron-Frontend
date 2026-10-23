// Regenerate the Lua completion data from the same immutable engine ref as the protocol.
const fs = require("node:fs")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const { parseLuaApi } = require("./lua-api-index")
const root = path.resolve(__dirname, "..")
const engine = path.resolve(process.argv[2] || process.env.N2ENGINE_DIR || path.join(root, "..", "N2Engine"))
const ref = fs.readFileSync(path.join(root, "engine-ref.txt"), "utf8").trim()
if (!/^[0-9a-f]{40}$/i.test(ref)) throw new Error("engine-ref.txt must contain one immutable 40-character commit")
function read(file, optional = false) {
  if (optional) {
    const exists = spawnSync("git", ["-C", engine, "ls-tree", "--name-only", ref, "--", file], { encoding: "utf8" })
    if (exists.status !== 0) throw new Error(`Cannot inspect pinned engine: ${exists.stderr}`)
    if (!exists.stdout.trim()) return { available: false, classes: {}, functions: {}, globals: {}, aliases: {} }
  }
  const result = spawnSync("git", ["-C", engine, "show", `${ref}:${file}`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`Cannot read ${file} at pinned engine ${ref}: ${result.stderr || result.error}`)
  return { available: true, ...parseLuaApi(result.stdout) }
}
const index = { version: 1, engineRef: ref,
  runtime: read("engine/src/scripting/bindings/engine-api.lua"),
  editor: read("editor-server/editor-api.lua", true) }
const output = path.join(root, "src", "renderer", "lua", "lua-api.generated.json")
fs.mkdirSync(path.dirname(output), { recursive: true })
const text = JSON.stringify(index, null, 2) + "\n"
if (!fs.existsSync(output) || fs.readFileSync(output, "utf8").replace(/\r\n/g, "\n") !== text) fs.writeFileSync(output, text)
console.log(`Generated Lua API index from ${ref}`)
