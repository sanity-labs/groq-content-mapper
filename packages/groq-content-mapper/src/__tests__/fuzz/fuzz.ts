import {readFileSync} from 'node:fs'

import type * as fc from 'fast-check'
import {type SchemaType, type TypeNode} from 'groq-js'

/**
 * Settings for every property test: a fixed seed, so CI is deterministic, and a modest number of
 * runs. `FUZZ_RUNS=10000 pnpm test` runs deeper, and `FUZZ_SEED` replays a reported failure.
 */
export function fuzzOptions<T>(runs = 100): fc.Parameters<T> {
  const deep = Number(process.env['FUZZ_RUNS'])
  const seed = Number(process.env['FUZZ_SEED'])
  return {
    numRuns: Number.isInteger(deep) && deep > 0 ? deep : runs,
    seed: Number.isInteger(seed) ? seed : 0x5a417,
  }
}

/** A timeout that leaves room for a deep run. */
export const FUZZ_TIMEOUT = process.env['FUZZ_RUNS'] ? 600_000 : 30_000

export const schema = JSON.parse(
  readFileSync(new URL('../fixtures/schema.json', import.meta.url), 'utf8'),
) as SchemaType

/** Whether a JSON value is one a field of `type` can hold, with `schema` resolving inline types. */
export function conforms(value: unknown, type: TypeNode, types: SchemaType = schema): boolean {
  switch (type.type) {
    case 'unknown': {
      return true
    }
    case 'null': {
      return value === null
    }
    case 'boolean':
    case 'number':
    case 'string': {
      return typeof value === type.type && (type.value === undefined || value === type.value)
    }
    case 'array': {
      return Array.isArray(value) && value.every((item) => conforms(item, type.of, types))
    }
    case 'union': {
      return type.of.some((member) => conforms(value, member, types))
    }
    case 'inline': {
      const named = types.find((entry) => entry.name === type.name)
      if (!named) return false
      return conforms(
        value,
        named.type === 'type' ? named.value : {...named, type: 'object'},
        types,
      )
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
      const record = value as Record<string, unknown>
      for (const [name, attribute] of Object.entries(type.attributes)) {
        // GROQ reads a missing attribute as null. groq-js narrows `!defined(title)` to a
        // required `title: null`, although the document has no `title` key.
        if (!(name in record)) {
          if (attribute.optional || conforms(null, attribute.value, types)) continue
          return false
        }
        if (!conforms(record[name], attribute.value, types)) return false
      }
      return type.rest === undefined || conforms(value, type.rest, types)
    }
    default: {
      return false
    }
  }
}
