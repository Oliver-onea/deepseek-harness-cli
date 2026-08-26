import { describe, expect, it } from 'vitest'
import { CallId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { Transcript } from '../src/transcript.ts'
import type { AssistantEntry, NoticeEntry, ToolEntry, UserEntry } from '../src/transcript.ts'

/**
 * Folds REAL logged events: every event under test is appended to a genuine
 * `Session`, so the transcript sees the same frozen snapshots a live terminal
 * would, including the surface metadata the log requires.
 */
function log(): { session: Session; transcript: Transcript; feed: (event: SessionEvent) => boolean } {
  const session = Session.create(SessionId('session-transcript'))
  const transcript = new Transcript()
  return {
    session,
    transcript,
    feed: (event: SessionEvent) => transcript.append(event),
  }
}

function userPrompt(session: Session, text: string): SessionEvent {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function assistantText(session: Session, text: string, step = 0): SessionEvent {
  return session.append('assistant/message', {
    turn: 0,
    step,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'p', model: 'm' },
    }),
  }, { surfaceOp: 'append' })
}

describe('Transcript', () => {
  it('folds a human prompt into a user entry', () => {
    const { session, transcript, feed } = log()
    expect(feed(userPrompt(session, 'hello'))).toBe(true)
    expect(transcript.entries).toEqual([{ kind: 'user', text: 'hello' }])
  })

  it('ignores a human prompt with no text blocks', () => {
    const { session, transcript, feed } = log()
    const event = session.append('user/message', createUserMessage({
      content: [],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(feed(event)).toBe(false)
    expect(transcript.entries).toEqual([])
  })

  it('draws an injected notice but not other injected context', () => {
    const { session, transcript, feed } = log()
    feed(session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'the whole file' }],
      source: { kind: 'plugin', plugin: 'skill', form: 'notice', summary: 'loaded skill x' },
    }), { surfaceOp: 'append' }))
    feed(session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'catalog' }],
      source: { kind: 'plugin', plugin: 'skill', form: 'catalog' },
    }), { surfaceOp: 'append' }))
    expect(transcript.entries).toEqual([{ kind: 'notice', tone: 'info', text: 'loaded skill x' }])
  })

  it('accumulates text deltas and settles them against the committed message', () => {
    const { session, transcript, feed } = log()
    feed(session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'Hel' } }))
    feed(session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'lo' } }))
    expect(transcript.entries).toEqual([{ kind: 'assistant', text: 'Hello', streaming: true }])
    feed(assistantText(session, 'Hello'))
    expect(transcript.entries).toEqual([{ kind: 'assistant', text: 'Hello', streaming: false }])
  })

  it('keeps reasoning in its own entry', () => {
    const { session, transcript, feed } = log()
    feed(session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'think' } }))
    feed(session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 1, text: 'answer' } }))
    expect(transcript.entries.map(entry => entry.kind)).toEqual(['reasoning', 'assistant'])
  })

  it('extends reasoning across several deltas', () => {
    const { session, transcript, feed } = log()
    feed(session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'one ' } }))
    feed(session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'two' } }))
    expect(transcript.entries).toEqual([{ kind: 'reasoning', text: 'one two', streaming: true }])
  })

  it('creates the committed entry for a step whose chunks were never logged', () => {
    const { session, transcript, feed } = log()
    expect(feed(assistantText(session, 'replayed'))).toBe(true)
    expect(transcript.entries).toEqual([{ kind: 'assistant', text: 'replayed', streaming: false }])
  })

  it('reports no change when a committed message carries nothing to draw', () => {
    const { session, transcript, feed } = log()
    expect(feed(assistantText(session, ''))).toBe(false)
    expect(transcript.entries).toEqual([])
  })

  it('ignores stream chunks that carry no drawable text', () => {
    const { session, transcript, feed } = log()
    expect(feed(session.append('assistant/chunk', {
      turn: 0, step: 0, chunk: { type: 'finish', reason: { kind: 'stop' } },
    }))).toBe(false)
    expect(transcript.entries).toEqual([])
  })

  it('pairs a tool result with its call and closes the streamed answer above it', () => {
    const { session, transcript, feed } = log()
    feed(session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'calling' } }))
    feed(session.append('tool/call', {
      turn: 0, step: 0, callId: CallId('c1'), name: 'bash', arguments: '{"command":"ls"}',
    }))
    feed(session.append('tool/result', {
      turn: 0,
      step: 0,
      message: {
        id: 'm1', role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'a.txt' }] }],
        source: { kind: 'tool', callId: CallId('c1'), name: 'bash' },
      },
    } as unknown as SessionEvent<'tool/result'>['data'], { surfaceOp: 'append' }))
    const [answer, tool] = transcript.entries as [AssistantEntry, ToolEntry]
    expect(answer).toEqual({ kind: 'assistant', text: 'calling', streaming: true })
    expect(tool.name).toBe('bash')
    expect(tool.outcome?.isError).toBe(false)
    // Later text belongs to the next step, so it must not extend the answer
    // that sits above this card.
    feed(session.append('assistant/chunk', { turn: 0, step: 1, chunk: { type: 'text-delta', index: 0, text: 'done' } }))
    expect(transcript.entries).toHaveLength(3)
  })

  it('drops a result whose call fell outside this transcript', () => {
    const { session, transcript, feed } = log()
    expect(feed(session.append('tool/result', {
      turn: 0,
      step: 0,
      message: {
        id: 'm1', role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('unknown'), content: [], isError: true }],
        source: { kind: 'tool', callId: CallId('unknown'), name: 'bash' },
      },
    } as unknown as SessionEvent<'tool/result'>['data'], { surfaceOp: 'append' }))).toBe(false)
    expect(transcript.entries).toEqual([])
  })

  it('keeps a tool result meta payload for the presenter to replay', () => {
    const { session, transcript, feed } = log()
    feed(session.append('tool/call', { turn: 0, step: 0, callId: CallId('c2'), name: 'read', arguments: '{}' }))
    feed(session.append('tool/result', {
      turn: 0,
      step: 0,
      message: {
        id: 'm2', role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('c2'), content: [], isError: true }],
        source: { kind: 'tool', callId: CallId('c2'), name: 'read' },
      },
      meta: { lines: 3 },
    } as unknown as SessionEvent<'tool/result'>['data'], { surfaceOp: 'append' }))
    const [tool] = transcript.entries as [ToolEntry]
    expect(tool.outcome).toEqual({ content: [], isError: true, meta: { lines: 3 } })
  })

  it('keeps the latest plan out of the entry list', () => {
    const { session, transcript, feed } = log()
    expect(feed(session.append('todo/write', { todos: [{ content: 'first', status: 'pending' }] }))).toBe(true)
    feed(session.append('todo/write', { todos: [{ content: 'first', status: 'completed' }] }))
    expect(transcript.entries).toEqual([])
    expect(transcript.todos).toEqual([{ content: 'first', status: 'completed' }])
  })

  it.each([
    [{ kind: 'completed' }, undefined],
    [{ kind: 'aborted', reason: { kind: 'user' } }, 'Interrupted (user)'],
    [{ kind: 'blocked' }, 'Turn blocked before any step ran'],
    [{ kind: 'max-tokens' }, 'Stopped at the output-token limit'],
    [{ kind: 'interrupted' }, 'Turn left open by an earlier crash'],
    [{ kind: 'error', error: { message: 'boom', code: 'E' } }, 'E: boom'],
    [{ kind: 'from-a-newer-build' }, 'Turn ended: from-a-newer-build'],
  ])('reports how turn %o ended', (reason, expected) => {
    const { session, transcript, feed } = log()
    feed(session.append('turn/end', { turn: 0, reason } as SessionEvent<'turn/end'>['data']))
    expect((transcript.entries[0] as NoticeEntry | undefined)?.text).toBe(expected)
  })

  it('keeps one notice when an identical turn failure repeats across resends', () => {
    const { session, transcript, feed } = log()
    const failed = (turn: number): void => {
      feed(session.append('turn/end', {
        turn,
        reason: { kind: 'error', error: { message: 'no API key', code: 'MISSING_CREDENTIAL' } },
      } as SessionEvent<'turn/end'>['data']))
    }
    feed(userPrompt(session, 'first'))
    failed(0)
    feed(userPrompt(session, 'second'))
    failed(1)
    expect(transcript.entries).toEqual([
      { kind: 'user', text: 'first' },
      { kind: 'user', text: 'second' },
      { kind: 'notice', tone: 'error', text: 'MISSING_CREDENTIAL: no API key' },
    ])
  })

  it('keeps distinct turn failures and failures separated by model output', () => {
    const { session, transcript, feed } = log()
    const failed = (turn: number, message: string): void => {
      feed(session.append('turn/end', {
        turn,
        reason: { kind: 'error', error: { message, code: 'E' } },
      } as SessionEvent<'turn/end'>['data']))
    }
    feed(userPrompt(session, 'one'))
    failed(0, 'first failure')
    feed(userPrompt(session, 'two'))
    failed(1, 'second failure')
    feed(userPrompt(session, 'three'))
    feed(assistantText(session, 'an answer'))
    feed(userPrompt(session, 'four'))
    failed(2, 'first failure')
    const notices = transcript.entries.filter(entry => entry.kind === 'notice')
    expect(notices).toEqual([
      { kind: 'notice', tone: 'error', text: 'E: first failure' },
      { kind: 'notice', tone: 'error', text: 'E: second failure' },
      { kind: 'notice', tone: 'error', text: 'E: first failure' },
    ])
  })

  it('draws a command outcome only when the handler said something', () => {
    const { session, transcript, feed } = log()
    feed(session.append('command/done', { commandId: CommandId('cmd-1'), kind: 'success' }))
    expect(transcript.entries).toEqual([])
    feed(session.append('command/done', { commandId: CommandId('cmd-2'), kind: 'error', text: 'no such thing' }))
    feed(session.append('command/done', { commandId: CommandId('cmd-3'), kind: 'success', text: 'compacted 12 turns' }))
    expect(transcript.entries).toEqual([
      { kind: 'notice', tone: 'error', text: 'no such thing' },
      { kind: 'notice', tone: 'info', text: 'compacted 12 turns' },
    ])
  })

  it('marks a finished compaction so the summarized range reads as one', () => {
    const { session, transcript, feed } = log()
    feed(session.append('compaction/end', { compactionId: 'k1', turn: 0 } as SessionEvent<'compaction/end'>['data']))
    feed(session.append('compaction/end', { compactionId: 'k2', turn: 0, error: 'over budget' } as SessionEvent<'compaction/end'>['data']))
    expect(transcript.entries).toEqual([
      { kind: 'notice', tone: 'info', text: 'Conversation compacted' },
      { kind: 'notice', tone: 'error', text: 'Compaction failed: over budget' },
    ])
  })

  it('draws nothing for an event type it does not present', () => {
    const { session, transcript, feed } = log()
    expect(feed(session.append('turn/start', { turn: 0 }))).toBe(false)
    expect(transcript.entries).toEqual([])
  })

  it('normalizes control sequences out of model text', () => {
    const { session, transcript, feed } = log()
    feed(userPrompt(session, 'run\x1b[2J'))
    expect((transcript.entries[0] as UserEntry).text).toBe('run\\x1b[2J')
  })
})
