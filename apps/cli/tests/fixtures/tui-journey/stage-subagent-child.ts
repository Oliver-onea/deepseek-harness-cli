/**
 * Test fixture: stage one deterministic running subagent child under the
 * terminal's session so the `@` menu journey snapshot can exercise a real
 * child roster without a model turn.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { TUI_STARTUP_SERVICE, type TuiStartupValues } from '@deepseek-ai/dsh-tui-app/startup'

export const name = 'tui-journey-stage-child'
export const inject = ['agents', 'sessions', 'tuiStartup']

const CHILD_ID = 'journey-child'
const AGENT_WAIT_TIMEOUT_MS = 10_000

export async function apply(ctx: Context): Promise<void> {
  const startup = ctx.get(TUI_STARTUP_SERVICE) as TuiStartupValues | undefined
  if (startup === undefined) {
    throw new Error('tui-journey-stage-child: tuiStartup service is not available')
  }
  const parentSessionId = SessionId(startup.session)
  const agent = await new Promise<Agent>((resolve, reject) => {
    const existing = ctx.agents.get(parentSessionId)
    if (existing !== undefined) {
      resolve(existing)
      return
    }
    const stop = ctx.on('agent/created', ({ agent: created }: { agent: Agent }) => {
      if (created.session.id !== parentSessionId) return
      stop()
      clearTimeout(timer)
      resolve(created)
    })
    const timer = setTimeout(() => {
      stop()
      reject(new Error('tui-journey-stage-child: terminal agent did not appear'))
    }, AGENT_WAIT_TIMEOUT_MS)
    ctx.effect(() => () => {
      stop()
      clearTimeout(timer)
    })
  })

  const child = ctx.sessions.create(SessionId(CHILD_ID), {
    meta: {
      cwd: agent.session.header.cwd ?? process.cwd(),
      parentSession: parentSessionId,
      origin: 'subagent',
      delegationDepth: 1,
    },
  })
  child.append('subagent/descriptor', snapshotSubagentDescriptor({
    mode: 'continuable',
    provider: 'spawn',
    label: 'journey-child',
  }))
}
