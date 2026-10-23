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
  /** The query the default export evaluates to: the file's exact content, as a text import delivers it. */
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
  /** The file's content, which is also the query: a text import delivers the file as it is. */
  content: string
  /** The `.groq` file, named in a comment at the top of the module. */
  filename: string
  schema: SchemaType

  /** The directory file names in comments are relative to. Defaults to the working directory. */
  root?: string
  /** The schema file, named in a comment at the top of the module. */
  schemaPath?: string
}

/**
 * Types one `.groq` file as a TypeScript module, so a text import of the file,
 * `import query from './file.groq' with {type: 'text'}`, gives a query string that carries
 * its own types:
 *
 * ```ts
 * export type QueryResponse = Array<{title: string | null}>
 * export type QueryParams = {slug: string}
 * declare const query: '*[_type == "post" && slug.current == $slug]{title}\n' & {
 *   readonly __groqResult?: QueryResponse
 *   readonly __groqParams?: QueryParams
 * }
 * export default query
 * ```
 *
 * The literal is the file's exact content, whitespace and all, because that is what a text
 * import evaluates to at run time; GROQ does not mind the whitespace. The result type is
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
  const {content, filename, root, schema, schemaPath} = options
  const query = content
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

  if (query.trim().length === 0) {
    report(GroqFileDiagnosticCode.EmptyFile, 'This .groq file has no query.', 0, content.length)
    return render({})
  }

  let ast: ReturnType<typeof safeParseQuery>
  try {
    ast = safeParseQuery(query)
  } catch (error) {
    const position = error instanceof GroqSyntaxError ? error.position : 0
    report(GroqFileDiagnosticCode.SyntaxError, getMessage(error), position, 1)
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
    report(GroqFileDiagnosticCode.EvaluationFailed, message, 0, query.length)
    notes.push(message)
    return render({})
  }
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
  return {ast, code: body.map((statement) => generateCode(statement)).join('')}
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
 * The default export's declaration: the query's literal type intersected with an object of two
 * optional, readonly phantom properties, `__groqResult` and `__groqParams`. The properties never
 * exist at runtime, and because they are optional the value is still assignable to `string` and
 * to its own literal.
 */
function queryDeclaration(query: string): t.VariableDeclaration {
  const brand = t.tsTypeLiteral([
    phantomProperty(GROQ_RESULT_BRAND, QUERY_RESPONSE),
    phantomProperty(GROQ_PARAMS_BRAND, QUERY_PARAMS),
  ])
  const id = t.identifier('query')
  id.typeAnnotation = t.tsTypeAnnotation(
    t.tsIntersectionType([t.tsLiteralType(t.stringLiteral(query)), brand]),
  )
  const declaration = t.variableDeclaration('const', [t.variableDeclarator(id)])
  declaration.declare = true
  return declaration
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
    t.tsTypeParameterDeclaration([t.tsTypeParameter(null, null, 'T')]),
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
