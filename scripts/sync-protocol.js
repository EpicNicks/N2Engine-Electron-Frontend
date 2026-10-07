// Regenerates the protocol files from the engine's protocol.json, so neither is edited by hand:
// - src/protocol/protocol.generated.ts: the engine's TypeScript generator (ids, types and codecs), run with --out
// - src/protocol/test-vectors.json: the engine's golden vectors, copied (the codec tests check the codecs against them)
// CI runs this against the engine commit in engine-ref.txt and fails if either file changes.
//
// Usage: npm run sync-protocol [-- <path to the N2Engine repo>]  (default: N2ENGINE_DIR, else ../N2Engine)
// Python: PYTHON if set, else python (python3 off Windows), falling back to the py launcher on Windows
const { spawnSync } = require("child_process")
const path = require("path")
const fs = require("fs")

const engineDir = path.resolve(process.argv[2] || process.env.N2ENGINE_DIR || path.join(__dirname, "..", "..", "N2Engine"))
const protocolDir = path.join(engineDir, "editor-server", "protocol")
const generator = path.join(protocolDir, "generators", "generate_typescript.py")
const vectorsSource = path.join(protocolDir, "test-vectors.json")

const outputDir = path.resolve(__dirname, "..", "src", "protocol")
const codecsPath = path.join(outputDir, "protocol.generated.ts")
const vectorsPath = path.join(outputDir, "test-vectors.json")

for (const required of [generator, vectorsSource]) {
  if (!fs.existsSync(required)) {
    console.error(`No ${path.basename(required)} in ${path.dirname(required)} (pass the N2Engine repo path, or set N2ENGINE_DIR)`)
    process.exit(1)
  }
}

/**
 * Writes text with the line endings the file already has (LF for a new file), so a sync on any OS changes only what
 * the protocol changed: git may have checked the file out with either
 */
function writeKeepingLineEndings(file, text) {
  const crlf = fs.existsSync(file) && fs.readFileSync(file, "utf-8").includes("\r\n")
  const lf = text.replace(/\r\n/g, "\n")
  const wanted = crlf ? lf.replace(/\n/g, "\r\n") : lf
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf-8") !== wanted) {
    fs.writeFileSync(file, wanted)
  }
}

const candidates = process.env.PYTHON
  ? [[process.env.PYTHON]]
  : process.platform === "win32"
    ? [["python"], ["py", "-3"]]
    : [["python3"], ["python"]]

// Exit code 9009 is Windows' "command not found", which the Microsoft Store's python alias stub also returns
const NotFound = 9009

// The generator writes LF, and leaves a file alone whose content is unchanged (ignoring line endings)
let result = null
for (const [command, ...args] of candidates) {
  // -B: leave no __pycache__ in the engine repo
  result = spawnSync(command, [...args, "-B", generator, "--out", codecsPath], { stdio: "inherit" })
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

writeKeepingLineEndings(codecsPath, fs.readFileSync(codecsPath, "utf-8"))
writeKeepingLineEndings(vectorsPath, fs.readFileSync(vectorsSource, "utf-8"))
console.log(`Copied ${vectorsSource} to ${vectorsPath}`)
