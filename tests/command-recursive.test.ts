import { describe, expect, it } from 'vitest'

import { parseCommand } from '../src/command'

describe('recursive flag false positives', () => {
  it('does not treat a hyphenated path segment as a recursive flag', () => {
    expect(parseCommand('Remove-Item C:\\my-report')).toMatchObject({ recursive: false })
    expect(parseCommand('Remove-Item C:\\data\\x-raw')).toMatchObject({ recursive: false })
    expect(parseCommand('rm C:\\foo-report.txt')).toMatchObject({ recursive: false })
    expect(parseCommand('del C:\\temp\\pre-release')).toMatchObject({ recursive: false })
  })

  it('still detects real recursive flags in option position', () => {
    expect(parseCommand('Remove-Item -Recurse C:\\x')).toMatchObject({ recursive: true })
    expect(parseCommand('Remove-Item C:\\x -Recurse')).toMatchObject({ recursive: true })
    expect(parseCommand('rm -r C:\\x')).toMatchObject({ recursive: true })
    expect(parseCommand('rm -rf C:\\x')).toMatchObject({ recursive: true })
    expect(parseCommand('rd /s C:\\x')).toMatchObject({ recursive: true })
  })
})
