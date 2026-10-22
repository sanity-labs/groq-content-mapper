import {createHash} from 'node:crypto'
import {dirname} from 'node:path'
import {type Readable, type Writable} from 'node:stream'

import * as v from 'valibot'

import {
  generateGroqModule,
  type GroqFileDiagnostic,
  GroqFileDiagnosticCode,
  renderGroqModule,
} from './groqModule.js'
import {JsonRpcError, JsonRpcErrorCode, type JsonRpcRequest, serveJsonRpc} from './jsonRpc.js'
import {
  parseGroqFilesOptions,
  type ResolvedGroqFiles,
  resolveGroqFiles,
  schemaFor,
} from './schemas.js'

/**
 * The source TypeScript shows for the mapper's diagnostics, as in `error groq2`.
 * @beta
 */
export const DIAGNOSTIC_SOURCE = 'groq'

/** The code of every option diagnostic: the message says what is wrong. */
const INVALID_OPTION = 1

/** The protocol version this mapper speaks. The 7.1 beta does not send one; later hosts do. */
const PROTOCOL_VERSION = 1

/**
 * The content mapper protocol of TypeScript 7.1, as far as this mapper uses it.
 * https://github.com/microsoft/typescript-go/pull/4712
 */
interface InitializeResult {
  diagnosticSource: string
  positionEncoding: 'utf-16'
  protocolVersion: number
}

interface OpenProjectResult {
  configIdentity: string
  watchedFiles: string[]

  optionDiagnostics?: OptionDiagnostic[]
}

interface OptionDiagnostic {
  code: number
  messageText: string
  /** Property names and array indexes into the mapper entry's `options` object. */
  path: (number | string)[]
}

interface TransformResult {
  /** `.mts`: the module is an ES module whatever the nearest package.json says, as every loader evaluates it. */
  extension: '.mts'
  text: string

  diagnostics?: GroqFileDiagnostic[]
}

interface Project {
  resolved: ResolvedGroqFiles
}

const initializeParams = v.looseObject({
  positionEncodings: v.array(v.string()),
  protocolVersion: v.optional(v.number()),
})

const openProjectParams = v.looseObject({
  configFileName: v.string(),
  options: v.optional(v.unknown()),
  projectHandle: v.string(),
})

const transformParams = v.looseObject({
  content: v.string(),
  fileName: v.string(),
  projectHandle: v.string(),
})

const closeProjectParams = v.looseObject({projectHandle: v.string()})

/**
 * A TypeScript 7.1 content mapper that types `.groq` files from their live content, so
 * `import query from './posts.groq'` is typed with nothing generated to disk. TypeScript
 * starts it from the `typescript.contentMapper` field of this package's `package.json` when a
 * `tsconfig.json` registers it:
 *
 * ```jsonc
 * {
 *   "contentMappers": [
 *     {"package": "@sanity-labs/groq-content-mapper", "extensions": [".groq"], "options": {"schema": "./schema.json"}}
 *   ]
 * }
 * ```
 *
 * The tsconfig is the only place the mapper is configured. `options` is a `GroqFilesOptions`
 * object: `schema`, the file `sanity schema extract` writes, or `schemas`, one such file per
 * folder for a codebase that queries more than one project or dataset. The mapper declares
 * `dynamicConfig`, so every schema is watched and the project is reopened when one changes.
 *
 * One instance serves any number of projects, each under the handle TypeScript assigns it.
 * @beta
 */
export class ContentMapper {
  private projects = new Map<string, Project>()

  private static initialize({
    positionEncodings,
    protocolVersion,
  }: v.InferOutput<typeof initializeParams>): InitializeResult {
    if (protocolVersion !== undefined && protocolVersion !== PROTOCOL_VERSION) {
      throw new JsonRpcError(
        JsonRpcErrorCode.InvalidParams,
        `This content mapper speaks protocol version ${PROTOCOL_VERSION}, not ${protocolVersion}.`,
      )
    }
    // Positions are JavaScript string offsets, which are UTF-16 code units.
    if (!positionEncodings.includes('utf-16')) {
      throw new JsonRpcError(
        JsonRpcErrorCode.InvalidParams,
        'This content mapper reports positions in utf-16, which the host does not accept.',
      )
    }
    return {
      diagnosticSource: DIAGNOSTIC_SOURCE,
      positionEncoding: 'utf-16',
      protocolVersion: PROTOCOL_VERSION,
    }
  }

  /**
   * Answers one request of the protocol: `initialize`, `openProject`, `transform` or
   * `closeProject`. Throws a `JsonRpcError` for a request the mapper cannot answer.
   */
  async handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'closeProject': {
        this.projects.delete(parse(closeProjectParams, params, method).projectHandle)
        return {}
      }
      case 'initialize': {
        return ContentMapper.initialize(parse(initializeParams, params, method))
      }
      case 'openProject': {
        return this.openProject(parse(openProjectParams, params, method))
      }
      case 'transform': {
        return this.transform(parse(transformParams, params, method))
      }
      default: {
        throw new JsonRpcError(JsonRpcErrorCode.MethodNotFound, `Unknown method "${method}".`)
      }
    }
  }

  /** Serves the protocol over the streams until `input` ends. */
  serve({input, output}: {input: Readable; output: Writable}): Promise<void> {
    return serveJsonRpc({
      handle: (request: JsonRpcRequest) => this.handle(request.method, request.params),
      input,
      output,
    })
  }

  private async openProject({
    configFileName,
    options,
    projectHandle,
  }: v.InferOutput<typeof openProjectParams>): Promise<OpenProjectResult> {
    // The protocol sends "" for a project without a tsconfig. The host starts this process in
    // the package directory, so without one only absolute paths in the options are usable.
    const root = configFileName === '' ? undefined : dirname(configFileName)
    const parsed = parseGroqFilesOptions(options)
    const optionDiagnostics = parsed.issues.map(({message, path}): OptionDiagnostic => ({
      code: INVALID_OPTION,
      messageText: message,
      path,
    }))

    const resolved = await resolveGroqFiles({options: parsed.options, root})
    this.projects.set(projectHandle, {resolved})

    // Every schema's path and content: a change to either reopens the project.
    const identity = createHash('sha256')
    for (const located of [resolved.fallback, ...resolved.scopes]) {
      identity.update(`${located?.schemaPath ?? ''}\0`)
      identity.update(located?.bytes ?? 'missing')
      identity.update('\0')
    }
    return {
      configIdentity: identity.digest('hex'),
      ...(optionDiagnostics.length > 0 ? {optionDiagnostics} : {}),
      watchedFiles: resolved.watchedFiles,
    }
  }

  private transform({
    content,
    fileName,
    projectHandle,
  }: v.InferOutput<typeof transformParams>): TransformResult {
    const project = this.projects.get(projectHandle)
    if (!project) {
      throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, `Unknown project "${projectHandle}".`)
    }

    const {resolved} = project
    const root = resolved.root ?? dirname(fileName)
    const located = schemaFor(resolved, fileName)
    if (!located.schema) {
      const messageText = located.error ?? 'No schema is configured.'
      const {code} = renderGroqModule({
        filename: fileName,
        notes: [messageText],
        query: content,
        root,
        schemaPath: located.schemaPath,
      })
      return {
        diagnostics: [
          {
            code: GroqFileDiagnosticCode.SchemaUnavailable,
            length: Math.min(1, content.length),
            messageText,
            start: 0,
          },
        ],
        extension: '.mts',
        text: code,
      }
    }

    const {code, diagnostics} = generateGroqModule({
      content,
      filename: fileName,
      root,
      schema: located.schema,
      schemaPath: located.schemaPath,
    })
    return {
      ...(diagnostics.length > 0 ? {diagnostics} : {}),
      extension: '.mts',
      text: code,
    }
  }
}

function parse<TSchema extends v.GenericSchema>(
  schema: TSchema,
  params: unknown,
  method: string,
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, params)
  if (result.success) return result.output
  const issues = result.issues.map(
    (issue) => `${v.getDotPath(issue) ?? 'params'}: ${issue.message}`,
  )
  throw new JsonRpcError(
    JsonRpcErrorCode.InvalidParams,
    `Invalid params for ${method}: ${issues.join('; ')}`,
  )
}
