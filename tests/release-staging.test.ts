import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let root: string
let originalCwd: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsd-release-stage-'))
  originalCwd = process.cwd()
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root })
  mkdirSync(join(root, 'lib'))
  writeFileSync(join(root, 'package.json'), '{"version":"1.0.0"}\n')
  writeFileSync(join(root, 'lib', 'index.js'), 'old\n')
  execFileSync('git', ['add', 'package.json', 'lib'], { cwd: root })
  execFileSync('git', ['commit', '--quiet', '-m', 'base'], { cwd: root })
})

afterEach(() => {
  process.chdir(originalCwd)
  rmSync(root, { recursive: true, force: true })
})

describe('release staging is explicit', () => {
  it('stages only package.json and lib, never unrelated probes', async () => {
    writeFileSync(join(root, 'package.json'), '{"version":"1.0.1"}\n')
    writeFileSync(join(root, 'lib', 'index.js'), 'new\n')
    writeFileSync(join(root, '.probe.mts'), 'do not publish\n')
    writeFileSync(join(root, '.state'), 'do not publish\n')

    const { stageReleaseFiles } = await import('../scripts/release-stage.mjs')
    process.chdir(root)
    stageReleaseFiles()

    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .sort()
    expect(staged).toEqual(['lib/index.js', 'package.json'])
    expect(readFileSync(join(root, '.probe.mts'), 'utf8')).toContain('do not publish')
  })
})
