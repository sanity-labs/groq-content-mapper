import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'

import * as fc from 'fast-check'
import {afterAll, describe, expect, test} from 'vitest'

import {load} from '../nodeHooks.js'
import {groqModuleSource} from '../runtime.js'
import groqFiles from '../vite.js'
import {FUZZ_TIMEOUT, fuzzOptions} from './fuzz/fuzz.js'

const root = mkdtempSync(join(tmpdir(), 'groq-content-mapper-runtime-fuzz-'))
afterAll(() => rmSync(root, {force: true, recursive: true}))

/** Characters a folder or file name can have; Windows reserves `?` among others. */
const NAME_CHARACTERS = ['a', 'b', '-', '_', '.', '#', '%', '&', '+', '@', ' ', '(', ')', '[', ']']
const nameCharacter = fc.constantFrom(
  ...NAME_CHARACTERS,
  '{',
  '}',
  'é',
  '漢',
  ...(process.platform === 'win32' ? [] : ['?', ':']),
)
const segment = fc
  .string({maxLength: 6, minLength: 1, unit: nameCharacter})
  .filter((name) => name !== '.' && name !== '..' && !name.endsWith('.') && !name.endsWith(' '))

/** Stands in for the next hook in the chain. */
const next = () => ({format: 'next', shortCircuit: true})

const plugin = groqFiles()
let files = 0

describe('the Node load hook and the Vite plugin', () => {
  test(
    'loads a .groq file whatever its folder and file are named',
    () => {
      fc.assert(
        fc.property(
          fc.array(segment, {maxLength: 3}),
          segment,
          fc.string({unit: 'grapheme'}),
          (folders, name, content) => {
            const folder = join(root, String(files++), ...folders)
            mkdirSync(folder, {recursive: true})
            const file = join(folder, `${name}.groq`)
            writeFileSync(file, content)
            const url = pathToFileURL(file).href

            expect(load(url, {} as never, next as never)).toEqual({
              format: 'module',
              shortCircuit: true,
              source: groqModuleSource(content),
            })
            for (const other of [`${url}?raw`, `${url}#x`, `${url}.ts`]) {
              expect((load(other, {} as never, next as never) as {format: string}).format).toBe(
                'next',
              )
            }

            expect(plugin.load(file)).toEqual({
              code: groqModuleSource(content),
              map: null,
              moduleType: 'js',
            })
            for (const other of [`${file}?raw`, `${file}#x`, `\0${file}`]) {
              expect(plugin.load(other)).toBeNull()
            }
          },
        ),
        fuzzOptions(50),
      )
    },
    FUZZ_TIMEOUT,
  )
})
