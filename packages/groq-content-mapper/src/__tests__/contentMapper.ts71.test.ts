import {access, cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeAll, describe, expect, test} from 'vitest'

import {
  exampleTsconfig,
  FIXTURES,
  hoverTs71,
  linkPackage,
  PACKAGE_ROOT,
  postCardsWithFunctions,
  runTsc71,
  writeExampleProject,
} from './exampleProject.js'

// Drives the built mapper, `dist/bin/contentMapper.js`, through a real TypeScript 7.1 `tsc`.
// `pnpm test` builds first; run `pnpm build` before running this file on its own.
const MAPPER = join(PACKAGE_ROOT, 'dist', 'bin', 'contentMapper.js')
const ENTRY = {extensions: ['.groq'], package: '@sanity-labs/groq-content-mapper'}

const SHOP_SCHEMA = JSON.stringify([
  {
    attributes: {
      _id: {type: 'objectAttribute', value: {type: 'string'}},
      _type: {type: 'objectAttribute', value: {type: 'string', value: 'product'}},
      price: {type: 'objectAttribute', value: {type: 'number'}},
      sku: {type: 'objectAttribute', value: {type: 'string'}},
    },
    name: 'product',
    type: 'document',
  },
])

const SHOP_CHECK = `import products, {type QueryParams, type QueryResponse} from './products.groq'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

export type _Products = Expect<Equal<QueryResponse, Array<{sku: string; price: number}>>>
export type _NoParams = Expect<Equal<QueryParams, Record<string, never>>>
export const text: string = products
`

let directory: string

async function setup(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), 'groq-content-mapper-ts71-'))
  await linkPackage(directory)
  return directory
}

beforeAll(async () => {
  await access(MAPPER).catch(() => {
    throw new Error(`${MAPPER} is missing. Run "pnpm build" first.`)
  })
})

afterEach(async () => {
  if (!directory) return
  // Windows keeps a directory locked briefly after the language server and its content mapper
  // exit. The hover test waits for them; this still retries if the handle is slow to drop.
  for (let attempt = 0; ; attempt++) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- retries are sequential after EBUSY/EPERM
      await rm(directory, {force: true, recursive: true})
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if ((code !== 'EBUSY' && code !== 'EPERM') || attempt === 20) throw error
      // oxlint-disable-next-line no-await-in-loop -- each retry waits for the previous lock
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
})

describe('TypeScript 7.1 content mapper', () => {
  test('type-checks the example through --runExternalCode', async () => {
    const dir = await setup()
    await writeExampleProject(dir)
    await writeFile(
      join(dir, 'tsconfig.json'),
      exampleTsconfig({contentMappers: [{...ENTRY, options: {schema: './schema.json'}}]}),
    )

    expect(await runTsc71(dir)).toBe('')
  }, 120_000)

  test('shows the query as written on its own lines when the import is hovered', async () => {
    const dir = await setup()
    await writeExampleProject(dir)
    await writeFile(
      join(dir, 'tsconfig.json'),
      exampleTsconfig({contentMappers: [{...ENTRY, options: {schema: './schema.json'}}]}),
    )
    const source = await readFile(join(FIXTURES, 'queries', 'postsBySearch.groq'), 'utf8')
    const shown = source.replace(/(?:\r?\n)+$/, '')
    expect(shown.split('\n').length).toBeGreaterThan(1)

    // Line 6 of check.ts: `import postsBySearch from './queries/postsBySearch.groq'`.
    const markdown = await hoverTs71(dir, 'check.ts', {character: 10, line: 5})
    // The signature escapes the line breaks; the doc comment below it keeps the source's.
    expect(markdown).toContain(`const query: ${JSON.stringify(source)} & {`)
    expect(markdown).toContain(`\`\`\`groq\n${shown}\n\`\`\``)
    expect(markdown).toContain(') | order(_score desc) [$start...$end] {')
  }, 120_000)

  test('reports a syntax error at the .groq file, with groq as the source', async () => {
    const dir = await setup()
    await writeExampleProject(dir)
    await writeFile(join(dir, 'bad.groq'), '*[_type == "post"\n')
    await writeFile(join(dir, 'check.ts'), "import bad from './bad.groq'\n\nexport {bad}\n")
    await writeFile(
      join(dir, 'tsconfig.json'),
      exampleTsconfig({contentMappers: [{...ENTRY, options: {schema: './schema.json'}}]}),
    )

    await expect(runTsc71(dir)).rejects.toThrow(/bad\.groq\(1,18\): error groq2: Syntax error/)
  }, 120_000)

  test('types two folders against two schemas from one mapper entry, with `schemas`', async () => {
    const dir = await setup()
    await writeExampleProject(join(dir, 'blog'))
    await mkdir(join(dir, 'shop'))
    await writeFile(join(dir, 'shop', 'schema.json'), SHOP_SCHEMA)
    await writeFile(join(dir, 'shop', 'products.groq'), '*[_type == "product"]{sku, price}\n')
    await writeFile(join(dir, 'shop', 'check.ts'), SHOP_CHECK)
    await writeFile(
      join(dir, 'tsconfig.json'),
      exampleTsconfig({
        contentMappers: [
          {
            ...ENTRY,
            options: {
              schemas: [
                {include: 'blog', schema: 'blog/schema.json'},
                {include: 'shop', schema: 'shop/schema.json'},
              ],
            },
          },
        ],
        files: ['blog/check.ts', 'shop/check.ts'],
      }),
    )

    expect(await runTsc71(dir)).toBe('')
  }, 120_000)

  test('scopes `schemas` by glob', async () => {
    const dir = await setup()
    await writeExampleProject(join(dir, 'blog'))
    await mkdir(join(dir, 'shop'))
    await writeFile(join(dir, 'shop', 'schema.json'), SHOP_SCHEMA)
    await writeFile(join(dir, 'shop', 'products.groq'), '*[_type == "product"]{sku, price}\n')
    await writeFile(join(dir, 'shop', 'check.ts'), SHOP_CHECK)
    await writeFile(
      join(dir, 'tsconfig.json'),
      exampleTsconfig({
        contentMappers: [
          {
            ...ENTRY,
            options: {
              schemas: [
                {include: 'blog/**/*.groq', schema: 'blog/schema.json'},
                {include: '*/products.groq', schema: 'shop/schema.json'},
              ],
            },
          },
        ],
        files: ['blog/check.ts', 'shop/check.ts'],
      }),
    )

    expect(await runTsc71(dir)).toBe('')
  }, 120_000)

  test('resolves a package.json `imports` alias to the file, so its folder\u2019s schema applies', async () => {
    const dir = await setup()
    await writeExampleProject(join(dir, 'src', 'queries', 'blog'))
    await mkdir(join(dir, 'src', 'queries', 'shop'), {recursive: true})
    await writeFile(join(dir, 'src', 'queries', 'shop', 'schema.json'), SHOP_SCHEMA)
    await writeFile(
      join(dir, 'src', 'queries', 'shop', 'products.groq'),
      '*[_type == "product"]{sku, price}\n',
    )
    // The alias names the folder, and the mapper sees the resolved path under it.
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({imports: {'#queries/*': './src/queries/*'}, type: 'module'}),
    )
    await writeFile(
      join(dir, 'src', 'check.ts'),
      `import posts from '#queries/blog/queries/posts.groq'
import products from '#queries/shop/products.groq'
import type {QueryResponse as Posts} from '#queries/blog/queries/posts.groq'
import type {QueryResponse as Products} from '#queries/shop/products.groq'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

export type _Posts = Expect<Equal<Posts, Array<{title: string | null; role: 'admin' | 'member' | null}>>>
export type _Products = Expect<Equal<Products, Array<{sku: string; price: number}>>>
export const text: string = posts + products
`,
    )
    await writeFile(
      join(dir, 'tsconfig.json'),
      exampleTsconfig({
        contentMappers: [
          {
            ...ENTRY,
            options: {
              schemas: [
                {include: 'src/queries/blog', schema: 'src/queries/blog/schema.json'},
                {include: 'src/queries/shop', schema: 'src/queries/shop/schema.json'},
              ],
            },
          },
        ],
        files: ['src/check.ts'],
      }),
    )

    expect(await runTsc71(dir)).toBe('')
  }, 120_000)

  test('reports a misspelled option against the tsconfig', async () => {
    const dir = await setup()
    await writeExampleProject(dir)
    await writeFile(
      join(dir, 'tsconfig.json'),
      exampleTsconfig({
        contentMappers: [{...ENTRY, options: {schema: './schema.json', shcema: 1}}],
      }),
    )

    await expect(runTsc71(dir)).rejects.toThrow(/tsconfig\.json\(\d+,\d+\): error groq1: .*shcema/)
  }, 120_000)

  test('types the query as written with the custom functions it calls prepended', async () => {
    const dir = await setup()
    await writeExampleProject(dir)
    await cp(join(FIXTURES, 'functions'), dir, {recursive: true})
    const typed = await postCardsWithFunctions(dir, {minify: false})
    const delivered = await postCardsWithFunctions(dir)
    await writeFile(
      join(dir, 'check.ts'),
      `import postCards, {type QueryResponse} from './postCards.groq'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const typed = ${JSON.stringify(typed)}
const delivered = ${JSON.stringify(delivered)}
export const text: typeof typed = postCards
// @ts-expect-error the type is the query as written, not the string a loader delivers
export const runtime: typeof postCards = delivered
export type _Cards = Expect<Equal<QueryResponse, Array<{card: {title: string | null; slug: string; author: {name: string | null; slug: string | null} | null}}>>>
`,
    )
    const options = {functions: 'lib/*.groq', schema: './schema.json'}
    await writeFile(
      join(dir, 'tsconfig.json'),
      exampleTsconfig({contentMappers: [{...ENTRY, options}]}),
    )
    expect(await runTsc71(dir)).toBe('')

    await writeFile(
      join(dir, 'lib', 'author.groq'),
      'fn author::summary($author) = $author.name;\n',
    )
    await expect(runTsc71(dir)).rejects.toThrow(
      /postCards\.groq\(1,1\): error groq5: The custom GROQ functions cannot all be used:\n- Invalid function definition author::summary .*must be a projection/,
    )
  }, 120_000)
})
