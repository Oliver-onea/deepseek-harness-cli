/**
 * Types for the TypeScript SDK client: launch options, notification shapes,
 * and owned activity results.
 *
 * @module @deepseek-ai/dsh-sdk-client/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalRequestParams, ApprovalRequestResult } from '@deepseek-ai/dsh-sdk-protocol'

/**
 * Handler for one server→client approval question; `'allowed-once'` is the
 * only grant, and a throwing handler fails the question closed server-side.
 */
export type ApprovalRequestHandler = (request: ApprovalRequestParams) => Promise<ApprovalRequestResult>

/** One server-to-client notification as received off the wire. */
export interface HarnessNotification {
  /** The JSON-RPC notification method name. */
  method: string
  /** The raw params object; see `HarnessSdkNotificationMap` for the shapes per method. */
  params: Record<string, unknown>
}

/** Predicate deciding whether a subscription receives a notification. */
export type NotificationFilter = (notification: HarnessNotification) => boolean

/** Launch and timeout options for {@link HarnessClient}. */
export interface HarnessClientOptions {
  /** The runtime executable (the `dsh-jsonrpc-agent` bin, a packaged exe, or `node`). */
  command: string
  /** Arguments passed to {@link command}. */
  args?: string[]
  /** Working directory for the runtime process itself. */
  cwd?: string
  /**
   * The complete child environment. `undefined` inherits the parent env
   * verbatim; passing an object replaces it entirely, so callers own
   * credential policy (see `scrubbedParentEnv` in `@deepseek-ai/dsh-subprocess`
   * for the shared scrub-then-merge base).
   */
  env?: NodeJS.ProcessEnv
  /** Per-request timeout (ms); `undefined` waits indefinitely (a turn can legitimately run long). */
  requestTimeoutMs?: number
  /** Bound (ms) on the protocol `shutdown` exchange inside `close()` (default 1000). */
  shutdownTimeoutMs?: number
  /** Grace (ms) for the runtime's stdin-EOF quiesce during `close()` (default 6000). */
  disposeEofGraceMs?: number
  /** Termination confirmation window (ms) after SIGTERM/SIGKILL during `close()` (default 3000). */
  disposeGraceMs?: number
}

/** Options for the high-level {@link DeepSeekHarness} wrapper. */
export interface DeepSeekHarnessOptions {
  /** Launch spec for the runtime subprocess (command, args, cwd, env, timeouts). */
  launch: HarnessClientOptions
  /**
   * Handler for server→client approval questions, installed on the underlying
   * client at construction; the runtime fails every approval closed without
   * one. See {@link ApprovalRequestHandler}.
   */
  onApproval?: ApprovalRequestHandler
  /** Workspace cwd recorded on every SDK-created session (default: the launch cwd, else `process.cwd()`). */
  cwd?: string
  /** Provider route for SDK-created agents (default `deepseek-official`). */
  provider?: string
  /** Model for SDK-created agents (default `deepseek-v4-flash`). */
  model?: string
  /** Maximum output tokens for each conversation-model request. */
  maxTokens?: number
}

/** One owned session activity interval, from enqueue receipt through idle. */
export interface RunResult {
  /** The session the activity ran on. */
  sessionId: string
  /** Concatenated text of the interval's last assistant message (empty when none). */
  finalResponse: string
  /** Every `session.event` payload for the root session, in wire order. */
  events: SessionEvent[]
  /** Every notification for the root session and discovered descendants, in wire order. */
  notifications: HarnessNotification[]
}

/** Options for `HarnessClient.interrupt` and `HarnessSession.interrupt`. */
export interface SessionInterruptOptions {
  /**
   * Preserve queued and steering inbox items; omitted clears them (the wire
   * default). Preserved work stays parked until a later waking prompt claims it.
   */
  keepInbox?: boolean
}

/** Re-exported content-block alias so SDK callers need no extra import. */
export type { ContentBlock }
