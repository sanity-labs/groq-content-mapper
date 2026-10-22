import * as fc from 'fast-check'

/**
 * Generators of GROQ queries over `fixtures/schema.json`, and of datasets that conform to it.
 * The queries are built from a small grammar, so most of them parse and many of them type, and
 * each comparison of a placeholder with a field is recorded, so its value can be read back from
 * a dataset.
 */

/** A field of a post, as a GROQ expression, with how to read it from a post in a dataset. */
interface Field {
  expr: string
  read: (post: Post, dataset: Doc[]) => unknown
}

interface Doc {
  _id: string
  _type: string
  [key: string]: unknown
}

type Post = Doc & {_type: 'post'}

const deref = (dataset: Doc[], ref: unknown): Doc | undefined =>
  dataset.find((doc) => doc._id === (ref as {_ref?: unknown} | undefined)?._ref)

const POST_FIELDS: Field[] = [
  {expr: '_id', read: (post) => post._id},
  {expr: 'title', read: (post) => post['title']},
  {expr: 'slug.current', read: (post) => (post['slug'] as {current?: unknown})?.current},
  {expr: 'role', read: (post) => post['role']},
  {expr: 'views', read: (post) => post['views']},
  {expr: 'featured', read: (post) => post['featured']},
  {expr: 'publishedAt', read: (post) => post['publishedAt']},
  {expr: 'tags', read: (post) => post['tags']},
  {expr: 'author._ref', read: (post) => (post['author'] as {_ref?: unknown})?._ref},
  {expr: 'author->name', read: (post, dataset) => deref(dataset, post['author'])?.['name']},
]

const word = fc.constantFrom('alpha', 'beta', 'gamma', 'delta', "it's", 'a"b', '')
const optional = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, {nil: undefined})

/** A dataset of authors, categories and posts that conforms to the fixture schema. */
export const dataset: fc.Arbitrary<Doc[]> = fc
  .record({
    authors: fc.array(optional(word), {maxLength: 3, minLength: 1}),
    categories: fc.array(optional(word), {maxLength: 3}),
    posts: fc.array(
      fc.record({
        author: optional(fc.nat(2)),
        categories: optional(fc.array(fc.nat(2), {maxLength: 3})),
        featured: optional(fc.boolean()),
        publishedAt: optional(fc.constantFrom('2024-01-01T00:00:00Z', '2025-06-30T12:00:00Z')),
        role: optional(fc.constantFrom('admin', 'member')),
        slug: optional(optional(word)),
        tags: optional(fc.array(word, {maxLength: 3})),
        title: optional(word),
        views: optional(fc.integer({max: 1000, min: -5})),
      }),
      {maxLength: 6, minLength: 1},
    ),
  })
  .map(({authors, categories, posts}) => {
    const docs: Doc[] = []
    const strip = (doc: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(doc).filter(([, value]) => value !== undefined)) as Doc
    authors.forEach((name, index) => docs.push(strip({_id: `a${index}`, _type: 'author', name})))
    categories.forEach((title, index) =>
      docs.push(strip({_id: `c${index}`, _type: 'category', title})),
    )
    posts.forEach((post, index) =>
      docs.push(
        strip({
          ...post,
          _id: `p${index}`,
          _type: 'post',
          author:
            post.author === undefined
              ? undefined
              : {_ref: `a${post.author % authors.length}`, _type: 'reference'},
          categories: post.categories?.map((category, key) => ({
            _key: `k${key}`,
            _ref: `c${category}`,
            _type: 'reference',
          })),
          slug: post.slug === undefined ? undefined : strip({_type: 'slug', current: post.slug}),
        }),
      ),
    )
    return docs
  })

/** A placeholder compared with a field of a post, and how the field's value is read. */
export interface Probe {
  field: Field
  name: string
  op: '!=' | '<' | '<=' | '==' | '>' | '>='
  paramOnLeft: boolean
}

/** `*[_type == "post" && <comparisons>]`, with each comparison recorded. */
export const probedQuery: fc.Arbitrary<{probes: Probe[]; query: string}> = fc
  .array(
    fc.record({
      field: fc.constantFrom(...POST_FIELDS),
      op: fc.constantFrom('==', '!=', '<', '>', '<=', '>=' as const),
      paramOnLeft: fc.boolean(),
    }),
    {maxLength: 4, minLength: 1},
  )
  .chain((comparisons) =>
    fc
      .tuple(
        fc.constantFrom('&&', '||'),
        fc.constantFrom('', '{title, views}', '[0]', '| order(views desc)', '[0...2]'),
      )
      .map(([join, tail]) => {
        const probes = comparisons.map((comparison, index) => ({...comparison, name: `p${index}`}))
        const filter = probes
          .map(({field, name, op, paramOnLeft}) =>
            paramOnLeft ? `$${name} ${op} ${field.expr}` : `${field.expr} ${op} $${name}`,
          )
          .join(` ${join} `)
        return {probes, query: `*[_type == "post" && (${filter})]${tail}`}
      }),
  )

/** A GROQ expression from a grammar over the fixture schema, valid or not. */
export const groqQuery: fc.Arbitrary<string> = fc.letrec<{
  cond: string
  projection: string
  query: string
  value: string
}>((tie) => ({
  cond: fc.oneof(
    {depthSize: 'small', withCrossShrink: true},
    fc.constantFrom(
      '_type == "post"',
      'defined(title)',
      'views > $min',
      '$tag in tags',
      '_id in $ids',
      'title match $q',
      'author->name == $name',
      'views in $low..$high',
      '^.title == $parent',
      'slug.current == $slug',
      'role == $role',
      '@ == $x',
      '$a == $b',
      'references($id)',
      'count(categories) > $n',
      'featured',
      'true',
      'null',
    ),
    fc
      .tuple(tie('cond'), fc.constantFrom('&&', '||'), tie('cond'))
      .map(([a, op, b]) => `${a} ${op} ${b}`),
    tie('cond').map((cond) => `!(${cond})`),
    tie('cond').map((cond) => `(${cond})`),
  ),
  projection: fc.oneof(
    {depthSize: 'small'},
    fc.constantFrom(
      '{title}',
      '{...}',
      '{_id, "n": author->name}',
      '{"s": slug.current, "c": categories[]->title}',
      '{"p": $p}',
      '{"t": coalesce(title, $fallback)}',
    ),
    tie('value').map((value) => `{"v": ${value}}`),
    fc
      .tuple(tie('cond'), tie('value'))
      .map(([cond, value]) => `{title, ${cond} => {"v": ${value}}}`),
    fc
      .tuple(tie('cond'), tie('projection'))
      .map(([cond, inner]) => `{"a": author->${inner}, "w": select(${cond} => 1, 2)}`),
  ),
  query: fc.oneof(
    {depthSize: 'small'},
    fc.constant('*'),
    fc.constantFrom('*[_type == "post"]', '*[_type == "author"]', '*[_type == $type]'),
    fc.tuple(tie('query'), tie('cond')).map(([base, cond]) => `${base}[${cond}]`),
    fc.tuple(tie('query'), tie('projection')).map(([base, projection]) => `${base}${projection}`),
    fc
      .tuple(
        tie('query'),
        fc.constantFrom('[0]', '[0..2]', '[$start...$end]', '[1...$end]', '[$i]'),
      )
      .map(([base, slice]) => `${base}${slice}`),
    fc
      .tuple(
        tie('query'),
        fc.constantFrom(
          '| order(views desc)',
          '| order(title asc, _id)',
          '| score(title match $q)',
          '| score(boost(views > $v, 2))',
        ),
      )
      .map(([base, pipe]) => `${base} ${pipe}`),
    tie('query').map((base) => `count(${base})`),
    fc.tuple(tie('query'), tie('query')).map(([a, b]) => `{"a": ${a}, "b": ${b}}`),
    tie('query').map((base) => `${base}[]->`),
  ),
  value: fc.oneof(
    {depthSize: 'small'},
    fc.constantFrom(
      'title',
      'views',
      '$p',
      '"x"',
      '1',
      'null',
      '^.title',
      '@',
      'tags[0]',
      'author->',
      'categories[]->title',
    ),
    fc.tuple(tie('value'), tie('value')).map(([a, b]) => `coalesce(${a}, ${b})`),
    fc
      .tuple(tie('cond'), tie('value'), tie('value'))
      .map(([cond, a, b]) => `select(${cond} => ${a}, ${b})`),
    tie('query'),
  ),
})).query

/** A query from the grammar with random characters spliced in, to reach the parser's error paths. */
export const mangledQuery: fc.Arbitrary<string> = fc
  .tuple(groqQuery, fc.nat(), fc.nat(3), fc.string({maxLength: 3, unit: 'binary'}))
  .map(([query, at, remove, insert]) => {
    const index = at % (query.length + 1)
    return query.slice(0, index) + insert + query.slice(index + remove)
  })
