/**
 * Named wire types for the DeepSeek Harness SDK runtime protocol: the five
 * client→server request/result pairs, the one server→client request/result
 * pair (`approval/request`), and the four server-to-client notification
 * payloads exchanged over the newline-delimited JSON-RPC stdio transport. The
 * server plugin (`@deepseek-ai/dsh-sdk-jsonrpc-server`) and SDK clients share
 * these shapes; `serverInfo.name` stays the wire-stable
 * `deepseek-harness-sdk-runtime`.
 *
 * @module @deepseek-ai/dsh-sdk-protocol/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'

/** Parameters for the process-wide SDK handshake. */
export interface InitializeParams {
  /** Working directory recorded on every SDK-created session's header. */
  cwd: string
  /** Provider route every SDK-created agent runs on. */
  provider: string
  /** Model name every SDK-created agent runs on (the server may mount a fallback adapter; see `HarnessSdkJsonRpcServer.initialize`). */
  model: string
  /** Optional positive output-token cap inherited by SDK-created agents and their in-process descendants. */
  maxTokens?: number
}

/** Wire-stable server identity returned by initialization. */
export interface InitializeResult {
  /** Wire-stable server identity (`deepseek-harness-sdk-runtime`) and version. */
  serverInfo: { name: string; version: string }
}

/** One user turn on one SDK session. */
export interface SessionPromptParams {
  /** The SDK-side session id; an unknown id lazily creates the agent+session pair. */
  sessionId: string
  /** The prompt content blocks, sent verbatim as the user message. */
  contentBlocks: ContentBlock[]
}

/** Durable enqueue receipt for one prompt. */
export interface SessionPromptResult {
  /** Identity of the queued user message. */
  messageId: string
}

/**
 * Steer one SDK session: the content joins the running turn at its next step
 * boundary, or opens the next turn when the session is idle.
 */
export interface SessionSteerParams {
  /** The SDK-side session id; like `session/interrupt`, an unknown id fails instead of creating the session. */
  sessionId: string
  /** The steering content blocks, sent verbatim as the user message. */
  contentBlocks: ContentBlock[]
}

/** Durable enqueue receipt for one steering message. */
export interface SessionSteerResult {
  /** Identity of the spliced `next-step` user message. */
  messageId: string
}

/** Stop one SDK session's active turn, with explicit queued-work semantics. */
export interface SessionInterruptParams {
  /** The SDK-side session id; unlike `session/prompt`, an unknown id fails instead of creating the session. */
  sessionId: string
  /**
   * Preserve queued and steering inbox items while the active turn aborts;
   * preserved work stays parked until a later waking prompt claims it.
   * Omission clears them (the `Agent.cancel` default), so a bare interrupt
   * stops all pending work on the session.
   */
  keepInbox?: boolean
}

/**
 * Acceptance receipt for `session/interrupt`: the session exists and the
 * params were valid. The abort itself is observed through `session.event`
 * and `session.status`, and an idle session accepts the interrupt as a no-op.
 */
export type SessionInterruptResult = Record<string, never>

/** Server→client approval question: decide one pending tool action. */
export interface ApprovalRequestParams {
  /** The SDK-side session id whose agent awaits the decision. */
  sessionId: string
  /** The tool the question is about. */
  toolName: string
  /** The exact tool call being decided, when the asker had one. */
  callId?: string
  /** The asker's human-readable explanation of why it is asking. */
  reason?: string
}

/**
 * Client decision for one approval question. `'allowed-once'` is the only
 * grant; every other value the server can observe (including an error
 * response) fails closed.
 */
export interface ApprovalRequestResult {
  outcome: 'allowed-once' | 'rejected'
}

/** Deployment-mapped SDK outcome: `ok` for an accepted result, `error` otherwise. */
export type SdkRunStatus = 'ok' | 'error'

/** `session.event` payload: one session-log event, streamed as it is recorded. */
export interface SessionEventNotification {
  /** Session the event belongs to (every session in the runtime, not only SDK-created ones). */
  sessionId: string
  /** The full session-log event envelope. */
  event: SessionEvent
}

/** Whole-agent lifecycle state for one session. */
export interface SessionStatusNotification {
  /** Session whose live agent changed status. */
  sessionId: string
  /** The whole-agent state after the transition. */
  status: 'idle' | 'running'
}

/** `subagent.started` payload: an in-runtime child session was created. */
export interface SubagentStartedNotification {
  /** The delegating session. */
  parentSessionId: string
  /** The new child session. */
  childSessionId: string
}

/** `subagent.finished` payload: an in-process subagent run ended (remote runs are not reported). */
export interface SubagentFinishedNotification {
  /** Subagent provider name that ran the child. */
  provider: string
  /** The child agent's id (equals {@link childSessionId} for local runs). */
  agentId: string
  /** The delegating session. */
  parentSessionId: string
  /** The child session. */
  childSessionId: string
  /** Deployment-mapped run outcome. */
  status: SdkRunStatus
  /** The provider-reported stop reason. */
  stopReason: SubagentStopReason
  /** The child's selected assistant output; absent when the child produced none. */
  lastAssistantMessage?: ContentBlock[]
}

/** Server-to-client notifications by JSON-RPC method name. */
export interface HarnessSdkNotificationMap {
  'session.event': SessionEventNotification
  'session.status': SessionStatusNotification
  'subagent.started': SubagentStartedNotification
  'subagent.finished': SubagentFinishedNotification
}

/** Client-to-server request methods with their param and result shapes. */
export interface HarnessSdkRequestMap {
  'initialize': { params: InitializeParams; result: InitializeResult }
  'session/prompt': { params: SessionPromptParams; result: SessionPromptResult }
  'session/steer': { params: SessionSteerParams; result: SessionSteerResult }
  'session/interrupt': { params: SessionInterruptParams; result: SessionInterruptResult }
  'shutdown': { params: undefined; result: Record<string, never> }
}

/** Server-to-client request methods with their param and result shapes. */
export interface HarnessSdkServerRequestMap {
  'approval/request': { params: ApprovalRequestParams; result: ApprovalRequestResult }
}
