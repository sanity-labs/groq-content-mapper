import {describe, expect, test} from 'vitest'

import {compileInclude} from '../include.js'

const POSIX_ROOT = '/repo'
const WINDOWS_ROOT = 'C:\\Repo'

function depthOf(
  include: string,
  file: string,
  {platform = 'linux', root = POSIX_ROOT}: {platform?: NodeJS.Platform; root?: string} = {},
): number | undefined {
  return compileInclude(include, root, platform)?.depthOf(file)
}

describe('compileInclude', () => {
  test('a folder includes every file under it, as deep as the folder', () => {
    expect(depthOf('src/shop', '/repo/src/shop/a.groq')).toBe('/repo/src/shop'.length)
    expect(depthOf('./src/shop/', '/repo/src/shop/deep/a.groq')).toBe('/repo/src/shop'.length)
    expect(depthOf('src/shop', '/repo/src/shopping/a.groq')).toBe(-1)
    expect(depthOf('src/shop', '/repo/src/a.groq')).toBe(-1)
    expect(depthOf('src/shop', '/repo/src/Shop/a.groq')).toBe(-1)
  })

  test('a glob includes the files it matches, as deep as its folder before the wildcard', () => {
    const depth = '/repo/src'.length
    expect(depthOf('src/**/*.groq', '/repo/src/a.groq')).toBe(depth)
    expect(depthOf('src/**/*.groq', '/repo/src/shop/deep/a.groq')).toBe(depth)
    expect(depthOf('src/**/*.groq', '/repo/lib/a.groq')).toBe(-1)
    expect(depthOf('src/*.groq', '/repo/src/shop/a.groq')).toBe(-1)
    expect(depthOf('src/{blog,shop}/*.groq', '/repo/src/shop/a.groq')).toBe(depth)
    expect(depthOf('src/{blog,shop}/*.groq', '/repo/src/news/a.groq')).toBe(-1)
    expect(depthOf('**/*.groq', '/repo/a.groq')).toBe(POSIX_ROOT.length)
    expect(depthOf('**/posts.groq', '/repo/src/posts.groq')).toBe(POSIX_ROOT.length)
    expect(depthOf('**/posts.groq', '/repo/src/products.groq')).toBe(-1)
  })

  test('a glob that matches a folder includes everything under it', () => {
    const depth = '/repo/src'.length
    expect(depthOf('src/*/queries', '/repo/src/blog/queries/a.groq')).toBe(depth)
    expect(depthOf('src/*/queries', '/repo/src/blog/queries/deep/a.groq')).toBe(depth)
    expect(depthOf('src/*/queries', '/repo/src/blog/other/a.groq')).toBe(-1)
    expect(depthOf('src/**', '/repo/src/blog/a.groq')).toBe(depth)
  })

  test('a folder whose name looks like a glob is still a folder', () => {
    expect(depthOf('app/[locale]', '/repo/app/[locale]/a.groq')).toBe('/repo/app/[locale]'.length)
    expect(depthOf('app/(shop)', '/repo/app/(shop)/a.groq')).toBe('/repo/app/(shop)'.length)
    expect(depthOf('app/[locale]', '/repo/app/l/a.groq')).toBe('/repo/app'.length)
    expect(depthOf('!legacy', '/repo/!legacy/a.groq')).toBe('/repo/!legacy'.length)
    expect(depthOf('!legacy', '/repo/src/a.groq')).toBe(-1)
  })

  test('resolves absolute entries without a root, and nothing relative', () => {
    expect(compileInclude('src', undefined, 'linux')).toBeUndefined()
    expect(compileInclude('src/**/*.groq', undefined, 'linux')).toBeUndefined()
    const glob = compileInclude('/repo/src/**/*.groq', undefined, 'linux')
    expect(glob?.depthOf('/repo/src/a/b.groq')).toBe('/repo/src'.length)
    expect(compileInclude('/**/*.groq', undefined, 'linux')?.depthOf('/a/b.groq')).toBe(1)
  })

  test('folds case where the file system does', () => {
    const darwin = {platform: 'darwin' as const}
    expect(depthOf('src/Shop', '/repo/SRC/shop/a.groq', darwin)).toBe('/repo/src/shop'.length)
    expect(depthOf('src/**/*.GROQ', '/repo/SRC/Shop/a.groq', darwin)).toBe('/repo/src'.length)
    expect(depthOf('src/**/*.GROQ', '/repo/src/a.groq')).toBe(-1)
  })

  describe('on Windows', () => {
    const windows = {platform: 'win32' as const, root: WINDOWS_ROOT}

    test('a folder includes files under it, with either separator and any case', () => {
      const depth = 'c:\\repo\\src\\shop'.length
      expect(depthOf('src/shop', 'C:\\Repo\\src\\shop\\a.groq', windows)).toBe(depth)
      expect(depthOf('src\\shop', 'C:/Repo/src/shop/a.groq', windows)).toBe(depth)
      expect(depthOf('SRC/Shop', 'c:\\repo\\src\\shop\\deep\\a.groq', windows)).toBe(depth)
      expect(depthOf('src/shop', 'C:\\Repo\\src\\shopping\\a.groq', windows)).toBe(-1)
      expect(depthOf('src/shop', 'D:\\Repo\\src\\shop\\a.groq', windows)).toBe(-1)
    })

    test('a glob matches with either separator and any case', () => {
      const depth = 'c:\\repo\\src'.length
      expect(depthOf('src/**/*.groq', 'C:\\Repo\\src\\shop\\a.groq', windows)).toBe(depth)
      expect(depthOf('src/**/*.groq', 'C:/Repo/src/shop/a.groq', windows)).toBe(depth)
      expect(depthOf('src\\**\\*.groq', 'C:\\Repo\\src\\shop\\a.groq', windows)).toBe(depth)
      expect(depthOf('SRC/**/*.GROQ', 'C:\\Repo\\src\\Shop\\A.groq', windows)).toBe(depth)
      expect(depthOf('src/*/queries', 'C:\\Repo\\src\\blog\\queries\\a.groq', windows)).toBe(depth)
      expect(depthOf('src/**/*.groq', 'C:\\Repo\\lib\\a.groq', windows)).toBe(-1)
      expect(depthOf('src/**/*.groq', 'D:\\Repo\\src\\a.groq', windows)).toBe(-1)
    })

    test('resolves absolute entries with a drive letter', () => {
      const glob = compileInclude('C:/Repo/src/**/*.groq', undefined, 'win32')
      expect(glob?.depthOf('C:\\Repo\\src\\a\\b.groq')).toBe('c:\\repo\\src'.length)
      expect(glob?.depthOf('D:\\Repo\\src\\a\\b.groq')).toBe(-1)
      const root = compileInclude('C:\\**\\*.groq', undefined, 'win32')
      expect(root?.depthOf('C:\\a\\b.groq')).toBe('c:\\'.length)
      expect(compileInclude('src/**/*.groq', undefined, 'win32')).toBeUndefined()
    })
  })
})
