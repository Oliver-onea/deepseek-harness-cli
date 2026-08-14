# Agent Note: terminal parity with the web surface

Status: proposed

English | [中文](2026-08-14-terminal-web-parity.zh.md)

## Problem

`dsh` with no arguments opens the terminal, so the terminal is the surface a person meets first. Its interaction is far behind the web surface it shares an agent plane with, and the gap is not evenly distributed: some capabilities are absent, but a whole tier is already reachable and merely invisible.

Seven commands resolve in a shipped terminal session — `/compact`, `/exit`, `/feedback`, `/goal`, `/permission`, `/plan`, `/quit`. Nothing on screen reveals that any of them exist, what the current goal is, whether plan mode is on, or which permission preset applies. The web surface gives each of those a standing element.

Typing `/` or `@` does nothing. The web surface detects both under the caret and offers a grouped candidate menu ([`ui-input-trigger`](../../../../packages/client/ui-input-trigger/README.md)), which is how a reader discovers commands, skills, and file references without reading documentation. In the terminal, discovery has no entry point at all.

The terminal already depends on a framework that ships most of the missing mechanics. `dsh-tui` imports `Editor`, `ScrollView`, `Text`, `VStack`, `Markdown`, `TuiAltScreen`, `ProcessTerminal`, `matchesKey`, and `wrapTextWithAnsi` from `@earendil-works/pi-tui`. It imports none of `AutocompleteProvider`, `AutocompleteItem`, `AutocompleteSuggestions`, `SelectList`, `SettingsList`, `Loader`, or `Image`, though the package exports all of them and documents autocomplete over both file paths and slash commands.

## Proposal

Reproduce the web surface's capabilities in the terminal, taking the web plugin set as the parity inventory rather than inventing a separate terminal feature list. Each web capability names a browser plugin under `packages/client/`, and the terminal work is to give the same capability a terminal form — not to port React components, which have no terminal counterpart.

The work splits into three tiers by cost, and the tiers are independently shippable in the order below.

### Tier A — surface what already resolves

Give the commands that already work a visible state. The data each needs is already in the session; only the rendering is missing.

| Web plugin | Terminal gap |
|---|---|
| [`ui-goal`](../../../../packages/client/ui-goal/README.md) | `/goal` sets a goal that is never displayed. |
| [`ui-plan`](../../../../packages/client/ui-plan/README.md) | `/plan` toggles a mode with no indicator. |
| [`ui-permission-presets`](../../../../packages/client/ui-permission-presets/README.md) | `/permission` switches a preset the reader cannot see. |
| [`ui-message-feedback`](../../../../packages/client/ui-message-feedback/README.md) | `/feedback` is session-scoped; the web surface attaches feedback per message. |

### Tier B — the input trigger pipeline

Detect `/` and `@` under the caret and offer grouped candidates, matching [`ui-input-trigger`](../../../../packages/client/ui-input-trigger/README.md), [`ui-commands`](../../../../packages/client/ui-commands/README.md), and [`ui-skill`](../../../../packages/client/ui-skill/README.md). Build it on pi-tui's `AutocompleteProvider` rather than a hand-rolled menu: candidate sourcing, suggestion state, and keyboard arbitration are the parts that make this expensive, and the framework already owns them.

This tier is the terminal's whole discovery story. Nothing else on the surface names a command, so until it lands a reader learns the command set from this repository or not at all.

### Tier C — new terminal screens

Each item here needs a surface the terminal does not have, and each is a separate change: [`ui-trajectory`](../../../../packages/client/ui-trajectory/README.md) (a turn-aware event ledger), [`ui-sidebar`](../../../../packages/client/ui-sidebar/README.md) (session list and new-session action), [`ui-model-selection`](../../../../packages/client/ui-model-selection/README.md), [`ui-workspace`](../../../../packages/client/ui-workspace/README.md), [`ui-jobs`](../../../../packages/client/ui-jobs/README.md), [`ui-subagent`](../../../../packages/client/ui-subagent/README.md), [`ui-deliverables`](../../../../packages/client/ui-deliverables/README.md), [`ui-attachment`](../../../../packages/client/ui-attachment/README.md), and the `ui-settings` family.

Two of these close limitations [`dsh-tui`](../../../../packages/ui/tui/README.md) already records as deferred: the absent session switcher and the absent terminal model picker. Inline images are the third, and pi-tui's `Image` component is the mechanism.

### What parity does not mean

Terminal parity is capability parity, not layout parity. The web surface composes named slots (`conversation.input.dock`, `sidebar.workspaces`, `conversation.session.header.actions`); the terminal has one viewport, one composer, and a footer. A capability whose web form is a persistent card may take a footer field, a transient notice, or an overlay in the terminal, decided per capability against the reading it has to support.

## Alternatives considered

**Re-point the terminal at the JSON-RPC protocol first.** The terminal reads `ctx.agents`, `ctx.tools`, and `ctx.timer` directly, while [`dsh-sdk-jsonrpc-server`](../../../../packages/sdk/server/README.md) already serves the same agent plane to out-of-process clients. Making the terminal a protocol client is a real architectural improvement, and the protocol would need interactive methods it currently lacks — it carries `initialize`, `session/prompt`, and `shutdown` with `session.event` and `session.status` notifications, and no approval request, cancel, or steer method. That work is orthogonal to this one: how a capability is drawn does not depend on whether its data arrived through an injected service or a transport, so ordering parity first keeps the architectural option open without paying for it now.

**Point terminal users at the web surface.** This is the current de facto answer and it is why the terminal fell behind. It fails the case the terminal exists for: a person already in a shell, over SSH, or without a browser.

**Hand-roll the candidate menu.** Rejected on the same grounds as [the dependencies-over-hand-rolling policy](../../implemented/process/2026-07-26-dependencies-over-hand-rolling.md): pi-tui's autocomplete deletes owned code and tests, and a second suggestion implementation would drift from the editor's own key handling.

## Acceptance criteria

Tier A is done when a terminal session shows the current goal, plan mode, and permission preset without the reader running a command, and each indicator disappears when its state is absent.

Tier B is done when typing `/` lists the commands the live registry resolves for that agent and typing `@` offers workspace file candidates, both dismissible, both selectable by keyboard, and neither reaching the model as literal text when a candidate is picked.

Each tier ships with a keyless snapshot through a real runnable example, per [the testing policy](../../../../docs/testing.md), because every item changes product-user-visible output. Tier B additionally proves that a candidate list is derived from live registries, so a command or skill registered after mount appears without a restart.

Every terminal string continues to pass through `displayText()`, so untrusted model or tool text cannot repaint the screen through a new path.

## Risks

The terminal has one viewport, and every indicator this adds competes with the transcript for rows. A small terminal is the constraint that keeps the design honest: the stress-tested 20x5 case must stay usable, which means each addition needs a degradation rule rather than an assumed minimum width.

Taking the web plugin set as the inventory imports the web surface's own judgments about what deserves a permanent element. Some of those will be wrong in a terminal, where attention is scarcer and there is no peripheral vision; a capability whose web form is a standing card may deserve to be command-only here, and that call belongs to the change that implements it.

Tier C is large enough that finishing Tiers A and B and stopping is a legitimate outcome. Recording the remainder as deferred work in the `dsh-tui` README is preferable to a half-built session switcher.
