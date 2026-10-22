import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PassThrough} from 'node:stream'

import {afterEach, describe, expect, test} from 'vitest'

import {ContentMapper, DIAGNOSTIC_SOURCE} from '../contentMapper.js'
import {GroqFileDiagnosticCode} from '../groqModule.js'
import {decode, frame} from './jsonRpc.test.js'

const SCHEMA = new URL('fixtures/schema.json', import.meta.url)
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

interface Transformed {
  extension: string
  text: string

  diagnostics?: {code: number; length: number; messageText: string; start: number}[]
}

interface Opened {
  configIdentity: string
  watchedFiles: string[]

  optionDiagnostics?: {code: number; messageText: string; path: (number | string)[]}[]
}

let directory: string

async function project(files: Record<string, string> = {}): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), 'groq-content-mapper-mapper-'))
  await Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      await mkdir(join(directory, name, '..'), {recursive: true})
      await writeFile(join(directory, name), content)
    }),
  )
  return directory
}

afterEach(async () => {
  if (directory) await rm(directory, {force: true, recursive: true})
})

describe('ContentMapper', () => {
  test('serves initialize, openProject, transform and closeProject over stdio framing', async () => {
    const dir = await project({'schema.json': await readFile(SCHEMA, 'utf8')})
    const input = new PassThrough()
    const output = new PassThrough()
    const written: Buffer[] = []
    output.on('data', (chunk: Buffer) => written.push(chunk))
    const served = new ContentMapper().serve({input, output})

    const messages = [
      {
        id: 'api1',
        jsonrpc: '2.0',
        method: 'initialize',
        params: {positionEncodings: ['utf-8', 'utf-16'], protocolVersion: 1},
      },
      {
        id: 'api2',
        jsonrpc: '2.0',
        method: 'openProject',
        params: {
          compilerOptions: {strict: true},
          configFileName: join(dir, 'tsconfig.json'),
          options: {schema: './schema.json'},
          projectHandle: '@sanity-labs/groq-content-mapper@0:0',
        },
      },
      {
        id: 'api3',
        jsonrpc: '2.0',
        method: 'transform',
        params: {
          content: '*[_type == "post" && slug.current == $slug][0]{title}\n',
          fileName: join(dir, 'src', 'postBySlug.groq'),
          projectHandle: '@sanity-labs/groq-content-mapper@0:0',
        },
      },
      {
        id: 'api4',
        jsonrpc: '2.0',
        method: 'closeProject',
        params: {projectHandle: '@sanity-labs/groq-content-mapper@0:0'},
      },
      {id: 'api5', jsonrpc: '2.0', method: 'nope', params: {}},
    ]
    for (const message of messages) input.write(frame(message))
    input.end()
    await served

    const responses = decode(Buffer.concat(written))
    expect(responses.map((response) => response.id)).toEqual([
      'api1',
      'api2',
      'api3',
      'api4',
      'api5',
    ])
    expect(responses[0]?.result).toEqual({
      diagnosticSource: DIAGNOSTIC_SOURCE,
      positionEncoding: 'utf-16',
      protocolVersion: 1,
    })
    const opened = responses[1]?.result as Opened
    expect(opened.configIdentity).toMatch(/^[a-f0-9]{64}$/)
    expect(opened.optionDiagnostics).toBeUndefined()
    expect(opened.watchedFiles).toEqual([join(dir, 'schema.json')])
    const transformed = responses[2]?.result as Transformed
    expect(transformed.extension).toBe('.mts')
    expect(transformed.diagnostics).toBeUndefined()
    expect(transformed.text).toContain('// Source: src/postBySlug.groq')
    expect(transformed.text).toContain('slug: string;')
    expect(transformed.text).toContain('export default query;')
    expect(responses[3]?.result).toEqual({})
    expect(responses[4]?.error).toEqual(expect.objectContaining({code: -32_601}))
  })

  test('refuses a host that cannot take utf-16 positions, or speaks another protocol', async () => {
    const mapper = new ContentMapper()
    await expect(mapper.handle('initialize', {positionEncodings: ['utf-8']})).rejects.toMatchObject(
      {code: -32_602},
    )
    await expect(
      mapper.handle('initialize', {positionEncodings: ['utf-16'], protocolVersion: 2}),
    ).rejects.toMatchObject({code: -32_602, message: expect.stringContaining('version 1')})
    // The 7.1 beta sends no version and ignores the one answered.
    await expect(mapper.handle('initialize', {positionEncodings: ['utf-16']})).resolves.toEqual({
      diagnosticSource: DIAGNOSTIC_SOURCE,
      positionEncoding: 'utf-16',
      protocolVersion: 1,
    })
  })

  test('reports an entry without options against the entry, and types nothing until it has them', async () => {
    const dir = await project({'schema.json': await readFile(SCHEMA, 'utf8')})
    const mapper = new ContentMapper()
    const opened = (await mapper.handle('openProject', {
      compilerOptions: {},
      configFileName: join(dir, 'tsconfig.json'),
      projectHandle: 'p',
    })) as Opened
    expect(opened.optionDiagnostics).toEqual([
      {code: 1, messageText: expect.stringContaining('Set "schema"'), path: []},
    ])
    expect(opened.watchedFiles).toEqual([])

    const transformed = (await mapper.handle('transform', {
      content: '*[_type == "post"]{title}',
      fileName: join(dir, 'posts.groq'),
      projectHandle: 'p',
    })) as Transformed
    expect(transformed.diagnostics).toEqual([
      expect.objectContaining({
        code: GroqFileDiagnosticCode.SchemaUnavailable,
        messageText: expect.stringContaining('No schema is configured'),
      }),
    ])
    expect(transformed.text).toContain('export type QueryResponse = unknown;')
    expect(transformed.text).toContain('export default query;')
  })

  test('changes the config identity when a schema changes', async () => {
    const dir = await project({'schema.json': await readFile(SCHEMA, 'utf8')})
    const mapper = new ContentMapper()
    const open = async () =>
      (await mapper.handle('openProject', {
        compilerOptions: {},
        configFileName: join(dir, 'tsconfig.json'),
        options: {schema: './schema.json'},
        projectHandle: 'p',
      })) as Opened
    const before = (await open()).configIdentity
    expect((await open()).configIdentity).toBe(before)
    await writeFile(join(dir, 'schema.json'), '[]')
    expect((await open()).configIdentity).not.toBe(before)
  })

  test('returns a module and a diagnostic for a file it cannot type', async () => {
    const dir = await project({'schema.json': await readFile(SCHEMA, 'utf8')})
    const mapper = new ContentMapper()
    await mapper.handle('openProject', {
      configFileName: join(dir, 'tsconfig.json'),
      options: {schema: './schema.json'},
      projectHandle: 'p',
    })

    const transformed = (await mapper.handle('transform', {
      content: '*[',
      fileName: join(dir, 'bad.groq'),
      projectHandle: 'p',
    })) as Transformed
    expect(transformed.diagnostics).toEqual([
      expect.objectContaining({code: GroqFileDiagnosticCode.SyntaxError, start: 1}),
    ])
    expect(transformed.text).toContain('export default query;')
  })

  test('reports a missing schema file on every file, and keeps the imports resolving', async () => {
    const dir = await project()
    const mapper = new ContentMapper()
    const opened = (await mapper.handle('openProject', {
      configFileName: join(dir, 'tsconfig.json'),
      options: {schema: './schema.json'},
      projectHandle: 'p',
    })) as Opened
    expect(opened.optionDiagnostics).toBeUndefined()
    // Watched while missing, so that `sanity schema extract` reopens the project.
    expect(opened.watchedFiles).toEqual([join(dir, 'schema.json')])

    const transformed = (await mapper.handle('transform', {
      content: '*[_type == "post"]{title}',
      fileName: join(dir, 'posts.groq'),
      projectHandle: 'p',
    })) as Transformed
    expect(transformed.diagnostics).toEqual([
      {
        code: GroqFileDiagnosticCode.SchemaUnavailable,
        length: 1,
        messageText: `No schema file at ${join(dir, 'schema.json')}. Run "sanity schema extract" to create it.`,
        start: 0,
      },
    ])
    expect(transformed.text).toContain('// No schema file at')
    expect(transformed.text).toContain('export type QueryResponse = unknown;')
    expect(transformed.text).toContain('export type QueryParams = Record<string, unknown>;')
    expect(transformed.text).toContain('export default query;')
  })

  test('reports malformed options at their path and still opens the project', async () => {
    const dir = await project({'schema.json': await readFile(SCHEMA, 'utf8')})
    const mapper = new ContentMapper()
    const opened = (await mapper.handle('openProject', {
      configFileName: join(dir, 'tsconfig.json'),
      options: {schema: './schema.json', schemas: [{include: 'src/shop'}], typo: true},
      projectHandle: 'p',
    })) as Opened
    expect(opened.optionDiagnostics).toEqual([
      {code: 1, messageText: expect.stringContaining('typo'), path: ['typo']},
      {code: 1, messageText: expect.stringContaining('schema'), path: ['schemas', 0, 'schema']},
    ])
    expect(opened.watchedFiles).toEqual([join(dir, 'schema.json')])

    const transformed = (await mapper.handle('transform', {
      content: '*[_type == "post"]{title}',
      fileName: join(dir, 'src', 'shop', 'posts.groq'),
      projectHandle: 'p',
    })) as Transformed
    expect(transformed.diagnostics).toBeUndefined()
    expect(transformed.text).toContain('title: string | null;')
  })

  test('types each folder against its own schema with `schemas`', async () => {
    const dir = await project({
      'blog/schema.json': await readFile(SCHEMA, 'utf8'),
      'shop/schema.json': SHOP_SCHEMA,
    })
    const mapper = new ContentMapper()
    const opened = (await mapper.handle('openProject', {
      configFileName: join(dir, 'tsconfig.json'),
      options: {
        schemas: [
          {include: 'blog', schema: 'blog/schema.json'},
          {include: ['shop', 'extra'], schema: './shop/schema.json'},
        ],
      },
      projectHandle: 'multi',
    })) as Opened
    expect(opened.optionDiagnostics).toBeUndefined()
    expect(opened.watchedFiles).toEqual([
      join(dir, 'blog', 'schema.json'),
      join(dir, 'shop', 'schema.json'),
    ])

    const typed = async (file: string, content: string) =>
      (await mapper.handle('transform', {
        content,
        fileName: join(dir, file),
        projectHandle: 'multi',
      })) as Transformed

    const posts = await typed('blog/queries/posts.groq', '*[_type == "post"]{title, role}')
    expect(posts.diagnostics).toBeUndefined()
    expect(posts.text).toContain('role: "admin" | "member" | null;')
    expect(posts.text).toContain('// Schema: blog/schema.json')

    const products = await typed('shop/products.groq', '*[_type == "product"]{sku, price}')
    expect(products.diagnostics).toBeUndefined()
    expect(products.text).toContain('sku: string;')
    expect(products.text).toContain('price: number;')
    expect(products.text).toContain('// Schema: shop/schema.json')

    const extra = await typed('extra/products.groq', '*[_type == "product"]{sku}')
    expect(extra.text).toContain('sku: string;')

    // The blog schema has no product type.
    const crossed = await typed('blog/products.groq', '*[_type == "product"]{sku}')
    expect(crossed.text).toContain('export type QueryResponse = Array<never>;')

    // Outside every folder, with no `schema` for the rest.
    const outside = await typed('posts.groq', '*[_type == "post"]{title}')
    expect(outside.diagnostics?.[0]?.messageText).toBe(
      'This file is outside every "schemas" folder, and no "schema" is set for the rest.',
    )
    expect(outside.text).toContain('export type QueryResponse = unknown;')
  })

  test('needs absolute paths for a project without a tsconfig', async () => {
    const dir = await project({'schema.json': await readFile(SCHEMA, 'utf8')})
    const mapper = new ContentMapper()

    const relative = (await mapper.handle('openProject', {
      configFileName: '',
      options: {schema: 'schema.json'},
      projectHandle: 'relative',
    })) as Opened
    expect(relative.watchedFiles).toEqual([])
    const untyped = (await mapper.handle('transform', {
      content: '*[_type == "post"]{title}',
      fileName: join(dir, 'posts.groq'),
      projectHandle: 'relative',
    })) as Transformed
    expect(untyped.diagnostics?.[0]?.messageText).toContain('must be an absolute path')
    expect(untyped.text).toContain('// Source: posts.groq')

    const absolute = (await mapper.handle('openProject', {
      configFileName: '',
      options: {schema: join(dir, 'schema.json')},
      projectHandle: 'absolute',
    })) as Opened
    expect(absolute.watchedFiles).toEqual([join(dir, 'schema.json')])
    const typed = (await mapper.handle('transform', {
      content: '*[_type == "post"]{title}',
      fileName: join(dir, 'posts.groq'),
      projectHandle: 'absolute',
    })) as Transformed
    expect(typed.diagnostics).toBeUndefined()
    expect(typed.text).toContain('title: string | null;')
  })

  test('rejects malformed params and unknown projects', async () => {
    const mapper = new ContentMapper()
    await expect(mapper.handle('openProject', {})).rejects.toMatchObject({code: -32_602})
    await expect(
      mapper.handle('transform', {content: '*', projectHandle: 'p'}),
    ).rejects.toMatchObject({
      code: -32_602,
    })
    await expect(
      mapper.handle('transform', {content: '*', fileName: 'x.groq', projectHandle: 'never-opened'}),
    ).rejects.toMatchObject({code: -32_602, message: 'Unknown project "never-opened".'})
    await expect(mapper.handle('closeProject', {})).rejects.toMatchObject({code: -32_602})
  })
})
