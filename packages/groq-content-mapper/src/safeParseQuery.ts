import {type ExprNode, parse} from 'groq-js'

/**
 * Parses a GROQ query for type evaluation. groq-js only accepts constant slice bounds, so a
 * `$param` used as one is bound to `0` first: the value does not matter for its type. Not for
 * queries that are executed.
 */
export function safeParseQuery(query: string): ExprNode {
  const params: Record<string, unknown> = {}
  for (const param of extractSliceParams(query)) {
    params[param] = 0
  }
  return parse(query, {params})
}

/** The names of the `$params` used as slice bounds, as in `[$start...$end]` or `[10..$end]`. */
export function* extractSliceParams(query: string): Generator<string> {
  const sliceRegex = /\[\s*(\$(\w+)|\d+)\s*\.\.\.?\s*(\$(\w+)|\d+)\s*\]/g
  for (const match of query.matchAll(sliceRegex)) {
    if (match[1] === `$${match[2]}`) yield match[2]!
    if (match[3] === `$${match[4]}`) yield match[4]!
  }
}
