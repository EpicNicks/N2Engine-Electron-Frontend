import generated from "./lua-api.generated.json"

export interface ApiField { name: string; type: string; description: string }
export interface ApiClass { name: string; base?: string; description: string; fields: Record<string, ApiField> }
export interface ApiFunction { name: string; owner?: string; method: boolean; signature: string; description: string;
  params: ApiField[]; returns: { type: string; description: string }[]; overloads: string[] }
export interface ApiIndex { available?: boolean; classes: Record<string, ApiClass>; functions: Record<string, ApiFunction>;
  globals: Record<string, ApiField>; aliases: Record<string, string> }
export interface LuaSuggestion { label: string; type: "class" | "function" | "property" | "keyword"; detail?: string; info?: string }
export interface LuaCompletions { from: number; options: LuaSuggestion[] }
export interface LuaHover { from: number; to: number; title: string; description: string }
export const LuaApi = generated as { version: number; engineRef: string; runtime: ApiIndex; editor: ApiIndex }

/** Extension annotations are kept separate: runtime scripts must never suggest host-only Editor APIs. */
export function indexForPath(path: string): ApiIndex {
  return /(?:^|\/)editor\//i.test(path.replace(/\\/g, "/")) ? LuaApi.editor : LuaApi.runtime
}

const attributes = ["type", "default", "tooltip", "hidden", "readOnly", "min", "max", "options", "assetType", "replicated"]

/** Avoid suggesting engine symbols inside Lua strings and comments, including long-bracket strings/comments. */
export function luaCodeAt(text: string, position: number): boolean {
  let quote = "", longEnd = "", comment = false
  for (let i = 0; i < Math.min(position, text.length); i++) {
    const c = text[i]
    if (longEnd) { if (text.startsWith(longEnd, i)) { i += longEnd.length - 1; longEnd = "" }; continue }
    if (comment) { if (c === "\n") comment = false; continue }
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue }
    const isComment = text.startsWith("--", i)
    const start = i + (isComment ? 2 : 0)
    const match = /^\[(=*)\[/.exec(text.slice(start))
    if (match) { longEnd = `]${match[1]}]`; i = start + match[0].length - 1 }
    else if (isComment) { comment = true; i++ }
    else if (c === '"' || c === "'") quote = c
  }
  return !quote && !longEnd && !comment
}

function selfMembers(text: string, position: number): LuaSuggestion[] {
  const prefix = text.slice(0, position)
  const moduleName = /\breturn\s+([A-Za-z_]\w*)\s*$/.exec(text)?.[1] ?? /\blocal\s+([A-Za-z_]\w*)\s*=\s*\{/.exec(text)?.[1]
  if (!moduleName) return []
  // Recognise the declared behaviour's method shape; v1 deliberately does not infer arbitrary local variables.
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const methods = [...prefix.matchAll(new RegExp(`function\\s+${escaped}[:.]([A-Za-z_]\\w*)\\s*\\([^)]*\\)`, "g"))]
  const latest = methods.at(-1)
  if (!latest) return []
  const after = prefix.slice((latest.index ?? 0) + latest[0].length)
  // Match Lua block boundaries rather than retaining self after a method's closing end.
  let depth = 1, elseif = false
  for (const token of after.matchAll(/\b(function|then|do|repeat|end|until|elseif)\b/g)) {
    if (!luaCodeAt(after, token.index!)) continue
    if (token[1] === "elseif") elseif = true
    else if (token[1] === "then" && elseif) elseif = false
    else if (token[1] === "end" || token[1] === "until") depth--
    else depth++
    if (depth === 0) return []
  }
  const options: LuaSuggestion[] = [{ label: "gameObject", type: "property", detail: "GameObject" }]
  const declaration = new RegExp(`${escaped}\\.SerializableFields\\s*=\\s*\\{`).exec(text)
  if (declaration) {
    let depth = 1, i = declaration.index + declaration[0].length, fieldStart = i
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++
      else if (text[i] === "}") depth--
      if (depth === 1 && (i === fieldStart || text[i - 1] === "," || text[i - 1] === "\n")) {
        const field = /^\s*([A-Za-z_]\w*)\s*=/.exec(text.slice(i))
        if (field) options.push({ label: field[1], type: "property", detail: "Serializable field" })
      }
      i++
    }
  }
  for (const method of text.matchAll(new RegExp(`function\\s+${escaped}[:.]([A-Za-z_]\\w*)\\s*\\(([^)]*)\\)`, "g")))
    options.push({ label: method[1], type: "function", detail: `(${method[2]})` })
  return options
}

export function apiMembers(index: ApiIndex, owner: string): LuaSuggestion[] {
  const fields: Record<string, LuaSuggestion> = {}
  const visited = new Set<string>()
  let name: string | undefined = index.aliases[owner] ?? owner
  while (name && !visited.has(name)) {
    visited.add(name)
    const cls: ApiClass | undefined = index.classes[name]
    if (!cls) break
    for (const [key, field] of Object.entries(cls.fields))
      fields[key] ??= { label: key, type: "property", detail: field.type, info: field.description }
    for (const fn of Object.values(index.functions))
      if (fn.owner === name || fn.owner === owner)
        fields[fn.name.slice(fn.name.lastIndexOf(".") + 1)] ??= functionOption(fn)
    name = cls.base
  }
  for (const fn of Object.values(index.functions))
    if (fn.owner === owner) fields[fn.name.slice(fn.name.lastIndexOf(".") + 1)] ??= functionOption(fn)
  // Namespace tables such as Editor.Scene also appear as members of their parent namespace.
  for (const global of Object.values(index.globals))
    if (global.name.startsWith(owner + ".") && !global.name.slice(owner.length + 1).includes("."))
      fields[global.name.slice(owner.length + 1)] ??= { label: global.name.slice(owner.length + 1), type: "class", detail: global.type }
  return Object.values(fields)
}
function functionOption(fn: ApiFunction): LuaSuggestion {
  return { label: fn.name.slice(fn.name.lastIndexOf(".") + 1), type: "function", detail: fn.signature,
    info: [fn.description, ...fn.overloads].filter(Boolean).join("\n") }
}

export function luaCompletions(text: string, position: number, index: ApiIndex, explicit = false): LuaCompletions | null {
  if (!luaCodeAt(text, position)) return null
  const prefix = text.slice(0, position)
  const member = /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)[.:]([A-Za-z_]\w*)?$/.exec(prefix)
  if (member) {
    const self = member[1] === "self" ? selfMembers(text, position) : null
    const own = self ? (self.length ? [...apiMembers(index, "LuaComponent"), ...self] : []) : apiMembers(index, member[1])
    const unique = [...new Map(own.map(item => [item.label, item])).values()]
    return { from: position - (member[2]?.length ?? 0), options: unique }
  }
  const word = /[A-Za-z_]\w*$/.exec(prefix)
  if (!word && !explicit) return null
  // Inside a SerializableFields value, offer the declaration schema's keys.
  const fieldDeclaration = /\.SerializableFields\s*=\s*\{[\s\S]*$/.exec(prefix)
  if (fieldDeclaration && (fieldDeclaration[0].match(/\{/g)?.length ?? 0) > (fieldDeclaration[0].match(/\}/g)?.length ?? 0))
    return { from: position - (word?.[0].length ?? 0), options: attributes.map(label => ({ label, type: "property", detail: "Field declaration" })) }
  const globals: LuaSuggestion[] = Object.values(index.globals).filter(item => !item.name.includes(".")).map(item =>
    ({ label: item.name, type: "class", detail: item.type, info: item.description }))
  for (const fn of Object.values(index.functions)) if (!fn.owner) globals.push(functionOption(fn))
  return { from: position - (word?.[0].length ?? 0), options: globals }
}

export function luaHover(text: string, position: number, index: ApiIndex): LuaHover | null {
  if (!luaCodeAt(text, position)) return null
  const before = /[\w.:]*$/.exec(text.slice(0, position))?.[0] ?? ""
  const after = /^[\w.:]*/.exec(text.slice(position))?.[0] ?? ""
  const token = (before + after).replace(/:/g, ".")
  const from = position - before.length, to = position + after.length
  const fn = index.functions[token]
  if (fn) return { from, to, title: [fn.signature, ...fn.overloads].join("\n"), description: [fn.description,
    ...fn.params.map(p => `${p.name}: ${p.type}${p.description ? ` — ${p.description}` : ""}`),
    ...fn.returns.map(r => `returns ${r.type}${r.description ? ` — ${r.description}` : ""}`)].filter(Boolean).join("\n") }
  const cls = index.classes[index.aliases[token] ?? token]
  if (cls) return { from, to, title: cls.name, description: cls.description }
  const dot = token.lastIndexOf(".")
  if (dot >= 0) {
    const owner = token.slice(0, dot)
    const self = owner === "self" ? selfMembers(text, position) : null
    const members = self ? (self.length ? [...apiMembers(index, "LuaComponent"), ...self] : []) : apiMembers(index, owner)
    const member = members.find(item => item.label === token.slice(dot + 1))
    if (member) return { from, to, title: `${token}: ${member.detail ?? ""}`, description: member.info ?? "" }
  }
  return null
}
