import {readFileSync} from 'node:fs'

import type * as codegen from '@sanity/codegen'
import {type SchemaType} from 'groq-js'
import {describe, expect, test, vi} from 'vitest'

import {schemaTypesFor} from '../schemaTypes.js'

const schema = JSON.parse(
  readFileSync(new URL('fixtures/schema.json', import.meta.url), 'utf8'),
) as SchemaType

const constructed = vi.hoisted(() => ({count: 0}))

vi.mock('@sanity/codegen', async (importOriginal) => {
  const original = await importOriginal<typeof codegen>()
  const instance = (
    new original.TypeGenerator() as unknown as {
      getSchemaTypeGenerator: (options: {schema: SchemaType}) => object
    }
  ).getSchemaTypeGenerator({schema: []})
  const Exported = instance.constructor as new (schema: SchemaType) => object
  class SchemaTypeGenerator extends Exported {
    constructor(schema: SchemaType) {
      super(schema)
      constructed.count++
    }
  }
  return {...original, SchemaTypeGenerator}
})

describe('schemaTypesFor', () => {
  test('uses SchemaTypeGenerator from @sanity/codegen once it is exported', () => {
    const schemaTypes = schemaTypesFor(schema)
    expect(constructed.count).toBe(1)
    expect(schemaTypes.generateTsType({type: 'string'})).toEqual({type: 'TSStringKeyword'})
    expect([...schemaTypes].map(({name}) => name)).toContain('post')
  })

  test('builds the types once per schema object', () => {
    expect(schemaTypesFor(schema)).toBe(schemaTypesFor(schema))
    expect(constructed.count).toBe(1)
  })
})
