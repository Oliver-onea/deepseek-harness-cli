/**
 * The human transcript: an append-origin fold of session events into the
 * ordered entries the terminal draws. It reads the durable log rather than the
 * model-visible surface, so a resumed session keeps every message the reader
 * already saw and a compacted range stays readable behind its marker.
 * @module @deepseek-ai/dsh-tui/transcript
 */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CallId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue, SessionEvent, TodoItem } from '@deepseek-ai/dsh-session'
// Side-effect type imports: they merge the command and compaction members this
// fold reads into `SessionEventMap`.
import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@deepseek-ai/dsh-compaction'
import { displayLine, displayText } from './display-text.ts'

/** A human turn the reader typed. */
export interface UserEntry {
  kind: 'user'
  text: string
}

/**
 * A durable image the reader attached to their own turn. Only user-authored
 * content draws inline: the current production adapters emit text-only
 * assistant output, so an assistant or tool-result image block — forward
 * compatible on the block type itself — contributes nothing here yet.
 */
export interface ImageEntry {
  kind: 'image'
  ref: ImageAttachmentRef
}

/** Committed or still-streaming assistant text. */
export interface AssistantEntry {
  kind: 'assistant'
  text: string
  /** Whether the step that produces this text is still streaming. */
  streaming: boolean
}

/** Committed or still-streaming model reasoning, rendered apart from the answer. */
export interface ReasoningEntry {
  kind: 'reasoning'
  text: string
  /** Whether the step that produces this reasoning is still streaming. */
  streaming: boolean
}

/** The settled outcome of one tool call. */
export interface ToolOutcome {
  /** The model-facing result blocks. */
  content: ContentBlock[]
  /** Whether the tool reported failure. */
  isError: boolean
  /** The tool's own presentation payload, replayed into `presentResult`. */
  meta?: JsonValue
}

/** One tool call and, once it settles, its outcome. */
export interface ToolEntry {
  kind: 'tool'
  callId: CallId
  name: string
  /** The raw arguments JSON exactly as the model produced it. */
  rawArguments: string
  /** Absent while the call is still running. */
  outcome?: ToolOutcome
}

/** How prominently a notice reads. */
export type NoticeTone = 'info' | 'warn' | 'error'

/** A one-line lifecycle remark: an ended turn, a command, a compaction marker. */
export interface NoticeEntry {
  kind: 'notice'
  tone: NoticeTone
  text: string
}

/** The cold-open header seeded at startup; it scrolls away with the transcript. */
export interface HeaderEntry {
  kind: 'header'
  /** The composed, styled header lines. */
  lines: readonly string[]
}

/** One drawable unit of the conversation, in append order. */
export type TranscriptEntry = UserEntry | AssistantEntry | ReasoningEntry | ToolEntry | NoticeEntry | HeaderEntry | ImageEntry

/**
 * Join a message's text or reasoning blocks; the other collects images
 * instead, so this reads only the two block types that ever produce one.
 * @param content - the message's content blocks.
 * @param type - the block type to collect.
 * @returns the joined text of the selected blocks.
 */
function joinBlocks(content: readonly ContentBlock[], type: 'text' | 'reasoning'): string {
  let joined = ''
  for (const block of content) {
    if (block.type === type) joined += block.text
  }
  return joined
}

/** One ordered piece a user message contributes: prose or one attached image. */
type UserPart = { kind: 'text'; text: string } | { kind: 'image'; ref: ImageAttachmentRef }

/**
 * Split a user message's content into transcript entries in block order.
 * Adjacent text blocks join into one part, and each image becomes its own,
 * so a message that interleaves prose and pictures draws them in the order
 * the reader attached them.
 * @param content - the message's content blocks.
 * @returns the ordered parts this message contributes.
 */
function splitUserParts(content: readonly ContentBlock[]): UserPart[] {
  const parts: UserPart[] = []
  let text = ''
  const flushText = (): void => {
    if (text !== '') parts.push({ kind: 'text', text })
    text = ''
  }
  for (const block of content) {
    if (block.type === 'text') {
      text += block.text
    } else if (block.type === 'image') {
      flushText()
      parts.push({ kind: 'image', ref: block.attachment })
    }
  }
  flushText()
  return parts
}

/**
 * Describe why a turn ended, for the reasons a reader must be told about. A
 * turn that simply completed needs no line — its assistant text is the outcome.
 * @param reason - the logged turn-end reason.
 * @returns the notice to append, or `undefined` when the ending is unremarkable.
 */
function turnEndNotice(reason: SessionEvent<'turn/end'>['data']['reason']): NoticeEntry | undefined {
  switch (reason.kind) {
    case 'completed':
      return undefined
    case 'aborted':
      return { kind: 'notice', tone: 'warn', text: `Interrupted (${reason.reason.kind})` }
    case 'blocked':
      return { kind: 'notice', tone: 'warn', text: 'Turn blocked before any step ran' }
    case 'max-tokens':
      return { kind: 'notice', tone: 'warn', text: 'Stopped at the output-token limit' }
    case 'interrupted':
      return { kind: 'notice', tone: 'warn', text: 'Turn left open by an earlier crash' }
    case 'error':
      return { kind: 'notice', tone: 'error', text: `${reason.error.code}: ${displayLine(reason.error.message)}` }
    // The reason map is merge-extensible: an unknown ending still gets a line,
    // because silence would read as a turn that completed normally.
    default: {
      const { kind } = reason as { kind: string }
      return { kind: 'notice', tone: 'warn', text: `Turn ended: ${displayLine(kind)}` }
    }
  }
}

/**
 * The ordered entries the renderer draws, folded from the session log one
 * event at a time. Streaming chunks mutate the entry they belong to, so the
 * live view and a resumed view converge on the same content.
 */
export class Transcript {
  private readonly items: TranscriptEntry[] = []
  private readonly calls = new Map<CallId, ToolEntry>()
  private streamingText: AssistantEntry | undefined
  private streamingReasoning: ReasoningEntry | undefined
  private plan: readonly TodoItem[] = []

  /** The drawable entries, oldest first. */
  get entries(): readonly TranscriptEntry[] {
    return this.items
  }

  /** The latest `todo/write` plan; empty until the agent writes one. */
  get todos(): readonly TodoItem[] {
    return this.plan
  }

  /**
   * Append one terminal-only remark that no durable event carries.
   * @param tone - how prominently the remark reads.
   * @param text - the remark.
   */
  notice(tone: NoticeTone, text: string): void {
    this.items.push({ kind: 'notice', tone, text: displayText(text) })
  }

  /**
   * Seed the cold-open header once, and only while nothing else has been
   * drawn: a resumed transcript keeps its own first entry.
   * @param lines - the composed header lines.
   */
  seedHeader(lines: readonly string[]): void {
    if (this.items.length > 0) return
    this.items.push({ kind: 'header', lines })
  }

  /**
   * Fold one durable event into the transcript.
   * @param event - the appended session event.
   * @returns whether the drawn content changed.
   */
  append(event: SessionEvent): boolean {
    switch (event.type) {
      case 'user/message':
        return this.appendUserMessage(event.data)
      case 'assistant/chunk':
        return this.appendChunk(event.data.chunk)
      case 'assistant/message':
        return this.commitAssistant(event.data.message.content)
      case 'tool/call':
        return this.openCall(event.data)
      case 'tool/result':
        return this.settleCall(event.data)
      case 'todo/write':
        this.plan = event.data.todos
        return true
      case 'turn/end':
        return this.appendTurnEnd(event.data.reason)
      case 'command/done':
        return this.push(commandNotice(event.data))
      case 'compaction/end':
        return this.push(compactionNotice(event.data))
      // Merge-extensible vocabulary: every other event type is either already
      // represented by the events above (`turn/start`, `step/*`, chunk rows) or
      // carries no reader-facing content, so it draws nothing.
      default:
        return false
    }
  }

  /**
   * Append one entry when there is one.
   * @param entry - the entry to append, or `undefined` to append nothing.
   * @returns whether an entry was appended.
   */
  private push(entry: TranscriptEntry | undefined): boolean {
    if (entry === undefined) return false
    this.items.push(entry)
    return true
  }

  /**
   * Fold one turn ending. A failed turn draws its code and message as an
   * error notice; a resend against an unchanged failure replaces the identical
   * error notice instead of stacking another, so repeated keyless sends leave
   * one visible failure, always the newest. The replacement only reaches back
   * across user entries: any assistant, reasoning, tool, or other notice in
   * between means the earlier failure belongs to a different moment and stays.
   * The same fold runs live and on resume, so both views keep one notice.
   * @param reason - the logged turn-end reason.
   * @returns whether the drawn content changed.
   */
  private appendTurnEnd(reason: SessionEvent<'turn/end'>['data']['reason']): boolean {
    const entry = turnEndNotice(reason)
    if (entry === undefined) return false
    if (entry.tone === 'error') {
      for (let index = this.items.length - 1; index >= 0; index -= 1) {
        const candidate = this.items[index]
        if (candidate === undefined) break
        if (candidate.kind === 'user') continue
        if (candidate.kind === 'notice' && candidate.tone === 'error' && candidate.text === entry.text) {
          this.items.splice(index, 1)
        }
        break
      }
    }
    this.items.push(entry)
    return true
  }

  /**
   * Fold a user-role message. A human prompt becomes a turn; plugin-injected
   * context is model-visible but not conversation, so only the `notice` form —
   * the one that carries a reader-facing summary — draws a line.
   * @param message - the logged user message.
   * @returns whether the drawn content changed.
   */
  private appendUserMessage(message: SessionEvent<'user/message'>['data']): boolean {
    const source = message.source
    if (source.kind === 'user') {
      // Every part below is a defined entry, so `push` always returns true here;
      // what varies is whether the message contributed any part at all.
      const parts = splitUserParts(message.content)
      for (const part of parts) {
        this.push(part.kind === 'text'
          ? { kind: 'user', text: displayText(part.text) }
          : { kind: 'image', ref: part.ref })
      }
      return parts.length > 0
    }
    if (source.kind === 'plugin' && source.form === 'notice') {
      return this.push({ kind: 'notice', tone: 'info', text: displayLine(source.summary) })
    }
    return false
  }

  /**
   * Fold one raw stream chunk into the entry it extends, creating that entry on
   * the first delta of its kind.
   * @param chunk - the streamed chunk.
   * @returns whether the drawn content changed.
   */
  private appendChunk(chunk: SessionEvent<'assistant/chunk'>['data']['chunk']): boolean {
    if (chunk.type === 'text-delta') {
      if (this.streamingText === undefined) {
        this.streamingText = { kind: 'assistant', text: '', streaming: true }
        this.items.push(this.streamingText)
      }
      this.streamingText.text += displayText(chunk.text)
      return true
    }
    if (chunk.type === 'reasoning-delta') {
      if (this.streamingReasoning === undefined) {
        this.streamingReasoning = { kind: 'reasoning', text: '', streaming: true }
        this.items.push(this.streamingReasoning)
      }
      this.streamingReasoning.text += displayText(chunk.text)
      return true
    }
    return false
  }

  /**
   * Settle a step's streamed entries against the committed message. The
   * committed content replaces the accumulated deltas rather than adding to
   * them, so a replayed log and a live stream render identically; a step whose
   * chunks were never logged still gets its entries here.
   * @param content - the committed assistant message's blocks.
   * @returns whether the drawn content changed.
   */
  private commitAssistant(content: readonly ContentBlock[]): boolean {
    const reasoning = displayText(joinBlocks(content, 'reasoning'))
    const text = displayText(joinBlocks(content, 'text'))
    let changed = false
    changed = this.settleStream('reasoning', this.streamingReasoning, reasoning) || changed
    changed = this.settleStream('assistant', this.streamingText, text) || changed
    this.streamingReasoning = undefined
    this.streamingText = undefined
    return changed
  }

  /**
   * Replace one streamed entry's content with the committed text, or create the
   * entry when nothing streamed.
   * @param kind - which streamed entry is settling.
   * @param streamed - the entry the deltas built, when any.
   * @param text - the committed text for that entry.
   * @returns whether the drawn content changed.
   */
  private settleStream(
    kind: 'assistant' | 'reasoning',
    streamed: AssistantEntry | ReasoningEntry | undefined,
    text: string,
  ): boolean {
    if (streamed !== undefined) {
      const changed = streamed.text !== text || streamed.streaming
      streamed.text = text
      streamed.streaming = false
      return changed
    }
    if (text === '') return false
    this.items.push({ kind, text, streaming: false })
    return true
  }

  /**
   * Open a tool card for one requested call.
   * @param call - the logged tool call.
   * @returns whether the drawn content changed.
   */
  private openCall(call: SessionEvent<'tool/call'>['data']): boolean {
    // A streamed step ends at its first tool call: later text belongs to the
    // next step and must not extend the answer above this card.
    this.streamingText = undefined
    this.streamingReasoning = undefined
    const entry: ToolEntry = {
      kind: 'tool',
      callId: call.callId,
      name: call.name,
      rawArguments: call.arguments,
    }
    this.calls.set(call.callId, entry)
    this.items.push(entry)
    return true
  }

  /**
   * Attach a settled outcome to its open card. A result whose call is not in
   * this transcript (a page boundary on a resumed log) draws nothing rather
   * than inventing a card with no arguments to present.
   * @param result - the logged tool result.
   * @returns whether the drawn content changed.
   */
  private settleCall(result: SessionEvent<'tool/result'>['data']): boolean {
    const [block] = result.message.content
    const entry = this.calls.get(block.toolCallId)
    if (entry === undefined) return false
    entry.outcome = {
      content: block.content,
      isError: block.isError === true,
      ...result.meta === undefined ? {} : { meta: result.meta },
    }
    this.calls.delete(block.toolCallId)
    return true
  }
}

/**
 * Describe a settled slash command. A successful command with no text said
 * everything through its own domain events, so it draws no line.
 * @param done - the logged command settlement.
 * @returns the notice to append, or `undefined` when the command speaks for itself.
 */
function commandNotice(done: SessionEvent<'command/done'>['data']): NoticeEntry | undefined {
  if (done.text === undefined || done.text === '') return undefined
  return {
    kind: 'notice',
    tone: done.kind === 'error' ? 'error' : 'info',
    text: displayText(done.text),
  }
}

/**
 * Describe a finished compaction, so the reader knows why the model's memory of
 * the conversation above the marker is now a summary.
 * @param end - the logged compaction ending.
 * @returns the marker notice.
 */
function compactionNotice(end: SessionEvent<'compaction/end'>['data']): NoticeEntry {
  return end.error === undefined
    ? { kind: 'notice', tone: 'info', text: 'Conversation compacted' }
    : { kind: 'notice', tone: 'error', text: `Compaction failed: ${displayLine(end.error)}` }
}
