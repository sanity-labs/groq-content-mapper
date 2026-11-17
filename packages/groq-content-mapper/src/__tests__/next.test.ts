import {cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'

import {afterEach, describe, expect, test, vi} from 'vitest'
import {type Stats, webpack} from 'webpack'

import {type GroqFilesNextConfig, withGroqFiles} from '../next.js'
import {FIXTURES, linkPackage, postCardsWithFunctions, TYPESCRIPT_7_1} from './exampleProject.js'

type Built = Required<Pick<GroqFilesNextConfig, 'compiler' | 'typescript'>> & {
  webpack: NonNullable<GroqFilesNextConfig['webpack']>
}

/** The hook `withGroqFiles` leaves in the config, which `next build` runs after the compile. */
const afterCompile = (config: GroqFilesNextConfig) =>
  (withGroqFiles(config) as Built).compiler.runAfterProductionCompile!

let directory: string

/**
 * A Next.js app's directory, as the hook sees it: a `.groq` file, a module importing it, this
 * package, and and TypeScript 7.1.
 */
async function app(main: string): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), 'groq-content-mapper-next-'))
  await writeFile(join(directory, 'package.json'), '{"private": true, "type": "module"}\n')
  await writeFile(join(directory, 'schema.json'), await readFile(join(FIXTURES, 'schema.json')))
  await writeFile(
    join(directory, 'posts.groq'),
    await readFile(join(FIXTURES, 'queries', 'posts.groq')),
  )
  await writeFile(join(directory, 'main.ts'), main)
  await writeFile(join(directory, 'next-env.d.ts'), '')
  await writeFile(
    join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: 'ES2023',
        types: [],
      },
      contentMappers: [
        {
          extensions: ['.groq'],
          options: {schema: './schema.json'},
          package: '@sanity-labs/groq-content-mapper',
        },
      ],
      include: ['*.ts'],
    }),
  )
  await linkPackage(directory)
  await symlink(TYPESCRIPT_7_1, join(directory, 'node_modules', 'typescript'), 'junction')
  return directory
}

afterEach(async () => {
  vi.restoreAllMocks()
  if (directory) await rm(directory, {force: true, recursive: true})
})

describe('withGroqFiles', () => {
  test('the webpack loader prepends only the functions the query calls', async () => {
    const dir = await app('export {}\n')
    await cp(join(FIXTURES, 'functions'), dir, {recursive: true})
    await writeFile(
      join(dir, 'main.mjs'),
      "import postCards from './postCards.groq'\nexport {postCards}\n",
    )
    await writeFile(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        contentMappers: [
          {
            extensions: ['.groq'],
            options: {functions: 'lib/*.groq', schema: './schema.json'},
            package: '@sanity-labs/groq-content-mapper',
          },
        ],
      }),
    )
    const {module} = withGroqFiles<GroqFilesNextConfig>({}).webpack!(
      {
        module: {rules: []},
      },
      {isServer: false},
    )
    const stats = await new Promise<Stats | undefined>((resolve, reject) => {
      webpack(
        {
          context: dir,
          entry: join(dir, 'main.mjs'),
          experiments: {outputModule: true},
          mode: 'production',
          module,
          output: {filename: 'out.mjs', library: {type: 'module'}, path: join(dir, 'dist')},
        },
        (error, result) => (error ? reject(error) : resolve(result)),
      )
    })
    expect(stats?.hasErrors()).toBe(false)
    const bundled = (await import(pathToFileURL(join(dir, 'dist', 'out.mjs')).href)) as {
      postCards: string
    }
    const delivered = bundled.postCards
    expect(delivered).toBe(await postCardsWithFunctions())
    expect(delivered).not.toContain('post::tagged')
  }, 60_000)

  test('adds the loader to Turbopack and, after the project\u2019s rules, to webpack, and leaves the rest alone', () => {
    const seen: string[] = []
    const config = withGroqFiles({
      reactStrictMode: true,
      turbopack: {root: '/app', rules: {'*.svg': {as: '*.js', loaders: ['@svgr/webpack']}}},
      webpack(webpackConfig: {module: {rules: unknown[]}}, context: {isServer: boolean}) {
        seen.push(context.isServer ? 'server' : 'client')
        return webpackConfig
      },
    })

    expect(config.reactStrictMode).toBe(true)
    const groqRule = {as: '*.js', loaders: [expect.stringMatching(/[/\\]loader\.js$/)]}
    expect(config.turbopack).toEqual({
      root: '/app',
      rules: {'*.groq': groqRule, '*.svg': {as: '*.js', loaders: ['@svgr/webpack']}},
    })
    for (const isServer of [true, false]) {
      const [rule] = config.webpack({module: {rules: []}}, {isServer}).module.rules as {
        test: RegExp
        type: string
        use: string[]
      }[]
      expect(rule?.type).toBe('javascript/auto')
      expect(rule?.use).toEqual(groqRule.loaders)
      expect(rule?.test.test('posts.groq')).toBe(true)
      expect(rule?.test.test('posts.groq.ts')).toBe(false)
    }
    expect(seen).toEqual(['server', 'client'])
  })

  test('turns Next\u2019s type check off for its own, and leaves both off where the project did', () => {
    const config = withGroqFiles({typescript: {tsconfigPath: 'tsconfig.app.json'}}) as Built
    expect(config.typescript).toEqual({ignoreBuildErrors: true, tsconfigPath: 'tsconfig.app.json'})
    expect(typeof config.compiler.runAfterProductionCompile).toBe('function')

    const off: GroqFilesNextConfig = withGroqFiles({typescript: {ignoreBuildErrors: true}})
    expect(off.typescript).toEqual({ignoreBuildErrors: true})
    expect(off.compiler).toBeUndefined()

    // Wrapped again, the outer wrapper finds Next's check off and adds no second one.
    expect((withGroqFiles(config) as Built).compiler.runAfterProductionCompile).toBe(
      config.compiler.runAfterProductionCompile,
    )
  })

  test('the type check runs the content mapper after the project\u2019s own hook', async () => {
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {})
    const order: string[] = []
    const hook = afterCompile({
      compiler: {
        async runAfterProductionCompile() {
          order.push('project')
        },
      },
    })

    // Without --runExternalCode the import is TS2307, and the tsconfig entry TS18068.
    const good = await app(
      "import posts from './posts.groq'\nimport type {QueryResponse} from './posts.groq'\nexport const q: string = posts\nexport type R = QueryResponse\n",
    )
    await hook({distDir: join(good, '.next'), projectDir: good})
    expect(order).toEqual(['project'])
    expect(printed).not.toHaveBeenCalled()
  }, 60_000)

  test('the type check fails on an error, at its line and column', async () => {
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {})
    const bad = await app("import posts from './posts.groq'\nexport const n: number = posts\n")
    await expect(afterCompile({})({distDir: join(bad, '.next'), projectDir: bad})).rejects.toThrow(
      'Failed to type check (tsc --runExternalCode).',
    )
    const output = printed.mock.calls.map((call) => String(call[0])).join('\n')
    expect(output).toMatch(
      /main\.ts\(2,14\): error TS2322: Type '.*' is not assignable to type 'number'\./,
    )
  }, 60_000)

  test('on a first build the type check runs `next typegen`, which writes next-env.d.ts', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const root = await app("import posts from './posts.groq'\nexport const q: string = posts\n")
    const next = join(root, 'node_modules', 'next')
    await mkdir(join(next, 'dist', 'bin'), {recursive: true})
    await writeFile(
      join(next, 'package.json'),
      JSON.stringify({bin: {next: './dist/bin/next'}, name: 'next'}),
    )
    await writeFile(
      join(next, 'dist', 'bin', 'next'),
      `require("node:fs").writeFileSync(require("node:path").join(process.argv[3], "next-env.d.ts"), "// " + process.argv.slice(2).join(" ") + "\\n");\n`,
    )
    await rm(join(root, 'next-env.d.ts'))

    await afterCompile({})({distDir: join(root, '.next'), projectDir: root})
    expect(await readFile(join(root, 'next-env.d.ts'), 'utf8')).toBe(`// typegen ${root}\n`)
  }, 60_000)

  test('the type check refuses a TypeScript older than 7.1', async () => {
    directory = await mkdtemp(join(tmpdir(), 'groq-content-mapper-next-'))
    await writeFile(join(directory, 'package.json'), '{}')
    await mkdir(join(directory, 'node_modules', 'typescript'), {recursive: true})
    await writeFile(
      join(directory, 'node_modules', 'typescript', 'package.json'),
      '{"name": "typescript", "version": "5.9.3"}',
    )
    await expect(
      afterCompile({})({distDir: join(directory, '.next'), projectDir: directory}),
    ).rejects.toThrow(/needs TypeScript 7\.1 or later.*; the project has TypeScript 5\.9\.3/)
  })
})
