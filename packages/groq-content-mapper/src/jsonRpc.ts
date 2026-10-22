import {type Readable, type Writable} from 'node:stream'

type JsonRpcId = number | string | null

/** @beta */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  method: string

  id?: JsonRpcId
  params?: unknown
}

/** @beta */
export const JsonRpcErrorCode = {
  InternalError: -32_603,
  InvalidParams: -32_602,
  InvalidRequest: -32_600,
  MethodNotFound: -32_601,
  ParseError: -32_700,
} as const

/**
 * An error a request handler throws to answer with a specific JSON-RPC error code. Any other
 * error is answered as an internal error with its message.
 * @beta
 */
export class JsonRpcError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = 'JsonRpcError'
    this.code = code
  }
}

/** @beta */
export interface ServeJsonRpcOptions {
  /** Answers a request, or throws. The result is sent back as the response. */
  handle: (request: JsonRpcRequest) => Promise<unknown>
  input: Readable
  output: Writable
}

/**
 * Serves JSON-RPC 2.0 over a pair of streams, framed with `Content-Length` headers the way the
 * LSP base protocol and TypeScript's content mapper host do. Requests are answered one at a
 * time, in order. Resolves once `input` ends and the last answer is written, and rejects if
 * `input` errors.
 * @beta
 */
export async function serveJsonRpc({handle, input, output}: ServeJsonRpcOptions): Promise<void> {
  let buffer = Buffer.alloc(0)
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
    for (let frame = readFrame(buffer); frame; frame = readFrame(buffer)) {
      buffer = buffer.subarray(frame.consumed)
      // oxlint-disable-next-line no-await-in-loop -- requests are answered one at a time, in order
      await respond(frame.body, handle, output)
    }
  }
}

/** The next complete frame in `buffer`, or `undefined` while it is still arriving. */
function readFrame(buffer: Buffer): {body: Buffer | undefined; consumed: number} | undefined {
  const headerEnd = buffer.indexOf('\r\n\r\n')
  if (headerEnd === -1) return undefined
  const length = Number(/content-length:\s*(\d+)/i.exec(buffer.toString('utf8', 0, headerEnd))?.[1])
  // Without a length the body cannot be found. Only the header is dropped, and it is answered
  // as an invalid request so the host learns something was lost.
  if (!Number.isSafeInteger(length)) return {body: undefined, consumed: headerEnd + 4}
  const bodyStart = headerEnd + 4
  if (buffer.length < bodyStart + length) return undefined
  return {body: buffer.subarray(bodyStart, bodyStart + length), consumed: bodyStart + length}
}

async function respond(
  body: Buffer | undefined,
  handle: ServeJsonRpcOptions['handle'],
  output: Writable,
): Promise<void> {
  if (body === undefined) {
    writeError(output, null, JsonRpcErrorCode.InvalidRequest, 'Invalid Request')
    return
  }
  let message: unknown
  try {
    message = JSON.parse(body.toString('utf8'))
  } catch {
    writeError(output, null, JsonRpcErrorCode.ParseError, 'Parse error')
    return
  }
  if (!isRequest(message)) {
    writeError(output, idOf(message), JsonRpcErrorCode.InvalidRequest, 'Invalid Request')
    return
  }
  try {
    const result = await handle(message)
    // A request without an id is a notification, which is not answered.
    if (message.id !== undefined) write(output, {id: message.id, jsonrpc: '2.0', result})
  } catch (error) {
    if (message.id === undefined) return
    const code = error instanceof JsonRpcError ? error.code : JsonRpcErrorCode.InternalError
    const text = error instanceof Error ? error.message : 'Internal error'
    writeError(output, message.id, code, text)
  }
}

function isRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as {id?: unknown; jsonrpc?: unknown; method?: unknown}
  return (
    record.jsonrpc === '2.0' &&
    typeof record.method === 'string' &&
    (!('id' in record) || isId(record.id))
  )
}

function idOf(value: unknown): JsonRpcId {
  if (typeof value !== 'object' || value === null || !('id' in value)) return null
  return isId(value.id) ? value.id : null
}

function isId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === 'string' || typeof value === 'number'
}

function writeError(output: Writable, id: JsonRpcId, code: number, message: string): void {
  write(output, {error: {code, message}, id, jsonrpc: '2.0'})
}

function write(output: Writable, message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  output.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
}
