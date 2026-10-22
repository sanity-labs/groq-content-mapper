// What the Node preload, the Vite plugin and the Jest transformer share: a `.groq` file is a
// module whose default export is the file's text, and nothing else. The text is the file as it
// is, which is what `import query from './posts.groq' with {type: 'text'}` evaluates to where a
// runtime or bundler handles the attribute itself, and what the content mapper types.

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
  return !id.startsWith('\0') && !/[?#]/.test(id) && id.endsWith('.groq')
}

/**
 * The same module as CommonJS, for Jest when it loads the file that way. The default export is
 * a JSON string, so nothing in it can be mistaken for code, and `__esModule` lets a default
 * import compiled by Babel or TypeScript read `exports.default`.
 */
export function groqModuleSourceCommonJs(content: string): string {
  return `Object.defineProperty(exports, "__esModule", {value: true});\nexports.default = ${JSON.stringify(content)};\n`
}
