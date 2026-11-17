import * as t from '@babel/types'
import {SchemaTypeGenerator} from '@sanity/codegen'
import {type SchemaType} from 'groq-js'

type TypeNode = Parameters<SchemaTypeGenerator['generateTsType']>[0]

interface SchemaTypeAlias {
  id: t.Identifier
  name: string
  tsType: t.TSType
}

/** The TypeScript types of a schema, as Babel 8 nodes. */
export interface SchemaTypes extends Iterable<SchemaTypeAlias> {
  generateTsType(typeNode: TypeNode): t.TSType
}

const cache = new WeakMap<SchemaType, SchemaTypes>()

/** The schema's types, computed once per schema object. */
export function schemaTypesFor(schema: SchemaType): SchemaTypes {
  let schemaTypes = cache.get(schema)
  if (!schemaTypes)
    cache.set(schema, (schemaTypes = fromGenerator(new SchemaTypeGenerator(schema))))
  return schemaTypes
}

function fromGenerator(generator: SchemaTypeGenerator): SchemaTypes {
  let aliases: SchemaTypeAlias[] | undefined
  return {
    generateTsType: (typeNode) => toBabel8(generator.generateTsType(typeNode)) as t.TSType,
    [Symbol.iterator]() {
      aliases ??= [...generator].map(({id, name, tsType}) => ({
        id: toBabel8(id) as t.Identifier,
        name,
        tsType: toBabel8(tsType) as t.TSType,
      }))
      return aliases[Symbol.iterator]()
    },
  }
}

/**
 * A Babel 8 copy of a node `@sanity/codegen` built with Babel 7. Babel 7 keeps the arguments of
 * a type reference in `typeParameters`, a field Babel 8 neither visits, clones, nor prints.
 */
function toBabel8(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toBabel8)
  if (!isNode(value)) return value
  const fields = t.NODE_FIELDS[value.type]
  const renameTypeParameters =
    !!fields && 'typeArguments' in fields && !('typeParameters' in fields)
  const copy: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const target = renameTypeParameters && key === 'typeParameters' ? 'typeArguments' : key
    copy[target] = toBabel8(child)
  }
  return copy
}

function isNode(value: unknown): value is {type: string} {
  return (
    typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
  )
}
