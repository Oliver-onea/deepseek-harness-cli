import { describe, expect, it, vi } from 'vitest'
import type { Component } from '@earendil-works/pi-tui'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { QuestionPanel, TerminalQuestions, type PanelHost } from '../src/questions.ts'
import { createPalette } from '../src/theme.ts'

const palette = createPalette(false)

const ESCAPE = '\x1b'
const ENTER = '\r'
const TAB = '\t'
const DOWN = '\x1b[B'
const UP = '\x1b[A'
const SPACE = ' '
const BACKSPACE = '\x7f'

function choice(over: Partial<AskUserQuestionItem> = {}): AskUserQuestionItem {
  return {
    id: 'q1',
    question: 'Which one?',
    options: [{ label: 'First' }, { label: 'Second', description: 'the other one' }],
    ...over,
  }
}

/** A question the reader answers by typing: it carries no options at all. */
function openQuestion(over: Partial<AskUserQuestionItem> = {}): AskUserQuestionItem {
  return { id: 'q1', question: 'What next?', ...over }
}

function panelFor(items: readonly AskUserQuestionItem[]): {
  panel: QuestionPanel
  settled: () => AskUserQuestionAnswer | undefined | 'pending'
} {
  let outcome: AskUserQuestionAnswer | undefined | 'pending' = 'pending'
  const panel = new QuestionPanel(items, palette, (answer) => { outcome = answer }, () => {})
  return { panel, settled: () => outcome }
}

/** A host that records what was presented and how often a redraw was asked for. */
function recordingHost(): PanelHost & { presented: Component[]; renders: number; closed: number } {
  const host = {
    presented: [] as Component[],
    renders: 0,
    closed: 0,
    present(panel: Component): () => void {
      host.presented.push(panel)
      return () => { host.closed += 1 }
    },
    requestRender(): void { host.renders += 1 },
  }
  return host
}

describe('QuestionPanel', () => {
  it('draws the question, its options, and the controls that apply', () => {
    const { panel } = panelFor([choice({ header: 'Scope', detail: 'pick one' })])
    const lines = panel.render(80)
    expect(lines[0]).toBe('Scope')
    expect(lines[1]).toBe('Which one?')
    expect(lines[2]).toBe('pick one')
    expect(lines[3]).toBe(' 1. ○ First')
    expect(lines[4]).toBe(' 2. ○ Second — the other one')
    expect(lines[5]).toBe('↑↓ move  tab type an answer  enter answer  esc cancel')
  })

  it('counts the batch when there is more than one question', () => {
    const { panel } = panelFor([choice(), choice({ id: 'q2' })])
    expect(panel.render(80)[0]).toBe('Question 1 of 2')
  })

  it('omits navigation for a single option and offers toggling only when multi-select', () => {
    const { panel } = panelFor([choice({ options: [{ label: 'Only' }] })])
    expect(panel.render(80).at(-1)).toBe('tab type an answer  enter answer  esc cancel')
    const { panel: multi } = panelFor([choice({ multiSelect: true })])
    expect(multi.render(80).at(-1)).toContain('space toggle')
  })

  it('answers with the highlighted option when the reader just presses enter', () => {
    const { panel, settled } = panelFor([choice()])
    panel.handleInput(ENTER)
    expect(settled()).toEqual({ answers: [{ id: 'q1', selected: ['First'] }] })
  })

  it('moves the cursor and wraps at both ends', () => {
    const { panel, settled } = panelFor([choice()])
    panel.handleInput(DOWN)
    panel.handleInput(DOWN)
    panel.handleInput(UP)
    panel.handleInput(ENTER)
    expect(settled()).toEqual({ answers: [{ id: 'q1', selected: ['Second'] }] })
  })

  it('selects an option by its number', () => {
    const { panel, settled } = panelFor([choice()])
    panel.handleInput('2')
    panel.handleInput(ENTER)
    expect(settled()).toEqual({ answers: [{ id: 'q1', selected: ['Second'] }] })
  })

  it('ignores a number with no option behind it', () => {
    const { panel } = panelFor([choice()])
    panel.handleInput('7')
    expect(panel.render(80)[1]).toBe(' 1. ○ First')
  })

  it('keeps one choice for a single-select question', () => {
    const { panel, settled } = panelFor([choice()])
    panel.handleInput('1')
    panel.handleInput('2')
    panel.handleInput(ENTER)
    expect(settled()).toEqual({ answers: [{ id: 'q1', selected: ['Second'] }] })
  })

  it('accumulates and unsets choices for a multi-select question', () => {
    const { panel, settled } = panelFor([choice({ multiSelect: true })])
    panel.handleInput(SPACE)
    panel.handleInput(DOWN)
    panel.handleInput(SPACE)
    panel.handleInput(SPACE)
    panel.handleInput(SPACE)
    panel.handleInput(ENTER)
    expect(settled()).toEqual({ answers: [{ id: 'q1', selected: ['First', 'Second'] }] })
  })

  it('opens in text mode for a question with no options', () => {
    const { panel, settled } = panelFor([openQuestion()])
    expect(panel.render(80).at(-2)).toContain('>')
    panel.handleInput('h')
    panel.handleInput('i')
    panel.handleInput('x')
    panel.handleInput(BACKSPACE)
    panel.handleInput(ENTER)
    expect(settled()).toEqual({ answers: [{ id: 'q1', selected: [], custom: 'hi' }] })
  })

  it('refuses control input in the answer field', () => {
    const { panel, settled } = panelFor([openQuestion()])
    panel.handleInput('a')
    panel.handleInput('\x01')
    panel.handleInput('\x7f\x7f')
    panel.handleInput('b')
    panel.handleInput(ENTER)
    expect(settled()).toEqual({ answers: [{ id: 'q1', selected: [], custom: 'ab' }] })
  })

  it('lets the reader switch to typing an answer instead of choosing one', () => {
    const { panel, settled } = panelFor([choice()])
    panel.handleInput(TAB)
    panel.handleInput('n')
    panel.handleInput('o')
    panel.handleInput('p')
    panel.handleInput('e')
    panel.handleInput(ENTER)
    expect(settled()).toEqual({ answers: [{ id: 'q1', selected: [], custom: 'nope' }] })
  })

  it('supplements the labels with typed text for a multi-select question', () => {
    const { panel, settled } = panelFor([choice({ multiSelect: true })])
    panel.handleInput(SPACE)
    panel.handleInput(TAB)
    panel.handleInput('x')
    panel.handleInput(ENTER)
    expect(settled()).toEqual({ answers: [{ id: 'q1', selected: ['First'], custom: 'x' }] })
  })

  it('has nothing to switch to when the question carries no options at all', () => {
    const { panel } = panelFor([openQuestion()])
    panel.handleInput(TAB)
    expect(panel.render(80).at(-2)).toContain('>')
    panel.handleInput(DOWN)
    expect(panel.render(80).at(-2)).toContain('>')
  })

  it('has nothing to switch to when the question has an empty option list', () => {
    const { panel } = panelFor([choice({ options: [] })])
    panel.handleInput(TAB)
    expect(panel.render(80).at(-2)).toContain('>')
  })

  it('numbers only the options a number key can reach', () => {
    const many = Array.from({ length: 11 }, (_unused, at) => ({ label: `Option ${at}` }))
    const { panel } = panelFor([choice({ options: many })])
    const lines = panel.render(80)
    expect(lines[9]).toContain(' 9. ')
    expect(lines[10]).toBe('    ○ Option 9')
  })

  it('offers option navigation again once the reader leaves the answer field', () => {
    const { panel } = panelFor([choice()])
    panel.handleInput(TAB)
    expect(panel.render(80).at(-1)).toContain('tab options')
    panel.handleInput(TAB)
    expect(panel.render(80).at(-1)).toContain('tab type an answer')
  })

  it('walks a batch in order and settles once', () => {
    const { panel, settled } = panelFor([choice(), choice({ id: 'q2', options: [{ label: 'Yes' }] })])
    panel.handleInput(ENTER)
    expect(settled()).toBe('pending')
    panel.handleInput(ENTER)
    expect(settled()).toEqual({
      answers: [{ id: 'q1', selected: ['First'] }, { id: 'q2', selected: ['Yes'] }],
    })
    panel.handleInput(ENTER)
    expect(settled()).toEqual({
      answers: [{ id: 'q1', selected: ['First'] }, { id: 'q2', selected: ['Yes'] }],
    })
  })

  it('aborts the whole batch on escape', () => {
    const { panel, settled } = panelFor([choice()])
    panel.handleInput(ESCAPE)
    expect(settled()).toBeUndefined()
  })

  it('marks the highlighted row and every chosen label', () => {
    const styled = new QuestionPanel([choice({ multiSelect: true })], createPalette(true), () => {}, () => {})
    styled.handleInput(SPACE)
    const lines = styled.render(80)
    expect(lines[1]).toContain('\x1b[7m')
    expect(lines[1]).toContain('●')
    expect(lines[2]).toContain('○')
  })

  it('redraws on every input that changes what is shown', () => {
    const onChange = vi.fn()
    const panel = new QuestionPanel([choice()], palette, () => {}, onChange)
    panel.handleInput(DOWN)
    panel.handleInput(SPACE)
    panel.handleInput(TAB)
    expect(onChange).toHaveBeenCalledTimes(3)
  })

  it('caches nothing between draws', () => {
    const { panel } = panelFor([choice()])
    expect(() => { panel.invalidate() }).not.toThrow()
  })
})

describe('TerminalQuestions', () => {
  it('presents a panel and resolves with the reader answer', async () => {
    const host = recordingHost()
    const questions = new TerminalQuestions(host, palette)
    const pending = questions.ask({ questions: [choice()] })
    const panel = host.presented[0] as QuestionPanel
    panel.handleInput(ENTER)
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['First'] }] })
    expect(host.closed).toBe(1)
  })

  it('rejects when the reader dismisses the panel', async () => {
    const host = recordingHost()
    const questions = new TerminalQuestions(host, palette)
    const pending = questions.ask({ questions: [choice()] })
    ;(host.presented[0] as QuestionPanel).handleInput(ESCAPE)
    await expect(pending).rejects.toThrow('the user dismissed the question')
  })

  it('takes the panel down when the asking step withdraws the question', async () => {
    const host = recordingHost()
    const questions = new TerminalQuestions(host, palette)
    const controller = new AbortController()
    const pending = questions.ask({ questions: [choice()], signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow('the user dismissed the question')
    expect(host.closed).toBe(1)
  })

  it('redraws when the panel changes', () => {
    const host = recordingHost()
    const questions = new TerminalQuestions(host, palette)
    void questions.ask({ questions: [choice()] }).catch(() => {})
    ;(host.presented[0] as QuestionPanel).handleInput(DOWN)
    expect(host.renders).toBeGreaterThan(0)
  })
})
