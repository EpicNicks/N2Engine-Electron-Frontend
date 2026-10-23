function typeAndDescription(text) {
  let depth = 0, quote = ""
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) { if (c === quote && text[i - 1] !== "\\") quote = ""; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if ("<({[".includes(c)) depth++
    if (">)}]".includes(c)) depth--
    if (/\s/.test(c) && depth <= 0) return { type: text.slice(0, i), description: text.slice(i).trim() }
  }
  return { type: text, description: "" }
}

/** Parses declarations only. It does not load or execute Lua and never treats documentation as HTML. */
function parseLuaApi(source) {
  const classes = {}, functions = {}, globals = {}, aliases = {}
  let comments = [], params = [], returns = [], overloads = [], currentClass = null
  const reset = () => { comments = []; params = []; returns = []; overloads = [] }
  for (const raw of source.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim()
    let match
    if ((match = /^---@class\s+([\w.]+)(?:\s*:\s*([\w.]+))?/.exec(line))) {
      currentClass = match[1]
      classes[currentClass] = { name: currentClass, ...(match[2] ? { base: match[2] } : {}), description: comments.join("\n"), fields: {} }
      reset(); continue
    }
    if ((match = /^---@field\s+(?:(?:public|protected|private)\s+)?([\w.]+\??)\s+(.+)/.exec(line))) {
      if (currentClass) classes[currentClass].fields[match[1].replace(/\?$/, "")] = { name: match[1], ...typeAndDescription(match[2]) }
      continue
    }
    if ((match = /^---@param\s+(\S+)\s+(.+)/.exec(line))) { params.push({ name: match[1], ...typeAndDescription(match[2]) }); continue }
    if ((match = /^---@return\s+(.+)/.exec(line))) { returns.push(typeAndDescription(match[1])); continue }
    if ((match = /^---@overload\s+(.+)/.exec(line))) { overloads.push(match[1]); continue }
    if (line.startsWith("---@")) continue
    if (line.startsWith("---")) { comments.push(line.slice(3).trim()); continue }
    if ((match = /^function\s+([\w.:]+)\s*\(([^)]*)\)/.exec(line))) {
      const rawName = match[1], name = rawName.replace(/:/g, "."), dot = name.lastIndexOf(".")
      functions[name] = { name, ...(dot >= 0 ? { owner: name.slice(0, dot) } : {}), method: rawName.includes(":"),
        signature: `${rawName}(${match[2]})`, description: comments.join("\n"), params, returns, overloads }
      reset(); continue
    }
    if ((match = /^([\w.]+)\s*=\s*\{\s*\}/.exec(line))) {
      globals[match[1]] = { name: match[1], type: currentClass || "table", description: comments.join("\n") }
      if (currentClass) aliases[match[1]] = currentClass
      currentClass = null; reset(); continue
    }
    if (line && !line.startsWith("--")) { reset(); currentClass = null }
    if (!line) reset()
  }
  return { classes, functions, globals, aliases }
}

module.exports = { parseLuaApi, typeAndDescription }
