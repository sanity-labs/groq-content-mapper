// The command in package.json `typescript.contentMapper.exec`. TypeScript 7.1 starts it with
// stdio pipes, speaks the content mapper protocol over them, and closes stdin to stop it.
import {ContentMapper} from '../contentMapper.js'

try {
  await new ContentMapper().serve({input: process.stdin, output: process.stdout})
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exitCode = 1
}
