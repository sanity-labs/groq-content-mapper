import {createHash} from 'node:crypto'

import {GroqFileReader, groqModuleSource, groqModuleSourceCommonJs} from './runtime.js'

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
  getCacheKey(source: string, path: string, options: GroqFilesJestOptions): string {
    return createHash('sha256')
      .update(make(source, path, options))
      .update(options.configString ?? '')
      .digest('hex')
  },
  process(source: string, path: string, options: GroqFilesJestOptions): {code: string} {
    return {code: make(source, path, options)}
  },
}

/** Read afresh each time: Jest's cache key is the module, so a changed functions file is a new key. */
function make(source: string, path: string, options: GroqFilesJestOptions): string {
  const {text} = new GroqFileReader().read(path, source)
  return options.supportsStaticESM ? groqModuleSource(text) : groqModuleSourceCommonJs(text)
}

export default transformer
