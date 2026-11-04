import { describe, expect, it } from 'vitest'
import { parseCommand } from '../src/command'

describe('silent allow regressions 2026-11-04', () => {
  it.each([
    'result="$(python -m venv --clear /tmp/env)"',
    'result=`python -m venv --clear /tmp/env`',
    'const worker = new Worker("cleanup.js")',
    'npm exec -- rimraf /tmp/x',
    'pnpm dlx rimraf /tmp/x',
    'env python cleanup.py',
  ])('requires review for executable content: %s', text => {
    expect(parseCommand(text).destructive).toBe(true)
  })
  it.each([
    'result="$(date)"', 'result=`date`',
    'const values = [1, 2]', 'const values = new Map([])',
    'npm list', 'echo hello',
  ])('keeps data and queries allowed: %s', text => {
    expect(parseCommand(text).destructive).toBe(false)
  })
})
