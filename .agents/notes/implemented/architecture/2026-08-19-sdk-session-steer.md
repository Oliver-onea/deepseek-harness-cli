# Agent Note: `session/steer` for the JSON-RPC SDK protocol

Status: implemented

English | [中文](2026-08-19-sdk-session-steer.zh.md)

## Problem

After [`session/interrupt`](2026-08-18-sdk-session-interrupt.md), the JSON-RPC SDK protocol could start and stop work but not shape it mid-turn: `session/prompt` always splices into the `next-turn` inbox, so a prompt sent while a turn runs waits for that turn to finish. Both interactive surfaces already steer — the TUI sends `agent.steer` when the session is running ([terminal steering](../../../../packages/ui/tui/README.md)) — and `Agent.steer` defines the exact semantics: splice into `next-step` with wakeup, so a running turn consumes the message at its next step boundary and an idle session opens its next turn with it. An SDK client with the same need had no wire method; its only mid-turn lever was aborting the turn.

## Decision

`session/steer` is shaped after `session/prompt`: params carry the target `sessionId` plus `contentBlocks`, and the result is `{ messageId }` — the durable identity of the spliced user message, whose `agent/inbox/spliced` receipt (target `next-step`) arrives on the `session.event` stream like any other. The server resolves the session id against its live records and calls `agent.steer` on the agent it already holds, after the same live-registry validation `session/prompt` performs. An idle steer is `Agent.steer`'s own wakeup semantics — it opens the next turn — so the server needs no status check and the wire states no policy.

Unlike `session/prompt` and like `session/interrupt`, an unknown session id fails loud instead of lazily creating the session: steering targets work the runtime already owns, and a stale or mistyped id is a client bug that minting an agent would hide. The method name rides the `session/*` namespace its siblings occupy; `Agent.steer` names the underlying seam.

`HarnessClient.steer(sessionId, contentBlocks)` mirrors `prompt` at the protocol layer, and `HarnessSession.steer(input)` is the per-session handle shortcut (string input normalizes to one text block). `DeepSeekHarness` itself gets nothing, as with `interrupt`: there is no harness-wide session to route to. The Python SDK gains the method with its own change; the parity gap stays recorded in the three SDK READMEs' Known Limitations.

## Alternatives considered

- **A `followupOrSteer` polymorphic prompt.** Overloading `session/prompt` with a `mode` field hides two different delivery contracts (queue-for-next-turn versus join-this-turn) behind one method and makes every client's receipt handling conditional. Two names keep the inbox target a wire-level fact.
- **Lazy-create the session like `session/prompt` does.** Prompting a fresh id is a normal workflow (first contact); steering one is not — the steer exists to affect work already under way, so an unknown id is almost certainly stale or mistyped. Fail loud at the earliest resolvable point, as `session/interrupt` does.
- **Reject an idle steer.** `Agent.steer` already defines idle behavior (wakeup opens the next turn), and re-implementing a status gate in the server would race the agent's own transition while buying no caller protection — the client that cares checks `session.status` first.
- **Report when the message is consumed.** The consumption is durably logged (`user/message` inside the consuming step) and streamed as `session.event`; a richer result would couple wire latency to loop internals for no new fact. The acceptance receipt keeps the response semantics stable, exactly as `session/interrupt` argues.

## Verification

- A steering message sent while a turn runs joins that turn: the step-2 model request carries the steering text and the turn completes once — pinned by the `steer` snapshot scenario over the real runtime, where the scripted step 1 runs bash `sleep 1` so the steer lands deterministically mid-tool.
- An idle steer opens the next turn and its text reaches the model request — covered by the server package test and the stdio plugin-apply test.
- An unknown session id produces a JSON-RPC error naming it; malformed params reject at the wire boundary without reaching the agent; a steer never creates the session — server and client package tests.
- Existing clients are unaffected: `initialize`, `session/prompt`, `session/interrupt`, and `shutdown` behave exactly as before, and the full SDK and snapshot suites stay green.

## Consequences

- The next-step consumption order follows the agent loop's step boundary, not arrival order relative to tool execution; clients needing strict ordering within a step own that through their own protocol.
- Until the Python SDK gains its own steer, the two SDKs diverge on a protocol method; the gap is recorded in the READMEs so Python users are not surprised.
- Approval requests were the remaining interactive gap when this shipped; [`approval/request`](2026-08-19-sdk-approval-request.md) later closed it through the same per-session ownership rule.
