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
  const {hash, pathname, search} = new URL(url)
  // The path is checked as the URL has it: a `#` or `?` in a folder or file name is encoded
  // there, and only a real query or hash makes the import ask for something else.
  if (search || hash || !isGroqFile(pathname)) return nextLoad(url, context)
  const path = fileURLToPath(url)
  return {
    format: 'module',
    shortCircuit: true,
    source: groqModuleSource(readFileSync(path, 'utf8')),
  }
}
