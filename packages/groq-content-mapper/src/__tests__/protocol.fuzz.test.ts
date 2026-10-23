import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PassThrough} from 'node:stream'

import * as fc from 'fast-check'
import {afterAll, beforeAll, describe, expect, test} from 'vitest'

import {ContentMapper} from '../contentMapper.js'
import {JsonRpcError, JsonRpcErrorCode, type JsonRpcRequest, serveJsonRpc} from '../jsonRpc.js'
import {FUZZ_TIMEOUT, fuzzOptions} from './fuzz/fuzz.js'
import {groqQuery, mangledQuery} from './fuzz/groqArbitraries.js'
import {decode, frame} from './jsonRpc.test.js'

/** Serves `handle` over in-memory streams, feeding it `chunks`, and returns all that was written. */
async function serve(
  chunks: Buffer[],
  handle: (request: JsonRpcRequest) => Promise<unknown>,
): Promise<Buffer> {
  const input = new PassThrough()
  const output = new PassThrough()
  const written: Buffer[] = []
  output.on('data', (chunk: Buffer) => written.push(chunk))
  const served = serveJsonRpc({handle, input, output})
  for (const chunk of chunks) input.write(chunk)
  input.end()
  await served
  return Buffer.concat(written)
}

/** `buffer` cut at the given offsets. */
function split(buffer: Buffer, cuts: number[]): Buffer[] {
  const offsets = [...new Set(cuts.map((cut) => cut % (buffer.length + 1)))].toSorted(
    (a, b) => a - b,
  )
  return [0, ...offsets].map((from, index) =>
    buffer.subarray(from, [...offsets, buffer.length][index]),
  )
}

const request = fc.record(
  {
    id: fc.oneof(fc.integer(), fc.string(), fc.constant(null)),
    jsonrpc: fc.constantFrom('2.0', '2.0', '2.0', '1.0'),
    method: fc.constantFrom('echo', 'fail', 'typed'),
    params: fc.jsonValue(),
  },
  {requiredKeys: ['jsonrpc', 'method']},
)

const message = fc.oneof(
  {arbitrary: request.map((value) => frame(value)), weight: 5},
  {arbitrary: fc.jsonValue().map((value) => frame(value)), weight: 1},
  {
    arbitrary: fc
      .string({maxLength: 12, unit: 'binary'})
      .map((text) => Buffer.from(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`)),
    weight: 1,
  },
)

async function echo(request: JsonRpcRequest): Promise<unknown> {
  if (request.method === 'fail') throw new Error('boom')
  if (request.method === 'typed') throw new JsonRpcError(-32_000, 'typed')
  return request.params
}

describe('serveJsonRpc, fuzzed', () => {
  test(
    'answers the same however the stream is split into chunks',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(message, {maxLength: 6, minLength: 1}),
          fc.array(fc.nat(), {maxLength: 8}),
          async (messages, cuts) => {
            const stream = Buffer.concat(messages)
            const whole = await serve([stream], echo)
            const pieces = await serve(split(stream, cuts), echo)
            expect(pieces.equals(whole)).toBe(true)
            // One answer per message that is not a notification, each valid JSON-RPC.
            for (const answer of decode(whole)) {
              expect(answer).toHaveProperty('jsonrpc', '2.0')
              expect('result' in answer || 'error' in answer).toBe(true)
            }
          },
        ),
        fuzzOptions(200),
      )
    },
    FUZZ_TIMEOUT,
  )

  test(
    'never rejects, whatever bytes arrive',
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.uint8Array({maxLength: 64}), async (bytes) => {
          await serve([Buffer.from(bytes)], echo)
        }),
        fuzzOptions(300),
      )
    },
    FUZZ_TIMEOUT,
  )
})

let directory: string
let schemaPath: string

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'groq-content-mapper-protocol-'))
  schemaPath = join(directory, 'schema.json')
  await writeFile(
    schemaPath,
    await readFile(new URL('fixtures/schema.json', import.meta.url), 'utf8'),
  )
})

afterAll(async () => {
  await rm(directory, {force: true, recursive: true})
})

/** A request's params: usually the right shape with odd values, sometimes anything at all. */
const paramsFor = (method: string) =>
  fc
    .oneof(
      {arbitrary: fc.anything(), weight: 1},
      {
        arbitrary: fc.record(
          {
            configFileName: fc.constantFrom('', 'tsconfig.json', '/nowhere/tsconfig.json', '\0'),
            content: fc.oneof(groqQuery, mangledQuery, fc.string()),
            fileName: fc.constantFrom('', 'a.groq', '/x/(shop)/[locale]/a.groq', 'C:\\x\\a.groq'),
            options: fc.oneof(
              fc.constant({schema: 'SCHEMA'}),
              fc.constant({schemas: [{include: '/', schema: 'SCHEMA'}]}),
              fc.anything(),
            ),
            positionEncodings: fc.oneof(fc.constant(['utf-16']), fc.anything()),
            projectHandle: fc.constantFrom('p1', 'p2', ''),
            protocolVersion: fc.oneof(fc.constant(1), fc.anything()),
          },
          {requiredKeys: []},
        ),
        weight: 4,
      },
    )
    .map((params) => ({method, params}))

const call = fc.oneof(
  ...['initialize', 'openProject', 'transform', 'closeProject', 'shutdown', '__proto__'].map(
    (method) => paramsFor(method),
  ),
)

describe('ContentMapper, fuzzed', () => {
  test(
    'answers every request, or fails it with a protocol error rather than an internal one',
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(call, {maxLength: 8, minLength: 1}), async (calls) => {
          const mapper = new ContentMapper()
          for (const {method, params} of calls) {
            const resolved =
              typeof params === 'object' && params !== null && 'options' in params
                ? JSON.parse(
                    JSON.stringify(params).replaceAll('"SCHEMA"', JSON.stringify(schemaPath)),
                  )
                : params
            try {
              // oxlint-disable-next-line no-await-in-loop -- the calls build on each other, in order
              await mapper.handle(method, resolved)
            } catch (error) {
              expect(error, `${method} ${JSON.stringify(resolved)}`).toBeInstanceOf(JsonRpcError)
              expect([JsonRpcErrorCode.InvalidParams, JsonRpcErrorCode.MethodNotFound]).toContain(
                (error as JsonRpcError).code,
              )
            }
          }
        }),
        fuzzOptions(200),
      )
    },
    FUZZ_TIMEOUT,
  )
})
