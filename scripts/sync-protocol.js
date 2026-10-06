// Regenerates src/protocol.generated.ts from the engine's protocol.json with the engine's own TypeScript generator.
// The generator writes into the engine repo by default, so this imports it and points its output here instead.
//
// Usage: npm run sync-protocol [-- <path to the N2Engine repo>]  (default: N2ENGINE_DIR, else ../N2Engine)
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

const code = [
  "import sys",
  "from pathlib import Path",
  "sys.path.insert(0, sys.argv[1])",
  "import generate_typescript as g",
  "g.OUTPUT_PATH = Path(sys.argv[2])",
  "g.generate()",
].join("\n")

const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3")
// -B: leave no __pycache__ in the engine repo
const result = spawnSync(python, ["-B", "-c", code, generatorsDir, outputPath], { stdio: "inherit" })
if (result.error) {
  console.error(`Failed to run ${python}:`, result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
