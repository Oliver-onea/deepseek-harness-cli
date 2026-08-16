import { describe, expect, it } from 'vitest'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { helpText } from '../src/command-help.ts'

describe('helpText', () => {
  it('lists every command with its hint and description', () => {
    const commands: readonly CommandDescriptor[] = [
      { name: 'compact', description: 'Summarize the conversation' },
      { name: 'goal', description: 'set or view the goal', input: { hint: '[<objective>|clear]' } },
    ]
    expect(helpText(commands)).toBe(
      '/compact — Summarize the conversation\n/goal [<objective>|clear] — set or view the goal',
    )
  })

  it('normalizes registry text that carries control characters', () => {
    const commands: readonly CommandDescriptor[] = [
      { name: 'goal', description: 're\x1b[2Jpaint', input: { hint: 'a\tb' } },
    ]
    const text = helpText(commands)
    expect(text).not.toContain('\x1b')
    expect(text).not.toContain('\t')
    expect(text).toContain('/goal a       b — re\\x1b[2Jpaint')
  })

  it('answers an empty registry with an empty listing', () => {
    expect(helpText([])).toBe('')
  })
})
