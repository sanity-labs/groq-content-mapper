// The preload that lets `import query from './posts.groq' with {type: 'text'}` run on Node:
//
//   node --import @sanity-labs/groq-content-mapper/register main.ts
//
// Node 26.5 and later can do it alone with `--experimental-import-text`; Bun and Deno need no
// preload at all. Types come from the content mapper, not from here.
import * as nodeModule from 'node:module'

import {load} from './nodeHooks.js'

// `registerHooks` runs in-thread, and reaches `require()` too; Node before 22.15 has only the
// hooks that run on their own thread.
// oxlint-disable-next-line typescript/no-deprecated -- `register` is only the fallback for Node before 22.15
const {register, registerHooks} = nodeModule as Partial<typeof nodeModule>
if (registerHooks) {
  registerHooks({load})
} else {
  register!('./nodeHooks.js', import.meta.url)
}
