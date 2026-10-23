import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, parse} from 'node:path'

import {afterEach, describe, expect, test} from 'vitest'

import {parseGroqFilesOptions, resolveGroqFiles, schemaFor} from '../schemas.js'

const SCHEMA = new URL('fixtures/schema.json', import.meta.url)
const SHOP_SCHEMA = JSON.stringify([
  {
    attributes: {
      _id: {type: 'objectAttribute', value: {type: 'string'}},
      _type: {type: 'objectAttribute', value: {type: 'string', value: 'product'}},
      sku: {type: 'objectAttribute', value: {type: 'string'}},
    },
    name: 'product',
    type: 'document',
  },
])

let root: string

async function project(files: Record<string, string>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'groq-content-mapper-schemas-'))
  await Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      await mkdir(join(root, name, '..'), {recursive: true})
      await writeFile(join(root, name), content)
    }),
  )
  return root
}

afterEach(async () => {
  if (root) await rm(root, {force: true, recursive: true})
})

describe('parseGroqFilesOptions', () => {
  test('accepts a schema, or one schema per folder, or both', () => {
    const one = {schema: 'schema.json'}
    expect(parseGroqFilesOptions(one)).toEqual({issues: [], options: one})
    const several = {schemas: [{include: ['a', 'b'], schema: 'a.json'}]}
    expect(parseGroqFilesOptions(several)).toEqual({issues: [], options: several})
    const both = {...one, ...several}
    expect(parseGroqFilesOptions(both)).toEqual({issues: [], options: both})
  })

  test('requires one of them', () => {
    for (const input of [undefined, {}, {schemas: []}]) {
      const {issues, options} = parseGroqFilesOptions(input)
      expect(issues).toEqual([{message: expect.stringContaining('Set "schema"'), path: []}])
      expect(options.schema).toBeUndefined()
    }
    expect(parseGroqFilesOptions('schema.json')).toEqual({
      issues: [{message: 'The options must be an object.', path: []}],
      options: {},
    })
  })

  test('reports each problem at its path and keeps what is well-formed', () => {
    const {issues, options} = parseGroqFilesOptions({
      schema: 'schema.json',
      schemas: [
        {include: 'ok', schema: 'ok.json'},
        'nope',
        {include: 42, schema: 'x.json'},
        {include: [], schema: 'y.json'},
        {include: 'z', schema: 'z.json', typo: true},
      ],
      typo: true,
    })
    expect(options).toEqual({schema: 'schema.json', schemas: [{include: 'ok', schema: 'ok.json'}]})
    expect(issues.map(({path}) => path)).toEqual([
      ['typo'],
      ['schemas', 1],
      ['schemas', 2, 'include'],
      ['schemas', 3, 'include'],
      ['schemas', 4, 'typo'],
    ])
    expect(parseGroqFilesOptions({schema: 7}).issues).toEqual([
      {message: expect.stringContaining('"schema" must be'), path: ['schema']},
      {message: expect.stringContaining('Set "schema"'), path: []},
    ])
    expect(
      parseGroqFilesOptions({
        schema: 's.json',
        schemas: [
          {include: ['src', 3], schema: 'a.json'},
          {include: 'src'},
          {include: 'src', schema: 'a.json', typo: 1},
          ['src', 'a.json'],
          {include: 42, schema: ''},
        ],
      }).issues,
    ).toEqual([
      {
        message: 'A folder or glob in "include" must be a path.',
        path: ['schemas', 0, 'include', 1],
      },
      {
        message: '"schema" is required: a "schemas" entry has "include" and "schema".',
        path: ['schemas', 1, 'schema'],
      },
      {
        message: 'Unknown key "typo". A "schemas" entry has "include" and "schema".',
        path: ['schemas', 2, 'typo'],
      },
      {
        message: 'A "schemas" entry must be an object with "include" and "schema".',
        path: ['schemas', 3],
      },
      {
        message: '"include" must be a folder, a glob, or a list of them.',
        path: ['schemas', 4, 'include'],
      },
      {message: '"schema" must not be empty.', path: ['schemas', 4, 'schema']},
    ])
    expect(parseGroqFilesOptions({schemas: {include: 'a', schema: 'a.json'}}).issues[0]).toEqual({
      message: expect.stringContaining('list'),
      path: ['schemas'],
    })
  })
})

describe('resolveGroqFiles', () => {
  test('reads the schema and watches it', async () => {
    const dir = await project({'schemas/main.json': await readFile(SCHEMA, 'utf8')})
    const resolved = await resolveGroqFiles({options: {schema: './schemas/main.json'}, root: dir})
    expect(resolved.fallback?.schemaPath).toBe(join(dir, 'schemas', 'main.json'))
    expect(resolved.fallback?.schema).toHaveLength(6)
    expect(resolved.fallback?.bytes).toBeInstanceOf(Buffer)
    expect(resolved.watchedFiles).toEqual([join(dir, 'schemas', 'main.json')])
    expect(schemaFor(resolved, join(dir, 'anywhere', 'posts.groq'))).toBe(resolved.fallback)
  })

  test('explains a missing or malformed schema instead of throwing', async () => {
    const dir = await project({'invalid.json': '{', 'object.json': '{"types": []}'})
    const missing = await resolveGroqFiles({options: {schema: 'nope.json'}, root: dir})
    expect(missing.fallback?.schema).toBeUndefined()
    expect(missing.fallback?.error).toContain('sanity schema extract')
    // Watched even while missing, so that creating it reopens the project.
    expect(missing.watchedFiles).toEqual([join(dir, 'nope.json')])

    const object = await resolveGroqFiles({options: {schema: 'object.json'}, root: dir})
    expect(object.fallback?.error).toContain('is not the array')
    const invalid = await resolveGroqFiles({options: {schema: 'invalid.json'}, root: dir})
    expect(invalid.fallback?.error).toContain('Could not parse')
  })

  test('types each folder against its own schema, the deepest folder winning', async () => {
    const dir = await project({
      'schema.json': await readFile(SCHEMA, 'utf8'),
      'shop/schema.json': SHOP_SCHEMA,
    })
    const resolved = await resolveGroqFiles({
      options: {
        schema: 'schema.json',
        schemas: [
          {include: ['src/shop', 'src/checkout'], schema: 'shop/schema.json'},
          {include: 'src/shop/legacy', schema: './schema.json'},
        ],
      },
      root: dir,
    })
    const schemaPathFor = (file: string) => schemaFor(resolved, join(dir, file)).schemaPath

    expect(schemaPathFor('src/shop/products.groq')).toBe(join(dir, 'shop', 'schema.json'))
    expect(schemaPathFor('src/checkout/deep/cart.groq')).toBe(join(dir, 'shop', 'schema.json'))
    expect(schemaPathFor('src/shop/legacy/old.groq')).toBe(join(dir, 'schema.json'))
    expect(schemaPathFor('src/blog/posts.groq')).toBe(join(dir, 'schema.json'))
    // A sibling whose name merely starts with a folder's name is not inside it.
    expect(schemaPathFor('src/shopping/list.groq')).toBe(join(dir, 'schema.json'))
    expect(resolved.watchedFiles).toEqual([
      join(dir, 'schema.json'),
      join(dir, 'shop', 'schema.json'),
    ])
  })

  test('includes by glob, alongside folders', async () => {
    const dir = await project({
      'schema.json': await readFile(SCHEMA, 'utf8'),
      'shop/schema.json': SHOP_SCHEMA,
    })
    const resolved = await resolveGroqFiles({
      options: {
        schemas: [
          {include: ['src/*/shop', 'src/checkout/**/cart*.groq'], schema: 'shop/schema.json'},
          {include: 'src/**/*.groq', schema: 'schema.json'},
          {include: 'src/eu/shop/legacy', schema: 'schema.json'},
        ],
      },
      root: dir,
    })
    const schemaPathFor = (file: string) => schemaFor(resolved, join(dir, file)).schemaPath

    expect(schemaPathFor('src/posts.groq')).toBe(join(dir, 'schema.json'))
    expect(schemaPathFor('src/blog/deep/posts.groq')).toBe(join(dir, 'schema.json'))
    // Both globs are as deep as `src`, and of equally deep entries the first listed wins.
    expect(schemaPathFor('src/eu/shop/products.groq')).toBe(join(dir, 'shop', 'schema.json'))
    expect(schemaPathFor('src/eu/shop/deep/products.groq')).toBe(join(dir, 'shop', 'schema.json'))
    expect(schemaPathFor('src/checkout/a/cart.groq')).toBe(join(dir, 'shop', 'schema.json'))
    expect(schemaPathFor('src/checkout/a/order.groq')).toBe(join(dir, 'schema.json'))
    // A folder deeper than a glob's wins over it.
    expect(schemaPathFor('src/eu/shop/legacy/old.groq')).toBe(join(dir, 'schema.json'))
    expect(schemaFor(resolved, join(dir, 'lib', 'a.groq')).error).toContain('outside every')
  })

  test('says so when no folder claims a file and there is no schema for the rest', async () => {
    const dir = await project({'shop/schema.json': SHOP_SCHEMA})
    const resolved = await resolveGroqFiles({
      options: {schemas: [{include: 'src/shop', schema: 'shop/schema.json'}]},
      root: dir,
    })
    expect(resolved.fallback).toBeUndefined()
    expect(schemaFor(resolved, join(dir, 'src', 'shop', 'a.groq')).schema).toBeDefined()
    expect(schemaFor(resolved, join(dir, 'src', 'blog', 'a.groq'))).toEqual({
      error: 'This file is outside every "schemas" folder, and no "schema" is set for the rest.',
    })
    expect(
      schemaFor(await resolveGroqFiles({options: {}, root: dir}), join(dir, 'a.groq')),
    ).toEqual({
      error: expect.stringContaining('No schema is configured'),
    })
  })

  test('requires absolute paths when there is no tsconfig to resolve against', async () => {
    const dir = await project({'schema.json': await readFile(SCHEMA, 'utf8')})
    const relative = await resolveGroqFiles({
      options: {schema: 'schema.json', schemas: [{include: 'src', schema: 'schema.json'}]},
    })
    expect(relative.fallback?.error).toContain('must be an absolute path')
    expect(relative.scopes[0]?.error).toContain('must be an absolute path')
    expect(relative.scopes[0]?.includes).toEqual([])
    expect(relative.watchedFiles).toEqual([])

    const absolute = await resolveGroqFiles({
      options: {
        schema: join(dir, 'schema.json'),
        schemas: [{include: join(dir, 'src'), schema: join(dir, 'schema.json')}],
      },
    })
    expect(absolute.fallback?.schema).toBeDefined()
    expect(schemaFor(absolute, join(dir, 'src', 'a.groq'))).toBe(absolute.scopes[0])
    expect(schemaFor(absolute, join(dir, 'other', 'a.groq'))).toBe(absolute.fallback)
  })

  test('a file system root as a folder contains every file', async () => {
    const dir = await project({'schema.json': await readFile(SCHEMA, 'utf8')})
    const resolved = await resolveGroqFiles({
      options: {schemas: [{include: parse(dir).root, schema: 'schema.json'}]},
      root: dir,
    })
    expect(schemaFor(resolved, join(dir, 'src', 'a.groq'))).toBe(resolved.scopes[0])
  })
})
