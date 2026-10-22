import {SchemaTypeGenerator} from '@sanity/codegen'
import {type SchemaType} from 'groq-js'

export type SchemaTypes = SchemaTypeGenerator

const cache = new WeakMap<SchemaType, SchemaTypes>()

/** The schema's types, computed once per schema object. */
export function schemaTypesFor(schema: SchemaType): SchemaTypes {
  let schemaTypes = cache.get(schema)
  if (!schemaTypes) cache.set(schema, (schemaTypes = new SchemaTypeGenerator(schema)))
  return schemaTypes
}
