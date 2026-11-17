// What the Node preload, the Vite plugin, the Jest transformer and the webpack loader share: a
// `.groq` file is a module whose default export is the query, and nothing else. The query is
// the file as it is, which is what the content mapper types. With the `functions` option, the
// definitions of the custom functions it calls come first, and unless `minify` is turned off the
// whole is minified, as the content mapper types them too. Without a tsconfig.json there are no
// options to read, and the file is delivered as it is.

import {existsSync, readFileSync} from 'node:fs'
import {dirname, resolve} from 'node:path'

import {getTsconfig} from 'get-tsconfig'

import {
  type LoadedGroqFunctions,
  loadGroqFunctions,
  minifyGroq,
  withGroqFunctions,
} from './functions.js'
import {type GroqMinifyOptions, parseGroqFilesOptions, resolveMinify} from './schemas.js'

const PACKAGE_NAME = '@sanity-labs/groq-content-mapper'

/**
 * Reads `.groq` files as the loaders deliver them. The `functions` and `minify` options come from this
 * package's `contentMappers` entry in the `tsconfig.json` nearest the file, which is read, with
 * the functions files, once until `clear`.
 */
interface ReadGroqConfig {
  functions?: LoadedGroqFunctions
  minify: Required<GroqMinifyOptions>
}

export class GroqFileReader {
  private loaded = new Map<string, ReadGroqConfig>()
  private tsconfigs = new Map<string, unknown>()

  clear(): void {
    this.loaded.clear()
    this.tsconfigs.clear()
  }

  /**
   * The text a `.groq` import evaluates to, and the files besides the `.groq` file it depends
   * on. Throws when the functions files cannot be used, saying why.
   */
  read(
    file: string,
    content: string = readFileSync(file, 'utf8'),
  ): {dependencies: string[]; text: string} {
    const tsconfig = getTsconfig(dirname(file), 'tsconfig.json', this.tsconfigs)
    if (!tsconfig) return {dependencies: [], text: content}
    // get-tsconfig gives `/` as the separator on every platform.
    const configPath = resolve(tsconfig.path)
    if (!this.loaded.has(configPath)) {
      const {contentMappers} = tsconfig.config as {contentMappers?: unknown}
      const entry = Array.isArray(contentMappers)
        ? (contentMappers as {options?: unknown; package?: unknown}[]).find(
            (each) => each?.package === PACKAGE_NAME,
          )
        : undefined
      const options = entry && parseGroqFilesOptions(entry.options).options
      this.loaded.set(configPath, {
        functions:
          options?.functions === undefined
            ? undefined
            : loadGroqFunctions(options.functions, dirname(configPath)),
        minify: resolveMinify(options?.minify),
      })
    }
    const loaded = this.loaded.get(configPath)
    if (!loaded) return {dependencies: [configPath], text: content}
    const dependencies = [
      configPath,
      ...(loaded.functions === undefined ? [] : loaded.functions.files.keys()),
    ]
    if (loaded.functions && loaded.functions.issues.length > 0) {
      const issues = loaded.functions.issues.map(({message}) => `- ${message}`).join('\n')
      throw new Error(
        `The custom GROQ functions that ${configPath} configures cannot be used:\n${issues}`,
      )
    }
    const query =
      loaded.functions === undefined
        ? content
        : withGroqFunctions(content, loaded.functions.functions)
    return {dependencies, text: loaded.minify.comments ? query : minifyGroq(query)}
  }
}

/** The module source for a `.groq` file's content. */
export function groqModuleSource(content: string): string {
  return `export default ${JSON.stringify(content)}\n`
}

/**
 * Whether an id names a `.groq` file outright. An id with a query or a hash, as in
 * `./posts.groq?raw`, asks another plugin for something this one does not make, so it is left
 * alone, as is a virtual id.
 */
export function isGroqFile(id: string): boolean {
  if (id.startsWith('\0') || !id.endsWith('.groq')) return false
  // A folder or file name can have a `#` or `?` in it too, as in `c#/posts.groq`, and only the
  // file system tells that apart from a query or hash.
  return !/[?#]/.test(id) || existsSync(id)
}

/**
 * The same module as CommonJS, for Jest when it loads the file that way. The default export is
 * a JSON string, so nothing in it can be mistaken for code, and `__esModule` lets a default
 * import compiled by Babel or TypeScript read `exports.default`.
 */
export function groqModuleSourceCommonJs(content: string): string {
  return `Object.defineProperty(exports, "__esModule", {value: true});\nexports.default = ${JSON.stringify(content)};\n`
}
