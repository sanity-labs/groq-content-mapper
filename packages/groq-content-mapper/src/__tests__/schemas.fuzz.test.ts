import {isAbsolute, join, parse as parsePath, relative, resolve, sep} from 'node:path'

import * as fc from 'fast-check'
import {describe, expect, test} from 'vitest'

import {parseGroqFilesOptions, resolveGroqFiles, schemaFor} from '../schemas.js'
import {FUZZ_TIMEOUT, fuzzOptions} from './fuzz/fuzz.js'

const pathString = fc.oneof(
  fc.constantFrom('schema.json', './schema.json', 'src', 'src/shop/', '../shared', ''),
  fc.string({maxLength: 8}),
)

/** Option objects shaped roughly right, so most of them reach the per-entry validation. */
const nearlyOptions = fc.record(
  {
    schema: fc.oneof(pathString, fc.anything()),
    schemas: fc.oneof(
      fc.array(
        fc.oneof(
          fc.record(
            {
              extra: fc.anything(),
              include: fc.oneof(
                pathString,
                fc.array(fc.oneof(pathString, fc.anything()), {maxLength: 3}),
                fc.anything(),
              ),
              schema: fc.oneof(pathString, fc.anything()),
            },
            {requiredKeys: []},
          ),
          fc.anything(),
        ),
        {maxLength: 4},
      ),
      fc.anything(),
    ),
    typo: fc.anything(),
  },
  {requiredKeys: []},
)

const anyOptions = fc.oneof(nearlyOptions, fc.anything(), fc.jsonValue())

/** The value at `path` in `input`, and whether every step of the way exists. */
function at(input: unknown, path: (number | string)[]): {exists: boolean; value: unknown} {
  let value = input
  for (const key of path) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) {
      return {exists: false, value: undefined}
    }
    value = (value as Record<number | string, unknown>)[key]
  }
  return {exists: true, value}
}

describe('parseGroqFilesOptions, fuzzed', () => {
  test(
    'never throws, and every issue is a sentence about a place in the input',
    () => {
      fc.assert(
        fc.property(anyOptions, (input) => {
          const {issues} = parseGroqFilesOptions(input)
          for (const {message, path} of issues) {
            expect(message).toMatch(/^[A-Z"].*\.$/)
            expect(message).not.toMatch(/\[object |Expected never|received undefined/)
            // Every issue but a missing key points at something the input has.
            if (path.length > 0 && !/required/.test(message)) {
              expect(at(input, path).exists, `${JSON.stringify(path)}: ${message}`).toBe(true)
            }
          }
        }),
        fuzzOptions(500),
      )
    },
    FUZZ_TIMEOUT,
  )

  test(
    'keeps what is well-formed: the kept options parse cleanly and as themselves',
    () => {
      fc.assert(
        fc.property(anyOptions, (input) => {
          const {issues, options} = parseGroqFilesOptions(input)
          const again = parseGroqFilesOptions(options)
          expect(again.options).toEqual(options)
          expect(again.issues.every(({path}) => path.length === 0)).toBe(true)
          if (issues.length === 0) expect(options).toEqual(input)
        }),
        fuzzOptions(500),
      )
    },
    FUZZ_TIMEOUT,
  )
})

const segment = fc.constantFrom(
  'src',
  'shop',
  'Shop',
  '[locale]',
  '(shop)',
  '[...slug]',
  '@modal',
  '.hidden',
  'a b',
  'ü',
  '_app',
  '..',
  '.',
)
const relativeFolder = fc
  .tuple(fc.array(segment, {maxLength: 4}), fc.constantFrom('/', sep), fc.boolean())
  .map(([parts, separator, trailing]) => {
    const folder = parts.join(separator) || '.'
    return trailing ? `${folder}${separator}` : folder
  })

const ROOT = resolve('fuzz-project')
const FILESYSTEM_ROOT = parsePath(ROOT).root

const fold = (path: string) =>
  process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path

/** Whether `file` is strictly inside `folder`, by path segments rather than string prefixes. */
function contains(folder: string, file: string): boolean {
  const rel = relative(fold(folder), fold(file))
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

describe('schemaFor, fuzzed', () => {
  test(
    'a file gets the schema of the deepest folder that contains it, else the fallback',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.array(
              fc.oneof(
                {arbitrary: relativeFolder, weight: 5},
                {arbitrary: relativeFolder.map((folder) => join(ROOT, folder)), weight: 1},
                {arbitrary: fc.constant(FILESYSTEM_ROOT), weight: 1},
              ),
              {maxLength: 3, minLength: 1},
            ),
            {maxLength: 4, minLength: 1},
          ),
          fc.boolean(),
          relativeFolder,
          async (includes, withFallback, fileFolder) => {
            const schemas = includes.map((include, index) => ({include, schema: `s${index}.json`}))
            const resolved = await resolveGroqFiles({
              options: {schemas, ...(withFallback ? {schema: 'fallback.json'} : {})},
              root: ROOT,
            })
            const file = join(ROOT, fileFolder, 'query.groq')

            let expected: string | undefined
            let depth = -1
            for (const [index, include] of includes.entries()) {
              for (const folder of include.map((entry) => resolve(ROOT, entry))) {
                if (contains(folder, file) && folder.length > depth) {
                  expected = join(ROOT, `s${index}.json`)
                  depth = folder.length
                }
              }
            }
            if (expected === undefined && withFallback) expected = join(ROOT, 'fallback.json')
            expect(schemaFor(resolved, file).schemaPath).toBe(expected)
          },
        ),
        fuzzOptions(300),
      )
    },
    FUZZ_TIMEOUT,
  )
})
