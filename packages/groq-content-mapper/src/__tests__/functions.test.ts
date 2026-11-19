import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {evaluate, parse, type SchemaType} from 'groq-js'
import {afterEach, describe, expect, test} from 'vitest'

import {loadGroqFunctions, minifyGroq, withGroqFunctions} from '../functions.js'
import {generateGroqModule, groqQueryTypeText} from '../groqModule.js'
import {FIXTURES} from './exampleProject.js'

const LIBRARY = join(FIXTURES, 'functions', 'lib')
const AUTHOR = 'fn author::summary($author) = $author->{name, "slug": slug.current};'
const CARD =
  'fn post::card($post) = $post{title, "slug": slug.current, "author": author::summary(author)};'
const TAGGED = 'fn post::tagged($post) = $post{title, tags};'

let root: string

async function project(files: Record<string, string>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'groq-content-mapper-functions-'))
  await Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      await mkdir(join(root, name, '..'), {recursive: true})
      await writeFile(join(root, name), content)
    }),
  )
  return root
}

const library = () => loadGroqFunctions('lib/*.groq', join(FIXTURES, 'functions')).functions

afterEach(async () => {
  if (root) await rm(root, {force: true, recursive: true})
})

describe('loadGroqFunctions', () => {
  test('reads every definition of the files a glob matches', () => {
    const loaded = loadGroqFunctions('lib/*.groq', join(FIXTURES, 'functions'))
    expect(loaded.issues).toEqual([])
    expect([...loaded.files.keys()]).toEqual([
      join(LIBRARY, 'author.groq'),
      join(LIBRARY, 'post.groq'),
    ])
    expect(
      [...loaded.functions.values()].map(({calls, name, source}) => ({calls, name, source})),
    ).toEqual([
      {calls: [], name: 'author::summary', source: AUTHOR},
      {calls: ['author::summary'], name: 'post::card', source: CARD},
      {calls: [], name: 'post::tagged', source: TAGGED},
    ])
  })

  test('reads a list of files and globs, each file once', () => {
    const loaded = loadGroqFunctions(
      ['lib/post.groq', 'lib/*.groq', 'lib/author.groq'],
      join(FIXTURES, 'functions'),
    )
    expect(loaded.issues).toEqual([])
    expect([...loaded.functions.keys()]).toEqual(['post::card', 'post::tagged', 'author::summary'])
  })

  test('reports a missing file, a glob without matches and a folder, at their place in the list', async () => {
    const dir = await project({'lib/a.groq': AUTHOR})
    const loaded = loadGroqFunctions(['missing.groq', 'nothing/*.groq', 'lib'], dir)
    expect(loaded.issues).toEqual([
      {message: `No functions file at ${join(dir, 'missing.groq')}.`, path: ['functions', 0]},
      {message: '"nothing/*.groq" matches no functions files.', path: ['functions', 1]},
      {
        message: `${join(dir, 'lib')} is a folder. Name the functions files, or match them with a glob.`,
        path: ['functions', 2],
      },
    ])
    // Watched while missing, so that creating it is noticed.
    expect([...loaded.files]).toEqual([[join(dir, 'missing.groq'), undefined]])
  })

  test('reports a function defined in two files, and keeps the first', async () => {
    const dir = await project({'a.groq': AUTHOR, 'b.groq': `\n${AUTHOR.replace('name, ', '')}`})
    const loaded = loadGroqFunctions('*.groq', dir)
    expect(loaded.issues).toEqual([
      {
        message: `The function author::summary is defined twice: at ${join(dir, 'a.groq')}:1:1 and at ${join(dir, 'b.groq')}:2:1.`,
        path: ['functions'],
      },
    ])
    expect(loaded.functions.get('author::summary')?.source).toBe(AUTHOR)
  })

  test('reports an invalid definition at its line and column, and what calls it', async () => {
    const dir = await project({
      'bad.groq': `${TAGGED}\nfn post::broken($post) = $post{title,, slug};\n${CARD.replace('author::summary', 'post::broken')}\n`,
    })
    const loaded = loadGroqFunctions('bad.groq', dir)
    expect(loaded.issues).toEqual([
      {
        message: expect.stringMatching(
          new RegExp(`^Invalid function definition at ${escape(join(dir, 'bad.groq'))}:2:\\d+: `),
        ),
        path: ['functions'],
      },
    ])
    expect([...loaded.functions.keys()]).toEqual(['post::tagged'])
  })

  test('reports a body that is not a projection, and a call to a function that does not exist', async () => {
    const dir = await project({
      'a.groq': 'fn post::title($post) = $post.title;\n',
      'b.groq': 'fn post::typo($post) = $post{"author": author::nope(author)};\n',
    })
    const loaded = loadGroqFunctions(['a.groq', 'b.groq'], dir)
    expect(loaded.issues).toEqual([
      {
        message: expect.stringMatching(
          /^Invalid function definition post::title at .*a\.groq:1:1: .*must be a projection/,
        ),
        path: ['functions', 0],
      },
      {
        message: expect.stringMatching(
          /^Invalid function definition post::typo at .*b\.groq:1:1: .*Undefined namespace: author/,
        ),
        path: ['functions', 1],
      },
    ])
    expect(loaded.functions.size).toBe(0)
  })

  test('reports a file that holds more than definitions, or a definition without its ";"', async () => {
    const dir = await project({
      'query.groq': `${TAGGED}\n*[_type == "post"]\n`,
      'unended.groq': '// No semicolon\nfn post::tagged($post) = $post{title}\n',
    })
    expect(loadGroqFunctions('query.groq', dir).issues).toEqual([
      {
        message: `Invalid function definition at ${join(dir, 'query.groq')}:2:1: expected "fn namespace::name($param) = …;"; a functions file holds only function definitions.`,
        path: ['functions'],
      },
    ])
    expect(loadGroqFunctions('unended.groq', dir).issues).toEqual([
      {
        message: `Invalid function definition at ${join(dir, 'unended.groq')}:2:1: post::tagged has no ";" to end it.`,
        path: ['functions'],
      },
    ])
  })

  test('is not misled by a ";" or a call in a string or a comment', async () => {
    const dir = await project({
      'a.groq': `fn post::label($post) = $post{"label": "a; b post::card(x)"}; // post::tagged(@);\n${TAGGED}\n`,
    })
    const loaded = loadGroqFunctions('a.groq', dir)
    expect(loaded.issues).toEqual([])
    expect(loaded.functions.get('post::label')?.calls).toEqual([])
    expect([...loaded.functions.keys()]).toEqual(['post::label', 'post::tagged'])
  })
})

describe('withGroqFunctions', () => {
  test('prepends a function the query calls, and the ones it calls before it', () => {
    const query = '*[_type == "post"]{"card": post::card(@)}'
    expect(withGroqFunctions(query, library())).toBe(`${AUTHOR}\n${CARD}\n${query}`)
  })

  test('leaves a query that calls none as it is', () => {
    const query = '*[_type == "post"]{title, "n": count(tags), "t": pt::text(body)}'
    expect(withGroqFunctions(query, library())).toBe(query)
    expect(withGroqFunctions(query, new Map())).toBe(query)
  })

  test('prepends each function once, whoever calls it', () => {
    const query =
      '{"a": *[0]{"a": author::summary(author)}, "c": *[0]{"c": post::card(@)}, "t": *[0]{"t": post::tagged(@), "c": post::card(@)}}'
    expect(withGroqFunctions(query, library())).toBe(`${AUTHOR}\n${CARD}\n${TAGGED}\n${query}`)
  })

  test('does not prepend a function the query defines itself, but does what that one calls', () => {
    const own = 'fn post::card($post) = $post{title, "author": author::summary(author)};'
    const query = `${own}\n*[_type == "post"]{"card": post::card(@)}`
    expect(withGroqFunctions(query, library())).toBe(`${AUTHOR}\n${query}`)
  })

  test('ignores calls in strings and comments', () => {
    const query = '// post::card(@)\n*[title == "post::tagged(@)"]'
    expect(withGroqFunctions(query, library())).toBe(query)
  })

  test('finds a call however it is written, and leaves a query that does not parse alone', () => {
    const piped = '*[_type == "post"] | post::card(@)'
    expect(withGroqFunctions(piped, library())).toBe(`${AUTHOR}\n${CARD}\n${piped}`)
    const spaced = '*[_type == "post"]{"card": post::card (@)}'
    expect(withGroqFunctions(spaced, library())).toBe(`${AUTHOR}\n${CARD}\n${spaced}`)
    const broken = '*[_type == "post"]{"card": post::card(@)'
    expect(withGroqFunctions(broken, library())).toBe(broken)
  })

  test('makes a query groq-js evaluates', async () => {
    const query = await readFile(join(FIXTURES, 'functions', 'postCards.groq'), 'utf8')
    const dataset = [
      {_id: 'a', _type: 'author', name: 'Ada', slug: {current: 'ada'}},
      {_id: 'p', _type: 'post', author: {_ref: 'a'}, slug: {current: 'hello'}, title: 'Hello'},
    ]
    const result = await evaluate(parse(withGroqFunctions(query, library())), {dataset})
    expect(await result.get()).toEqual([
      {card: {author: {name: 'Ada', slug: 'ada'}, slug: 'hello', title: 'Hello'}},
    ])
  })

  test('is what the type of the query is inferred from, as written', async () => {
    const content = await readFile(join(FIXTURES, 'functions', 'postCards.groq'), 'utf8')
    const schema = JSON.parse(await readFile(join(FIXTURES, 'schema.json'), 'utf8')) as SchemaType
    const query = withGroqFunctions(content, library())
    const module = generateGroqModule({
      content,
      filename: 'postCards.groq',
      query,
      schema,
    })
    expect(module.diagnostics).toEqual([])
    expect(module.query).toBe(query)
    expect(module.code).toContain(`declare const query: ${groqQueryTypeText(query)} & {`)
    expect(module.code).toMatch(
      /card: \{\s*title: string \| null;\s*slug: string;\s*author: \{\s*name: string \| null;\s*slug: string \| null;\s*\} \| null;\s*\};/,
    )
  })

  test('minify drops comments and whitespace, and keeps the words apart', () => {
    const query = minifyGroq(
      '// note\n*[_type == "post" && title match $q] | order(publishedAt desc) [$start...$end]{title, "a label": a}\n',
    )
    expect(query).toBe(
      '*[_type=="post"&&title match $q]|order(publishedAt desc)[$start...$end]{title,"a label":a}',
    )
    expect(
      minifyGroq('fn image::field($image) = $image{crop, "asset": image::asset(asset)};'),
    ).toBe('fn image::field($image)=$image{crop,"asset":image::asset(asset)};')
  })

  test('minify drops a trailing comma from a projection', () => {
    const query = '*[_type == "page" && slug.current == $slug][0]{title, "slug": slug.current,}'
    expect(minifyGroq(query)).toBe(
      '*[_type=="page"&&slug.current==$slug][0]{title,"slug":slug.current}',
    )
  })

  test('a minified query evaluates the same, and does not include an unreferenced function', async () => {
    const query = withGroqFunctions('*[_type == "post"] {\n  "card": post::card(@)\n}\n', library())
    const minified = minifyGroq(query)
    expect(minified).not.toContain('post::tagged')
    expect(minified).toContain('fn author::summary')
    expect(minified).toContain('fn post::card')
    const dataset = [
      {_id: 'a', _type: 'author', name: 'Ada', slug: {current: 'ada'}},
      {_id: 'p', _type: 'post', author: {_ref: 'a'}, slug: {current: 'hello'}, title: 'Hello'},
    ]
    const run = async (source: string) => (await evaluate(parse(source), {dataset})).get()
    expect(await run(minified)).toEqual(await run(query))
  })

  test('reports a syntax error at its position in the file, not in the prepended query', () => {
    const content = '*[_type == "post"]{"card": post::card(@)\n'
    const query = withGroqFunctions(content, library())
    const module = generateGroqModule({content, filename: 'x.groq', query, schema: []})
    const unprefixed = generateGroqModule({content, filename: 'x.groq', schema: []})
    expect(unprefixed.diagnostics).toEqual([expect.objectContaining({code: 2, start: 40})])
    expect(module.diagnostics).toEqual(unprefixed.diagnostics)
  })
})

function escape(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}
