import { useLayoutEffect, useRef, useState } from "preact/hooks"
import { Compartment, EditorState, Transaction } from "@codemirror/state"
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view"
import { bracketMatching, defaultHighlightStyle, indentOnInput, StreamLanguage, syntaxHighlighting } from "@codemirror/language"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search"
import { autocompletion, completionKeymap } from "@codemirror/autocomplete"
import { hoverTooltip } from "@codemirror/view"
import { lintGutter, setDiagnostics } from "@codemirror/lint"
import { json } from "@codemirror/lang-json"
import { lua } from "@codemirror/legacy-modes/mode/lua"
import { indexForPath, luaCompletions, luaHover } from "./lua/lua-intelligence"
import { LuaSyntaxChecker, LuaSyntaxScheduler } from "./lua/lua-syntax"

export interface ScriptEditorProps {
  path: string
  text: string
  readOnly: boolean
  onChange(text: string): void
  /** Omitted until an EN1-capable host is connected. Syntax checks remain permitted in read-only mode. */
  checkSyntax?: LuaSyntaxChecker
}
const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "#1e1e1e", color: "#d4d4d4", fontSize: "13px" },
  ".cm-scroller": { overflow: "auto", fontFamily: "Consolas, Monaco, 'Courier New', monospace", lineHeight: "1.5" },
  ".cm-content": { padding: "8px 0", minHeight: "100%" },
  ".cm-gutters": { backgroundColor: "#252526", color: "#858585", borderRight: "1px solid #333" },
  ".cm-activeLineGutter, .cm-activeLine": { backgroundColor: "#ffffff0a" },
  ".cm-cursor": { borderLeftColor: "#d4d4d4" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "#264f78" },
  ".cm-panels": { backgroundColor: "#252526", color: "#ddd" },
  ".cm-tooltip": { backgroundColor: "#252526", color: "#ddd", border: "1px solid #555" },
  ".n2-lua-hover": { padding: "8px", maxWidth: "480px", whiteSpace: "pre-wrap" },
  ".n2-lua-hover pre": { margin: "0 0 4px", fontFamily: "inherit", color: "#9cdcfe" },
}, { dark: true })

function language(path: string) {
  if (/\.lua$/i.test(path)) {
    const index = indexForPath(path)
    return [StreamLanguage.define(lua), autocompletion({ override: [context => {
      const result = luaCompletions(context.state.doc.toString(), context.pos, index, context.explicit)
      return result ? { ...result, validFor: /^[A-Za-z_]\w*$/ } : null
    }] }), hoverTooltip((view, pos) => {
      const result = luaHover(view.state.doc.toString(), pos, index)
      if (!result) return null
      return { pos: result.from, end: result.to, create() {
        const dom = document.createElement("div"); dom.className = "n2-lua-hover"
        const signature = document.createElement("pre"); signature.textContent = result.title
        const description = document.createElement("div"); description.textContent = result.description
        dom.append(signature, description)
        return { dom }
      } }
    })]
  }
  return /\.(json|scene|mat|n2proj)$/i.test(path) ? [json()] : []
}

/** CodeMirror is a view of AssetsState's LF text. Saving, conflicts, tabs and line endings stay in AssetsState. */
export function ScriptEditor(props: ScriptEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef(props); latest.current = props
  const controller = useRef<{ view: EditorView; writable: Compartment; scheduler: LuaSyntaxScheduler | null } | null>(null)
  const [syntaxStatus, setSyntaxStatus] = useState("")
  useLayoutEffect(() => {
    if (!host.current) return
    setSyntaxStatus("")
    const writable = new Compartment()
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: latest.current.text, extensions: [
      lineNumbers(), highlightActiveLineGutter(), history(), drawSelection(), highlightActiveLine(),
      indentOnInput(), bracketMatching(), syntaxHighlighting(defaultHighlightStyle), highlightSelectionMatches(),
      keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
      EditorState.tabSize.of(4), theme, ...language(latest.current.path), lintGutter(),
      writable.of([EditorState.readOnly.of(latest.current.readOnly), EditorView.editable.of(!latest.current.readOnly)]),
      EditorView.contentAttributes.of({ "aria-label": latest.current.path.split("/").at(-1) ?? latest.current.path, spellcheck: "false" }),
      EditorView.updateListener.of(update => {
        if (update.docChanged && update.state.doc.toString() !== latest.current.text)
          latest.current.onChange(update.state.doc.toString())
      }),
    ] }) })
    controller.current = { view, writable, scheduler: null }
    return () => {
      controller.current?.scheduler?.dispose()
      view.destroy(); controller.current = null
    }
  }, [props.path])
  useLayoutEffect(() => {
    const current = controller.current
    if (!current) return
    if (current.view.state.doc.toString() !== props.text)
      current.view.dispatch({ changes: { from: 0, to: current.view.state.doc.length, insert: props.text },
        annotations: Transaction.addToHistory.of(false) })
    current.view.dispatch({ effects: current.writable.reconfigure([
      EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly),
      EditorView.contentAttributes.of({ "aria-readonly": String(props.readOnly) }),
    ]) })
  }, [props.text, props.readOnly, props.path])
  useLayoutEffect(() => {
    const current = controller.current
    if (!current) return
    if (!props.checkSyntax || !/\.lua$/i.test(props.path)) {
      current.view.dispatch(setDiagnostics(current.view.state, [])); setSyntaxStatus(""); return
    }
    const scheduler = new LuaSyntaxScheduler((text, name) => latest.current.checkSyntax!(text, name), (diagnostics, error) => {
      current.view.dispatch(setDiagnostics(current.view.state, diagnostics))
      setSyntaxStatus(error ?? (diagnostics.length ? `${diagnostics.length} syntax error` : ""))
    })
    current.scheduler = scheduler
    return () => { scheduler.dispose(); current.scheduler = null }
  }, [!!props.checkSyntax, props.path])
  useLayoutEffect(() => {
    controller.current?.scheduler?.update(props.text, props.path)
  }, [props.text, props.path, !!props.checkSyntax])
  return <div class="script-editor-wrap">
    <div class="script-editor" ref={host} />
    {syntaxStatus && <div class="script-syntax-status" role="status">{syntaxStatus}</div>}
  </div>
}
