import {PassThrough} from 'node:stream'

import {describe, expect, test} from 'vitest'

import {JsonRpcError, type JsonRpcRequest, serveJsonRpc} from '../jsonRpc.js'

interface Response {
  id: number | string | null

  error?: {code: number; message: string}
  result?: unknown
}

export function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message))
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}

export function decode(buffer: Buffer): Response[] {
  const messages: Response[] = []
  let rest = buffer
  while (rest.length > 0) {
    const headerEnd = rest.indexOf('\r\n\r\n')
    const length = Number(/content-length:\s*(\d+)/i.exec(rest.toString('utf8', 0, headerEnd))?.[1])
    const start = headerEnd + 4
    messages.push(JSON.parse(rest.toString('utf8', start, start + length)) as Response)
    rest = rest.subarray(start + length)
  }
  return messages
}

/** Serves `handle` over in-memory streams, feeds it `chunks`, and returns every response. */
export async function roundTrip(
  chunks: Buffer[],
  handle: (request: JsonRpcRequest) => Promise<unknown>,
): Promise<Response[]> {
  const input = new PassThrough()
  const output = new PassThrough()
  const written: Buffer[] = []
  output.on('data', (chunk: Buffer) => written.push(chunk))
  const served = serveJsonRpc({handle, input, output})
  for (const chunk of chunks) input.write(chunk)
  input.end()
  await served
  return decode(Buffer.concat(written))
}

describe('serveJsonRpc', () => {
  test('answers requests in order, across split and packed frames, and skips notifications', async () => {
    const first = frame({id: 1, jsonrpc: '2.0', method: 'echo', params: 'x'})
    const second = frame({id: 'two', jsonrpc: '2.0', method: 'echo'})
    const responses = await roundTrip(
      [
        first.subarray(0, 7),
        Buffer.concat([first.subarray(7), second]),
        frame({jsonrpc: '2.0', method: 'notify'}),
        frame({id: 3, jsonrpc: '2.0', method: 'echo', params: {deep: [1]}}),
      ],
      async (request) => request.params,
    )
    expect(responses).toEqual([
      {id: 1, jsonrpc: '2.0', result: 'x'},
      {id: 'two', jsonrpc: '2.0'},
      {id: 3, jsonrpc: '2.0', result: {deep: [1]}},
    ])
  })

  test('reports a parse error and invalid requests without stopping', async () => {
    const responses = await roundTrip(
      [
        Buffer.from('Content-Length: 5\r\n\r\n{nope'),
        frame({id: 'bad', jsonrpc: '1.0', method: 'x'}),
        frame({id: {nested: true}, jsonrpc: '2.0', method: 'x'}),
        frame([1, 2, 3]),
        Buffer.from('Content-Length: nope\r\n\r\n'),
        frame({id: 4, jsonrpc: '2.0', method: 'x'}),
      ],
      async () => 'ok',
    )
    expect(responses).toEqual([
      {error: {code: -32_700, message: 'Parse error'}, id: null, jsonrpc: '2.0'},
      {error: {code: -32_600, message: 'Invalid Request'}, id: 'bad', jsonrpc: '2.0'},
      {error: {code: -32_600, message: 'Invalid Request'}, id: null, jsonrpc: '2.0'},
      {error: {code: -32_600, message: 'Invalid Request'}, id: null, jsonrpc: '2.0'},
      {error: {code: -32_600, message: 'Invalid Request'}, id: null, jsonrpc: '2.0'},
      {id: 4, jsonrpc: '2.0', result: 'ok'},
    ])
  })

  test('maps thrown errors to error responses', async () => {
    const responses = await roundTrip(
      [
        frame({id: 1, jsonrpc: '2.0', method: 'typed'}),
        frame({id: 2, jsonrpc: '2.0', method: 'plain'}),
        frame({id: 3, jsonrpc: '2.0', method: 'weird'}),
        frame({jsonrpc: '2.0', method: 'plain'}),
      ],
      async (request) => {
        switch (request.method) {
          case 'plain': {
            throw new Error('boom')
          }
          case 'typed': {
            throw new JsonRpcError(-32_000, 'custom')
          }
          default: {
            throw 'not an error'
          }
        }
      },
    )
    expect(responses.map((response) => response.error)).toEqual([
      {code: -32_000, message: 'custom'},
      {code: -32_603, message: 'boom'},
      {code: -32_603, message: 'Internal error'},
    ])
  })

  test('rejects when the input errors', async () => {
    const input = new PassThrough()
    const served = serveJsonRpc({handle: async () => 'never', input, output: new PassThrough()})
    input.destroy(new Error('pipe broke'))
    await expect(served).rejects.toThrow('pipe broke')
  })
})
