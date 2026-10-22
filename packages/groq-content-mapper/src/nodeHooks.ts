import {readFileSync} from 'node:fs'
import {type LoadHookSync} from 'node:module'
import {fileURLToPath} from 'node:url'

import {groqModuleSource, isGroqFile} from './runtime.js'

/**
 * Node's `load` hook for `.groq` files. Synchronous, as `module.registerHooks` requires, and so
 * also what `module.register` accepts for the off-thread hooks of Node before 22.15. A URL that
 * is not a plain `.groq` file goes on to the next hook.
 */
export const load: LoadHookSync = (url, context, nextLoad) => {
  if (!url.startsWith('file:')) return nextLoad(url, context)
  const {hash, search} = new URL(url)
  const path = fileURLToPath(url.replace(/[?#].*$/, ''))
  if (search || hash || !isGroqFile(path)) return nextLoad(url, context)
  return {
    format: 'module',
    shortCircuit: true,
    source: groqModuleSource(readFileSync(path, 'utf8')),
  }
}
