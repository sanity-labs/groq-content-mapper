import {execFile} from 'node:child_process'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

import {SchemaTypeGenerator} from '@sanity/codegen'
import * as fc from 'fast-check'
import {type SchemaType, type TypeNode} from 'groq-js'
import {expect, test} from 'vitest'

import {generateGroqModule} from '../groqModule.js'
import {FUZZ_TIMEOUT, fuzzOptions} from './fuzz/fuzz.js'

const execFileAsync = promisify(execFile)
const TSC = fileURLToPath(new URL('bin/tsc', import.meta.resolve('typescript/package.json')))

/**
 * Names that collide with what a module declares, with TypeScript, or with each other. Not
 * `Array`: see the `test.fails` below.
 */
const typeName = fc.constantFrom(
  'post',
  'QueryResponse',
  'QueryParams',
  'query',
  'ArrayOf',
  'internalGroqTypeReferenceTo',
  'foo-bar',
  'fooBar',
  'FooBar',
  '1st',
  'ünïcode',
  'with space',
  'sanity.imageAsset',
  'default',
  'class',
  'Record',
  'string',
  'unknown',
)

const attributeName = fc.constantFrom(
  'title',
  'with-dash',
  'with space',
  '0lead',
  'default',
  'constructor',
  'ü',
  '"quote',
  "it's",
  String.raw`back\slash`,
  '$dollar',
  '*/',
)

function valueType(names: string[]): fc.Arbitrary<TypeNode> {
  return fc.letrec<{value: TypeNode}>((tie) => ({
    value: fc.oneof(
      {depthSize: 'small', withCrossShrink: true},
      fc.constantFrom<TypeNode>(
        {type: 'string'},
        {type: 'number'},
        {type: 'boolean'},
        {type: 'null'},
        {type: 'unknown'},
        {type: 'string', value: 'a"b'},
        {type: 'string', value: '*/'},
        {type: 'number', value: -1},
        {type: 'boolean', value: true},
      ),
      fc.constantFrom(...names).map((name): TypeNode => ({name, type: 'inline'})),
      tie('value').map((of): TypeNode => ({of, type: 'array'})),
      fc
        .array(tie('value'), {maxLength: 3, minLength: 1})
        .map((of): TypeNode => ({of, type: 'union'})),
      fc.dictionary(attributeName, tie('value'), {maxKeys: 3}).map((attributes): TypeNode => ({
        attributes: Object.fromEntries(
          Object.entries(attributes).map(([key, value]) => [key, {type: 'objectAttribute', value}]),
        ),
        type: 'object',
      })),
    ),
  })).value
}

/** A schema of documents and named types, with names that are awkward in TypeScript. */
const schemaWithQuery = fc.uniqueArray(typeName, {maxLength: 5, minLength: 1}).chain((names) =>
  fc
    .tuple(
      fc.tuple(
        ...names.map((name) =>
          fc.record({
            attributes: fc.dictionary(
              attributeName,
              fc.record({optional: fc.boolean(), value: valueType(names)}),
              {maxKeys: 3},
            ),
            document: fc.boolean(),
            name: fc.constant(name),
          }),
        ),
      ),
      fc.constantFrom(...names),
      attributeName,
      fc.constantFrom(
        (type: string) => `*[_type == ${JSON.stringify(type)}]`,
        (type: string) => `*[_type == ${JSON.stringify(type)}][0]`,
        (type: string, attribute: string) =>
          `*[_type == ${JSON.stringify(type)}]{"v": @[${JSON.stringify(attribute)}]}`,
        (type: string, attribute: string) =>
          `*[_type == ${JSON.stringify(type)} && @[${JSON.stringify(attribute)}] == $p][0]{...}`,
        () => '*',
        () => '*{..., "refs": *[references(^._id)]}',
      ),
    )
    .map(([types, picked, attribute, render]) => {
      const schema: SchemaType = types.map(({attributes, document, name}) => {
        const entries = Object.fromEntries(
          Object.entries(attributes).map(([key, {optional, value}]) => [
            key,
            {optional, type: 'objectAttribute', value},
          ]),
        )
        return document
          ? {
              attributes: {
                _id: {type: 'objectAttribute', value: {type: 'string'}},
                _type: {type: 'objectAttribute', value: {type: 'string', value: name}},
                ...entries,
              },
              name,
              type: 'document',
            }
          : {name, type: 'type', value: {attributes: entries, type: 'object'}}
      }) as SchemaType
      return {query: render(picked, attribute), schema}
    }),
)

test(
  'every generated module type-checks with strict TypeScript',
  async () => {
    const cases = fc.sample(schemaWithQuery, {
      numRuns: fuzzOptions().numRuns,
      seed: fuzzOptions().seed,
    })
    const directory = await mkdtemp(join(tmpdir(), 'groq-content-mapper-module-types-'))
    try {
      const files = await Promise.all(
        cases.map(async ({query, schema}, index) => {
          const {code, diagnostics} = generateGroqModule({
            content: query,
            filename: join(directory, `q${index}.groq`),
            root: directory,
            schema,
          })
          await writeFile(join(directory, `q${index}.ts`), code)
          return {diagnostics, query, schema}
        }),
      )
      await writeFile(
        join(directory, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            module: 'nodenext',
            noEmit: true,
            noUnusedLocals: false,
            skipLibCheck: true,
            strict: true,
            target: 'esnext',
            types: [],
          },
          include: ['*.ts'],
        }),
      )
      const output = await execFileAsync(
        process.execPath,
        [TSC, '--pretty', 'false', '-p', directory],
        {cwd: directory},
      ).then(
        () => '',
        (error: {stdout: string}) => error.stdout,
      )
      const failing = [...output.matchAll(/q(\d+)\.ts\(\d+,\d+\): (.*)$/gm)].map(
        ([, index, message]) => ({file: files[Number(index)], message}),
      )
      expect(failing.slice(0, 3), output.slice(0, 2000)).toEqual([])
      expect(output).toBe('')
    } finally {
      await rm(directory, {force: true, recursive: true})
    }
  },
  FUZZ_TIMEOUT,
)

// Fixed upstream, this starts passing: add `Array` to `typeName` then.
test.fails('@sanity/codegen renames a schema type that would shadow `Array`', () => {
  const generator = new SchemaTypeGenerator([
    {name: 'Array', type: 'type', value: {type: 'string'}},
  ] as SchemaType)
  expect([...generator].map(({id}) => id.name)).not.toContain('Array')
})
