import {readFileSync} from 'node:fs'

import {type SchemaType} from 'groq-js'
import {describe, expect, test} from 'vitest'

import {generateGroqModule, GroqFileDiagnosticCode} from '../groqModule.js'

const schema = JSON.parse(
  readFileSync(new URL('fixtures/schema.json', import.meta.url), 'utf8'),
) as SchemaType

const strip = (code: string) => code.replace(/^\/\/ Source: .*$/m, '')

function generate(content: string, filename = '/app/src/queries/posts.groq') {
  return generateGroqModule({
    content,
    filename,
    root: '/app',
    schema,
    schemaPath: '/app/schema.json',
  })
}

describe('generateGroqModule', () => {
  test('exports the branded query as default and its two types, nothing else', () => {
    const content =
      '\n*[_type == "post" && slug.current == $slug][0]{title, "author": author->name}\n'
    const {code, diagnostics, query} = generate(content)

    // The literal is the file as it is, which is what a text import evaluates to.
    expect(diagnostics).toEqual([])
    expect(query).toBe(content)
    expect(code).toMatchInlineSnapshot(`
      "// Source: src/queries/posts.groq
      // Schema: schema.json
      /** The result of this query, as \`client.fetch\` resolves it. */
      export type QueryResponse = {
        title: string | null;
        author: string | null;
      } | null;

      /** The values for the \`$\` placeholders in this query. */
      export type QueryParams = {
        slug: string;
      };

      declare const query: "\\n*[_type == \\"post\\" && slug.current == $slug][0]{title, \\"author\\": author->name}\\n" & {
        readonly __groqResult?: QueryResponse;
        readonly __groqParams?: QueryParams;
      };

      export default query;

      "
    `)
  })

  test('declares nothing globally and imports nothing', () => {
    const {code} = generate('*[_type == "post"]')
    expect(code).not.toContain('declare global')
    expect(code).not.toContain('declare module')
    expect(code).not.toContain('import ')
    expect(code).not.toContain('SanityQueries')
    expect(code.match(/^export \w+/gm)).toEqual(['export type', 'export type', 'export default'])
  })

  test('includes only the schema types the result refers to, with what they need', () => {
    const {code} = generate('*[_type == "post"]{slug, author}')
    expect(code).toContain('declare const internalGroqTypeReferenceTo: unique symbol;')
    expect(code).toContain('type Slug = {')
    expect(code).toContain('type AuthorReference = {')
    expect(code).toContain('[internalGroqTypeReferenceTo]?: "author";')
    expect(code).not.toContain('CategoryReference')
    expect(code).not.toContain('export type Slug')
    expect(code).not.toContain('AllSanitySchemaTypes')

    const projection = generate('*[_type == "post"]{title}')
    expect(projection.code).not.toContain('internalGroqTypeReferenceTo')
    expect(projection.code).not.toContain('type Slug')
  })

  test('includes the schema types the params refer to', () => {
    const {code} = generate('*[_type == "post" && slug == $slug]{title}')
    expect(code).toContain('type Slug = {')
    expect(code).toContain('slug: Slug;')
  })

  test('types a query without placeholders as taking no params', () => {
    const {code} = generate('*[_type == "post"]{title}')
    expect(code).toContain('export type QueryParams = Record<string, never>;')
    expect(code).toContain('export type QueryResponse = Array<{\n  title: string | null;\n}>;')
  })

  test('types slice bounds as numbers and keeps the query text as written', () => {
    const content = `*[_type == "post"] | score(
  boost(title match $searchQuery, 10),
  text::semanticSimilarity($searchQuery)
) | order(_score desc) [$start...$end] {
  _id,
  title,
  slug,
  "_score": _score
}`
    const {code, query} = generate(content)
    expect(query).toBe(content)
    expect(code).toContain(
      'export type QueryParams = {\n  searchQuery: string;\n  start: number;\n  end: number;\n};',
    )
    expect(code).toContain(`declare const query: ${JSON.stringify(content)} & {`)
  })

  test('writes the same module for the same query in two files, apart from the source', () => {
    const a = generate('*[_type == "post"]{title, author}', '/app/a.groq')
    const b = generate('*[_type == "post"]{title, author}', '/app/b.groq')
    expect(strip(a.code)).toBe(strip(b.code))
    expect(a.code).toContain('// Source: a.groq')
  })

  test('keeps the import resolving for an empty file, with a diagnostic', () => {
    const {code, diagnostics, query} = generate('  \n')
    expect(query).toBe('  \n')
    expect(diagnostics).toEqual([
      {
        code: GroqFileDiagnosticCode.EmptyFile,
        length: 3,
        messageText: 'This .groq file has no query.',
        start: 0,
      },
    ])
    expect(code).toContain('export type QueryResponse = unknown;')
    expect(code).toContain('export type QueryParams = Record<string, unknown>;')
    expect(code).toContain('declare const query: "  \\n" & {')
  })

  test('points a syntax error at its position in the file', () => {
    const {code, diagnostics} = generate('\n  *[_type == "post"')
    expect(diagnostics).toEqual([
      {
        code: GroqFileDiagnosticCode.SyntaxError,
        length: 1,
        messageText: 'Syntax error in GROQ query at position 19: Unexpected end of query',
        start: 19,
      },
    ])
    expect(code).toContain('export type QueryResponse = unknown;')
    expect(code).toContain('export default query;')

    // A position past the end of the content is clamped to it.
    const atEnd = generate('  ')
    expect(atEnd.diagnostics[0]).toMatchObject({length: 2, start: 0})
    expect(generate('*[').diagnostics[0]).toMatchObject({length: 1, start: 1})
  })

  test('types a file whose last line is a comment', () => {
    for (const content of ['*[_type == "post"]{title} // the titles', '*[_type == "post"]\n//']) {
      const {code, diagnostics} = generate(content)
      expect(diagnostics).toEqual([])
      expect(code).toContain('export type QueryResponse = Array<{')
    }
  })

  test('reports a query the schema cannot type, and notes it in the module', () => {
    const {code, diagnostics} = generateGroqModule({
      content: '*[_type == "post"]{title}',
      filename: 'posts.groq',
      schema: [{name: 'post', type: 'nope'}] as unknown as SchemaType,
    })
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: GroqFileDiagnosticCode.EvaluationFailed,
        length: 25,
        start: 0,
      }),
    ])
    expect(diagnostics[0]?.messageText).toMatch(/^Could not type this query against the schema: /)
    expect(code).toContain('// Could not type this query against the schema: ')
    expect(code).toContain('export type QueryResponse = unknown;')
    expect(code).not.toContain('// Schema:')
  })
})

describe('TypeGenerator.generateGroqModule with a schema type named like an export', () => {
  test('renames the alias within the module so the exports keep their names', () => {
    const {code} = generateGroqModule({
      content: '*[_type == "queryResponse"]{title, "p": params}',
      filename: 'odd.groq',
      schema: [
        {
          attributes: {
            _id: {type: 'objectAttribute', value: {type: 'string'}},
            _type: {type: 'objectAttribute', value: {type: 'string', value: 'queryResponse'}},
            params: {type: 'objectAttribute', value: {name: 'queryParams', type: 'inline'}},
            title: {type: 'objectAttribute', value: {type: 'string'}},
          },
          name: 'queryResponse',
          type: 'document',
        },
        {
          name: 'queryParams',
          type: 'type',
          value: {
            attributes: {q: {type: 'objectAttribute', value: {type: 'string'}}},
            type: 'object',
          },
        },
      ],
    })
    expect(code).toContain('type QueryParams_2 = {')
    expect(code).toContain('p: QueryParams_2;')
    expect(code).toContain('export type QueryResponse = Array<{')
    expect(code).toContain('export type QueryParams = Record<string, never>;')
    expect(code).not.toContain('type QueryResponse_2')
  })

  test('renames a schema type named record, which would shadow the params type', () => {
    const {code} = generateGroqModule({
      content: '*[_type == "album"]{"r": record}',
      filename: 'albums.groq',
      schema: [
        {
          attributes: {
            _id: {type: 'objectAttribute', value: {type: 'string'}},
            _type: {type: 'objectAttribute', value: {type: 'string', value: 'album'}},
            record: {type: 'objectAttribute', value: {name: 'record', type: 'inline'}},
          },
          name: 'album',
          type: 'document',
        },
        {name: 'record', type: 'type', value: {type: 'string'}},
      ],
    })
    expect(code).toContain('type Record_2 = string;')
    expect(code).toContain('r: Record_2;')
    expect(code).toContain('export type QueryParams = Record<string, never>;')
    expect(code).not.toMatch(/type Record\b/)
  })
})
