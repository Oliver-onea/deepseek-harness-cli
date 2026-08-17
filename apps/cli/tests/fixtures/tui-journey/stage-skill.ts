/**
 * Test fixture: stage one deterministic user-invocable skill under the
 * terminal's agent so the `/` menu journey snapshot can exercise a real skill
 * catalog without a model turn.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TUI_STARTUP_SERVICE, type TuiStartupValues } from '@deepseek-ai/dsh-tui-app/startup'

export const name = 'tui-journey-stage-skill'
export const inject = ['agents', 'skills', 'tuiStartup']

const SKILL_NAME = 'journey-skill'
const AGENT_WAIT_TIMEOUT_MS = 10_000

export async function apply(ctx: Context): Promise<void> {
  const startup = ctx.get(TUI_STARTUP_SERVICE) as TuiStartupValues | undefined
  if (startup === undefined) {
    throw new Error('tui-journey-stage-skill: tuiStartup service is not available')
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
      reject(new Error('tui-journey-stage-skill: terminal agent did not appear'))
    }, AGENT_WAIT_TIMEOUT_MS)
    ctx.effect(() => () => {
      stop()
      clearTimeout(timer)
    })
  })

  ctx.skills.register({
    name: SKILL_NAME,
    description: 'A staged skill for journey snapshots',
    content: 'This skill exists only to prove the `/` menu lists live skills.',
    source: 'runtime',
    invocation: { modelInvocable: true, userInvocable: true },
  })

  // Wait for the skill to be observable through the same catalog path the menu
  // uses, so the snapshot never races the registration.
  const listed = await ctx.skills.list({ scope: agent })
  if (!listed.some(skill => skill.name === SKILL_NAME)) {
    throw new Error('tui-journey-stage-skill: registered skill is not visible in the agent scope')
  }
}
