import {readFileSync} from 'node:fs'

import {type SchemaType} from 'groq-js'
import {describe, expect, test} from 'vitest'

import {schemaTypesFor} from '../schemaTypes.js'

const schema = JSON.parse(
  readFileSync(new URL('fixtures/schema.json', import.meta.url), 'utf8'),
) as SchemaType

describe('schemaTypesFor', () => {
  test('wraps the SchemaTypeGenerator from @sanity/codegen', () => {
    const schemaTypes = schemaTypesFor(schema)
    expect(schemaTypes.generateTsType({type: 'string'})).toEqual({type: 'TSStringKeyword'})
    expect([...schemaTypes].map(({name}) => name)).toContain('post')
  })

  test('builds the types once per schema object', () => {
    expect(schemaTypesFor(schema)).toBe(schemaTypesFor(schema))
  })
})
