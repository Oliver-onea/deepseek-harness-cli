# Agent Note: TUI as a protocol client — inventory, feasibility, and recommendation

Status: proposed

English | [中文](2026-08-26-tui-as-protocol-client.zh.md)

## Problem

`dsh` has two front doors that share no protocol. The terminal (`packages/ui/tui`) reaches directly into in-process Cordis services through `ctx.inject`, `ctx.get`, and deferred `ctx.inject` — it is a plugin that happens to draw, not a client of anything. The SDK app-server (`packages/sdk`) speaks newline-delimited JSON-RPC over stdio with `initialize`, `session/prompt`, `session/steer`, `session/interrupt`, `shutdown`, and `approval/request`. The terminal does not use one byte of the protocol.

Codex is the shape being copied: one app-server protocol, and the TUI is its best-known client. This note inventories every service the terminal touches, classifies each against the protocol, answers the three feasibility questions that decide whether the TUI *can* become a protocol client, and sizes the work.

The terminal-web parity plan ([2026-08-14-terminal-web-parity.md](../../implemented/feature/2026-08-14-terminal-web-parity.md)) calls the protocol question orthogonal to parity. After the inventory, this holds: the protocol gap is independent of whether the terminal draws a footer field or a menu. The two efforts can proceed in parallel, and neither blocks the other.

## Proposal

### Service inventory

Fifteen services the terminal reaches, classified against the SDK protocol.

| # | Service | Access | Classification | Rationale |
|---|---------|--------|----------------|-----------|
| 1 | `agents` | hard `inject` (`index.ts:62`) | **Already covered** | `session/prompt` creates agents; `session/status` reports lifecycle. The TUI holds an `Agent` reference today, but a protocol client holds a `sessionId` handle and drives the same operations through the protocol. |
| 2 | `tools` | hard `inject` (`index.ts:62`) | **Folds into session state** | The tool registry is used only for `createPresenter()` (`index.ts:217`), which resolves `presentCall`/`presentResult`. The views are plain JSON data (see feasibility analysis). The protocol already streams `tool/call` and `tool/result` events through `session.event`; the server could attach the rendered views as fields on those events, and the terminal would draw them without holding the tool object. |
| 3 | `timer` | hard `inject` (`index.ts:62`) | **Stays local** | Cordis built-in. Used for `ctx.interval()` to refresh the elapsed-time footer every second (`index.ts:413`). This is a render-loop concern with no model-visible component. |
| 4 | `appExit` | `ctx.get` (`index.ts:310,425`) | **Stays local** | `process.exit()` is a host concern. The protocol's `shutdown` method disposes the server; a TUI client that receives a shutdown response or EOF exits its own process. |
| 5 | `agentDefaultModel` | `ctx.get` (`index.ts:327,332,462`) | **Needs a new method** | Two operations: reading the deployment default (`currentSelection()`) and persisting a pick (`saveSelection()`). The read folds into `session/status` as `defaultModel?: {provider, model}`. The write is an action: `session/selectModel` with params `{sessionId, provider, model, reasoningEffort?}` and result `{accepted: boolean, reason?}`. |
| 6 | `goals` | `ctx.get` (`index.ts:336`) | **Folds into session state** | The footer reads `goals.get(agent)` to show the current objective and phase. Enrich `session/status` with `goal?: {objective: string, phase: 'active' | 'complete'}`. The reader closure that hides completed goals is a rendering decision that stays terminal-local. |
| 7 | `planMode` | `ctx.get` (`index.ts:337`) | **Folds into session state** | The footer reads `planMode.get(agent)` for the `plan`/`plan*` indicator. Enrich `session/status` with `planMode?: {state: 'active' | 'pending' | 'off'}`. |
| 8 | `permissionPresets` | `ctx.get` (`index.ts:338`) | **Folds into session state** | The footer reads `permissionPresets.current(agent.session.events)`. Enrich `session/status` with `permissionPreset?: string`. The derivation from session events is a server-side computation. |
| 9 | `commands` | `ctx.get` + deferred `ctx.inject` (`index.ts:339,426`) | **Needs new methods** | Two operations: listing the commands the registry resolves for the agent (`commands.list(agent)`), and executing one (`commands.execute(agent, line)`). The terminal also registers `exit`, `quit`, `help`, and `model` commands through deferred injection. New methods: `command/list` — params `{sessionId}`, result `{commands: {name: string, description: string, input?: {hint: string}}[]}`. `command/execute` — params `{sessionId, line: string}`, result `{kind: 'success' | 'error', text: string}`. The `exit`/`quit` commands map to `shutdown`; `model` maps to `session/selectModel`; `help` is a rendering of the `command/list` result. |
| 10 | `skills` | `ctx.get` (`index.ts:340`) | **Needs a new method** | The `/` menu reads the user-invocable skill catalog through `skills.list({cwd, signal, scope: agent})`. New method: `skill/list` — params `{sessionId}`, result `{skills: {name: string, description: string, modelInvocable: boolean}[]}`. The `user-only` marker and sanitization are rendering decisions that stay terminal-local. |
| 11 | `subagents` | `ctx.get` (`index.ts:341`) | **Needs a new method** | The `@` menu reads running children through `subagents.listChildren(agent.session.id, signal)`. New method: `subagent/listChildren` — params `{sessionId}`, result `{children: {name: string, id: string}[]}`. The `subagent.started`/`subagent.finished` notifications already exist; the server could maintain the running set from those signals. |
| 12 | `llm` | `ctx.get` (`index.ts:342`) | **Needs a new method** | The model picker reads the live adapter registry (`llm.listProviders()`) and resolves model info per route. New method: `model/list` — params `{}`, result `{models: {provider: string, model: string, reasoningEfforts?: string[]}[]}`. The picker's rendering (numbered rows, keyboard navigation, effort tier) stays terminal-local. |
| 13 | `tokenMeter` | `ctx.get` (`index.ts:349`) | **Folds into session state** | The footer reads token counts from the meter. Enrich `session/status` with `tokens?: {input: number, output: number, cache?: number}`. The meter's real-time updates already arrive through `session.event` (the `assistant/chunk` and `request/context` events carry token counts); the status field is a convenience aggregation. |
| 14 | `userQuestions` | deferred `ctx.inject` (`index.ts:418`) | **Already covered by pattern** | The terminal registers a `TerminalQuestions` provider that renders a keyboard panel. The protocol's `approval/request` server→client request is the same pattern: the server asks, the client answers. A `userQuestions/ask` server→client request would mirror it: params `{sessionId, questions: AskUserQuestionItem[]}`, result `{answers: AskUserQuestionAnswerItem[]}`. |
| 15 | `approval` | deferred `ctx.inject` (`index.ts:421`) | **Already covered** | The `approval/request` server→client request already exists with params `{sessionId, toolName, callId?, reason?}` and result `{outcome: 'allowed-once' | 'rejected'}`. The terminal's `installApprovalAnswerer` (`approval.ts:64`) answers through the same panel as `userQuestions`. |

**Summary:** 3 services are already covered, 4 fold into session state, 5 need new methods, 3 stay local.

### Feasibility

#### 1. Do tool render intents survive serialization?

**Yes.** Every variant of `ToolCallView` and `ToolResultView` is plain JSON-shaped data.

`ToolCallView` (`packages/core/tools/src/presentation.ts:46`):
- `GenericCallView` (`presentation.ts:53`): `{card: 'generic', title: string, kind?: ToolCallKind, rawInput?: unknown, content?: ContentBlock[], locations?: FileLocation[]}`. `ToolCallKind` is a string union (`presentation.ts:15`). `FileLocation` is `{path: string, line?: number}` (`presentation.ts:23`).
- `TerminalCallView` (`presentation.ts:84`): `{card: 'terminal', title: string, description?: string, cwd?: string}` — all strings.
- `DiffCallView` (`presentation.ts:110`): `{card: 'diff', title: string, diffs: FileDiff[], locations?: FileLocation[]}`. `FileDiff` is `{path: string, oldText: string | null, newText: string}` (`presentation.ts:34`).

`ToolResultView` (`presentation.ts:140`):
- `GenericResultView` (`presentation.ts:146`): `{card: 'generic', title?: string, content?: ContentBlock[]}`.
- `TerminalResultView` (`presentation.ts:163`): `{card: 'terminal', title?: string, output?: string, exitCode?: number, signal?: string}`.
- `DiffResultView` (`presentation.ts:184`): `{card: 'diff', title?: string, diffs: FileDiff[]}`.
- `SearchMatchesResultView` (`presentation.ts:216`): `{card: 'search', shape: 'matches', title?: string, files: SearchFileMatches[], truncated: boolean, total: number}`. `SearchFileMatches` is `{path: string, matches: {lineNumber: number, line: string}[]}` (`presentation.ts:200`).
- `SearchPathsResultView` (`presentation.ts:238`): `{card: 'search', shape: 'paths', title?: string, paths: string[], truncated: boolean, total: number}`.
- `ReadResultView` (`presentation.ts:281`): `{card: 'read', title?: string, path: string, offset: number, lines: {number: number, text: string}[], totalLines: number, lang?: string, content?: ContentBlock[]}`.
- `WebSearchResultView` (`presentation.ts:355`): `{card: 'web', kind: 'search', title?: string, sources: {url: string, title?: string, snippet?: string, publishedAt?: string}[], answer?: string, truncated: boolean}`.
- `WebFetchResultView` (`presentation.ts:374`): `{card: 'web', kind: 'fetch', title?: string, url: string, statusCode: number, truncated: boolean}`.

`ContentBlock` (`packages/llm/llm/src/types.ts:110`) is a discriminated union of `{type: 'text', text: string}`, `{type: 'image', ...}`, and other plain JSON objects.

No variant carries a function, a class instance, a symbol, or any non-serializable value. The `presentCall`/`presentResult` methods are documented as pure functions of `args` (`packages/core/tools/src/index.ts:279,287`), and the code-mode example confirms it (`packages/core/tools/src/code-mode.ts:645`). The server can compute the views and attach them to `tool/call` and `tool/result` events; the terminal can draw them without holding the tool object.

#### 2. What does the terminal do that the protocol has no vocabulary for at all?

- **Autocomplete menus while typing** (`/` and `@`): The terminal uses pi-tui's `AutocompleteProvider` (`packages/ui/tui/src/autocomplete.ts:176`). The roster reads (`commands.list()`, `skills.list()`, `subagents.listChildren()`) are gaps — they need the new methods listed in the inventory. The autocomplete mechanics (debouncing, fuzzy filtering, keyboard arbitration, `menuRowsFor` degradation) are pi-tui editor concerns that legitimately stay terminal-local. The protocol needs to serve the data; the terminal owns the rendering.
- **Launch resume picker**: `pickResumeSession` (`packages/ui/tui/src/resume-picker.ts`) reads the session store directly. The protocol has no `session/list` or `session/resume` method. This is a gap, but it legitimately stays terminal-local: the picker runs *before* the TUI boots, and the same boot sequence that starts the protocol server would need to run the picker first. The picker is a host-level concern, not a session-level one.
- **Streaming partial assistant text**: Already covered. The protocol streams `session.event` notifications including `assistant/chunk` events (`packages/sdk/protocol/src/types.ts:111`). The terminal renders them as they arrive through `shell.observe(event)` (`packages/ui/tui/src/index.ts:401`).
- **Plan-mode transitions**: Gap. The protocol has no plan-mode notification. The terminal reads `planMode.get(agent)` directly (`packages/ui/tui/src/index.ts:337`). This state would need to be part of `session/status` or a new notification.
- **Queued-prompt inbox**: Gap. The terminal reads `agent.inbox.nextTurn` and `agent.inbox.nextStep` for the image guard in the model picker (`packages/ui/tui/src/index.ts:459`). The protocol has no inbox visibility. This is a narrow use case (the model picker refuses a model that cannot accept images when queued content has one); the inbox state could be part of `session/status`.

#### 3. What breaks the transcript contract?

**Nothing breaks.** The model-visible inputs the terminal produces today are:
- User prompts (`shell.prompt(text)` → `agent.followup(message)` → `user/message` event). The protocol's `session/prompt` produces the same event.
- Interrupts (`agent.cancel({kind: 'user'})`). The protocol's `session/interrupt` produces the same cancellation.
- Steering (`agent.steer(message)` → `user/message` event). The protocol's `session/steer` produces the same event.

The model picker (`packages/ui/tui/src/index.ts:332-333`) changes the selection via `installModelSelection(agent.ctx, selection)`, which does not produce a model-visible input directly — it changes the model route for the next request, and the route is recorded in the `request/context` event. A protocol-based `session/selectModel` would produce the same `request/context` event.

Every model-visible input path already goes through the agent loop, which produces session events. The protocol methods are thin wrappers over the same agent loop calls. Moving the terminal behind the protocol does not change which events are logged.

### Relationship to Typert RPC remotes

The web surface already reaches `commands.list`, `commands.execute`, and `goals.*` through Typert RPC (`ctx.remote.commands.list` etc. — see `packages/client/ui-commands/src/client/service.ts:134`). Steps 2–6 of this plan add equivalent methods to the JSON-RPC protocol. That is two RPC surfaces exposing the same capability, and the question is whether that duplication is legitimate or a mistake that a later change must undo.

The two transports are legitimately separate, not duplication to converge:

- **Typert RPC** is HTTP-based, session-keyed, and serves the browser web client. Its methods are typed through the Typert type-graph generator and carry the Gateway's authorization, connection lifecycle, and mux semantics. It is the web surface's transport.
- **JSON-RPC** is stdio-based, newline-delimited, and serves external SDK clients (Python SDK, Codex-style automation). It has no HTTP lifecycle, no Gateway, and a different consumer audience: automation and headless programs, not browsers.

They serve different consumers over different transports with different lifetimes. The same underlying service (`CommandRuntime.list`, `CommandRuntime.execute`) is exposed through two facades — the same pattern as `session/prompt`, which the JSON-RPC protocol already carries and the web surface also exposes through its own Typert session prompt endpoint. Convergence would mean generating one from the other, which would bind their evolution (a method the web surface needs immediately would gate on the JSON-RPC spec, or vice versa). Keeping them separate lets each surface evolve at its own pace.

The sizing in this plan does not change: adding the methods to JSON-RPC is still ~4 files per step, and the terminal's migration to JSON-RPC would still be a large PR. The recommendation is unchanged: the protocol is the architecture, and the two transports are two views of it.

### Migration plan

The work is 7 independently mergeable PRs. Each leaves the terminal working and the protocol backward-compatible. Every PR can be verified by keyless snapshot tests.

#### Step 1: Enrich `session/status` with footer fields

Add `goal`, `planMode`, `permissionPreset`, `tokens`, and `defaultModel` fields to `SessionStatusNotification`. The server reads these from the same services the TUI reads today.

- **Files touched:** 3 (`packages/sdk/protocol/src/types.ts`, `packages/sdk/server/src/server.ts`, `packages/sdk/server/tests/`)
- **Keyless snapshot:** Not needed (the change is additive data fields; snapshot tests verify rendered output, not protocol types).
- **Size:** Small. No behavioral change for existing clients.

#### Step 2: Add `model/list` and `session/selectModel`

`model/list` returns the live adapter catalog. `session/selectModel` validates and applies a route pick, persisting the default through the `agentDefaultModel` service.

- **Files touched:** 5 (protocol types, server, server tests, protocol client types, snapshot harness)
- **Keyless snapshot:** Yes (`session/selectModel` changes the session's model route; a snapshot verifies the `request/context` event carries the new route).
- **Size:** Medium. The model picker's rendering stays in the terminal; the protocol only serves the data and the action.

#### Step 3: Add `command/list` and `command/execute`

`command/list` returns the live command registry for the session's agent. `command/execute` dispatches a line through the command runtime.

- **Files touched:** 4 (protocol types, server, server tests, snapshot harness)
- **Keyless snapshot:** Yes (`command/execute` produces a `command/run` event; a snapshot verifies the output).
- **Size:** Medium. The `exit`/`quit` commands map to the existing `shutdown` method. The `help` command is a client-side rendering of the `command/list` result. The `model` command maps to the new `session/selectModel`.

#### Step 4: Add `skill/list`

`skill/list` returns the user-invocable skill catalog for the session's agent, scoped to its cwd and scope chain.

- **Files touched:** 4 (protocol types, server, server tests, snapshot harness)
- **Keyless snapshot:** Yes (a snapshot verifies the skill catalog matches the live composition).
- **Size:** Small. The server wraps the existing `skills.list()` call.

#### Step 5: Add `subagent/listChildren`

`subagent/listChildren` returns the running children of the session. The server maintains the running set from the existing `subagent.started`/`subagent.finished` notifications.

- **Files touched:** 4 (protocol types, server, server tests, snapshot harness)
- **Keyless snapshot:** Yes (a snapshot verifies the children list after a subagent starts and finishes).
- **Size:** Small. The server wraps the existing `subagents.listChildren()` call.

#### Step 6: Add `userQuestions/ask` server→client request

Mirror the `approval/request` pattern: the server sends a `userQuestions/ask` request, the client answers through its panel.

- **Files touched:** 4 (protocol types, server, server tests, snapshot harness)
- **Keyless snapshot:** Yes (a snapshot verifies the question/answer round-trip).
- **Size:** Small. The pattern already exists for `approval/request`.

#### Step 7: Refactor the TUI to use the protocol client

Replace the TUI's direct `ctx.get`/`ctx.inject` calls with a protocol client. The TUI plugin mounts the server in-process (no IPC — the process-split constraint from the order holds), and the terminal shell drives the protocol client instead of the Cordis context.

- **Files touched:** ~8 (`packages/ui/tui/src/index.ts`, `shell.ts`, `autocomplete.ts`, `approval.ts`, `questions.ts`, `model-picker.ts`, `status.ts`, plus tests)
- **Keyless snapshot:** Yes (the existing PTY boot tests in `packages/ui/tui/tests/pty-boot.spec.ts` verify the same rendered output).
- **Size:** Large. This is the only step that changes the TUI's internal architecture. Every other step is protocol-only.

**Total: 7 PRs, ~32 files, all keyless-snapshot-verifiable except Step 1.**

### Recommendation

**Do not refactor the TUI to use the protocol client (Step 7). Build the protocol (Steps 1–6) and stop there.**

The architecture the owner is asking for is the protocol, not the terminal's internal wiring. The protocol already exists and already carries the core operations (`session/prompt`, `session/steer`, `session/interrupt`, `session.event`, `session.status`, `approval/request`). Steps 1–6 close the remaining gaps: the protocol gains every method the terminal needs, and an external client can now do everything the TUI can. That is the architecture — one app-server protocol, one interface.

The TUI's direct service access is then an in-process fast path, not a missing protocol. It is the same pattern the parity note named: "how a capability is drawn does not depend on whether its data arrived through an injected service or a transport." The terminal does not need to route its own rendering through a transport to prove the transport exists. Codex itself runs the TUI and the app-server in the same process; the value is the shared interface, not the IPC.

The 6 protocol-only PRs are ~24 files, all small to medium, and can ship independently. The TUI refactor (Step 7) is ~8 files, large, and its only benefit is removing the `ctx.get` calls — at the cost of routing every footer read, every menu query, and every tool view through JSON serialization/deserialization inside the same process. That is a performance regression for a purity gain.

If the terminal is ever rewritten (e.g., a different UI framework, or a move to a separate process), the protocol is already there. Until then, the terminal's direct service access is a documented shortcut, not a missing protocol. The web surface already proves the pattern: it reaches `ctx.remote.commands.list`, `ctx.remote.commands.execute`, and `ctx.remote.goals.*` over Typert RPC — a transport. The terminal is the only surface with direct in-process access, and that is the fact that makes its internal wiring a scenic route rather than the architecture itself.

## Alternatives considered

**Full TUI migration (Step 7).** This is the plan the order asks to size. The cost is one large PR after six protocol-only PRs, for a total of 7 PRs and ~32 files. The benefit is architectural purity: the terminal and every external client share exactly one code path. The cost is real: every footer read, menu query, and tool view goes through JSON serialization in the same process, and the TUI's rendering path changes from direct service calls to async protocol round-trips. The purity gain does not justify the performance cost or the migration risk when the protocol already covers every operation.

**Skip the protocol work entirely.** The terminal works today, and the protocol already covers the core operations. The missing methods (`model/list`, `command/list`, `skill/list`, `subagent/listChildren`) are needed only by interactive clients — and the only interactive client today is the terminal, which already has direct access. This is the "架构維持現狀" answer the owner is unhappy with. The protocol-only steps (1–6) are the minimum that makes the architecture real without paying for a TUI migration.

**One big-bang PR.** Rejected because the protocol-only steps (1–6) are independently useful and independently verifiable. An external SDK client can use `model/list` and `session/selectModel` without waiting for `command/list`. A big-bang PR would be ~32 files, unreviewable, and leave no intermediate state where the terminal works.

## Acceptance criteria

1. `model/list`, `session/selectModel`, `command/list`, `command/execute`, `skill/list`, `subagent/listChildren`, and `userQuestions/ask` are added to the protocol.
2. `session/status` is enriched with `goal`, `planMode`, `permissionPreset`, `tokens`, and `defaultModel`.
3. Each method has a keyless snapshot test.
4. The TUI is not changed. The protocol is the architecture; the TUI's direct service access is a documented fast path.

## Risks

- **Protocol-only approach may be rejected as "still not a real client."** The owner may insist that the terminal must route through the protocol to prove the architecture works. This note's recommendation argues that the protocol is the architecture, and the terminal's in-process path is a valid shortcut. If the owner disagrees, Step 7 must be included.
- **`userQuestions/ask` breaks the `approval/request` pattern's simplicity.** Adding a second server→client request type for user questions may be seen as unnecessary when the terminal handles both through the same panel today. The alternative is to fold user questions into the `approval/request` method, but the two have different schemas and different semantics (approval is a binary allow/deny; user questions are multi-select with free-text answers).
- **Footer fields in `session/status` may grow unbounded.** The enriched status notification carries goal, plan mode, permission preset, tokens, and default model. If every new footer indicator adds a field, the notification becomes a grab-bag. The mitigation is that these five fields are the complete set the terminal reads today, and no further footer fields are planned.
- **The migration plan may be overtaken by other work.** The protocol-only steps (1–6) are small enough to ship in a week, but they compete with the remaining Tier C parity items and other feature work. The recommendation to skip Step 7 reduces the risk of the work being too large to ever start.