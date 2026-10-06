// Regenerates src/protocol.generated.ts from the engine's protocol.json with the engine's own TypeScript generator.
// The generator writes into the engine repo by default, so this imports it and points its output here instead.
//
// Usage: npm run sync-protocol [-- <path to the N2Engine repo>]  (default: N2ENGINE_DIR, else ../N2Engine)
// Python: PYTHON if set, else python (python3 off Windows), falling back to the py launcher on Windows
const { spawnSync } = require("child_process")
const path = require("path")
const fs = require("fs")

const engineDir = path.resolve(process.argv[2] || process.env.N2ENGINE_DIR || path.join(__dirname, "..", "..", "N2Engine"))
const generatorsDir = path.join(engineDir, "editor-server", "protocol", "generators")
const outputPath = path.resolve(__dirname, "..", "src", "protocol.generated.ts")

if (!fs.existsSync(path.join(generatorsDir, "generate_typescript.py"))) {
  console.error(`No TypeScript generator in ${generatorsDir} (pass the N2Engine repo path, or set N2ENGINE_DIR)`)
  process.exit(1)
}

// The generator writes the platform's line endings; keep the committed file's (CRLF), so a sync on any OS
// changes only what the protocol changed
const crlf = !fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf-8").includes("\r\n")

const code = [
  "import sys",
  "from pathlib import Path",
  "sys.path.insert(0, sys.argv[1])",
  "import generate_typescript as g",
  "g.OUTPUT_PATH = Path(sys.argv[2])",
  "g.generate()",
].join("\n")

const candidates = process.env.PYTHON
  ? [[process.env.PYTHON]]
  : process.platform === "win32"
    ? [["python"], ["py", "-3"]]
    : [["python3"], ["python"]]

// Exit code 9009 is Windows' "command not found", which the Microsoft Store's python alias stub also returns
const NotFound = 9009

let result = null
for (const [command, ...args] of candidates) {
  // -B: leave no __pycache__ in the engine repo
  result = spawnSync(command, [...args, "-B", "-c", code, generatorsDir, outputPath], { stdio: "inherit" })
  if (!result.error && result.status !== NotFound) break
  console.warn(`${[command, ...args].join(" ")} isn't available${result.error ? `: ${result.error.message}` : ""}`)
  result = null
}

if (result === null) {
  console.error("No Python found (set PYTHON to its path)")
  process.exit(1)
}
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

const generated = fs.readFileSync(outputPath, "utf-8").replace(/\r\n/g, "\n")
fs.writeFileSync(outputPath, crlf ? generated.replace(/\n/g, "\r\n") : generated)
