# Agent Note: terminal parity with the web surface

Status: implemented

English | [中文](2026-08-14-terminal-web-parity.zh.md)

## Problem

`dsh` with no arguments opens the terminal, so the terminal is the surface a person meets first. Its interaction is far behind the web surface it shares an agent plane with, and the gap is not evenly distributed: some capabilities are absent, but a whole tier is already reachable and merely invisible.

Seven commands resolve in a shipped terminal session — `/compact`, `/exit`, `/feedback`, `/goal`, `/permission`, `/plan`, `/quit`. Nothing on screen reveals that any of them exist, what the current goal is, whether plan mode is on, or which permission preset applies. The web surface gives each of those a standing element.

Typing `/` or `@` does nothing. The web surface detects both under the caret and offers a grouped candidate menu ([`ui-input-trigger`](../../../../packages/client/ui-input-trigger/README.md)), which is how a reader discovers commands, skills, and file references without reading documentation. In the terminal, discovery has no entry point at all.

The terminal already depends on a framework that ships most of the missing mechanics. `dsh-tui` imports `Editor`, `ScrollView`, `Text`, `VStack`, `Markdown`, `TuiAltScreen`, `ProcessTerminal`, `matchesKey`, and `wrapTextWithAnsi` from `@earendil-works/pi-tui`. The `Editor` carries a complete autocomplete — provider-driven suggestions, debounced queries, keyboard arbitration, and an in-editor candidate list styled through the theme the shell already passes — so the input triggers need no second menu implementation; `SelectList`, `SettingsList`, `Loader`, and `Image` remain unimported and belong to Tier C surfaces.

## Decision

DeepSeek Harness ships terminal parity with the web surface in three independently shippable tiers. **Tier A and Tier B are implemented**; **Tier C is deferred** and recorded below.

### Tier A — surface what already resolves

The terminal footer reads standing session state from the services that already own it:

- [`@deepseek-ai/dsh-goal`](../../../../packages/goal/goal/README.md) supplies the current goal; completed goals are hidden, matching the web `GoalBar` behavior.
- [`@deepseek-ai/dsh-plan-mode`](../../../../packages/plan/plan-mode/README.md) supplies plan-mode state; the footer shows `plan` when the effective target is active and `plan*` while a pending `/plan` selection waits for the next accepted pre-step.
- [`@deepseek-ai/dsh-permission-presets`](../../../../packages/interaction/permission-presets/README.md) supplies the effective preset name, including the derived `custom` state.

[`dsh-tui`](../../../../packages/ui/tui/README.md) resolves each service through `ctx.get()` and passes a reader closure to `TerminalShell`. The readers are optional, so a composition without goal, plan-mode, or permission-presets simply omits the matching indicator. The footer continues to route every displayed string through `displayText()`, so untrusted model or tool text cannot repaint the screen through the new path.

### Tier B — the input trigger pipeline

The editor offers the two trigger menus on pi-tui's autocomplete (`CombinedAutocompleteProvider` under a thin wrapper, [`autocomplete.ts`](../../../../packages/ui/tui/src/autocomplete.ts)):

- `/` at the start of the input lists the commands the **live** [`ctx.commands`](../../../../packages/interaction/commands/README.md) registry resolves for the driven agent. The wrapper reads `commands.list(agent)` on every query, so a command registered after the screen is up appears on the next keystroke and a shadowed one disappears, without a restart.
- `@` at a word boundary lists workspace files under the working directory through the `fd`/`fdfind` binary (configurable as `fileFinderPath`; no finder means no `@` candidates).
- Candidate labels and descriptions pass through `displayLine()` before the editor draws them; the completion value stays literal so the pick inserts exactly what was found.
- `/help` is a real command, registered beside `exit`/`quit`, whose text lists the live registry — the footer's `/help` hint names a command that resolves, and running it opens no model turn.
- A picked `/` candidate completes to the command line and submits through the registry, so it never reaches the model; a picked `@` candidate inserts the file's path as plain reference text that rides the prompt — the web surface's plain-text pick arm. The terminal has no reference or attachment pipeline (no U+FFFC placeholder, no per-source codec); that machinery belongs to a future attachment capability, and silently downgrading a pick to nothing would be worse than honest path text.

Degradation: the menus clamp to the rows the footer, the editor, and one transcript row leave free (`menuRowsFor`), and a terminal with no room for a candidate row — the stress-tested 20x5 — shows no menu at all. `maxSuggestions` bounds the rows before that clamp; the palette renders both menus, so `color: false` draws the same layout unstyled.

### What parity does not mean

Terminal parity is capability parity, not layout parity. The web surface composes named slots (`conversation.input.dock`, `sidebar.workspaces`, `conversation.session.header.actions`); the terminal has one viewport, one composer, and a footer. A capability whose web form is a persistent card may take a footer field, a transient notice, or an overlay in the terminal, decided per capability against the reading it has to support.

## Alternatives considered

**Re-point the terminal at the JSON-RPC protocol first.** The terminal reads `ctx.agents`, `ctx.tools`, and `ctx.timer` directly, while [`dsh-sdk-jsonrpc-server`](../../../../packages/sdk/server/README.md) already serves the same agent plane to out-of-process clients. Making the terminal a protocol client is a real architectural improvement, and the protocol would need interactive methods it currently lacks — it carries `initialize`, `session/prompt`, and `shutdown` with `session.event` and `session.status` notifications, and no approval request, cancel, or steer method. That work is orthogonal to this one: how a capability is drawn does not depend on whether its data arrived through an injected service or a transport, so ordering parity first keeps the architectural option open without paying for it now.

**Point terminal users at the web surface.** This is the current de facto answer and it is why the terminal fell behind. It fails the case the terminal exists for: a person already in a shell, over SSH, or without a browser.

**Hand-roll the candidate menu.** Rejected on the same grounds as [the dependencies-over-hand-rolling policy](../../implemented/process/2026-07-26-dependencies-over-hand-rolling.md): pi-tui's autocomplete deletes owned code and tests, and a second suggestion implementation would drift from the editor's own key handling.

## Consequences

The `dsh-tui` package gained optional peer dependencies on `@deepseek-ai/dsh-goal`, `@deepseek-ai/dsh-plan-mode`, and `@deepseek-ai/dsh-permission-presets` so the footer can read authoritative state without re-folding session events. A terminal session now shows the current goal, plan mode, and permission preset when those services are composed, and each indicator disappears when its state is absent. The existing footer fields (run state, route, context occupancy, todo plan, queued depth, controls) keep their previous positions after the new indicators.

The terminal has one viewport, and every indicator competes with the transcript for rows. Tier A mitigates this by omitting completed goals, truncating long objectives, and hiding each indicator when its state is absent; Tier B's menus clamp to the rows the footer, the editor, and one transcript row leave free, and yield entirely on a terminal too small for one candidate row; Tier C will need its own degradation rules for the stress-tested 20x5 case.

The `/` menu lists commands grouped only by the registry's name order, without the web surface's source-grouped headings; a skill source would register its own candidates, but no terminal composition mounts one yet.

## Verification

- `packages/ui/tui/tests/status.spec.ts` covers formatting for goal, plan mode, and permission preset, including omission when absent.
- `packages/ui/tui/tests/shell.spec.ts` covers footer updates from the new readers, hides indicators when readers are absent, and drives the input-trigger menus end to end: live-roster offering and narrowing, escape dismissal, keyboard selection and tab completion, the `@` file pick, slash-pick submission through the registry, small-terminal clamping and suppression, and identical menu layout with `color` off.
- `packages/ui/tui/tests/tui.spec.ts` mounts the plugin with real `dsh-goal` and `dsh-plan-mode` services plus a permission-preset reader and asserts the footer reflects live service state; it also proves `/help` answers from the live registry with no `user/message` or `turn/start` event, lists a command registered after mounting, and that disposing the plugin fiber removes every terminal-owned command.
- `packages/ui/tui/tests/autocomplete.spec.ts` covers candidate derivation and normalization, the row budget, live-roster reads, delegate completion semantics, `@` search through the real file finder, and `resolveFileFinder` resolution and refusals; `command-help.spec.ts` covers the `/help` listing text.
- `packages/ui/tui/tests/pty-boot.spec.ts` boots the shipped profile under a real PTY: the slash menu draws from the live composition, `/help` prints the listing while the mock model serves zero requests and the footer stays at `0 tokens`, `@` offers workspace files through the real finder, and a 20x5 terminal shows no menu while the input stays usable.

## Deferred

**Tier C — new terminal screens.** Each item needs a surface the terminal does not have: [`ui-trajectory`](../../../../packages/client/ui-trajectory/README.md), [`ui-sidebar`](../../../../packages/client/ui-sidebar/README.md), [`ui-model-selection`](../../../../packages/client/ui-model-selection/README.md), [`ui-workspace`](../../../../packages/client/ui-workspace/README.md), [`ui-jobs`](../../../../packages/client/ui-jobs/README.md), [`ui-subagent`](../../../../packages/client/ui-subagent/README.md), [`ui-deliverables`](../../../../packages/client/ui-deliverables/README.md), [`ui-attachment`](../../../../packages/client/ui-attachment/README.md), and the `ui-settings` family. Two of these close limitations `dsh-tui` already records as deferred: the absent session switcher and the absent terminal model picker. Inline images are the third, and pi-tui's `Image` component is the mechanism. A fourth opens here once the terminal gains a reference or attachment pipeline: model-serialized file references and a skill trigger to match the web surface.
