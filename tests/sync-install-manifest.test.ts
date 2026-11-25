import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = join(process.cwd(), 'scripts', 'sync-install.mjs')
let root: string
let source: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsd-sync-manifest-'))
  source = join(root, 'source')
  mkdirSync(join(source, 'lib'), { recursive: true })
  writeFileSync(join(source, 'lib', 'index.js'), 'new build\n')
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'dsh-safe-delete', version: '9.9.9', files: ['lib/'] }))
  writeFileSync(join(source, 'README.md'), 'new readme\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function runSync(target?: string, env: Record<string, string> = {}) {
  return execFileSync(process.execPath, [SCRIPT, ...(target === undefined ? [] : [target])], {
    cwd: source,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
}

describe('sync-install keeps the installed manifest current', () => {
  it('copies package.json even though npm files omits it', () => {
    const target = join(root, 'installed')
    mkdirSync(join(target, 'lib'), { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'dsh-safe-delete', version: '1.0.0', files: ['lib/'] }))
    writeFileSync(join(target, 'lib', 'index.js'), 'old build\n')

    runSync(target)

    const installed = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as { version: string }
    expect(installed.version).toBe('9.9.9')
    expect(readFileSync(join(target, 'lib', 'index.js'), 'utf8')).toBe('new build\n')
  })

  it('uses DSH_PROFILE when no explicit target is given', () => {
    const dshHome = join(root, 'home')
    const target = join(dshHome, 'profiles', 'custom', 'node_modules', 'dsh-safe-delete')
    mkdirSync(join(target, 'lib'), { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'dsh-safe-delete', version: '1.0.0', files: ['lib/'] }))

    runSync(undefined, { DSH_HOME: dshHome, DSH_PROFILE: 'custom' })

    expect(existsSync(join(target, 'lib', 'index.js'))).toBe(true)
    const installed = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as { version: string }
    expect(installed.version).toBe('9.9.9')
  })

  it('prunes stale files in published directories outside lib without false out-of-bound warnings', () => {
    const sourceBin = join(source, 'bin')
    const sourceLocale = join(source, 'locale')
    mkdirSync(sourceBin)
    mkdirSync(sourceLocale)
    writeFileSync(join(sourceBin, 'cli.mjs'), 'new cli\n')
    writeFileSync(join(sourceLocale, 'en.json'), '{}\n')
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: 'dsh-safe-delete',
      version: '9.9.9',
      files: ['lib/', 'bin/', 'locale/'],
    }))

    const target = join(root, 'installed')
    mkdirSync(join(target, 'lib'), { recursive: true })
    mkdirSync(join(target, 'bin'))
    mkdirSync(join(target, 'locale'))
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'dsh-safe-delete', version: '1.0.0', files: [] }))
    writeFileSync(join(target, 'bin', 'stale.mjs'), 'stale\n')
    writeFileSync(join(target, 'locale', 'zz-old.json'), 'stale\n')

    const output = runSync(target)

    expect(existsSync(join(target, 'bin', 'stale.mjs'))).toBe(false)
    expect(existsSync(join(target, 'locale', 'zz-old.json'))).toBe(false)
    expect(output).not.toMatch(/跳过越界路径/)
  })
})
