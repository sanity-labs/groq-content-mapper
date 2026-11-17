import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs'
import {isAbsolute, join, relative, resolve, sep} from 'node:path'

import {parse} from 'groq-js'
import picomatch from 'picomatch'

import {parseCalls, parseDefinitions} from './groqParser.js'
import {getMessage} from './helpers.js'
import type {GroqFilesOptionIssue} from './schemas.js'

export {minifyGroq} from './groqParser.js'

/** One `fn namespace::name($param) = …;` definition from a functions file. */
export interface GroqFunction {
  /** The custom or built-in functions its body calls, as `namespace::name`. */
  calls: string[]
  file: string
  /** `namespace::name`. */
  name: string
  /** The definition as written, through its `;`. */
  source: string
  /** Where `source` starts in the file. */
  start: number
}

/** The definitions of a project's `functions` option, by name, and what reading them found. */
export interface LoadedGroqFunctions {
  /** Every file the option names or matched, absolute, with its text when it could be read. */
  files: Map<string, string | undefined>
  /** The valid definitions, by `namespace::name`. */
  functions: Map<string, GroqFunction>
  issues: GroqFilesOptionIssue[]
}

/**
 * Reads the files the `functions` option names, relative to `root`: paths, or globs with `/` as
 * the separator. Each file holds only `fn` definitions. A missing file, a glob that matches
 * nothing, a definition the parser or groq-js rejects, and a name defined twice are reported as
 * issues at the option's path; every definition that is valid is kept.
 */
export function loadGroqFunctions(
  option: string | string[],
  root: string | undefined,
): LoadedGroqFunctions {
  const files = new Map<string, string | undefined>()
  const issues: GroqFilesOptionIssue[] = []
  const definitions: GroqFunction[] = []
  /** The names of definitions the parser rejected: a function that calls one is unusable too. */
  const invalid = new Set<string>()
  /** The option path of the entry that named each file. */
  const paths = new Map<string, (number | string)[]>()

  for (const [index, pattern] of (Array.isArray(option) ? option : [option]).entries()) {
    const path = Array.isArray(option) ? ['functions', index] : ['functions']
    const report = (message: string) => issues.push({message, path})
    const expanded = expand(pattern, root)
    if ('error' in expanded) {
      report(expanded.error)
      if (expanded.missing) files.set(expanded.missing, undefined)
      continue
    }
    for (const file of expanded.files) {
      if (files.has(file)) continue
      paths.set(file, path)
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch (error) {
        files.set(file, undefined)
        report(`Could not read the functions file ${file}: ${getMessage(error)}`)
        continue
      }
      files.set(file, text)
      const split = splitDefinitions(text, file)
      definitions.push(...split.definitions)
      for (const name of split.rejected) invalid.add(name)
      for (const error of split.errors) report(error)
    }
  }

  const location = (fn: GroqFunction) =>
    `${fn.file}:${lineAndColumn(files.get(fn.file) ?? '', fn.start)}`
  const pathOf = (fn: GroqFunction) => paths.get(fn.file) ?? ['functions']
  const functions = new Map<string, GroqFunction>()
  for (const fn of definitions) {
    const existing = functions.get(fn.name)
    if (existing) {
      issues.push({
        message: `The function ${fn.name} is defined twice: at ${location(existing)} and at ${location(fn)}.`,
        path: pathOf(fn),
      })
      continue
    }
    functions.set(fn.name, fn)
  }

  // groq-js checks what the parser does not: bodies must be projections, calls must resolve.
  const dependsOnInvalid = (fn: GroqFunction) =>
    fn.calls.some((call) => invalid.has(call)) ||
    dependencies(fn, functions).some((dependency) => invalid.has(dependency.name))
  for (const fn of functions.values()) {
    if (dependsOnInvalid(fn)) continue
    try {
      const used = dependencies(fn, functions)
      parse(`${[...used, fn].map((each) => each.source).join('\n')}\nnull`)
    } catch (error) {
      invalid.add(fn.name)
      issues.push({
        message: `Invalid function definition ${fn.name} at ${location(fn)}: ${getMessage(error)}`,
        path: pathOf(fn),
      })
    }
  }
  // A function that calls an invalid one cannot be used either.
  const unusable = new Set(invalid)
  for (const fn of functions.values()) {
    if (dependsOnInvalid(fn)) unusable.add(fn.name)
  }
  for (const name of unusable) functions.delete(name)
  return {files, functions, issues}
}

/**
 * `query` with the definitions of the custom functions it calls prepended, and those of the
 * functions they call in turn, each once and after what it calls. A function the query defines
 * itself is not prepended. Without any to prepend, or when the query does not parse, `query` is
 * returned as it is.
 */
export function withGroqFunctions(query: string, functions: Map<string, GroqFunction>): string {
  if (functions.size === 0) return query
  const parsed = parseCalls(query)
  if (!parsed) return query
  const needed = called(parsed.calls, functions, new Set(parsed.defines))
  if (needed.length === 0) return query
  return `${needed.map((fn) => fn.source).join('\n')}\n${query}`
}

/** The custom functions `fn` calls, directly or not, each after what it calls. */
function dependencies(fn: GroqFunction, functions: Map<string, GroqFunction>): GroqFunction[] {
  return called(fn.calls, functions, new Set([fn.name]))
}

/** The custom functions `calls` name and those call in turn, each once and after what it calls, except those in `skip`. */
function called(
  calls: string[],
  functions: Map<string, GroqFunction>,
  skip: Set<string>,
): GroqFunction[] {
  const found: GroqFunction[] = []
  const visit = (name: string) => {
    const fn = functions.get(name)
    if (!fn || skip.has(name)) return
    skip.add(name)
    for (const call of fn.calls) visit(call)
    found.push(fn)
  }
  for (const call of calls) visit(call)
  return found
}

/**
 * The `fn` definitions in a functions file, from the parser: each with the functions its body
 * calls, so the file is never scanned as text. A definition the parser rejects is an error at
 * its line and column, and its name, when the header gave one, is `rejected`; the others are
 * kept.
 */
function splitDefinitions(
  text: string,
  file: string,
): {definitions: GroqFunction[]; errors: string[]; rejected: string[]} {
  const parsed = parseDefinitions(text)
  return {
    definitions: parsed.definitions.map(({calls, end, name, start}) => ({
      calls,
      file,
      name,
      source: text.slice(start, end),
      start,
    })),
    errors: parsed.problems.map(
      ({message, start}) =>
        `Invalid function definition at ${file}:${lineAndColumn(text, start)}: ${message}.`,
    ),
    rejected: parsed.problems.flatMap(({name}) => (name === null ? [] : [name])),
  }
}

/** The files a path or glob names, or why it names none. */
function expand(
  pattern: string,
  root: string | undefined,
): {files: string[]} | {error: string; missing?: string} {
  const located = locate(pattern, root)
  if (located === undefined) {
    return {
      error: `Without a tsconfig.json to resolve it against, "${pattern}" must be an absolute path.`,
    }
  }
  const scanned = scan(pattern)
  if (!scanned.isGlob) {
    if (!existsSync(located)) return {error: `No functions file at ${located}.`, missing: located}
    if (!statSync(located).isFile()) {
      return {error: `${located} is a folder. Name the functions files, or match them with a glob.`}
    }
    return {files: [located]}
  }
  const base = locate(scanned.base || '.', root)!
  const matches = picomatch(scanned.glob)
  const files = walk(base).filter((file) => matches(relative(base, file).split(sep).join('/')))
  if (files.length === 0) return {error: `"${pattern}" matches no functions files.`}
  return {files}
}

function scan(pattern: string) {
  return picomatch.scan(process.platform === 'win32' ? pattern.replaceAll('\\', '/') : pattern)
}

function locate(path: string, root: string | undefined): string | undefined {
  if (root !== undefined) return resolve(root, path)
  return isAbsolute(path) ? resolve(path) : undefined
}

/** Every file under `folder`, sorted, skipping `node_modules` and hidden folders. */
function walk(folder: string): string[] {
  let entries
  try {
    entries = readdirSync(folder, {withFileTypes: true})
  } catch {
    return []
  }
  return entries
    .flatMap((entry) => {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) {
        return entry.name === 'node_modules' || entry.name.startsWith('.') ? [] : walk(path)
      }
      return entry.isFile() ? [path] : []
    })
    .toSorted()
}

function lineAndColumn(text: string, offset: number): string {
  const before = text.slice(0, offset).split('\n')
  return `${before.length}:${before.at(-1)!.length + 1}`
}
