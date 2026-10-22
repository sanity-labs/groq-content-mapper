import type * as t from '@babel/types'
import * as codegen from '@sanity/codegen'
import {type SchemaType, type TypeNode} from 'groq-js'

/**
 * The part of `@sanity/codegen`'s `SchemaTypeGenerator` this package uses: the TypeScript type
 * for a groq-js type node, naming schema types by the aliases codegen gives them, and those
 * aliases with their types.
 */
export interface SchemaTypes {
  [Symbol.iterator](): Iterator<{id: t.Identifier; name: string; tsType: t.TSType}>
  generateTsType(typeNode: TypeNode): t.TSType
}

type SchemaTypeGeneratorClass = new (schema: SchemaType) => SchemaTypes

const cache = new WeakMap<SchemaType, SchemaTypes>()

/** The schema's types, computed once per schema object. */
export function schemaTypesFor(schema: SchemaType): SchemaTypes {
  let schemaTypes = cache.get(schema)
  if (!schemaTypes) cache.set(schema, (schemaTypes = createSchemaTypes(schema)))
  return schemaTypes
}

/**
 * `@sanity/codegen` 8.2 does not export `SchemaTypeGenerator`, and keeps `generateTsType` and
 * the selector that builds one private to TypeScript only. Until it exports the class, the
 * instance `TypeGenerator` builds for `generateTypes` is used, which is the same object.
 */
function createSchemaTypes(schema: SchemaType): SchemaTypes {
  const exported = (codegen as Record<string, unknown>)['SchemaTypeGenerator'] as
    | SchemaTypeGeneratorClass
    | undefined
  if (exported) return new exported(schema)

  const generator = new codegen.TypeGenerator() as unknown as {
    getSchemaTypeGenerator?: (options: {schema: SchemaType}) => SchemaTypes
  }
  const schemaTypes = generator.getSchemaTypeGenerator?.({schema})
  if (typeof schemaTypes?.generateTsType !== 'function') {
    throw new TypeError(
      'This version of @sanity/codegen does not provide SchemaTypeGenerator. Install @sanity/codegen 8.2 or later.',
    )
  }
  return schemaTypes
}
