import {readFileSync} from 'node:fs'

import {type SchemaType} from 'groq-js'
import {describe, expect, test} from 'vitest'

import {type ExprNode} from '../groqAst.js'
import {generateCode} from '../helpers.js'
import {inferParams} from '../inferParams.js'
import {safeParseQuery} from '../safeParseQuery.js'
import {schemaTypesFor} from '../schemaTypes.js'

const schema = JSON.parse(
  readFileSync(new URL('fixtures/schema.json', import.meta.url), 'utf8'),
) as SchemaType
const schemaTypes = schemaTypesFor(schema)

/** The inferred params as `name: type` strings, in order. */
function params(query: string): string[] {
  const inferred = inferParams({ast: safeParseQuery(query) as ExprNode, query, schema})
  return [...inferred].map(
    ([name, type]) => `${name}: ${generateCode(schemaTypes.generateTsType(type)).trim()}`,
  )
}

describe('inferParams', () => {
  test('a comparison with a field takes the type of the field', () => {
    expect(params('*[_type == "post" && slug.current == $slug]')).toEqual(['slug: string'])
    expect(params('*[_type == "post" && role == $role]')).toEqual(['role: "admin" | "member"'])
    expect(params('*[_type == "post" && views > $minViews]')).toEqual(['minViews: number'])
    expect(params('*[_type == "post" && $featured == featured]')).toEqual(['featured: boolean'])
    expect(params('*[_type == "post" && (role) != ($role)]')).toEqual(['role: "admin" | "member"'])
    expect(params('*[_type == "post" && views + $extra > 10]')).toEqual(['extra: number'])
  })

  test('a comparison with a literal widens to its primitive', () => {
    expect(params('*[_type == "post" && $role == "admin"]')).toEqual(['role: string'])
    expect(params('*[_type == "post" && $n == 1 && $b == true]')).toEqual([
      'n: number',
      'b: boolean',
    ])
    expect(params('*[_type == "post" && $z == null]')).toEqual(['z: null'])
  })

  test('`in` reads the element type on one side and wraps it on the other', () => {
    expect(params('*[_type == "post" && $tag in tags]')).toEqual(['tag: string'])
    expect(params('*[_type == "post" && _id in $ids]')).toEqual(['ids: Array<string>'])
    expect(params('*[_type == "post" && $role in ["admin", "member"]]')).toEqual([
      'role: "admin" | "member"',
    ])
    expect(params('*[_type == "post" && tags == $tags]')).toEqual(['tags: Array<string>'])
    expect(params('*[_type == "post" && views in $low..$high]')).toEqual([
      'low: number',
      'high: number',
    ])
  })

  test('`match` takes a string, and slice bounds take numbers', () => {
    expect(params('*[_type == "post" && title match $term]')).toEqual(['term: string'])
    expect(params('*[_type == "post"][$start...$end]')).toEqual(['start: number', 'end: number'])
    expect(params('*[_type == "post"][ 10 .. $end ]')).toEqual(['end: number'])
    expect(params('*[_type == "post"][-$n...-1]')).toEqual(['n: number'])
    expect(params('*[_type == "post"][($start)..$start + $size]')).toEqual([
      'start: number',
      'size: number',
    ])
    expect(params('*[_type == "post" && views in $low..$high][0]')).toEqual([
      'low: number',
      'high: number',
    ])
  })

  test('follows references, inline types and the filter chain', () => {
    expect(params('*[_type == "post" && author->name == $name]')).toEqual(['name: string'])
    expect(params('*[_type == "post" && slug == $slug]')).toEqual(['slug: Slug'])
    expect(params('*[_type == "post" && categories[]->title match $t][0]')).toEqual(['t: string'])
    expect(params('*[_type == "post"] | order(views desc)[views > $v]')).toEqual(['v: number'])
    expect(params('*[_type == "post" && _type == $type]')).toEqual(['type: "post"'])
  })

  test('narrows the document type from `_type` checks in the same filter', () => {
    expect(params('*[_type == "author" && name == $name]')).toEqual(['name: string'])
    expect(params('*[_type in ["author", "post"] && _id == $id]')).toEqual(['id: string'])
    expect(params('*[name == $name]')).toEqual(['name: string'])
    expect(params('*[_type == $type]')).toEqual(['type: "author" | "category" | "post"'])
    expect(params('*[_type == "post"]{"authors": *[_type == "author" && name == $n]}')).toEqual([
      'n: string',
    ])
  })

  test('resolves the scope of a nested filter, projection or pipe function', () => {
    expect(params('*[_type == "post"]{"c": categories[_ref == $ref]}')).toEqual(['ref: string'])
    expect(params('*[_type == "post"]{"c": count(categories[_ref == $ref])}')).toEqual([
      'ref: string',
    ])
    expect(params('*[_type == "post"] | score(title match $q, boost(views > $v, 2))')).toEqual([
      'q: string',
      'v: number',
    ])
    expect(params('*[_type == "post"]{"a": author->{"same": name == $name}}')).toEqual([
      'name: string',
    ])
    expect(params('*[_type == "post"]{"t": tags[@ == $tag]}')).toEqual(['tag: string'])
    expect(params('*[_type == "post"]{"t": tags[]{"x": @ == $tag}}')).toEqual(['tag: string'])
  })

  test('is `unknown` where the schema says nothing, and the placeholder stays required', () => {
    expect(params('*[_type == "post" && $q]')).toEqual(['q: unknown'])
    expect(params('*[_type == "post"][$index]')).toEqual(['index: unknown'])
    expect(params('*[_type == "post" && $a == $b]')).toEqual(['a: unknown', 'b: unknown'])
    expect(params('*[_type == "post"]{"n": $n, title}')).toEqual(['n: unknown'])
    expect(params('*[_type == "post" && dateTime(publishedAt) > dateTime($since)]')).toEqual([
      'since: unknown',
    ])
    expect(params('*[_type == "post" && author->missing == $x]')).toEqual(['x: unknown'])
    expect(params('*[_type == "post" && ^.title == $x]')).toEqual(['x: unknown'])
  })

  test('a comparison with `^` takes the type from the parent scope', () => {
    expect(params('*[_type == "post"]{"a": author->{"p": ^.title == $parent}}')).toEqual([
      'parent: string',
    ])
    expect(
      params(
        '*[_type == "post"]{"a": *[_type == "author" && _id == ^.author._ref && $v < ^.views]}',
      ),
    ).toEqual(['v: number'])
    expect(params('*[_type == "post"]{"c": categories[]->{"x": $t == ^.title}}')).toEqual([
      't: string',
    ])
    expect(
      params('*[_type == "post"]{"a": author->{"c": *[_type == "category" && $v == ^.^.views]}}'),
    ).toEqual(['v: number'])
    expect(params('*[_type == "post"]{"t": tags[@ == ^.title && @ == $tag]}')).toEqual([
      'tag: string',
    ])
  })

  test('unions the comparisons of one placeholder and lets the typed ones win', () => {
    expect(
      params('*[_type == "post"] | score(title match $q, text::semanticSimilarity($q))'),
    ).toEqual(['q: string'])
    expect(params('*[_type == "post" && (title == $x || views == $x)]')).toEqual([
      'x: string | number',
    ])
    expect(params('*[_type == "post" && role == $role && $role == "admin"]')).toEqual([
      'role: "admin" | "member" | string',
    ])
  })

  test('lists placeholders in order of first appearance, ignoring strings and comments', () => {
    expect(
      params(`*[_type == "post" // $comment
        && title == "$literal" && views > $v][$start...$end]{title, "s": $slug}`),
    ).toEqual(['v: number', 'start: number', 'end: number', 'slug: unknown'])
    expect(params('*[_type == "post" && title == "[0...$x]"]')).toEqual([])
  })
})
