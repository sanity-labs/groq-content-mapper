import {spawn} from 'node:child_process'
import {existsSync, readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname, join, resolve} from 'node:path'

const WEBPACK_TEST = /\.groq$/

type AfterProductionCompile = (metadata: {distDir: string; projectDir: string}) => Promise<void>

/**
 * The part of a Next.js config `withGroqFiles` reads or sets, so this entry does not depend on
 * `next`. Each field admits Next's own type, and the rest of the config passes through as it is.
 * @beta
 */
export interface GroqFilesNextConfig {
  compiler?: {runAfterProductionCompile?: AfterProductionCompile}
  typescript?: {ignoreBuildErrors?: boolean; tsconfigPath?: string}
  webpack?: ((config: any, context: any) => any) | null
}

/**
 * Sets a Next.js app up for `import query from './posts.groq' with {type: 'text'}`:
 *
 * ```ts
 * // next.config.ts
 * import {withGroqFiles} from '@sanity-labs/groq-content-mapper/next'
 *
 * export default withGroqFiles(nextConfig)
 * ```
 *
 * Turbopack handles the attribute itself (Next.js 16.3 and later). The webpack Next bundles,
 * 5.98, predates webpack's built-in rule for it, so the wrapper adds one: the file as its
 * source, through webpack's own `asset/source`, after the project's rules.
 *
 * It also takes over the type check `next build` runs. Next runs the project's `tsc` for that
 * check, but without `--runExternalCode`, which TypeScript takes from the command line only, so
 * that check cannot start the content mapper and fails on every `.groq` import. The wrapper
 * turns Next's check off and runs the same check with the flag in
 * `compiler.runAfterProductionCompile`, which Next runs after the compile under either bundler,
 * after the project's own hook and before the prerender; on a first build it runs `next typegen`
 * first, since Next writes `next-env.d.ts` only later. A project that set
 * `typescript.ignoreBuildErrors` itself gets no check.
 * @beta
 */
export function withGroqFiles<Config extends GroqFilesNextConfig>(
  config: Config = {} as Config,
): Config {
  const {compiler, typescript, webpack} = config
  const check = !typescript?.ignoreBuildErrors
  return {
    ...config,
    webpack(webpackConfig: any, context: any) {
      const out = webpack ? webpack(webpackConfig, context) : webpackConfig
      out.module.rules.push({test: WEBPACK_TEST, type: 'asset/source'})
      return out
    },
    ...(check && {
      compiler: {
        ...compiler,
        async runAfterProductionCompile(metadata: {distDir: string; projectDir: string}) {
          await compiler?.runAfterProductionCompile?.(metadata)
          const tsconfig = resolve(metadata.projectDir, typescript?.tsconfigPath ?? 'tsconfig.json')
          await typeCheck(metadata.projectDir, tsconfig)
        },
      },
      typescript: {...typescript, ignoreBuildErrors: true},
    }),
  }
}

/**
 * Next's own check, `next/dist/lib/typescript/runTypeCheckCli`, with `--runExternalCode`: the
 * project's TypeScript, run with this process's Node from the project directory.
 */
async function typeCheck(dir: string, tsconfig: string): Promise<void> {
  const require = createRequire(join(dir, 'package.json'))
  let manifest: string
  try {
    manifest = require.resolve('typescript/package.json')
  } catch {
    throw stackless(
      'The .groq type check needs TypeScript 7.1 or later, whose content mappers type the imports, and the project has no TypeScript.',
    )
  }
  const {version} = JSON.parse(readFileSync(manifest, 'utf8')) as {version: string}
  const [major = 0, minor = 0] = version.split('.').map(Number)
  if (major < 7 || (major === 7 && minor < 1)) {
    throw stackless(
      `The .groq type check needs TypeScript 7.1 or later, whose content mappers type the imports; the project has TypeScript ${version}.`,
    )
  }

  // Next writes next-env.d.ts after this hook; `next typegen` writes it on a first build.
  if (!existsSync(join(dir, 'next-env.d.ts'))) {
    const next = require.resolve('next/package.json')
    const {bin} = JSON.parse(readFileSync(next, 'utf8')) as {bin: {next: string}}
    const typegen = await run([join(dirname(next), bin.next), 'typegen', dir], dir)
    if (typegen.code !== 0) throw stackless(`next typegen failed:\n${typegen.output}`)
  }

  const tsc = join(dirname(manifest), 'lib', 'tsc.js')
  const args = [
    '--project',
    tsconfig,
    '--noEmit',
    '--declarationMap',
    'false',
    '--emitDeclarationOnly',
    'false',
    '--runExternalCode',
  ]
  const {code, output} = await run([tsc, ...args], dir)
  // Next's spinner pauses for console output, and not for a write to stdout.
  // eslint-disable-next-line no-console -- the type check's own output, as Next prints its own
  if (output.trim()) console.log(output.trimEnd())
  if (code !== 0) throw stackless('Failed to type check (tsc --runExternalCode).')
}

/** A child Node process's exit code and output, stdout and stderr in the order they came. */
function run(args: string[], cwd: string): Promise<{code: number; output: string}> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, {
      cwd,
      // A piped tsc prints no colors unless asked, which Next does for its own check too.
      env: {...process.env, ...(process.stdout.isTTY && {FORCE_COLOR: '1'})},
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
    child.on('error', fail)
    child.on('close', (code) => done({code: code ?? 1, output}))
  })
}

/**
 * `next build` prints a failed hook's error whole: a stack would point into this package rather
 * than at the errors tsc has printed above it.
 */
function stackless(message: string): Error {
  const error = new Error(message)
  error.stack = message
  return error
}
