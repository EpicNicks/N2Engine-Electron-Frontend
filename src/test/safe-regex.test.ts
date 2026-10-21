// The console's linear-time regex matcher: the same matches as RegExp for the patterns a filter uses, no hang for the
// patterns that make RegExp backtrack forever, and a reason for what it does not do. Unit tested in Node.
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { compileMatcher, MaxPatternLength } from "../renderer/console-filter"
import { compileProgram, exec, MaxProgram, UnsupportedPattern } from "../renderer/safe-regex"

/** The ranges RegExp finds the way the console used to: global, an empty match skipped */
function nativeRanges(source: string, flags: string, text: string): Array<[number, number]> {
  const re = new RegExp(source, flags + "g")
  const out: Array<[number, number]> = []
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0].length === 0) re.lastIndex++
    else out.push([m.index, m.index + m[0].length])
  }
  return out
}

const ordinary = [
  "error",
  "^load \\d+ files",
  "\\d+",
  "\\bfoo\\b",
  "\\Boo",
  "(ab)+",
  "(a|b)*c",
  "a+b+",
  "colou?r",
  "a{2}",
  "a{2,}",
  "a{1,3}",
  "a{,3}",
  "a{",
  "x}",
  "[a-c]+",
  "[^a-c ]+",
  "[\\d-z]+",
  "[a\\-z]+",
  "[-a]+",
  "[]",
  "[^]",
  "[\\w.]+@[\\w.]+",
  "\\[(\\w+)\\]",
  "\\(a+\\)",
  "^$",
  "^",
  "$",
  "a|ab|abc",
  "(?:ab|a)(?:bc|c)?",
  ".*?x",
  ".+?",
  "a.c",
  "a*?b",
  "(a*)*b",
  "(x+x+)+y",
  "((a+))+",
  "(a|aa)+$",
  "\\x41\\u0042",
  "\\t",
  "\\.\\*",
  "\\/",
  "\\S+\\s\\S+",
  "\\W+",
  "\\D\\d",
  "(foo|bar)baz",
  "[A-Z][a-z]+",
  "\u00e9+",
  "stra\u00dfe",
]

const inputs = [
  "",
  "error",
  "an ERROR here, error again",
  "Load 12 files",
  "load x files",
  "foo foobar barfoo foo",
  "aaa abab ab abc abcc",
  "color colour colr",
  "a.c abc a\nc",
  "xx x xxy xxxxy",
  "user@example.com [tag] (aaa)",
  "{a} a{ x} aa aaa aaaa",
  "\u00c9\u00c9 \u00e9\u00e9 straSSe stra\u00dfe STRASSE",
  "tab\there  spaces",
  "BAZ barbaz foobaz Foo-Bar_9",
  "-a-z0 9z",
  "A\u2028B",
]

describe("safe-regex: the same matches as RegExp", () => {
  for (const flags of ["i", ""]) {
    test(`ordinary patterns, ${flags === "i" ? "ignoring case" : "matching case"}`, () => {
      for (const source of ordinary) {
        new RegExp(source, flags) // a pattern the engine would refuse is not a case here
        const program = compileProgram(source, flags === "i")
        for (const text of inputs) {
          const found: Array<[number, number]> = []
          for (let from = 0; from <= text.length; ) {
            const m = exec(program, text, from)
            if (m === null) break
            if (m[1] === m[0]) from = m[0] + 1
            else {
              found.push(m)
              from = m[1]
            }
          }
          assert.deepEqual(found, nativeRanges(source, flags, text), `/${source}/${flags} on ${JSON.stringify(text)}`)
          assert.equal(exec(program, text, 0, true) !== null, new RegExp(source, flags).test(text), `test /${source}/ on ${JSON.stringify(text)}`)
        }
      }
    })
  }

  test("the leftmost match prefers what RegExp prefers (alternation order, greedy and lazy)", () => {
    const pick = (source: string, text: string) => {
      const m = exec(compileProgram(source, false), text)
      return m && text.slice(m[0], m[1])
    }
    assert.equal(pick("a|ab", "ab"), "a")
    assert.equal(pick("a+", "aaa"), "aaa")
    assert.equal(pick("a+?", "aaa"), "a")
    assert.equal(pick("(a|ab)(c|bcd)", "abcd"), "abcd")
    assert.equal(pick("x*", "aaa"), "")
    assert.equal(pick("b+", "aabbb"), "bbb")
  })
})

describe("safe-regex: patterns that make RegExp backtrack forever finish at once", () => {
  // Each of these takes an engine RegExp longer than the age of the universe on the matching input
  const bombs: Array<[string, string]> = [
    ["((a+))+$", "a".repeat(4000) + "!"],
    ["(a|aa)+$", "a".repeat(4000) + "!"],
    ["(a*)*b", "a".repeat(4000)],
    ["(x+x+)+y", "x".repeat(4000)],
    ["(a+)+$", "a".repeat(4000) + "!"],
    ["(.*a){12}", "a".repeat(4000) + "b"],
    ["(a|a)*$", "a".repeat(4000) + "!"],
    ["((a*)*)*$", "a".repeat(4000) + "!"],
    ["(\\w+\\s?)+$", "word ".repeat(780) + "!"],
    ["^(([a-z])+.)+[A-Z]([a-z])+$", "a".repeat(4000)],
    ["(a?){30}a{30}", "a".repeat(30)],
    ["(?:a|b|ab)*c", "ab".repeat(1900) + "d"],
  ]
  test("the old bypass shapes and the classic bombs, on long adversarial lines, within a second each", { timeout: 60000 }, () => {
    for (const [source, text] of bombs) {
      const matcher = compileMatcher({ search: source, matchCase: true, regex: true })
      assert.equal(matcher.error, null, source)
      const started = Date.now()
      matcher.test(text)
      matcher.ranges(text)
      const took = Date.now() - started
      assert.ok(took < 1000, `${source} took ${took} ms`)
    }
  })

  test("and they still give the right answer", () => {
    const m = (source: string, text: string) => compileMatcher({ search: source, matchCase: true, regex: true }).test(text)
    assert.equal(m("(a+)+$", "aaaa"), true)
    assert.equal(m("(a+)+$", "aaaa!"), false)
    assert.equal(m("(a|aa)+$", "aaaaa"), true)
    assert.equal(m("(a*)*b", "aaab"), true)
    assert.equal(m("(a*)*b", "aaac"), false)
    assert.equal(m("(x+x+)+y", "xxxy"), true)
    assert.equal(m("((a+))+", "a"), true)
  })

  test("highlighting every match of a long line is bounded too (a match that can look far ahead)", { timeout: 20000 }, () => {
    const line = "x".repeat(4096)
    for (const source of ["x(.*y)?", "(?:a.*z|a)", "x(.*y)?z?", "(x|xx)*(.*y)?"]) {
      const matcher = compileMatcher({ search: source, matchCase: true, regex: true })
      const started = Date.now()
      matcher.ranges(line)
      matcher.ranges("a".repeat(4096))
      assert.ok(Date.now() - started < 5000, source)
    }
  })

  test("a matcher is reusable and keeps no state between lines", () => {
    const matcher = compileMatcher({ search: "^ab+$", matchCase: true, regex: true })
    for (let i = 0; i < 5; i++) {
      assert.equal(matcher.test("abbb"), true)
      assert.equal(matcher.test("abbbc"), false)
    }
  })
})

describe("safe-regex: what it refuses says why", () => {
  const refused = (source: string) => {
    try {
      compileProgram(source, true)
    } catch (e) {
      return e instanceof UnsupportedPattern ? e.message : null
    }
    return null
  }

  test("back-references, look-around and named groups", () => {
    assert.match(refused("(a)\\1") ?? "", /Back-references/)
    assert.match(refused("(?<n>a)\\k<n>") ?? "", /Look-around and named groups|Back-references/)
    assert.match(refused("a(?=b)") ?? "", /Look-around/)
    assert.match(refused("(?<!a)b") ?? "", /Look-around/)
    assert.match(refused("(?!a)b") ?? "", /Look-around/)
  })

  test("legacy octal escapes are refused, not read differently", () => {
    assert.match(refused("\\01") ?? "", /Octal/)
    assert.equal(refused("\\0"), null)
  })

  test("ignore-case classes do not fold characters RegExp does not (the Kelvin sign is not a k)", () => {
    const program = compileProgram("[\\w]", false)
    const text = String.fromCharCode(0x212a)
    assert.equal(exec(program, text, 0, true) !== null, new RegExp("[\\w]", "i").test(text))
  })

  test("a counted repeat that would expand past the program limit", () => {
    for (const bomb of ["(a{50}){50}", "((((a{60}){60}){60}){60})", "a{1000000000}", ".{1,400}x{1,400}"]) {
      assert.match(refused(bomb) ?? "", /too large/, bomb)
    }
    assert.equal(refused("\\d{1,20}"), null)
    assert.ok(MaxProgram >= 100)
  })

  test("through the matcher: inline message, nothing filtered, and the pattern is plain text with regex off", () => {
    const m = compileMatcher({ search: "(a)\\1", matchCase: false, regex: true })
    assert.match(m.error ?? "", /Not supported in the filter: Back-references/)
    assert.equal(m.active, false)
    assert.equal(m.test("anything"), true)
    assert.equal(compileMatcher({ search: "(a)\\1", matchCase: false, regex: false }).error, null)
    const big = compileMatcher({ search: "(a{50}){50}", matchCase: false, regex: true })
    assert.match(big.error ?? "", /too large/)
  })

  test("a syntax error keeps the engine's own message, and the length cap still holds", () => {
    assert.match(compileMatcher({ search: "a[[", matchCase: false, regex: true }).error ?? "", /Unterminated character class|Invalid regular expression/)
    assert.match(compileMatcher({ search: "x".repeat(MaxPatternLength + 1), matchCase: false, regex: true }).error ?? "", /200/)
  })
})
