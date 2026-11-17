import {GroqFileReader, groqModuleSource} from './runtime.js'

/**
 * The context webpack and Turbopack give a loader. Typed structurally, so this file does not
 * depend on either bundler's types.
 */
interface GroqLoaderContext {
  /** The `.groq` file. */
  resourcePath: string
  /** Recompiles the module when `file` changes. */
  addDependency(file: string): void
}

/**
 * Webpack and Turbopack loader for `.groq` files: a module whose default export is the query,
 * with the custom functions it calls prepended. A new reader each time, so a rebuild sees an
 * edited functions file; `addDependency` is what asks for that rebuild. The bundler calls it
 * with the loader context as `this`.
 */
function groqLoader(this: GroqLoaderContext, source: string | Buffer): string {
  const {dependencies, text} = new GroqFileReader().read(this.resourcePath, String(source))
  for (const dependency of dependencies) this.addDependency(dependency)
  return groqModuleSource(text)
}

export default groqLoader
