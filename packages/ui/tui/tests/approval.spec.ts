import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { askApproval, installApprovalAnswerer } from '../src/approval.ts'

/** A stand-in for the live agent identity the answerer routes on. */
function agentStub(id: string): Agent {
  return { id: SessionId(id) } as unknown as Agent
}

/** An ask that answers with the given labels, recording what it was asked. */
function askWith(selected: string[]): {
  ask: (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>
  requests: AskUserQuestionRequest[]
} {
  const requests: AskUserQuestionRequest[] = []
  return {
    requests,
    ask: (request) => {
      requests.push(request)
      return Promise.resolve({ answers: [{ id: 'approval', selected }] })
    },
  }
}

describe('askApproval', () => {
  it('puts a one-question decision naming the tool and the reason', async () => {
    const { ask, requests } = askWith(['Allow once'])
    const outcome = await askApproval(ask, { toolName: 'bash', reason: 'writes outside the workspace', agent: agentStub('a') })
    expect(outcome).toBe('allowed-once')
    expect(requests[0]?.questions).toEqual([{
      id: 'approval',
      question: 'Allow bash?',
      detail: 'writes outside the workspace',
      options: [{ label: 'Allow once' }, { label: 'Deny' }],
    }])
  })

  it('omits the detail when the asker gave no reason', async () => {
    const { ask, requests } = askWith(['Deny'])
    await askApproval(ask, { toolName: 'bash', agent: agentStub('a') })
    expect(requests[0]?.questions[0]).not.toHaveProperty('detail')
  })

  it('treats any answer other than the grant as a rejection', async () => {
    const { ask } = askWith(['Deny'])
    await expect(askApproval(ask, { toolName: 'bash', agent: agentStub('a') })).resolves.toBe('rejected')
  })

  it('treats an unanswered question as an undecided request, not a grant', async () => {
    const ask = (): Promise<AskUserQuestionAnswer> => Promise.reject(new Error('dismissed'))
    await expect(askApproval(ask, { toolName: 'bash', agent: agentStub('a') })).resolves.toBe('cancelled')
  })

  it('rejects an answer that names no option', async () => {
    const ask = (): Promise<AskUserQuestionAnswer> => Promise.resolve({ answers: [] })
    await expect(askApproval(ask, { toolName: 'bash', agent: agentStub('a') })).resolves.toBe('rejected')
  })

  it('carries the asking step abort signal so a withdrawn request takes the panel down', async () => {
    const { ask, requests } = askWith(['Allow once'])
    const signal = new AbortController().signal
    await askApproval(ask, { toolName: 'bash', agent: agentStub('a'), signal })
    expect(requests[0]?.signal).toBe(signal)
  })
})

describe('installApprovalAnswerer', () => {
  it('answers for the agent this terminal drives', async () => {
    const ctx = new Context()
    const owned = agentStub('owned')
    const { ask } = askWith(['Allow once'])
    installApprovalAnswerer(ctx, owned, ask)
    const outcome = await ctx.waterfall('approval/request', { agent: owned, toolName: 'bash' }, () =>
      Promise.resolve<ApprovalOutcome>('unavailable'))
    expect(outcome).toBe('allowed-once')
  })

  it('delegates a question about another agent to the rest of the chain', async () => {
    const ctx = new Context()
    const ask = vi.fn()
    installApprovalAnswerer(ctx, agentStub('owned'), ask)
    const outcome = await ctx.waterfall('approval/request', { agent: agentStub('other'), toolName: 'bash' }, () =>
      Promise.resolve<ApprovalOutcome>('unavailable'))
    expect(outcome).toBe('unavailable')
    expect(ask).not.toHaveBeenCalled()
  })
})
