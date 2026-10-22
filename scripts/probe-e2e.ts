/**
 * 手工端到端抽查：真实删除 → 真实取回，并检查安全区里的布局是否可读。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listSafeZone, moveToSafeZone, restoreFromSafeZone } from '../src/store'

const root = mkdtempSync(join(tmpdir(), 'dsd-e2e-'))
const state = join(root, 'state')
const work = join(root, 'work')
mkdirSync(join(work, 'project'), { recursive: true })
writeFileSync(join(work, 'project', 'src.ts'), 'PRECIOUS')
writeFileSync(join(work, 'notes.txt'), 'NOTES')

const dirEntry = await moveToSafeZone(state, join(work, 'project'), { retentionDays: 7, reason: 'e2e' })
console.log(`dir  moved: id=${dirEntry.id}`)
console.log(`     layout: items/${dirEntry.id}/ -> ${readdirSync(join(state, 'items', dirEntry.id)).join(', ')}`)
console.log(`     source gone: ${!existsSync(join(work, 'project'))}`)

const fileEntry = await moveToSafeZone(state, join(work, 'notes.txt'), { retentionDays: 7 })
console.log(`file moved: id=${fileEntry.id}`)
console.log(`     layout: items/${fileEntry.id}/ -> ${readdirSync(join(state, 'items', fileEntry.id)).join(', ')}`)

console.log(`list count: ${(await listSafeZone(state)).length}`)

const r1 = await restoreFromSafeZone(state, dirEntry.id)
const r2 = await restoreFromSafeZone(state, fileEntry.id)
console.log(`restored dir  -> ${r1.restoredTo}  content=${readFileSync(join(r1.restoredTo, 'src.ts'), 'utf8')}`)
console.log(`restored file -> ${r2.restoredTo}  content=${readFileSync(r2.restoredTo, 'utf8')}`)
console.log(`list after: ${(await listSafeZone(state)).length}`)
console.log(`items dir leftovers: ${existsSync(join(state, 'items')) ? readdirSync(join(state, 'items')).length : 0}`)
