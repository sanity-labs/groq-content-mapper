import {readFileSync} from 'node:fs'

import {groqModuleSource, isGroqFile} from './runtime.js'

/**
 * The plugin `groqFiles()` returns. Typed structurally rather than as Vite's `Plugin`, so this
 * declaration does not depend on Vite's types; Vite, Vitest, Rollup and Rolldown accept it as is.
 * @beta
 */
export interface GroqFilesVitePlugin {
  enforce: 'pre'
  load: (id: string) => {code: string; map: null; moduleType: 'js'} | null
  name: string
}

/**
 * The plugin for Vite, Vitest, Rollup and Rolldown: a `.groq` import evaluates to the file's
 * text. Types come from the content mapper, not from here.
 *
 * ```ts
 * import groqFiles from '@sanity-labs/groq-content-mapper/vite'
 *
 * export default defineConfig({plugins: [groqFiles()]})
 * ```
 *
 * A Sanity Studio or App SDK app takes the same plugin in `vite.plugins` of `sanity.cli.ts`.
 *
 * `enforce: 'pre'` runs the hook before Vite's own handling of unknown files, and `moduleType`
 * tells Rolldown, which reads a module's type from its extension, that the code is JavaScript.
 * @beta
 */
export default function groqFiles(): GroqFilesVitePlugin {
  return {
    enforce: 'pre',
    load(id) {
      if (!isGroqFile(id)) return null
      return {code: groqModuleSource(readFileSync(id, 'utf8')), map: null, moduleType: 'js'}
    },
    name: '@sanity-labs/groq-content-mapper',
  }
}
