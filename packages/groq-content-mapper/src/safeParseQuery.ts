import {type ExprNode, parse} from 'groq-js'

const PARAMETER = /\$([A-Za-z_]\w*)/g

/**
 * Parses a GROQ query for type evaluation. groq-js only accepts slice bounds that are constant
 * once params are substituted, so a `$param` used in one is bound to `0` first: the value does
 * not matter for its type. Not for queries that are executed.
 */
export function safeParseQuery(query: string): ExprNode {
  const params: Record<string, unknown> = {}
  for (const param of extractSliceParams(query)) {
    params[param] = 0
  }
  return parse(query, {params})
}

/**
 * The names of the `$params` used in slice bounds, as in `[$start...$end]`, `[10..$end]` or
 * `[-$n..-1]`, in order of first appearance. A range in a filter, as in `[views in $a..$b]`, is
 * not a slice.
 */
export function* extractSliceParams(query: string): Generator<string> {
  const seen = new Set<string>()
  for (const bounds of sliceBounds(withoutLiterals(query))) {
    for (const match of bounds.matchAll(PARAMETER)) {
      if (seen.has(match[1]!)) continue
      seen.add(match[1]!)
      yield match[1]!
    }
  }
}

interface Bracket {
  char: string
  /** Whether a `,` or an `in` precedes the range at this bracket's own level. */
  notSlice: boolean
  start: number

  /** Where the first `..` or `...` at this bracket's own level is. */
  range?: number
}

const CLOSING: Record<string, string> = {')': '(', ']': '[', '}': '{'}

/** The text between the brackets of every slice in `code`, whose literals are blanked. */
function* sliceBounds(code: string): Generator<string> {
  const stack: Bracket[] = []
  for (let index = 0; index < code.length; index++) {
    const char = code[index]!
    const top = stack.at(-1)
    if (char === '(' || char === '[' || char === '{') {
      stack.push({char, notSlice: false, start: index})
    } else if (char in CLOSING) {
      if (!top || top.char !== CLOSING[char]) continue
      stack.pop()
      if (char !== ']' || top.notSlice || top.range === undefined) continue
      // `[...tags]` splats an array: a slice has a lower bound.
      if (code.slice(top.start + 1, top.range).trim().length === 0) continue
      yield code.slice(top.start + 1, index)
    } else if (char === '.' && code[index + 1] === '.') {
      if (top?.char === '[' && top.range === undefined) top.range = index
      while (code[index + 1] === '.') index++
    } else if (char === ',') {
      if (top && top.range === undefined) top.notSlice = true
    } else if (/[A-Za-z_$]/.test(char)) {
      let end = index
      while (end + 1 < code.length && /\w/.test(code[end + 1]!)) end++
      if (top && top.range === undefined && code.slice(index, end + 1) === 'in') {
        top.notSlice = true
      }
      index = end
    }
  }
}

/**
 * The query with the contents of string literals and comments blanked out, at the same
 * positions, so a `$name` or a slice inside them is neither read nor hides a real one.
 */
export function withoutLiterals(query: string): string {
  let code = ''
  let quote: string | undefined
  for (let index = 0; index < query.length; index++) {
    const char = query[index]!
    if (quote) {
      if (char === '\\') {
        code += '  '
        index++
      } else if (char === quote) {
        quote = undefined
        code += char
      } else {
        code += ' '
      }
    } else if (char === '"' || char === "'") {
      quote = char
      code += char
    } else if (char === '/' && query[index + 1] === '/') {
      const end = query.indexOf('\n', index)
      const length = (end === -1 ? query.length : end) - index
      code += ' '.repeat(length)
      index += length - 1
    } else {
      code += char
    }
  }
  return code
}
