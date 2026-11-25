import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('published package contents', { timeout: 30_000 }, () => {
  it('ships user docs and locale resources without design archives', () => {
    const args = ['pack', '--dry-run', '--json', '--ignore-scripts']
    const raw = process.platform === 'win32'
      ? execFileSync('cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], { encoding: 'utf8' })
      : execFileSync('npm', args, { encoding: 'utf8' })
    const packed = JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>
    const paths = packed[0]?.files.map((file) => file.path) ?? []

    expect(paths).toContain('locale/en.json')
    expect(paths).toContain('locale/zh.json')
    expect(paths).toContain('docs/DETAIL.md')
    expect(paths).toContain('docs/REFERENCE.md')
    expect(paths).toContain('docs/BOUNDARIES.md')
    expect(paths.some((path) => path.startsWith('docs/superpowers/'))).toBe(false)
  })
})
