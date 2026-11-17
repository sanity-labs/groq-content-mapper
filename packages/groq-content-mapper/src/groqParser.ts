import {readFileSync} from 'node:fs'

import {calls, definitions, format, initSync, minimize} from '../wasm/groq.js'

/**
 * GROQ's Rust parser, `groq-parser`, built to `wasm/` from `rust/` by `scripts/build-wasm.sh`.
 * groq-js inlines custom functions as it parses, so its syntax tree neither lists a file's
 * definitions nor shows which functions a query called; this parser keeps both.
 */
initSync({module: readFileSync(new URL('../wasm/groq_bg.wasm', import.meta.url))})

/** A `fn namespace::name($param) = …;` definition, as the parser found it in a file. */
export interface ParsedDefinition {
  /** The functions its body calls, as `namespace::name`, each once. Built-ins have no namespace. */
  calls: string[]
  /** Where the definition ends in the file, after its `;`. */
  end: number
  /** `namespace::name`. */
  name: string
  parameters: string[]
  /** Where the definition starts in the file, at its `fn`. */
  start: number
}

/** A definition the parser rejected, with where in the file. */
export interface DefinitionProblem {
  end: number
  message: string
  /** Its `namespace::name`, when the header could be read. */
  name: string | null
  start: number
}

interface RawDefinition {
  calls: string[]
  end: number
  name: string
  namespace: string
  parameters: string[]
  start: number
}

/** The definitions in a functions file, and the problems with those that do not parse. */
export function parseDefinitions(source: string): {
  definitions: ParsedDefinition[]
  problems: DefinitionProblem[]
} {
  const parsed = JSON.parse(definitions(source)) as {
    definitions: RawDefinition[]
    problems: DefinitionProblem[]
  }
  return {
    definitions: parsed.definitions.map(({namespace, name, ...rest}) => ({
      ...rest,
      name: `${namespace}::${name}`,
    })),
    problems: parsed.problems,
  }
}

/**
 * The functions a query defines itself and the ones it calls, as `namespace::name`, or
 * `undefined` for a query that does not parse.
 */
export function parseCalls(query: string): {calls: string[]; defines: string[]} | undefined {
  return (JSON.parse(calls(query)) as {calls: string[]; defines: string[]} | null) ?? undefined
}

/**
 * The query with comments removed and whitespace collapsed, so the string sent to the Content
 * Lake is shorter: its tokens, with a space only where two would otherwise run together, as in
 * `title match` or `publishedAt desc`. A trailing comma is dropped from an object, a projection,
 * an array, or a function argument list. Strings are kept as they are. A fragment is minimized
 * the same way.
 *
 * groq-js's `unparse` also drops whitespace, but it rewrites `count()` as `global::count()`,
 * refuses a slice bound that is a parameter, and inlines `fn` definitions, so it is not usable
 * on the queries this package emits.
 */
export function minifyGroq(query: string): string {
  return minimize(query)
}

/**
 * The query as the `groq-format` crate prints it, wrapped to `width` columns, comments kept. A
 * query that does not parse is returned as it is.
 */
export function prettifyGroq(query: string, width: number): string {
  return format(query, width) ?? query
}
