// A regular expression matcher that cannot backtrack: the console's regex filter runs on it, not on the engine's
// RegExp. A pattern is compiled to a small program and run as a Pike VM (a Thompson NFA simulation that keeps every
// live thread at once, in priority order), so a match costs at most (input length x program size) steps whatever the
// pattern is: (a+)+$, ((a+))+ and (a|aa)+$ are as cheap as a literal. The engine's own RegExp is used only to
// validate the syntax (compiling never runs a match); only the features that need backtracking are refused.
//
// Supported (JavaScript syntax without the u flag; the leftmost match with the same preferences as RegExp): literals
// and escapes (\n \t \r \f \v \0 \xHH \uHHHH and the escaped punctuation), . (not a line terminator), classes [a-z^]
// with \d \w \s, \D \W \S, ^ and $ (the whole line), \b and \B, groups (...) and (?:...) (neither captures), | and the
// quantifiers * + ? {n} {n,} {n,m} with the lazy ? form. Refused with a reason: back-references (\1, \k<n>),
// look-ahead and look-behind, named groups, and a pattern that compiles to more than MaxProgram instructions.
// Unlike RegExp, a repeated group that can match the empty string does not stop at its first empty round; the
// matches are the same, only which empty alternative is tried first can differ.

/** The most instructions a pattern may compile to: a counted repeat such as (a{50}){50} is refused rather than expanded */
export const MaxProgram = 600

/** The pattern uses something this matcher does not do; the message says what */
export class UnsupportedPattern extends Error {}

const tooLarge = () =>
  new UnsupportedPattern(`The pattern is too large for the filter (over ${MaxProgram} steps once repeats are counted out)`)

// ---------- Syntax tree ----------

type Ranges = ReadonlyArray<readonly [number, number]>

type Node =
  | { t: "char"; c: number }
  | { t: "any" }
  | { t: "class"; ranges: Ranges; negate: boolean }
  | { t: "assert"; kind: 0 | 1 | 2 | 3 } // bol, eol, word boundary, not a word boundary
  | { t: "cat"; items: Node[] }
  | { t: "alt"; items: Node[] }
  | { t: "rep"; node: Node; min: number; max: number; greedy: boolean }

const DIGIT: Ranges = [[48, 57]]
const WORD: Ranges = [
  [48, 57],
  [65, 90],
  [95, 95],
  [97, 122],
]
const SPACE: Ranges = [
  [9, 13],
  [32, 32],
  [160, 160],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
]

function complement(ranges: Ranges): Ranges {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: Array<[number, number]> = []
  let next = 0
  for (const [lo, hi] of sorted) {
    if (lo > next) out.push([next, lo - 1])
    next = Math.max(next, hi + 1)
  }
  if (next <= 0xffff) out.push([next, 0xffff])
  return out
}

const isHex = (s: string) => /^[0-9a-fA-F]+$/.test(s)

// ---------- Parser ----------

class Parser {
  private at = 0
  constructor(private readonly src: string) {}

  parse(): Node {
    const node = this.alternation()
    if (this.at < this.src.length) throw new UnsupportedPattern("Unexpected character in the pattern")
    return node
  }

  private peek(): string | undefined {
    return this.src[this.at]
  }

  private alternation(): Node {
    const items = [this.sequence()]
    while (this.peek() === "|") {
      this.at++
      items.push(this.sequence())
    }
    return items.length === 1 ? items[0] : { t: "alt", items }
  }

  private sequence(): Node {
    const items: Node[] = []
    for (let c = this.peek(); c !== undefined && c !== "|" && c !== ")"; c = this.peek()) {
      items.push(this.quantified(this.atom()))
    }
    return { t: "cat", items }
  }

  /** The quantifier after an atom, if there is one ({ that is not a quantifier is a literal) */
  private quantified(node: Node): Node {
    const rest = this.src.slice(this.at, this.at + 24)
    let min = -1
    let max = 0
    let length = 1
    const c = rest[0]
    if (c === "*") [min, max] = [0, Infinity]
    else if (c === "+") [min, max] = [1, Infinity]
    else if (c === "?") [min, max] = [0, 1]
    else if (c === "{") {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(rest)
      if (m) {
        min = Number(m[1])
        max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3])
        length = m[0].length
      }
    }
    if (min < 0) return node
    this.at += length
    let greedy = true
    if (this.peek() === "?") {
      greedy = false
      this.at++
    }
    return { t: "rep", node, min, max, greedy }
  }

  private atom(): Node {
    const c = this.src[this.at++]
    switch (c) {
      case "(": {
        if (this.peek() === "?") {
          if (this.src[this.at + 1] === ":") this.at += 2
          else throw new UnsupportedPattern("Look-around and named groups are not supported")
        }
        const inner = this.alternation()
        if (this.peek() !== ")") throw new UnsupportedPattern("Unterminated group")
        this.at++
        return inner
      }
      case "[":
        return this.charClass()
      case ".":
        return { t: "any" }
      case "^":
        return { t: "assert", kind: 0 }
      case "$":
        return { t: "assert", kind: 1 }
      case "\\":
        return this.escape()
      default:
        return { t: "char", c: c.charCodeAt(0) }
    }
  }

  /** After a backslash outside a class */
  private escape(): Node {
    const c = this.src[this.at++]
    if (c === undefined) throw new UnsupportedPattern("A pattern cannot end in a backslash")
    if (c === "b") return { t: "assert", kind: 2 }
    if (c === "B") return { t: "assert", kind: 3 }
    if (c === "k" || (c >= "1" && c <= "9")) throw new UnsupportedPattern("Back-references are not supported")
    const set = this.classEscape(c)
    if (set) return { t: "class", ranges: set, negate: false }
    return { t: "char", c: this.charEscape(c) }
  }

  /** \d \D \w \W \s \S as ranges, or null for any other escape letter */
  private classEscape(c: string): Ranges | null {
    switch (c) {
      case "d":
        return DIGIT
      case "D":
        return complement(DIGIT)
      case "w":
        return WORD
      case "W":
        return complement(WORD)
      case "s":
        return SPACE
      case "S":
        return complement(SPACE)
      default:
        return null
    }
  }

  /** The character an escape stands for (c is the letter after the backslash, already consumed) */
  private charEscape(c: string): number {
    switch (c) {
      case "n":
        return 10
      case "r":
        return 13
      case "t":
        return 9
      case "f":
        return 12
      case "v":
        return 11
      case "0":
        return 0
      case "x": {
        const h = this.src.slice(this.at, this.at + 2)
        if (h.length === 2 && isHex(h)) {
          this.at += 2
          return parseInt(h, 16)
        }
        return 120
      }
      case "u": {
        const h = this.src.slice(this.at, this.at + 4)
        if (h.length === 4 && isHex(h)) {
          this.at += 4
          return parseInt(h, 16)
        }
        return 117
      }
      case "c": {
        const l = this.src[this.at]
        if (l !== undefined && /[A-Za-z]/.test(l)) {
          this.at++
          return l.charCodeAt(0) % 32
        }
        throw new UnsupportedPattern("Unsupported escape \\c")
      }
      default:
        return c.charCodeAt(0)
    }
  }

  /** After the [ */
  private charClass(): Node {
    let negate = false
    if (this.peek() === "^") {
      negate = true
      this.at++
    }
    const ranges: Array<readonly [number, number]> = []
    for (;;) {
      if (this.at >= this.src.length) throw new UnsupportedPattern("Unterminated character class")
      if (this.peek() === "]") {
        this.at++
        return { t: "class", ranges, negate }
      }
      const first = this.classAtom()
      if (this.peek() === "-" && this.at + 1 < this.src.length && this.src[this.at + 1] !== "]") {
        const save = this.at
        this.at++
        const second = this.classAtom()
        if (typeof first === "number" && typeof second === "number") {
          if (second < first) throw new UnsupportedPattern("Range out of order in character class")
          ranges.push([first, second])
          continue
        }
        // A class escape on either side makes the - a literal (Annex B): read again from the dash
        this.at = save
      }
      if (typeof first === "number") ranges.push([first, first])
      else ranges.push(...first)
    }
  }

  /** One member of a class: a character code, or the ranges of \d, \w, \s and their negations */
  private classAtom(): number | Ranges {
    const c = this.src[this.at++]
    if (c !== "\\") return c.charCodeAt(0)
    const e = this.src[this.at++]
    if (e === undefined) throw new UnsupportedPattern("A pattern cannot end in a backslash")
    if (e === "b") return 8
    if (e === "-") return 45
    const set = this.classEscape(e)
    if (set) return set
    return this.charEscape(e)
  }
}

// ---------- Program ----------

const OpChar = 0
const OpAny = 1
const OpClass = 2
const OpSplit = 3
const OpJmp = 4
const OpAssert = 5
const OpMatch = 6

interface Inst {
  op: number
  /** Char: the code (case folded when ignoring case); Split and Jmp: the first target; Assert: its kind */
  x: number
  /** Split: the second target */
  y: number
  ranges?: Ranges
  negate?: boolean
}

export interface Program {
  insts: Inst[]
  ignoreCase: boolean
}

/** What RegExp treats as the same letter without the u flag: the upper case form when it is a single character */
function canon(ch: number): number {
  if (ch < 128) return ch >= 97 && ch <= 122 ? ch - 32 : ch
  const up = String.fromCharCode(ch).toUpperCase()
  if (up.length !== 1) return ch
  const u = up.charCodeAt(0)
  return u < 128 ? ch : u
}

function emit(node: Node, insts: Inst[], ignoreCase: boolean): void {
  const push = (inst: Inst): number => {
    if (insts.length >= MaxProgram) throw tooLarge()
    return insts.push(inst) - 1
  }
  switch (node.t) {
    case "char":
      push({ op: OpChar, x: ignoreCase ? canon(node.c) : node.c, y: 0 })
      return
    case "any":
      push({ op: OpAny, x: 0, y: 0 })
      return
    case "class":
      push({ op: OpClass, x: 0, y: 0, ranges: node.ranges, negate: node.negate })
      return
    case "assert":
      push({ op: OpAssert, x: node.kind, y: 0 })
      return
    case "cat":
      for (const item of node.items) emit(item, insts, ignoreCase)
      return
    case "alt": {
      const jumps: number[] = []
      node.items.forEach((item, i) => {
        if (i < node.items.length - 1) {
          const split = push({ op: OpSplit, x: 0, y: 0 })
          insts[split].x = insts.length
          emit(item, insts, ignoreCase)
          jumps.push(push({ op: OpJmp, x: 0, y: 0 }))
          insts[split].y = insts.length
        } else emit(item, insts, ignoreCase)
      })
      for (const j of jumps) insts[j].x = insts.length
      return
    }
    case "rep": {
      const { min, max, greedy } = node
      for (let i = 0; i < min; i++) emit(node.node, insts, ignoreCase)
      if (max === Infinity) {
        const split = push({ op: OpSplit, x: 0, y: 0 })
        const body = insts.length
        emit(node.node, insts, ignoreCase)
        push({ op: OpJmp, x: split, y: 0 })
        const after = insts.length
        insts[split].x = greedy ? body : after
        insts[split].y = greedy ? after : body
      } else {
        const splits: number[] = []
        for (let i = min; i < max; i++) {
          splits.push(push({ op: OpSplit, x: 0, y: 0 }))
          emit(node.node, insts, ignoreCase)
        }
        const after = insts.length
        for (const split of splits) {
          // The body of each optional copy follows its split
          insts[split].x = greedy ? split + 1 : after
          insts[split].y = greedy ? after : split + 1
        }
      }
      return
    }
  }
}

/** Compiles a pattern. Throws UnsupportedPattern for what this matcher does not do (the syntax is validated by the caller) */
export function compileProgram(source: string, ignoreCase: boolean): Program {
  const tree = new Parser(source).parse()
  const insts: Inst[] = []
  emit(tree, insts, ignoreCase)
  if (insts.length >= MaxProgram) throw tooLarge()
  insts.push({ op: OpMatch, x: 0, y: 0 })
  return { insts, ignoreCase }
}

// ---------- Matching ----------

function inRanges(ranges: Ranges, ch: number): boolean {
  for (const [lo, hi] of ranges) if (ch >= lo && ch <= hi) return true
  return false
}

function classMatches(inst: Inst, ch: number, ignoreCase: boolean): boolean {
  const ranges = inst.ranges as Ranges
  let found = inRanges(ranges, ch)
  if (!found && ignoreCase) {
    const up = canon(ch)
    found = up !== ch && inRanges(ranges, up)
    if (!found) {
      const low = String.fromCharCode(ch).toLowerCase()
      found = low.length === 1 && low.charCodeAt(0) !== ch && inRanges(ranges, low.charCodeAt(0))
    }
  }
  return found !== inst.negate
}

const isWordCode = (ch: number) =>
  (ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || ch === 95 || (ch >= 97 && ch <= 122)

const isLineTerminator = (ch: number) => ch === 10 || ch === 13 || ch === 0x2028 || ch === 0x2029

interface ThreadList {
  pcs: Int32Array
  starts: Int32Array
  n: number
}

/**
 * The leftmost match of the program in the text starting at or after `from`, as [start, end) (the first one found
 * when `firstOnly`, which is enough to know that there is one); null when there is none. At most
 * (text length x program size) steps, however the pattern is built.
 */
export function exec(program: Program, text: string, from = 0, firstOnly = false): [number, number] | null {
  const { insts, ignoreCase } = program
  const n = text.length
  const size = insts.length
  const mark = new Int32Array(size).fill(-1)
  let gen = 0
  const newList = (): ThreadList => ({ pcs: new Int32Array(size), starts: new Int32Array(size), n: 0 })
  let clist = newList()
  let nlist = newList()
  let best: [number, number] | null = null

  // Adds the thread at pc and what it reaches without reading a character (once per list: that is what bounds the work)
  const add = (l: ThreadList, pc: number, start: number, pos: number): void => {
    if (mark[pc] === gen) return
    mark[pc] = gen
    const inst = insts[pc]
    if (inst.op === OpJmp) add(l, inst.x, start, pos)
    else if (inst.op === OpSplit) {
      add(l, inst.x, start, pos)
      add(l, inst.y, start, pos)
    } else if (inst.op === OpAssert) {
      let ok: boolean
      if (inst.x === 0) ok = pos === 0
      else if (inst.x === 1) ok = pos === n
      else {
        const before = pos > 0 && isWordCode(text.charCodeAt(pos - 1))
        const after = pos < n && isWordCode(text.charCodeAt(pos))
        ok = inst.x === 2 ? before !== after : before === after
      }
      if (ok) add(l, pc + 1, start, pos)
    } else {
      l.pcs[l.n] = pc
      l.starts[l.n] = start
      l.n++
    }
  }

  gen++
  for (let pos = from; pos <= n; pos++) {
    // A thread that starts here has the lowest priority: it goes after everything already running
    if (best === null) add(clist, 0, pos, pos)
    if (clist.n === 0 && best !== null) break
    const ch = pos < n ? text.charCodeAt(pos) : -1
    gen++
    nlist.n = 0
    for (let i = 0; i < clist.n; i++) {
      const pc = clist.pcs[i]
      const start = clist.starts[i]
      const inst = insts[pc]
      if (inst.op === OpMatch) {
        best = [start, pos]
        if (firstOnly) return best
        break // the threads after this one are less preferred than the match
      }
      if (ch < 0) continue
      let ok: boolean
      if (inst.op === OpChar) ok = ignoreCase ? canon(ch) === inst.x : ch === inst.x
      else if (inst.op === OpAny) ok = !isLineTerminator(ch)
      else ok = classMatches(inst, ch, ignoreCase)
      if (ok) add(nlist, pc + 1, start, pos + 1)
    }
    const swap = clist
    clist = nlist
    nlist = swap
    if (clist.n === 0 && best !== null) break
  }
  return best
}
