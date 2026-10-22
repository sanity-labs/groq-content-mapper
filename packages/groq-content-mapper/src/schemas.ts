import {readFile} from 'node:fs/promises'
import {isAbsolute, resolve} from 'node:path'

import {type SchemaType} from 'groq-js'
import * as v from 'valibot'

import {getMessage} from './helpers.js'
import {compileInclude, type Include} from './include.js'

/**
 * One schema and the folders whose `.groq` files it types.
 * @beta
 */
export interface GroqFilesSchema {
  /**
   * One or more folders or globs, relative to the tsconfig. A `.groq` file under one of the
   * folders, or matched by one of the globs, is typed against `schema`. A glob that matches a
   * folder includes everything under it, so `src/*\/queries` works as `src/**\/*.groq` does.
   * The longest matching folder wins, a glob counting as its folder before the first wildcard,
   * so a nested folder can have a schema of its own. Of equally long ones, the first listed wins.
   */
  include: string | string[]
  /** The file `sanity schema extract` writes, relative to the tsconfig. */
  schema: string
}

/**
 * The `options` of the mapper's `contentMappers` entry in `tsconfig.json`, which is the only
 * place the mapper is configured. One of the two is required.
 * @beta
 */
export interface GroqFilesOptions {
  /** The schema for every `.groq` file no `schemas` entry claims. */
  schema?: string
  /**
   * One schema per folder, for a codebase that queries more than one project or dataset.
   * TypeScript registers a content mapper by file extension alone, so the folders are
   * scoped here rather than in separate `contentMappers` entries.
   */
  schemas?: GroqFilesSchema[]
}

const pathString = (name: string) =>
  v.pipe(v.string(`${name} must be a path.`), v.nonEmpty(`${name} must not be empty.`))

const ENTRY_KEYS = '"include" and "schema"'

const schemaEntry: v.GenericSchema<unknown, GroqFilesSchema> = v.pipe(
  // valibot takes an array for an object.
  v.custom<Record<string, unknown>>(
    isRecord,
    `A "schemas" entry must be an object with ${ENTRY_KEYS}.`,
  ),
  v.strictObject(
    {
      include: v.union(
        [
          pathString('"include"'),
          v.pipe(
            v.array(pathString('A folder or glob in "include"')),
            v.minLength(1, '"include" must list at least one folder or glob.'),
          ),
        ],
        '"include" must be a folder, a glob, or a list of them.',
      ),
      schema: pathString('"schema"'),
    },
    (issue) =>
      issue.expected === 'never'
        ? `Unknown key "${String(issue.input)}". A "schemas" entry has ${ENTRY_KEYS}.`
        : `${issue.expected} is required: a "schemas" entry has ${ENTRY_KEYS}.`,
  ),
)

/** An issue's path into the input, as keys. */
function keysOf(issue: v.BaseIssue<unknown>): (number | string)[] {
  return (issue.path ?? []).map((item) => item.key as number | string)
}

/**
 * The issues to report for one valibot issue. A union that fails on a list reports what is
 * wrong inside the list, as in `include: ["src", 3]`, rather than that it is not a list.
 */
function reported(issue: v.BaseIssue<unknown>): {message: string; path: (number | string)[]}[] {
  const nested = Array.isArray(issue.input)
    ? (issue.issues ?? []).filter((inner) => inner.path?.length)
    : []
  if (nested.length === 0) return [{message: issue.message, path: keysOf(issue)}]
  return nested.flatMap((inner) =>
    reported(inner).map(({message, path}) => ({message, path: [...keysOf(issue), ...path]})),
  )
}

/** Something wrong with a `GroqFilesOptions` object, at `path` within it. */
export interface GroqFilesOptionIssue {
  message: string
  path: (number | string)[]
}

/**
 * Validates the options object of a `contentMappers` entry. What is well-formed is kept, so one
 * bad entry does not stop the others from typing their files, and each problem is reported
 * with its path into the object.
 */
export function parseGroqFilesOptions(input: unknown): {
  issues: GroqFilesOptionIssue[]
  options: GroqFilesOptions
} {
  const issues: GroqFilesOptionIssue[] = []
  const options: GroqFilesOptions = {}
  if (input !== undefined && !isRecord(input)) {
    issues.push({message: 'The options must be an object.', path: []})
    return {issues, options}
  }
  const record: Record<string, unknown> & {schema?: unknown; schemas?: unknown} = input ?? {}

  for (const key of Object.keys(record)) {
    if (key !== 'schema' && key !== 'schemas') {
      issues.push({
        message: `Unknown option "${key}". The options are "schema" and "schemas".`,
        path: [key],
      })
    }
  }
  if (record.schema !== undefined) {
    if (typeof record.schema === 'string' && record.schema.length > 0)
      options.schema = record.schema
    else issues.push({message: '"schema" must be the path of a schema file.', path: ['schema']})
  }
  if (record.schemas !== undefined) {
    if (Array.isArray(record.schemas)) {
      options.schemas = []
      for (const [index, item] of record.schemas.entries()) {
        const parsed = v.safeParse(schemaEntry, item)
        if (parsed.success) {
          options.schemas.push(parsed.output)
          continue
        }
        for (const {message, path} of parsed.issues.flatMap((issue) => reported(issue))) {
          issues.push({message, path: ['schemas', index, ...path]})
        }
      }
    } else {
      issues.push({
        message: '"schemas" must be a list of {include, schema} entries.',
        path: ['schemas'],
      })
    }
  }
  if (options.schema === undefined && !options.schemas?.length) {
    issues.push({
      message:
        'Set "schema" to the file "sanity schema extract" writes, or "schemas" to one such file per folder.',
      path: [],
    })
  }
  return {issues, options}
}

/** A schema located for `.groq` files, read if it could be. */
export interface GroqFileSchema {
  /** The schema file's bytes, for the project's configuration identity. */
  bytes?: Buffer
  /** Why `schema` is absent. */
  error?: string
  schema?: SchemaType
  /** The schema file, absolute. */
  schemaPath?: string
}

interface ScopedSchema extends GroqFileSchema {
  includes: Include[]
}

/** `GroqFilesOptions` with every path resolved and every schema read. */
export interface ResolvedGroqFiles {
  scopes: ScopedSchema[]
  /** Absolute paths whose content decides the result: every schema file. */
  watchedFiles: string[]

  /** The schema for files no `schemas` entry claims, when `schema` is set. */
  fallback?: GroqFileSchema

  /** The directory relative paths were resolved against, when there was one. */
  root?: string
}

/**
 * Resolves `options` against `root`, the tsconfig's directory, and reads every schema it names.
 * A schema that cannot be read is kept with its `error`, which the mapper reports on every
 * `.groq` file that needed it, so the imports keep resolving while the schema is fixed.
 *
 * Without a `root`, as for a TypeScript project that has no tsconfig, only absolute paths can
 * be resolved; a relative one is an error on the schema it was meant to locate.
 */
export async function resolveGroqFiles({
  options,
  root,
}: {
  options: GroqFilesOptions
  root?: string
}): Promise<ResolvedGroqFiles> {
  const locate = (path: string): string | undefined =>
    root === undefined ? (isAbsolute(path) ? path : undefined) : resolve(root, path)
  const load = async (path: string): Promise<GroqFileSchema> => {
    const located = locate(path)
    if (located === undefined) {
      return {
        error: `Without a tsconfig.json to resolve it against, "${path}" must be an absolute path.`,
      }
    }
    return loadSchema(located)
  }

  const fallback = options.schema === undefined ? undefined : await load(options.schema)
  const scopes = await Promise.all(
    (options.schemas ?? []).map(async (entry): Promise<ScopedSchema> => {
      const includes = (Array.isArray(entry.include) ? entry.include : [entry.include]).flatMap(
        (include) => compileInclude(include, root) ?? [],
      )
      return Object.assign(await load(entry.schema), {includes})
    }),
  )

  const watchedFiles = [fallback, ...scopes].flatMap((located) =>
    located?.schemaPath === undefined ? [] : [located.schemaPath],
  )
  return {fallback, root, scopes, watchedFiles: [...new Set(watchedFiles)]}
}

/**
 * The schema for a `.groq` file: that of the `schemas` entry whose longest folder contains it,
 * else `schema`, else an error saying neither covers the file.
 */
export function schemaFor(resolved: ResolvedGroqFiles, file: string): GroqFileSchema {
  let best: GroqFileSchema | undefined
  let depth = -1
  for (const scope of resolved.scopes) {
    for (const include of scope.includes) {
      const found = include.depthOf(file)
      if (found > depth) {
        best = scope
        depth = found
      }
    }
  }
  if (best) return best
  if (resolved.fallback) return resolved.fallback
  return {
    error:
      resolved.scopes.length > 0
        ? 'This file is outside every "schemas" folder, and no "schema" is set for the rest.'
        : 'No schema is configured. Set the content mapper option "schema" to the file "sanity schema extract" writes.',
  }
}

async function loadSchema(schemaPath: string): Promise<GroqFileSchema> {
  let bytes: Buffer
  try {
    bytes = await readFile(schemaPath)
  } catch (error) {
    const missing =
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
    const reason = missing
      ? `No schema file at ${schemaPath}. Run "sanity schema extract" to create it.`
      : `Could not read the schema at ${schemaPath}: ${getMessage(error)}`
    return {error: reason, schemaPath}
  }
  let schema: unknown
  try {
    schema = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    return {
      bytes,
      error: `Could not parse the schema at ${schemaPath}: ${getMessage(error)}`,
      schemaPath,
    }
  }
  if (!Array.isArray(schema)) {
    return {
      bytes,
      error: `${schemaPath} is not the array "sanity schema extract" writes.`,
      schemaPath,
    }
  }
  return {bytes, schema: schema as SchemaType, schemaPath}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
