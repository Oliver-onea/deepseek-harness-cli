# Agent Note: `session/interrupt` for the JSON-RPC SDK protocol

Status: implemented

English | [中文](2026-08-18-sdk-session-interrupt.zh.md)

## Problem

The JSON-RPC SDK protocol (`dsh-sdk-protocol` / `dsh-sdk-jsonrpc-server` / `dsh-sdk-client`) exposes exactly three requests — `initialize`, `session/prompt`, `shutdown` — so an out-of-process client can start agent work but cannot stop it. The server already holds the `AgentHandle` for every session it creates, and `Agent.cancel(cause, options)` already defines the semantics an interrupt needs: abort the active turn, and clear queued and steering work unless `keepInbox` preserves it ([explicit turn cancellation](../../implemented/architecture/2026-07-16-explicit-turn-cancellation.md)). Both other interactive surfaces can stop a turn — the TUI via Esc, ACP via `session/cancel` — while an SDK client can only wait for the turn to end or kill the whole runtime.

The queued-work half of the decision is the part a wire designer cannot leave implicit. `Agent.cancel` clears the inbox by default; the web UI deliberately preserves it ([web stop preserves queue](../../implemented/bug-fix/2026-07-31-web-stop-preserves-queue.md)), and preserved work stays parked until a later waking prompt claims it ([cancel convergence wake latch](../../implemented/bug-fix/2026-08-07-cancel-convergence-wake-latch.md)). A wire method that hid this choice would force one policy on every client.

## Decision

Add a fourth request, `session/interrupt`, shaped after `session/prompt`: params carry the target `sessionId`, the result is an empty acceptance receipt, and progress is observed through the existing `session.event` / `session.status` notifications rather than the response. The server validates params at the wire boundary, resolves the session id against its live records — an unknown id fails loud with a JSON-RPC error naming it, and unlike `session/prompt` an interrupt never creates a session — then calls `agent.cancel({ kind: 'user' }, { keepInbox })` on the agent it already holds. Interrupting an idle session is `Agent.cancel`'s documented no-op and arms nothing.

`keepInbox` is an optional boolean, defaulting to `false`: the wire mirrors `Agent.cancel`'s own default rather than inventing a policy, on the principle that a bare "interrupt" means *stop everything* and preserving the queue is the deliberate choice a client states explicitly. Preserved work is parked, not auto-run; the next waking prompt claims it as its own turn.

The TypeScript client carries `HarnessClient.interrupt(sessionId, options?)` at the protocol layer and `HarnessSession.interrupt(options?)` on the per-session handle, since the session handle is where a client already routes prompts. `DeepSeekHarness` itself gets nothing: `run()` owns its activity interval and a harness-wide interrupt has no session to route to. The Python SDK is a design twin over the same protocol and gains interrupt in its own change; until then the parity gap is recorded in the SDK READMEs' Known Limitations.

## Wire contract

`session/interrupt` params: `sessionId: string` (required; a non-string rejects before any session state is touched) and `keepInbox?: boolean` (a present non-boolean rejects likewise). Result: `{}` — acceptance only, so the response never races the abort's convergence. Error cases: an unknown session id produces a JSON-RPC error whose message names the id; malformed params produce a `TypeError` surfaced as an internal-error response. Cause on the wire is always `{ kind: 'user' }`, matching ACP's `session/cancel`.

## Alternatives considered

- **A fire-and-forget notification instead of a request.** ACP's `session/cancel` is a notification, but ACP pairs it with a prompt request that returns per-turn. Here `session/prompt` is a request whose response confirms acceptance, and an interrupt needs the same channel to report an unknown session id — a notification cannot fail.
- **Lazy-create the session like `session/prompt` does.** Prompting a fresh id is a normal workflow; interrupting a session that never existed is almost certainly a client bug (a stale or mistyped id), and silently creating an empty session would hide it. Fail loud at the earliest resolvable point.
- **Default `keepInbox: true`.** The web UI's stop-preserves-queue default reflects an interactive human who expects drafts to survive; a programmatic client issuing an interrupt more often means *abandon this work entirely*. Mirroring `Agent.cancel`'s default keeps the wire policy-free and makes the preserving client say so.
- **Report whether a turn was active in the result.** That boolean would race the abort's convergence and invite polling; the notification stream is the authoritative observation channel, and the acceptance receipt keeps the response semantics stable.
- **Block the response until the turn has converged.** That would couple wire latency to loop internals (tool teardown, stream abort propagation) for no client benefit — the client that cares about convergence already subscribes to `session.status`.
- **A `DeepSeekHarness.run`-level cancel handle.** `run()` settles on the session's next idle and owns its notification subscription; bolting a per-run cancel onto it duplicates routing the session handle already provides. `HarnessSession.interrupt` covers the same sessions with one obvious target.

## Verification

- A client interrupts a running turn and observes it stop (`turn/end` aborted with cause `{ kind: 'user' }`, then `session.status` idle) — pinned by the `interrupt` snapshot scenario over the real runtime.
- Queued-work behavior is explicit on the wire, documented in all three SDK READMEs, and tested both ways: the default discards the queued prompt; `keepInbox: true` parks it and a later waking prompt claims it (the `interrupt-keep-inbox` snapshot).
- Interrupting an idle session is a no-op that does not arm later work; an unknown session id produces a JSON-RPC error naming it; malformed params reject at the wire boundary without reaching the agent — all covered by server and client package tests.
- Existing clients are unaffected: `initialize`, `session/prompt`, and `shutdown` behave exactly as before, and a client that never calls `session/interrupt` sees no change (the full SDK and snapshot suites stay green).

## Consequences

- The parked-queue semantics (preserved work waits for a waking prompt rather than resuming on its own) can surprise a client expecting web-style immediate continuation; the wire documentation and both snapshots state it explicitly, and changing it would be an agent-loop decision, not an SDK one.
- Until the Python SDK gains its own interrupt, the two SDKs diverge on a protocol method; the gap is recorded in the READMEs so Python users are not surprised by a missing method.
- Approval requests and `turn/steer` remain the other two interactive gaps; this design neither solves nor obstructs them — a future steer request would route through the same per-session record and the same acceptance-receipt shape.
