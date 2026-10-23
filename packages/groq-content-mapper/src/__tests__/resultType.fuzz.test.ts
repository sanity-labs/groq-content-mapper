import * as fc from 'fast-check'
import {type ExprNode, evaluate, parse, typeEvaluate} from 'groq-js'
import {describe, expect, test} from 'vitest'

import {generateGroqModule} from '../groqModule.js'
import {safeParseQuery} from '../safeParseQuery.js'
import {conforms, FUZZ_TIMEOUT, fuzzOptions, schema} from './fuzz/fuzz.js'
import {dataset, groqQuery} from './fuzz/groqArbitraries.js'

/** A value for every placeholder the grammar writes. */
const PARAMS: Record<string, unknown> = {
  a: 1,
  b: 1,
  end: 2,
  fallback: 'fallback',
  high: 100,
  id: 'a0',
  ids: ['p0', 'p1'],
  low: 0,
  min: 1,
  n: 0,
  name: 'alpha',
  p: 'p',
  parent: 'alpha',
  q: 'alpha',
  role: 'admin',
  slug: 'alpha',
  start: 0,
  tag: 'alpha',
  type: 'post',
  v: 1,
  x: 'alpha',
}

/** Every node of a GROQ AST. */
function* nodesOf(node: unknown): Generator<ExprNode> {
  if (typeof node !== 'object' || node === null) return
  if (Array.isArray(node)) {
    for (const item of node) yield* nodesOf(item)
    return
  }
  if (typeof (node as {type?: unknown}).type === 'string') yield node as ExprNode
  for (const value of Object.values(node)) yield* nodesOf(value)
}

/**
 * Whether `ast` filters or pipes something that is not an array. groq-js 2.0 types `1[true]`
 * as an array and `{"a": 1} | order(a)` as the object, though both are null. See the
 * `test.fails` below.
 */
function hitsKnownTypeGap(ast: ExprNode): boolean {
  for (const node of nodesOf(ast)) {
    if (node.type !== 'Filter' && node.type !== 'PipeFuncCall') continue
    let base
    try {
      base = typeEvaluate(node.base, schema)
    } catch {
      return true
    }
    const members = base.type === 'union' ? base.of : [base]
    if (members.some((member) => member.type !== 'array' && member.type !== 'unknown')) return true
  }
  return false
}

const generate = (content: string) =>
  generateGroqModule({content, filename: '/p/q.groq', root: '/p', schema}).code

describe('typeEvaluate, fuzzed', () => {
  test(
    'what a query returns for a conforming dataset has the type the module exports',
    async () => {
      await fc.assert(
        fc.asyncProperty(groqQuery, dataset, async (query, docs) => {
          const ast = safeParseQuery(query)
          fc.pre(!hitsKnownTypeGap(ast))
          const type = typeEvaluate(ast, schema)
          const result = await (
            await evaluate(parse(query, {params: PARAMS}), {dataset: docs, params: PARAMS})
          ).get()
          expect(
            conforms(result, type),
            `${query}\n${JSON.stringify(result)}\n${JSON.stringify(type)}`,
          ).toBe(true)
        }),
        fuzzOptions(200),
      )
    },
    FUZZ_TIMEOUT,
  )

  test('the same query gets the same module, whatever was typed before it', () => {
    const queries = fc.sample(groqQuery, {numRuns: 50, seed: 1})
    const first = queries.map((query) => generate(query))
    expect(queries.toReversed().map((query) => generate(query))).toEqual(first.toReversed())
  })

  // Fixed upstream, these start passing: drop `hitsKnownTypeGap` then.
  test.fails('groq-js types a filter or `order()` on a non-array as null', () => {
    expect(typeEvaluate(parse('1[true]'), schema)).toEqual({type: 'null'})
    expect(typeEvaluate(parse('{"a": 1} | order(a)'), schema)).toEqual({type: 'null'})
  })

  test('groq-js gives each element of `score()` a numeric `_score`', () => {
    const type = typeEvaluate(parse('*[_type == "post"] | score(title match "a") {_score}'), schema)
    expect(type).toEqual({
      of: {
        attributes: {_score: {type: 'objectAttribute', value: {type: 'number'}}},
        type: 'object',
      },
      type: 'array',
    })
  })
})
