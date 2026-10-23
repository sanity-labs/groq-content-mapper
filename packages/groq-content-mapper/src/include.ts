import {posix, win32} from 'node:path'

import picomatch from 'picomatch'

/** One `include` entry of a `schemas` entry, resolved against the tsconfig's directory. */
export interface Include {
  /**
   * How specifically `file`, absolute, is included: the length of the normalized folder that
   * claims it, or -1 when the entry does not include it. The longest folder wins.
   */
  depthOf: (file: string) => number
}

/**
 * Compiles an `include` entry. A plain folder includes every file under it. A glob, such as
 * `src/**\/*.groq` or `src/*\/queries`, includes a file when it matches the file or one of its
 * folders, and is as deep as its folder before the first wildcard. A folder whose name only
 * looks like a glob, such as Next.js's `app/[locale]`, is still included as a folder.
 *
 * Globs use `/` as the separator; on Windows `\` is one too. Returns `undefined` when there
 * is no `root` to resolve a relative entry against.
 */
export function compileInclude(
  include: string,
  root: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Include | undefined {
  const path = platform === 'win32' ? win32 : posix
  const locate = (entry: string): string | undefined => {
    if (root !== undefined) return normalizePath(path.resolve(root, entry), platform)
    return path.isAbsolute(entry) ? normalizePath(entry, platform) : undefined
  }
  const folder = locate(include)
  if (folder === undefined) return undefined
  const depthUnder = (base: string, file: string) =>
    file.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`) ? base.length : -1

  const scanned = picomatch.scan(platform === 'win32' ? include.replaceAll('\\', '/') : include)
  // A bare drive, as `C:` from `C:/**`, would resolve to that drive's working directory.
  const base = /^[a-z]:$/i.test(scanned.base) ? `${scanned.base}/` : scanned.base || '.'
  const globBase = scanned.isGlob && !scanned.negated ? locate(base) : undefined
  if (globBase === undefined) {
    return {depthOf: (file) => depthUnder(folder, normalizePath(file, platform))}
  }
  const matches = picomatch(scanned.glob, {nocase: foldsCase(platform)})
  return {
    depthOf(file) {
      const normalized = normalizePath(file, platform)
      const asFolder = depthUnder(folder, normalized)
      if (asFolder !== -1) return asFolder
      if (depthUnder(globBase, normalized) === -1) return -1
      const segments = path.relative(globBase, normalized).split(path.sep)
      for (let count = 1; count <= segments.length; count++) {
        if (matches(segments.slice(0, count).join('/'))) return globBase.length
      }
      return -1
    },
  }
}

/** Resolved, without a trailing separator, and case-folded where the file system is. */
function normalizePath(file: string, platform: NodeJS.Platform): string {
  const resolved = (platform === 'win32' ? win32 : posix).resolve(file)
  return foldsCase(platform) ? resolved.toLowerCase() : resolved
}

function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}
