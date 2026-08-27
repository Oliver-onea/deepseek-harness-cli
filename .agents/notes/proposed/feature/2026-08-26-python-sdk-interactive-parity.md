# Agent Note: Python SDK interactive parity

Status: proposed

English | [中文](2026-08-26-python-sdk-interactive-parity.zh.md)

## Problem

The Python SDK is the design twin of the TypeScript SDK client, but it has fallen behind by three interactive methods plus shutdown. Everything an interactive client needs — steering a running turn, interrupting it, answering an approval question — is reachable from TypeScript and not from Python. This gap prevents Python users from building interactive or approval-gated workflows.

## Proposal

Add four protocol methods to the Python `HarnessClient` and expose steering and interrupting on the high-level `Session` class.

1. **`session_steer(session_id, content_blocks)`** — mirrors `client.ts:346`. Sends `session/steer`, validates that the response carries `messageId`, and raises `SdkProtocolError` when it does not.

2. **`session_interrupt(session_id, keep_inbox=False)`** — mirrors the TypeScript `interrupt` method. Sends `session/interrupt` with `keepInbox` only when `True`, preserving the protocol default of clearing queued work. Validates that the result is a JSON object.

3. **`shutdown()`** — sends a protocol `shutdown` request. `close()` calls `shutdown()` before transport teardown, matching the TypeScript client's behavior where shutdown is best-effort and the dispose ladder is authoritative.

4. **`on_approval_request(handler)`** — registers a handler for server→client `approval/request` questions. The handler receives typed `ApprovalRequestParams` and must return an `ApprovalRequestResult` with `outcome` in `{'allowed-once', 'rejected'}`. Without a registered handler, the runtime's questions get an error response and the tool call fails closed. Malformed params and handlers that return no decision are treated as protocol errors, matching the TypeScript client.

The high-level `Session` class gains `steer(input)` and `interrupt(keep_inbox=False)` so users holding a `Session` do not need to reach for the raw client.

## Alternatives considered

- **Expose only raw client methods, no `Session` methods:** rejected because a user holding a `Session` should not need to reach for the raw client to interrupt or steer it. The TypeScript SDK's `Session` equivalent exposes these; parity demands the same convenience.
- **Add `shutdown` to `Session`:** rejected because shutdown is a runtime-level act, not a session-level act. `DeepSeekHarness.close()` already owns runtime lifecycle.
- **Use a callback-based approval handler instead of `on_approval_request`:** rejected because the synchronous Python SDK already uses a polling model (`next_request`/`respond`). A registration-based handler keeps the same pattern while automating the response, matching the TypeScript client's design.
- **Default `keep_inbox` to `True`:** rejected because the protocol documents `keepInbox` as omitted-by-default, which clears queued work. Preserving the protocol default avoids surprising users who expect an interrupt to stop everything.

## Acceptance criteria

- All four protocol methods have typed, documented Python surfaces.
- `keep_inbox` defaults in Python exactly as the protocol documents it (`False`, omitting `keepInbox` from the wire).
- Protocol-violation paths raise `SdkProtocolError` and are tested.
- A registered approval handler answers server requests; the no-handler case does not hang.
- `uv run --project python/sdk pytest` passes.
- Bilingual README and Agent Note updates pass `doc-sync`.

## Risks

- The approval handler runs in the reader thread. A slow handler blocks the reader loop and may delay other messages. Document this and recommend fast handlers.
- `_dispatch_server_request` is new wire-path code. Any bug could break the reader thread silently. Tests cover the three failure modes (no handler, malformed params, no decision).
