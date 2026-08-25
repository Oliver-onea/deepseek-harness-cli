# Agent Note: `approval/request` for the JSON-RPC SDK protocol

Status: implemented

English | [中文](2026-08-19-sdk-approval-request.zh.md)

## Problem

After [`session/steer`](2026-08-19-sdk-session-steer.md), the JSON-RPC SDK protocol could start, shape, and stop work, but a composition that asked for approval still failed closed on every question: the server registered no `approval/request` answerer, so the approval waterfall fell through to the fail-closed default and the tool call denied with "no approval channel is available". Both interactive surfaces already answer — the TUI panels the question ([terminal approval](../../../../packages/ui/tui/src/approval.ts)), ACP forwards it as `session/request_permission` ([ACP bridge](../../../../packages/acp/acp/src/index.ts)), and the web BFF carries it as a mux frame with a respond endpoint. The transport's reverse-request capability existed on both wire ends but nothing used it; the protocol README recorded it as dead capability reserved for approval.

## Decision

The server answers the `approval/request` waterfall for agents it owns and forwards each question to the wire client as the protocol's one server→client JSON-RPC request, method `approval/request`. Params carry the audit facts — `sessionId`, `toolName`, optional `callId` and `reason` — and the result is `{ outcome }` with `'allowed-once'` as the only grant. The question needs no wire-level correlation id: the JSON-RPC request id pairs ask and answer, and the durable audit pair (`approval/asked`/`approval/decided`) already rides the `session.event` stream every client sees.

Fail-closed is layered exactly as the seam defines it: a client answer that is not the one grant, and a malformed answer, map to `'rejected'` in the answerer; an error response, a lost transport, and an unanswered question reject the answerer, which the approval service's containment settles as `'unavailable'`; an aborting tool call withdraws the question (`'cancelled'`) through the request's abort signal. The composition decides whether approval exists at all: the server's answerer is registered unconditionally but only fires when an approval service dispatches the waterfall, so a deployment without `dsh-user-approval` keeps the executor's degrade-to-deny and a deployment with it gets wire-mediated decisions.

The TypeScript client installs `HarnessClient.onApprovalRequest(handler)` at the protocol layer and `DeepSeekHarnessOptions.onApproval` on the high-level constructor (a failed-handshake retry keeps the handler through the fresh client). Without a handler the transport answers `-32603` and the runtime fails closed — an unanswered question is a denied question, never a hang. The Python SDK's responder surface exists; its approval wiring arrives with its own change.

## Alternatives considered

- **A notification + client→server respond method (the api-proxy shape).** The web BFF uses `approval/requested` notifications plus a respond endpoint because an HTTP mux cannot hold a request open. The JSON-RPC transport is bidirectional with correlation built in, so a pending registry, replay ids, and a second method would re-implement what the request/response pair already provides. The BFF remains the reference for transports that cannot reverse-request.
- **Reuse ACP's `session/request_permission`.** That vocabulary belongs to the ACP wire; inventing an ACP-shaped method inside the SDK protocol would couple two contracts. The harness-native `ApprovalOutcome` vocabulary (`allowed-once` as the sole grant) is what the waterfall already speaks.
- **Offer `cancelled`/`unavailable` as client-selectable outcomes.** Those outcomes are owned by the seam's own edges — signal abort and containment — not by the answering client. A client that wants to deny answers `'rejected'`; letting it forge `'cancelled'` would corrupt the audit vocabulary.
- **Mount the approval service inside the server plugin.** Capability composition belongs to the surrounding `cordis.yml` (the repo's standing rule); the server only answers for agents it owns. `examples/jsonrpc-agent/approval.cordis.yml` shows the composition.
- **A per-question timeout in the server.** The asking edge already owns timing: the tool executor's abort signal withdraws the question when the turn is cancelled, and a client that never answers leaves the tool call pending exactly as long as the tool's own timeout allows. A second, server-owned timer would race both.

## Verification

- The `approval` snapshot scenario over the real runtime: a Claude Code `PreToolUse` hook turns the scripted bash call into an `ask`, the wire client answers `'allowed-once'`, and the session fixture pins the full sequence — `hook/invoked`, `hook/result` ask, `approval/asked`, `approval/decided` allowed-once, the granted tool result, and the completed turn — plus the notification stream and the client handler's received params.
- Server package tests: an owned agent's question reaches the transport with the audit facts; a non-grant answer and a client error fail closed through the mapped outcomes; a foreign agent's question delegates (`next()`).
- The stdio plugin-apply test drives the real `ApprovalService` through the mounted plugin: the ask crosses the wire as a server→client frame, the response settles the decision both ways (grant and reject).
- Client package tests: a handler answers on the wire verbatim; without a handler the runtime's question receives an error response (recorded by the fake runtime).
- Existing clients are unaffected: no approval question is sent unless the composition asks one, and the full SDK and snapshot suites stay green.

## Consequences

- The protocol now defines exactly one server→client request; adding another is a contract change, not a transport change (the transport always supported them).
- A client that declines to install a handler silently converts approvals into denials; deployments that compose approval must also compose an answering client, stated in the server README.
- Until the Python SDK wires its responder, the two SDKs diverge on approval answering; the gap stays recorded in the READMEs' Known Limitations.
- The interactive surface of the protocol — prompt, steer, interrupt, approval — is now closed; remaining gaps (per-session close, per-prompt result) are recorded in the protocol README's Known Limitations.
