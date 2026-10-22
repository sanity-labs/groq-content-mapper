import {execFile, execFileSync} from 'node:child_process'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {promisify} from 'node:util'
import {compileFunction} from 'node:vm'

import {build as esbuild} from 'esbuild'
import {type SchemaType} from 'groq-js'
import {createServer, build as vite, type Plugin as VitePlugin} from 'vite'
import {afterEach, describe, expect, expectTypeOf, test} from 'vitest'
import {type Stats, webpack} from 'webpack'

import {generateGroqModule} from '../groqModule.js'
import jestGroqFiles from '../jest.js'
import {load} from '../nodeHooks.js'
import {groqModuleSource, groqModuleSourceCommonJs, isGroqFile} from '../runtime.js'
import viteGroqFiles from '../vite.js'
import {FIXTURES, linkPackage, PACKAGE_ROOT} from './exampleProject.js'

const execFileAsync = promisify(execFile)
const QUERY_FILE = join(FIXTURES, 'queries', 'postsBySearch.groq')

/** The import every host should evaluate to the file's text, and the module's only export. */
const MAIN = [
  "import postsBySearch from './postsBySearch.groq' with {type: 'text'}",
  "import * as postsModule from './postsBySearch.groq' with {type: 'text'}",
  'export {postsBySearch, postsModule}',
  '',
].join('\n')

interface Bundled {
  postsBySearch: string
  postsModule: Record<string, unknown>
}

let directory: string

/** A project with the fixture query and `main.mjs` importing it as text. */
async function project(): Promise<{directory: string; query: string}> {
  directory = await mkdtemp(join(tmpdir(), 'groq-content-mapper-runtime-'))
  const query = await readFile(QUERY_FILE, 'utf8')
  await writeFile(join(directory, 'postsBySearch.groq'), query)
  await writeFile(join(directory, 'main.mjs'), MAIN)
  await writeFile(join(directory, 'package.json'), '{"type": "module"}\n')
  return {directory, query}
}

async function evaluate(code: string): Promise<Bundled> {
  const file = join(directory, 'bundle.mjs')
  await writeFile(file, code)
  return (await import(pathToFileURL(file).href)) as Bundled
}

/** Stands in for the next hook in the chain. */
const next = () => ({format: 'next', shortCircuit: true})

function bunAvailable(): boolean {
  try {
    execFileSync('bun', ['--version'], {stdio: 'ignore'})
    return true
  } catch {
    return false
  }
}

/** Node 26.5 added `--experimental-import-text`. */
function nodeHasTextImports(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  return major > 26 || (major === 26 && minor >= 5)
}

/** CommonJS run as Node runs a module: its exports. */
function evaluateCommonJs(code: string): Record<string, unknown> & {default?: unknown} {
  const module = {exports: {} as Record<string, unknown>}
  compileFunction(code, ['exports', 'require', 'module'])(
    module.exports,
    createRequire(import.meta.url),
    module,
  )
  return module.exports
}

const jestCacheKey = (
  text: string,
  options: {configString?: string; supportsStaticESM?: boolean},
) => jestGroqFiles.getCacheKey(text, '/app/posts.groq', options)

afterEach(async () => {
  if (directory) await rm(directory, {force: true, recursive: true})
})

describe('a .groq file at runtime', () => {
  test('is a module whose only export is the file\u2019s exact text', async () => {
    directory = await mkdtemp(join(tmpdir(), 'groq-content-mapper-runtime-'))
    const file = join(directory, 'module.mjs')
    await writeFile(file, groqModuleSource('  *[_type == "post"]{title}\n'))
    const module = (await import(pathToFileURL(file).href)) as {default?: unknown}
    expect(Object.keys(module)).toEqual(['default'])
    expect(module.default).toBe('  *[_type == "post"]{title}\n')
    expect(groqModuleSource('a "quoted" \\ query')).toBe(
      'export default "a \\"quoted\\" \\\\ query"\n',
    )
  })

  test('has the text the type declares', async () => {
    const content = await readFile(QUERY_FILE, 'utf8')
    const schema = JSON.parse(await readFile(join(FIXTURES, 'schema.json'), 'utf8')) as SchemaType
    const {query} = generateGroqModule({content, filename: 'x.groq', schema})
    expect(query).toBe(content)
    expect(groqModuleSource(content)).toBe(`export default ${JSON.stringify(query)}\n`)
  })

  test('is recognized by id, leaving queries, hashes and virtual ids to others', () => {
    expect(isGroqFile('/app/posts.groq')).toBe(true)
    expect(isGroqFile('/app/posts.groq?raw')).toBe(false)
    expect(isGroqFile('/app/posts.groq#x')).toBe(false)
    expect(isGroqFile('\0/app/posts.groq')).toBe(false)
    expect(isGroqFile('/app/posts.groq.ts')).toBe(false)
    expect(isGroqFile('/app/posts.ts')).toBe(false)
  })
})

describe('Node', () => {
  test('the load hook makes the module and passes anything else on', () => {
    const url = pathToFileURL(QUERY_FILE).href
    const loaded = load(url, {} as never, next as never) as {format: string; source: string}
    expect(loaded.format).toBe('module')
    expect(loaded.source).toMatch(/^export default "\*\[_type == \\"post\\"\] \| score\(/)
    for (const other of [`${url}?raw`, `${url}#x`, url.replace(/\.groq$/, '.ts'), 'node:fs']) {
      expect((load(other, {} as never, next as never) as {format: string}).format).toBe('next')
    }
  })

  test('`node --import @sanity-labs/groq-content-mapper/register` runs the text import', async () => {
    const {directory: root, query} = await project()
    await linkPackage(root)
    await writeFile(
      join(root, 'run.mjs'),
      "import {postsBySearch, postsModule} from './main.mjs'\nconsole.log(JSON.stringify({postsBySearch, keys: Object.keys(postsModule)}))\n",
    )

    const {stdout} = await execFileAsync(
      process.execPath,
      ['--import', '@sanity-labs/groq-content-mapper/register', 'run.mjs'],
      {cwd: root},
    )
    expect(JSON.parse(stdout)).toEqual({keys: ['default'], postsBySearch: query})
  }, 30_000)

  test.skipIf(!nodeHasTextImports())(
    'Node 26.5 and later run the text import alone, with --experimental-import-text',
    async () => {
      const {directory: root, query} = await project()
      await writeFile(
        join(root, 'run.mjs'),
        "import {postsBySearch} from './main.mjs'\nconsole.log(JSON.stringify(postsBySearch))\n",
      )
      const {stdout} = await execFileAsync(
        process.execPath,
        ['--experimental-import-text', 'run.mjs'],
        {cwd: root},
      )
      expect(JSON.parse(stdout)).toBe(query)
    },
    30_000,
  )
})

// Bun is not installed in CI; this ran against Bun 1.4.4 when written, and runs wherever `bun` is on the path.
describe.skipIf(!bunAvailable())('Bun', () => {
  test('runs the text import with nothing added', async () => {
    const {directory: root, query} = await project()
    await writeFile(
      join(root, 'run.ts'),
      "import {postsBySearch, postsModule} from './main.mjs'\nconsole.log(JSON.stringify({postsBySearch, keys: Object.keys(postsModule)}))\n",
    )
    const {stdout} = await execFileAsync('bun', ['run', 'run.ts'], {cwd: root})
    expect(JSON.parse(stdout)).toEqual({keys: ['default'], postsBySearch: query})
  }, 30_000)
})

describe('bundlers', () => {
  test('esbuild bundles the text import with nothing added', async () => {
    const {directory: root, query} = await project()
    const result = await esbuild({
      bundle: true,
      entryPoints: [join(root, 'main.mjs')],
      format: 'esm',
      write: false,
    })
    const bundled = await evaluate(result.outputFiles.map((file) => file.text).join('\n'))
    expect(bundled.postsBySearch).toBe(query)
    expect(Object.keys(bundled.postsModule)).toEqual(['default'])
  })

  test('webpack 5.102 and later bundle the text import with nothing added', async () => {
    const {directory: root, query} = await project()
    const stats = await new Promise<Stats | undefined>((resolve, reject) => {
      webpack(
        {
          context: root,
          entry: join(root, 'main.mjs'),
          experiments: {outputModule: true},
          mode: 'production',
          output: {filename: 'out.mjs', library: {type: 'module'}, path: join(root, 'dist')},
        },
        (error, result) => (error ? reject(error) : resolve(result)),
      )
    })
    expect(stats?.hasErrors()).toBe(false)
    const bundled = (await import(pathToFileURL(join(root, 'dist', 'out.mjs')).href)) as Bundled
    expect(bundled.postsBySearch).toBe(query)
    expect(Object.keys(bundled.postsModule)).toEqual(['default'])
  }, 60_000)

  test('Vite needs the plugin, which serves the text import in dev and in a build', async () => {
    const {directory: root, query} = await project()
    const plugin = viteGroqFiles()
    expectTypeOf(plugin).toExtend<VitePlugin>()
    expect(plugin.load(`${join(root, 'postsBySearch.groq')}?raw`)).toBeNull()
    expect(plugin.load(join(root, 'main.mjs'))).toBeNull()

    // Without the plugin, Rolldown reads the .groq file as JavaScript.
    await expect(
      vite({
        build: {
          lib: {entry: join(root, 'main.mjs'), fileName: 'out', formats: ['es']},
          write: false,
        },
        configFile: false,
        logLevel: 'silent',
        root,
      }),
    ).rejects.toThrow()

    const built = await vite({
      build: {lib: {entry: join(root, 'main.mjs'), fileName: 'out', formats: ['es']}, write: false},
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      root,
    })
    const bundle = Array.isArray(built) ? built[0] : built
    if (!bundle || !('output' in bundle)) throw new Error('Vite did not emit a bundle')
    const bundled = await evaluate(
      bundle.output.map((item) => (item.type === 'chunk' ? item.code : '')).join('\n'),
    )
    expect(bundled.postsBySearch).toBe(query)
    expect(Object.keys(bundled.postsModule)).toEqual(['default'])

    const server = await createServer({
      configFile: false,
      logLevel: 'silent',
      plugins: [viteGroqFiles()],
      root,
      server: {middlewareMode: true},
    })
    try {
      const served = (await server.ssrLoadModule('/main.mjs')) as Bundled
      expect(served.postsBySearch).toBe(query)
    } finally {
      await server.close()
    }
  }, 60_000)

  test('the Jest transformer makes an ES module or CommonJS, as Jest loads the file', () => {
    const source = ' *[_type == "post"]\n'
    const esm = jestGroqFiles.process(source, '/app/posts.groq', {supportsStaticESM: true})
    expect(esm.code).toBe(groqModuleSource(source))

    const cjs = jestGroqFiles.process(source, '/app/posts.groq', {})
    expect(cjs.code).toBe(groqModuleSourceCommonJs(source))
    const exported = evaluateCommonJs(cjs.code)
    expect(exported.default).toBe(source)
    // Non-enumerable, as Babel's interop defines it, so a default import reads `.default`.
    expect(Object.getOwnPropertyDescriptor(exported, '__esModule')).toMatchObject({
      enumerable: false,
      value: true,
    })

    expect(jestCacheKey(source, {})).toBe(jestCacheKey(source, {}))
    expect(jestCacheKey(source, {})).not.toBe(jestCacheKey(`${source}\n`, {}))
    expect(jestCacheKey(source, {})).not.toBe(jestCacheKey(source, {supportsStaticESM: true}))
    expect(jestCacheKey(source, {})).not.toBe(jestCacheKey(source, {configString: '{}'}))
  })
})

describe('the package', () => {
  test('exports one entry per host that needs one', async () => {
    const {exports} = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
    }
    expect(Object.keys(exports)).toEqual([
      '.',
      './jest',
      './next',
      './register',
      './vite',
      './package.json',
    ])
  })
})
