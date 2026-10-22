import path from 'node:path'

import {CodeGenerator} from '@babel/generator'
import * as t from '@babel/types'

/**
 * Names `@sanity/codegen` gives the helpers a schema type can refer to. A module that refers to
 * one declares it locally, as `sanity.types.ts` does.
 */
export const ARRAY_OF = 'ArrayOf'
export const INTERNAL_REFERENCE_SYMBOL = 'internalGroqTypeReferenceTo'

const RESERVED_IDENTIFIERS = new Set([
  'AllSanitySchemaTypes',
  ARRAY_OF,
  INTERNAL_REFERENCE_SYMBOL,
  'SanityQueries',
])

/** `filename` relative to `root`, with forward slashes on every platform. */
export function normalizePrintablePath(root: string, filename: string): string {
  return path.relative(root, path.resolve(root, filename)).replaceAll('\\', '/')
}

/** Whether a string is a valid ECMAScript IdentifierName. */
export function isIdentifierName(input: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(input)
}

/** A PascalCase identifier for `name` that is not in `taken`, suffixed `_2`, `_3`… as needed. */
export function getUniqueIdentifierForName(name: string, taken: Set<string>): t.Identifier {
  const sanitized = name
    .replace(/^\d/, '_')
    .replaceAll(/[^$\w]+(.)/g, (_, char: string) => char.toUpperCase())
  const desired = `${sanitized.charAt(0).toUpperCase()}${sanitized.slice(1)}`
  let resulting = desired
  for (let index = 2; taken.has(resulting) || RESERVED_IDENTIFIERS.has(resulting); index++) {
    resulting = `${desired}_${index}`
  }
  return t.identifier(resulting)
}

export function generateCode(node: t.Node): string {
  return `${new CodeGenerator(node).generate().code.trim()}\n\n`
}

export function getMessage(error: unknown): string {
  return typeof error === 'object' &&
    !!error &&
    'message' in error &&
    typeof error.message === 'string'
    ? error.message
    : 'Unknown error'
}
