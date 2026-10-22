import {describe, expect, test} from 'vitest'

import {extractSliceParams, safeParseQuery} from '../safeParseQuery.js'

const variants = [
  {
    params: ['from', 'to'],
    query: '*[_type == "author"][$from...$to]',
  },
  {
    params: ['from'],
    query: '*[_type == "author"][$from...5]',
  },
  {
    params: ['to'],
    query: '*[_type == "author"][5...$to]',
  },
  {
    params: [],
    query: '*[_type == "author"][3...5]',
  },
  {
    params: ['limit'],
    query: '*[_type == "author"][3...5] { name, "foo": *[_type == "bar"][0...$limit] }',
  },
  {
    params: ['from', 'to', 'limit'],
    query: '*[_type == "author"][$from...$to] { name, "foo": *[_type == "bar"][0...$limit] }',
  },
  {
    params: ['to'],
    query: '*[_type == "author"][10...$to]',
  },
  {
    params: ['from', 'to'],
    query: '*[_type == "author"][ $from .. $to ]',
  },
  {
    params: ['to'],
    query: '*[_type == "author"][-3...$to]',
  },
  {
    params: ['from'],
    query: '*[_type == "author"][$from..-1]',
  },
  {
    params: ['from', 'to'],
    query: '*[_type == "author"][($from)...$to + 1]',
  },
  {
    params: ['n'],
    query: '*[_type == "author"][-$n...1.5]',
  },
  {
    params: [],
    query: '*[_type == "author" && count(books) in $low..$high]',
  },
  {
    params: [],
    query: '*[_type == "author"]{"all": [...tags, ...$extra]}',
  },
  {
    params: [],
    query: '*[_type == "author" && name == "[$from...$to]"] // [$a..$b]\n',
  },
]
describe('safeParseQuery', () => {
  test.each(variants)('can extract: $query', async (variant) => {
    const params = collectAll(extractSliceParams(variant.query))
    expect(params).toStrictEqual(variant.params)
  })
  test.each(variants)('can parse: $query', async (variant) => {
    safeParseQuery(variant.query)
  })
})

function collectAll<T>(iterator: Generator<T>) {
  const res = []
  for (const item of iterator) {
    res.push(item)
  }
  return res
}
