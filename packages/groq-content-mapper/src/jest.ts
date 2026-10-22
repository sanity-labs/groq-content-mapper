import {createHash} from 'node:crypto'

import {groqModuleSource, groqModuleSourceCommonJs} from './runtime.js'

/**
 * The part of Jest's transform options this transformer reads.
 * @beta
 */
export interface GroqFilesJestOptions {
  configString?: string
  supportsStaticESM?: boolean
}

/**
 * A transformer for `transform` in Jest's config, which is where Jest takes a file it does not
 * read itself: it compiles a test's modules on its own, so neither the Node preload nor a
 * bundler plugin reaches a `.groq` file there.
 *
 * ```js
 * transform: {'\\.groq$': '@sanity-labs/groq-content-mapper/jest'}
 * ```
 *
 * The module is an ES module when Jest loads the file as one, with `--experimental-vm-modules`
 * and `.groq` in `extensionsToTreatAsEsm`, and CommonJS otherwise. Jest keeps a transformer's
 * output across runs under the key this gives, which is the module itself.
 * @beta
 */
const transformer = {
  getCacheKey(source: string, _path: string, options: GroqFilesJestOptions): string {
    return createHash('sha256')
      .update(make(source, options))
      .update(options.configString ?? '')
      .digest('hex')
  },
  process(source: string, _path: string, options: GroqFilesJestOptions): {code: string} {
    return {code: make(source, options)}
  },
}

function make(source: string, options: GroqFilesJestOptions): string {
  return options.supportsStaticESM ? groqModuleSource(source) : groqModuleSourceCommonJs(source)
}

export default transformer
