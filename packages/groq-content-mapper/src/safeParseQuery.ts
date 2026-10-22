import {type ExprNode, parse} from 'groq-js'

/**
 * Parses a GROQ query for type evaluation. groq-js only accepts constant slice bounds, so a
 * `$param` used as one is bound to `0` first: the value does not matter for its type. Not for
 * queries that are executed.
 *
 * groq-js 2.0 only ends a `//` comment at a newline, so a file whose last line is a comment
 * would not parse; such a query is parsed again with one appended. Any other error is the
 * query's own, at its own position.
 */
export function safeParseQuery(query: string): ExprNode {
  const params: Record<string, unknown> = {}
  for (const param of extractSliceParams(query)) {
    params[param] = 0
  }
  try {
    return parse(query, {params})
  } catch (error) {
    try {
      return parse(`${query}\n`, {params})
    } catch {
      throw error
    }
  }
}

/** The names of the `$params` used as slice bounds, as in `[$start...$end]` or `[10..$end]`. */
export function* extractSliceParams(query: string): Generator<string> {
  const sliceRegex = /\[\s*(\$(\w+)|\d+)\s*\.\.\.?\s*(\$(\w+)|\d+)\s*\]/g
  for (const match of query.matchAll(sliceRegex)) {
    if (match[1] === `$${match[2]}`) yield match[2]!
    if (match[3] === `$${match[4]}`) yield match[4]!
  }
}
