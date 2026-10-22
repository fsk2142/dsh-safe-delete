import { describe, expect, it } from 'vitest'

import { classifyPath, requiresApproval } from '../src/classify'

const env = { home: 'C:\\Users\\alice', workdir: 'C:\\Work\\project' }

describe('classifyPath', () => {
  it('treats ordinary workspace files as free', () => {
    expect(classifyPath('C:\\Work\\project\\build', env)).toBe('free')
    expect(classifyPath('C:\\Work\\other\\dist', env)).toBe('free')
  })

  it('protects profile manifests, patch layers, lockfiles and node_modules', () => {
    const profile = 'C:\\Users\\alice\\.dsh\\profiles\\desktop'
    expect(classifyPath(`${profile}\\package.json`, env)).toBe('protected')
    expect(classifyPath(`${profile}\\cordis.patch.yml`, env)).toBe('protected')
    expect(classifyPath(`${profile}\\pnpm-lock.yaml`, env)).toBe('protected')
    expect(classifyPath(`${profile}\\node_modules`, env)).toBe('protected')
    expect(classifyPath(`${profile}\\node_modules\\some-pkg\\index.js`, env)).toBe('protected')
  })

  it('protects the DSH home patch and settings', () => {
    expect(classifyPath('C:\\Users\\alice\\.dsh\\cordis.patch.yml', env)).toBe('protected')
    expect(classifyPath('C:\\Users\\alice\\.dsh\\settings.yaml', env)).toBe('protected')
  })

  it('marks the rest of the home directory and plugin sources as confirm', () => {
    expect(classifyPath('C:\\Users\\alice\\Documents\\old.txt', env)).toBe('confirm')
    expect(classifyPath('C:\\Users\\alice\\.dsh\\profiles\\desktop\\src', env)).toBe('confirm')
  })

  it('protects the safe zone itself', () => {
    expect(classifyPath('C:\\Users\\alice\\.dsh\\.dsh-safe-delete\\items\\abc', env)).toBe('protected')
  })

  it('normalizes traversal before classifying', () => {
    expect(classifyPath('C:\\Work\\..\\Users\\alice\\.dsh\\profiles\\desktop\\package.json', env)).toBe('protected')
  })

  it('compares paths case-insensitively on Windows paths', () => {
    expect(classifyPath('c:\\users\\alice\\.dsh\\profiles\\desktop\\package.json', env)).toBe('protected')
  })

  it('does not treat a sibling with a shared prefix as inside home', () => {
    expect(classifyPath('C:\\Users\\alice2\\file.txt', env)).toBe('free')
  })

  it('exempts the OS temp directory even though it sits inside the home directory', () => {
    // Windows 上 %TEMP% 是 C:\Users\<user>\AppData\Local\Temp —— 在家目录内部。
    // 若不豁免，删任何临时文件都会弹审批卡，日常干活被打断。
    const withTemp = { ...env, tmpdir: 'C:\\Users\\alice\\AppData\\Local\\Temp' }
    expect(classifyPath('C:\\Users\\alice\\AppData\\Local\\Temp\\scratch.txt', withTemp)).toBe('free')
    expect(classifyPath('C:\\Users\\alice\\AppData\\Local\\Temp\\build\\out', withTemp)).toBe('free')
    // 家目录里真正的用户内容仍然要确认。
    expect(classifyPath('C:\\Users\\alice\\Documents\\thesis.docx', withTemp)).toBe('confirm')
    // 临时目录本身也算 free。
    expect(classifyPath('C:\\Users\\alice\\AppData\\Local\\Temp', withTemp)).toBe('free')
  })
})

describe('requiresApproval', () => {
  it('only asks for confirm and protected', () => {
    expect(requiresApproval('free')).toBe(false)
    expect(requiresApproval('confirm')).toBe(true)
    expect(requiresApproval('protected')).toBe(true)
  })
})
