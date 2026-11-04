import { expect, it } from 'vitest'
import { parseRecycleManyOutput } from '../src/recycle'
it('does not parse a failed filename as the success summary',()=>{
 const out='ERR: C:\\work\\OK=999 FAIL=0.txt : access denied\nOK=0 FAIL=1\n'
 expect(parseRecycleManyOutput(out)).toMatchObject({ok:0,fail:1})
})
it('does not treat a summary embedded in an error as proof of completion',()=>{
 expect(parseRecycleManyOutput('ERR: C:\\work\\OK=999 FAIL=0.txt : denied')).toMatchObject({ok:0,fail:1})
})
