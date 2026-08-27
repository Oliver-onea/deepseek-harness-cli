import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionStore from '@deepseek-ai/dsh-session'
import * as invariant from '../src/invariant.ts'

describe('dsh-tui invariant companion', () => {
  it('registers this package without constraining the session log', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const scope = ctx.plugin(invariant)
    await expect(scope.then(() => undefined)).resolves.toBeUndefined()
    // The terminal derives its transcript from the log and owns no mutable
    // relation of its own, so no appended event can violate anything here.
    ctx.sessions.create().append('turn/start', { turn: 0 })
    await scope.dispose()
  })
})
