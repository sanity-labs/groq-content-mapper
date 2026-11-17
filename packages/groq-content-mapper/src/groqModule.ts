import * as t from '@babel/types'
import {GroqSyntaxError, type SchemaType, typeEvaluate} from 'groq-js'

import {type ExprNode} from './groqAst.js'
import {
  ARRAY_OF,
  generateCode,
  getMessage,
  getUniqueIdentifierForName,
  INTERNAL_REFERENCE_SYMBOL,
  isIdentifierName,
  normalizePrintablePath,
} from './helpers.js'
import {inferParams} from './inferParams.js'
import {safeParseQuery} from './safeParseQuery.js'
import {type SchemaTypes, schemaTypesFor} from './schemaTypes.js'

/** The type exports of every typed `.groq` module. */
const QUERY_RESPONSE = 'QueryResponse'
const QUERY_PARAMS = 'QueryParams'

/** The phantom properties the default export carries its types in. `@sanity/client` reads them. */
const GROQ_RESULT_BRAND = '__groqResult'
const GROQ_PARAMS_BRAND = '__groqParams'

/**
 * The block comment `sanity-io.vscode-sanity` matches in front of a template literal.
 * The text is fixed: the extension's injection grammar looks for this comment.
 */
const GROQ_TEMPLATE_COMMENT = '/* groq */'

/** TypeScript's `Record`, which the params type refers to. */
const RECORD = 'Record'

/** Names a module declares or refers to itself, which a schema type alias cannot take. */
const MODULE_NAMES = new Set(['query', QUERY_PARAMS, QUERY_RESPONSE, RECORD])

/**
 * Why a `.groq` file could not be typed, or not entirely. Reported by the content mapper with
 * `groq` as the diagnostic source, so an editor shows `groq2` for a syntax error.
 * @beta
 */
export const GroqFileDiagnosticCode = {
  /** The file holds no query. */
  EmptyFile: 1,
  /** groq-js could not evaluate the query against the schema. */
  EvaluationFailed: 4,
  /** The query has a problem, and the custom functions files have problems that may be why. */
  FunctionsUnavailable: 5,
  /** No schema to type the query against. */
  SchemaUnavailable: 3,
  /** The query does not parse. `start` points at the error. */
  SyntaxError: 2,
} as const

/** @beta */
export type GroqFileDiagnosticCode =
  (typeof GroqFileDiagnosticCode)[keyof typeof GroqFileDiagnosticCode]

/**
 * A problem with a `.groq` file. Positions are UTF-16 offsets into the file's content.
 * @beta
 */
export interface GroqFileDiagnostic {
  code: GroqFileDiagnosticCode
  length: number
  messageText: string
  start: number
}

/**
 * A `.groq` file typed as a TypeScript module. The default export is the query string, typed as
 * its own literal with the result and params types attached as optional phantom properties, and
 * `QueryResponse` and `QueryParams` are exported as types. Nothing is declared globally.
 * @beta
 */
export interface GroqModule {
  ast: t.Program
  code: string
  /**
   * Problems with the file. The module is still complete: an untyped query exports `unknown`
   * as its response and accepts any params, so the import keeps resolving.
   */
  diagnostics: GroqFileDiagnostic[]
  /** The string the default export is typed as: `query` as written, never minified. */
  query: string
}

export interface RenderGroqModuleOptions {
  /** The `.groq` file, for the `// Source:` comment. */
  filename: string
  /** Notes written as comments at the top of the module. */
  notes: string[]
  query: string

  /** The params object type. Absent when the query could not be parsed. */
  params?: t.TSType
  /** The result type, with the schema types it refers to. Absent when the query could not be typed. */
  result?: {schemaTypes: SchemaTypes; tsType: t.TSType}
  root?: string
  /** The schema file, for the `// Schema:` comment. */
  schemaPath?: string
}

/**
 * Options for typing one `.groq` file.
 * @beta
 */
export interface GenerateGroqModuleOptions {
  /** The file's content, which is also the query unless `query` says otherwise. */
  content: string
  /** The `.groq` file, named in a comment at the top of the module. */
  filename: string
  schema: SchemaType

  /**
   * The query the default export is typed as, when the loaders deliver more than the file:
   * `content` with custom function definitions prepended, each as written in its own file.
   * Defaults to `content`. Never minified, and never reformatted.
   */
  query?: string
  /** The directory file names in comments are relative to. Defaults to the working directory. */
  root?: string
  /** The schema file, named in a comment at the top of the module. */
  schemaPath?: string
}

/**
 * Types one `.groq` file as a TypeScript module, so that `import query from './file.groq'`
 * gives a query string that carries its own types:
 *
 * ```ts
 * export type QueryResponse = Array<{title: string | null}>
 * export type QueryParams = {slug: string}
 * declare const query: `*[_type == "post" && slug.current == $slug] {
 *   title
 * }` & {
 *   readonly __groqResult?: QueryResponse
 *   readonly __groqParams?: QueryParams
 * }
 * export default query
 * ```
 *
 * The literal is written as a template literal, prefixed with a groq block comment, so the
 * query's line breaks stay in the type text. Its value is `query` as written, comments and
 * whitespace included, and it is never minified. The declaration's doc comment repeats that
 * text in a fenced `groq` block, since a hover prints the literal type on one line with `\n`
 * escapes but renders the doc comment with its line breaks. The loaders minify at run time
 * unless the `minify` option is off, so with it on the string an import evaluates to differs
 * from its type. The result type is
 * evaluated as `@sanity/codegen` evaluates a `defineQuery` call, so `[0]` becomes `T | null`.
 * Params are inferred from the `$` placeholders: a placeholder compared with a field takes the
 * field's type, slice bounds are numbers, and anything else is `unknown`.
 *
 * A file that cannot be typed still yields a complete module, with `unknown` for what could
 * not be inferred, plus a diagnostic saying why. The schema's type aliases are computed once
 * per schema object.
 * @beta
 */
export function generateGroqModule(options: GenerateGroqModuleOptions): GroqModule {
  const {content, filename, query = content, root, schema, schemaPath} = options
  /** Where `content` starts in `query`: positions in the query are reported in the file. */
  const offset = query.length - content.length
  const diagnostics: GroqFileDiagnostic[] = []
  const notes: string[] = []
  const report = (
    code: GroqFileDiagnosticCode,
    messageText: string,
    start: number,
    length: number,
  ) => {
    const from = Math.min(start, content.length)
    diagnostics.push({
      code,
      length: Math.min(length, content.length - from),
      messageText,
      start: from,
    })
  }
  const render = (parts: Pick<RenderGroqModuleOptions, 'params' | 'result'>): GroqModule => ({
    ...renderGroqModule({filename, notes, query, root, schemaPath, ...parts}),
    diagnostics,
    query,
  })

  if (content.trim().length === 0) {
    report(GroqFileDiagnosticCode.EmptyFile, 'This .groq file has no query.', 0, content.length)
    return render({})
  }

  let ast: ReturnType<typeof safeParseQuery>
  try {
    ast = safeParseQuery(query)
  } catch (error) {
    if (!(error instanceof GroqSyntaxError)) {
      report(GroqFileDiagnosticCode.SyntaxError, getMessage(error), 0, 1)
      return render({})
    }
    const position = Math.max(error.position - offset, 0)
    const message = getMessage(error).replace(`position ${error.position}`, `position ${position}`)
    report(GroqFileDiagnosticCode.SyntaxError, message, position, 1)
    return render({})
  }

  try {
    const schemaTypes = schemaTypesFor(schema)
    const params = new Map<string, t.TSType>()
    for (const [name, type] of inferParams({ast: ast as ExprNode, query, schema})) {
      params.set(name, schemaTypes.generateTsType(type))
    }
    const tsType = schemaTypes.generateTsType(typeEvaluate(ast, schema))
    return render({params: paramsType(params), result: {schemaTypes, tsType}})
  } catch (error) {
    const message = `Could not type this query against the schema: ${getMessage(error)}`
    report(GroqFileDiagnosticCode.EvaluationFailed, message, 0, content.length)
    notes.push(message)
    return render({})
  }
}

/**
 * The type-position text for `query`: a template literal whose value is `query`,
 * prefixed with the groq block comment. Line breaks in `query` are line breaks in the literal.
 */
export function groqQueryTypeText(query: string): string {
  return `${GROQ_TEMPLATE_COMMENT} \`${escapeTemplateLiteral(query)}\``
}

/**
 * `query` escaped so a no-substitution template literal evaluates to it.
 * A carriage return is `\r`, because a raw CR in the generated text is not kept.
 */
function escapeTemplateLiteral(query: string): string {
  let escaped = ''
  for (let index = 0; index < query.length; index++) {
    const character = query.charAt(index)
    if (character === '\r') {
      escaped += '\\r'
    } else if (character === '\\' || character === '`') {
      escaped += `\\${character}`
    } else if (character === '$' && query.charAt(index + 1) === '{') {
      escaped += '\\$'
    } else {
      escaped += character
    }
  }
  return escaped
}

/**
 * The TypeScript module for a `.groq` file.
 *
 * The module is self-contained. Only the schema type aliases the result and params refer to are
 * declared, as module-local types, so a projection carries no schema at all and two files with
 * the same query text are interchangeable.
 */
export function renderGroqModule(
  options: RenderGroqModuleOptions,
): Pick<GroqModule, 'ast' | 'code'> {
  const {filename, notes, query, result, root = process.cwd(), schemaPath} = options
  let response = result?.tsType ?? t.tsUnknownKeyword()
  let params = options.params ?? recordOf(t.tsUnknownKeyword())
  const referenced = new Set<string>()
  collectReferences(response, referenced)
  collectReferences(params, referenced)

  const body: t.Statement[] = []
  if (result) {
    let aliases: {id: t.Identifier; tsType: t.TSType}[] = referencedSchemaTypes(
      result.schemaTypes,
      referenced,
    )
    // A schema type named like one of the exports is renamed within this module.
    const renames = renamesFor(aliases.map(({id}) => id.name))
    if (renames.size > 0) {
      response = renamed(response, renames)
      params = renamed(params, renames)
      aliases = aliases.map(({id, tsType}) => ({
        id: t.identifier(renames.get(id.name) ?? id.name),
        tsType: renamed(tsType, renames),
      }))
    }
    if (referenced.has(INTERNAL_REFERENCE_SYMBOL)) body.push(internalReferenceSymbol())
    if (referenced.has(ARRAY_OF)) body.push(arrayOf())
    for (const {id, tsType} of aliases) body.push(t.tsTypeAliasDeclaration(id, null, tsType))
  }

  body.push(
    documented(
      t.exportNamedDeclaration(
        t.tsTypeAliasDeclaration(t.identifier(QUERY_RESPONSE), null, response),
      ),
      ' The result of this query, as `client.fetch` resolves it. ',
    ),
    documented(
      t.exportNamedDeclaration(t.tsTypeAliasDeclaration(t.identifier(QUERY_PARAMS), null, params)),
      ' The values for the `$` placeholders in this query. ',
    ),
    queryDeclaration(query),
    t.exportDefaultDeclaration(t.identifier('query')),
  )

  const comments = [
    ` Source: ${normalizePrintablePath(root, filename)}`,
    ...(schemaPath ? [` Schema: ${normalizePrintablePath(root, schemaPath)}`] : []),
    ...notes.flatMap((note) => note.split('\n').map((line) => ` ${line}`)),
  ]
  t.addComments(
    body[0]!,
    'leading',
    comments.map((value) => ({type: 'CommentLine', value})),
  )

  const ast = t.program(body)
  return {ast, code: body.map((statement) => printStatement(statement)).join('')}
}

/**
 * Prints one statement. The query declaration's groq comment is printed tight against
 * the opening backtick; a space is inserted so it reads as a prefixed template literal.
 * Only the first occurrence is the prefix: a query that itself ends in the comment text
 * is followed by the closing backtick, and that one stays.
 */
function printStatement(statement: t.Statement): string {
  return generateCode(statement).replace(
    `${GROQ_TEMPLATE_COMMENT}\``,
    `${GROQ_TEMPLATE_COMMENT} \``,
  )
}

/** `{name: type}` for the inferred params, or `Record<string, never>` for a query without any. */
function paramsType(params: Map<string, t.TSType>): t.TSType {
  if (params.size === 0) return recordOf(t.tsNeverKeyword())
  return t.tsTypeLiteral(
    [...params].map(([name, type]) =>
      t.tsPropertySignature(
        isIdentifierName(name) ? t.identifier(name) : t.stringLiteral(name),
        t.tsTypeAnnotation(type),
      ),
    ),
  )
}

/**
 * The default export's declaration: the query as a template literal type, prefixed with the
 * groq block comment, intersected with an object of two optional, readonly phantom properties,
 * `__groqResult` and `__groqParams`. The properties never exist at runtime, and because they
 * are optional the value is still assignable to `string` and to its own literal.
 */
function queryDeclaration(query: string): t.VariableDeclaration {
  const literal = t.templateLiteral(
    [t.templateElement({cooked: query, raw: escapeTemplateLiteral(query)}, true)],
    [],
  )
  // The inside of `/* groq */`. addComment wraps a block comment around this text.
  t.addComment(literal, 'leading', GROQ_TEMPLATE_COMMENT.slice(2, -2), false)
  const brand = t.tsTypeLiteral([
    phantomProperty(GROQ_RESULT_BRAND, QUERY_RESPONSE),
    phantomProperty(GROQ_PARAMS_BRAND, QUERY_PARAMS),
  ])
  const id = t.identifier('query')
  id.typeAnnotation = t.tsTypeAnnotation(t.tsIntersectionType([t.tsLiteralType(literal), brand]))
  const declaration = t.variableDeclaration('const', [t.variableDeclarator(id)])
  declaration.declare = true
  const documentation = queryDocumentation(query)
  return documentation === undefined ? declaration : documented(declaration, documentation)
}

/**
 * The doc comment that makes a hover show `query` on its own lines. Quick info prints a string
 * literal type on one line with `\n` escapes, whatever the declaration spells it as, but renders
 * the documentation as markdown, so the query goes in a fenced `groq` block. The fence is longer
 * than any run of backticks in the query. A query that contains `*\/` would end the comment,
 * so it gets none.
 */
function queryDocumentation(query: string): string | undefined {
  const text = query.replace(/(?:\r?\n)+$/, '')
  if (text.trim().length === 0 || text.includes('*/')) return undefined
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  const lines = [`${fence}groq`, ...text.split(/\r?\n/), fence]
  return `\n${lines.map((line) => ` * ${line}`.trimEnd()).join('\n')}\n `
}

function phantomProperty(name: string, type: string): t.TSPropertySignature {
  const property = t.tsPropertySignature(
    t.identifier(name),
    t.tsTypeAnnotation(t.tsTypeReference(t.identifier(type))),
  )
  property.optional = true
  property.readonly = true
  return property
}

function recordOf(value: t.TSType): t.TSType {
  return t.tsTypeReference(
    globalIdentifier(RECORD),
    t.tsTypeParameterInstantiation([t.tsStringKeyword(), value]),
  )
}

/**
 * An identifier for one of TypeScript's own types. A schema type of the same name is renamed
 * within the module, and this identifier is neither a reference to it nor renamed with it.
 */
function globalIdentifier(name: string): t.Identifier {
  const identifier = t.identifier(name)
  identifier.extra = {global: true}
  return identifier
}

function isGlobal(identifier: t.Identifier): boolean {
  return identifier.extra?.['global'] === true
}

function documented<T extends t.Node>(node: T, comment: string): T {
  return t.addComment(node, 'leading', `*${comment}`, false)
}

/** `declare const internalGroqTypeReferenceTo: unique symbol`, as `sanity.types.ts` declares it. */
function internalReferenceSymbol(): t.Statement {
  const id = t.identifier(INTERNAL_REFERENCE_SYMBOL)
  id.typeAnnotation = t.tsTypeAnnotation(t.tsTypeOperator(t.tsSymbolKeyword(), 'unique'))
  const declaration = t.variableDeclaration('const', [t.variableDeclarator(id)])
  declaration.declare = true
  return declaration
}

/** `type ArrayOf<T> = Array<T & {_key: string}>`, as `sanity.types.ts` declares it. */
function arrayOf(): t.Statement {
  return t.tsTypeAliasDeclaration(
    t.identifier(ARRAY_OF),
    t.tsTypeParameterDeclaration([t.tsTypeParameter(null, null, t.identifier('T'))]),
    t.tsTypeReference(
      t.identifier('Array'),
      t.tsTypeParameterInstantiation([
        t.tsIntersectionType([
          t.tsTypeReference(t.identifier('T')),
          t.tsTypeLiteral([
            t.tsPropertySignature(t.identifier('_key'), t.tsTypeAnnotation(t.tsStringKeyword())),
          ]),
        ]),
      ]),
    ),
  )
}

/**
 * The schema aliases `referenced` names, and the ones they name in turn, in schema order. Every
 * name found on the way is added to `referenced`.
 */
function referencedSchemaTypes(schemaTypes: SchemaTypes, referenced: Set<string>) {
  const byName = new Map([...schemaTypes].map((schemaType) => [schemaType.id.name, schemaType]))
  const included = new Set<string>()
  const queue = [...referenced]
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    const schemaType = byName.get(name)
    if (!schemaType || included.has(name)) continue
    included.add(name)
    const inner = new Set<string>()
    collectReferences(schemaType.tsType, inner)
    for (const innerName of inner) {
      referenced.add(innerName)
      queue.push(innerName)
    }
  }
  return [...byName.values()].filter(({id}) => included.has(id.name))
}

/** New names for the aliases that collide with the module's own exports. */
function renamesFor(aliasNames: string[]): Map<string, string> {
  const renames = new Map<string, string>()
  const taken = new Set([...MODULE_NAMES, ...aliasNames])
  for (const name of aliasNames) {
    if (!MODULE_NAMES.has(name)) continue
    const id = getUniqueIdentifierForName(name, taken)
    taken.add(id.name)
    renames.set(name, id.name)
  }
  return renames
}

/** A copy of `node` with the identifiers in `renames` renamed. The original is shared and kept. */
function renamed<T extends t.TSType>(node: T, renames: Map<string, string>): T {
  const copy = t.cloneNode(node, true)
  visitIdentifiers(copy, (identifier) => {
    if (isGlobal(identifier)) return
    identifier.name = renames.get(identifier.name) ?? identifier.name
  })
  return copy
}

/**
 * Adds the identifiers a type mentions: the names of the types it refers to, and the computed
 * keys of its properties, which name a symbol. Plain property names are not references.
 */
function collectReferences(node: t.Node, into: Set<string>): void {
  visitIdentifiers(node, (identifier) => {
    if (!isGlobal(identifier)) into.add(identifier.name)
  })
}

function visitIdentifiers(node: t.Node, visit: (identifier: t.Identifier) => void): void {
  if (t.isIdentifier(node)) {
    visit(node)
    return
  }
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    if (key === 'key' && t.isTSPropertySignature(node) && !node.computed) continue
    const child = (node as unknown as Record<string, t.Node | t.Node[] | null>)[key]
    for (const item of Array.isArray(child) ? child : [child]) {
      if (item) visitIdentifiers(item, visit)
    }
  }
}
