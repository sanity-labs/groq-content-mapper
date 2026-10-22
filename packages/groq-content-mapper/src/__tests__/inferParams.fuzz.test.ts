import {transform} from 'esbuild'
import * as fc from 'fast-check'
import {evaluate, parse} from 'groq-js'
import {describe, expect, test} from 'vitest'

import {type ExprNode} from '../groqAst.js'
import {generateGroqModule} from '../groqModule.js'
import {inferParams} from '../inferParams.js'
import {safeParseQuery} from '../safeParseQuery.js'
import {conforms, FUZZ_TIMEOUT, fuzzOptions, schema} from './fuzz/fuzz.js'
import {dataset, groqQuery, mangledQuery, probedQuery} from './fuzz/groqArbitraries.js'

function tryParse(query: string): ExprNode | undefined {
  try {
    return safeParseQuery(query) as ExprNode
  } catch {
    return undefined
  }
}

describe('inferParams, fuzzed', () => {
  test(
    'a value a post holds in the compared field has the inferred type',
    async () => {
      await fc.assert(
        fc.asyncProperty(probedQuery, dataset, async ({probes, query}, docs) => {
          const ast = tryParse(query)
          expect(ast, query).toBeDefined()
          const params = inferParams({ast: ast!, query, schema})
          const runs: Record<string, unknown>[] = []
          for (const post of docs.filter((doc) => doc._type === 'post')) {
            const values: Record<string, unknown> = {}
            runs.push(values)
            for (const {field, name} of probes) {
              const value = field.read(post as never, docs)
              values[name] = value ?? null
              if (value === undefined) continue
              const type = params.get(name)
              expect(type, `${name} in ${query}`).toBeDefined()
              expect(
                conforms(value, type!),
                `${JSON.stringify(value)} for $${name} in ${query}: ${JSON.stringify(type)}`,
              ).toBe(true)
            }
          }
          // The runtime accepts the same values.
          await Promise.all(
            runs.map(async (values) =>
              (
                await evaluate(parse(query, {params: values}), {dataset: docs, params: values})
              ).get(),
            ),
          )
        }),
        fuzzOptions(),
      )
    },
    FUZZ_TIMEOUT,
  )

  test(
    'names every placeholder of a query that parses, once each',
    () => {
      fc.assert(
        fc.property(groqQuery, (query) => {
          const ast = tryParse(query)
          if (!ast) return
          const names = [...inferParams({ast, query, schema}).keys()]
          const expected = [...new Set([...query.matchAll(/\$(\w+)/g)].map((match) => match[1]))]
          expect(new Set(names)).toEqual(new Set(expected))
          expect(names).toHaveLength(expected.length)
        }),
        fuzzOptions(300),
      )
    },
    FUZZ_TIMEOUT,
  )
})

const sliceBound = fc.letrec<{bound: string}>((tie) => ({
  bound: fc.oneof(
    {depthSize: 'small'},
    fc.integer({max: 5, min: -5}).map(String),
    fc.constantFrom('$a', '$b', '1.5', '0'),
    tie('bound').map((bound) => `-${bound}`),
    tie('bound').map((bound) => `(${bound})`),
    fc
      .tuple(tie('bound'), fc.constantFrom('+', '-', '*'), tie('bound'))
      .map(([left, op, right]) => `${left} ${op} ${right}`),
  ),
})).bound

const sliced = fc
  .tuple(
    fc.constantFrom('*[_type == "post"]', '*[_type == "post"].tags', '*[views in $a..$b]'),
    sliceBound,
    fc.constantFrom('..', '...'),
    sliceBound,
    fc.constantFrom('', '{title}', '{"t": tags[0..$b]}', '{"all": [...tags, ...$c]}'),
  )
  .map(([base, left, range, right, tail]) => `${base}[${left}${range}${right}]${tail}`)

describe('safeParseQuery, fuzzed', () => {
  test('parses every slice groq-js parses once the params are numbers', () => {
    fc.assert(
      fc.property(sliced, fc.integer({max: 9, min: -9}), (query, value) => {
        let runtime = true
        try {
          parse(query, {params: {a: value, b: value, c: [value]}})
        } catch {
          runtime = false
        }
        if (runtime) expect(() => safeParseQuery(query), query).not.toThrow()
      }),
      fuzzOptions(300),
    )
  })
})

describe('generateGroqModule, fuzzed', () => {
  test(
    'never throws, is deterministic, and emits valid TypeScript for any query',
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.oneof(groqQuery, mangledQuery), async (content) => {
          const options = {content, filename: '/p/q.groq', root: '/p', schema}
          const first = generateGroqModule(options)
          expect(generateGroqModule(options).code).toBe(first.code)
          await transform(first.code, {loader: 'ts'})
          for (const {length, start} of first.diagnostics) {
            expect(start).toBeGreaterThanOrEqual(0)
            expect(start + length).toBeLessThanOrEqual(content.length)
          }
        }),
        fuzzOptions(200),
      )
    },
    FUZZ_TIMEOUT,
  )
})
