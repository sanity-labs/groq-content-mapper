/**
 * The type of a `.groq` file's default export: the query text, carrying its result and params
 * types as optional phantom properties.
 *
 * The properties never exist at runtime, and because they are optional the value is still
 * assignable to `string` and to its own literal, works in template literals and `===`, and goes
 * anywhere a `fetch(query: string)` goes. The brand is structural and keyed by plain strings so
 * a client can read it back with `Q extends {readonly __groqResult?: infer R}` without
 * depending on this package. A plain string literal does not match that check, so a client that
 * reads the brand first can still fall back to the `SanityQueries` registry for plain strings.
 *
 * Generated `.groq` modules spell this type out rather than import it, so they stay
 * self-contained. It is exported here as the reference for the shape.
 * @beta
 */
export type GroqQuery<Query extends string, Result, Params> = Query & {
  readonly __groqParams?: Params
  readonly __groqResult?: Result
}

/**
 * The result type a `GroqQuery` carries, or `unknown` for any other string.
 * @beta
 */
export type GroqResult<Query> = Query extends {readonly __groqResult?: infer Result}
  ? Result
  : unknown

/**
 * The params type a `GroqQuery` carries, or `unknown` for any other string.
 * @beta
 */
export type GroqParams<Query> = Query extends {readonly __groqParams?: infer Params}
  ? Params
  : unknown
