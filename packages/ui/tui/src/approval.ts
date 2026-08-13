/**
 * The terminal answerer for `approval/request`: it puts a permission question
 * to the reader through the same panel every other question uses, so one
 * keyboard surface owns every interruption.
 * @module @deepseek-ai/dsh-tui/approval
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
// Side-effect type import: it merges the approval waterfall answered here.
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { displayLine } from './display-text.ts'

/** The question id the approval panel uses; the batch has exactly one question. */
const QUESTION_ID = 'approval'

/** The label that grants the request; every other answer declines it. */
const ALLOW = 'Allow once'

/** The label that declines the request. */
const DENY = 'Deny'

/**
 * Put one approval request to the reader.
 * @param ask - the panel's ask function.
 * @param request - the pending approval question.
 * @returns the reader's decision.
 */
export async function askApproval(
  ask: (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>,
  request: { toolName: string; reason?: string; agent: Agent; signal?: AbortSignal },
): Promise<ApprovalOutcome> {
  try {
    const answer = await ask({
      questions: [{
        id: QUESTION_ID,
        question: `Allow ${displayLine(request.toolName)}?`,
        ...request.reason === undefined ? {} : { detail: displayLine(request.reason) },
        options: [{ label: ALLOW }, { label: DENY }],
      }],
      agent: request.agent,
      ...request.signal === undefined ? {} : { signal: request.signal },
    })
    const selected = answer.answers.find(item => item.id === QUESTION_ID)?.selected ?? []
    return selected.includes(ALLOW) ? 'allowed-once' : 'rejected'
  } catch {
    // A dismissed or withdrawn panel is not a grant. `cancelled` is the
    // outcome for a question that never got a decision, and every caller
    // fails closed on it.
    return 'cancelled'
  }
}

/**
 * Answer approval requests for the one agent this terminal drives, delegating
 * every other agent's question to the rest of the chain.
 * @param ctx - the plugin context registering the listener.
 * @param owned - the agent whose questions this terminal owns.
 * @param ask - the panel's ask function.
 * @returns the listener's disposer.
 */
export function installApprovalAnswerer(
  ctx: Context,
  owned: Agent,
  ask: (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>,
): () => void {
  return ctx.on('approval/request', (request, next) => {
    if (request.agent !== owned) return next()
    return askApproval(ask, request)
  })
}
