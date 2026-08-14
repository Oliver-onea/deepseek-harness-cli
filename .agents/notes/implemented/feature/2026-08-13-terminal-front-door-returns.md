# Agent Note: The terminal front door returns as the default dsh surface

Status: implemented

English | [中文](2026-08-13-terminal-front-door-returns.zh.md)

## Problem

The repository is `deepseek-harness-cli`, but `dsh` had no interactive command line. The [explicit-config entrypoint decision](../../archived/simplification/2026-08-03-explicit-config-dsh-entrypoint.md) removed the implicit terminal application, and [the package-wide removal](../simplification/2026-08-04-remove-tui-package.md) then deleted `@deepseek-ai/dsh-tui` itself, leaving Web as the only interactive surface and the one-shot headless app as the only command line. A bare `dsh` was a usage error.

That removal named its own conditions for coming back: a concrete product need, a named entry mode rather than an implicit raw default, an explicit package boundary, a concrete interaction provider, and assembled lifecycle acceptance for the frontend. The product need is now the repository's own identity — a CLI product needs an interactive terminal, not only a task-in/text-out mode.

## Decision

DeepSeek Harness ships a terminal front door again, as **two packages with one job each**, and `dsh` boots it when an invocation names no profile.

[`@deepseek-ai/dsh-tui`](../../../../packages/ui/tui/README.md) is the reusable Cordis plugin: it renders one live agent and owns terminal input, nothing else. It is the only member of a new `ui/` group, which exists so a terminal surface is not filed under the browser halves in `client/`/`host/`. [`@deepseek-ai/dsh-tui-app`](../../../../packages/bundle/tui-app/README.md) is the shipped composition: a patch layer over `dsh-base` plus the command-line provider that resolves the session, the route, and the optional first task.

Composition rather than a launcher default: `PROFILE_TEMPLATES` gains a `tui` entry (`dsh-base` + `dsh-tui-app`), and `apps/cli` treats an absent `--profile` as `tui`. `dsh`, `dsh "run the tests"`, and `dsh --resume <session>` all reach the terminal app's own flags; `dsh -h` with no profile still prints the launcher's help, because there is no app yet to hand `-h` to.

The agent plane stays where `dsh-base` put it. This surface is single-session and composes one agent process-wide, so the bundle mounts no preset roster — the inverse of `dsh-web-app`, which disables those rows and lets each session mount a preset instead.

### What the front door owns, and what it does not

It owns presentation and terminal input. The transcript is folded from the **append-origin session log**, not the model-visible surface, so a resumed session keeps every message the reader saw and a compacted range stays readable behind its marker. Tool cards are drawn from each tool's own `presentCall`/`presentResult`, so a tool changes how it reads in the terminal by changing its presenter.

It also owns three pieces of agent-scoped state, each because no other row in a single-session composition can: the `userQuestions` provider, an `approval/request` answerer scoped to its own agent (every other agent's question delegates to the rest of the chain), and the model-selection ref that fills the persona's `{{provider}}`/`{{model}}` variables and routes each request. `agent-loop` does not install that ref for configured agents — the entry point does, as `dsh-headless` and the Web host already did.

It requires both stdin and stdout to be TTYs and throws a typed startup refusal at mount rather than degrading. The startup provider inspects a requested resume through session persistence before publishing its service, and the renderer waits for the named agent only up to its validated `agentWaitTimeoutMs`; both checks finish before alternate-screen entry, so a missing or unreadable session and a broken agent composition report to the ordinary terminal.

### Terminal ownership

`displayText()` normalizes every string before it reaches pi-tui or the pane title: carriage returns collapse, tabs expand, and every other C0, DEL, and C1 control becomes a visible `\xNN` escape. Escaping rather than stripping keeps the text honest about what it contained, and is what stops untrusted tool output or model text from repainting the screen or setting the pane title. Only this package and pi-tui create ANSI sequences.

The palette is standard 16-color ANSI foregrounds and SGR attributes with body text and backgrounds left at terminal defaults, so host terminals remap the interface for light and dark themes without a TUI-specific theme setting.

### The rendering dependency

`@earendil-works/pi-tui` supplies the differential renderer, the alternate-screen viewport, the editor with autocomplete and paste handling, the Markdown renderer, and key parsing. It is the same family as the already-vendored `@earendil-works/pi-ai` and is MIT-licensed. Hand-rolling a full-screen renderer would be a product-sized frontend of owned code and tests, which is what [the dependencies-over-hand-rolling policy](../process/2026-07-26-dependencies-over-hand-rolling.md) exists to avoid. This version needs no patch, unlike the artifact the deleted package carried.

## Verification

Package suites hold per-file 100% coverage over the fold, the card renderer, the footer, the question panel, the approval answerer, and the plugin, driving the real plugin against a substituted `Terminal` and a real `SessionStore` so appends publish `session/event` exactly as in production.

PTY coverage is sanctioned because the subject IS terminal takeover, which pipes cannot prove ([the testing policy that reserves PTY for this case](../../archived/simplification/2026-07-20-retire-readline-front-door.md)): `packages/ui/tui/tests/pty-boot.spec.ts` boots the shipped `tui` profile through the `dsh` launcher against the keyless mock model, submits a prompt, waits for the answer on screen, and leaves through `/exit` with exit code 0. The same real composition proves that redirected stdin or stdout receives one refusal line, and that missing or corrupt resume logs fail before the alternate screen is entered.

## Alternatives considered

**Restore the deleted package from history.** Not possible and not desirable: the deletion predates the available history, and the removal note is explicit that a future terminal frontend should start from its actual host and interaction requirements rather than inherit an implementation.

**Keep `dsh` a usage error and add a `tui` subcommand.** Rejected because the repository's product IS the command line; a bare `dsh` that refuses to run is a worse default than the one interactive surface it ships.

**Put the screen in the bundle.** Rejected because the patch layer and the renderer have different reasons to change, and a reusable front door is what lets a deployment compose the terminal over its own agent plane.

**Render the transcript from the model-visible surface.** Rejected: compaction replaces ranges there, so a reader would watch their own conversation disappear.

## Consequences

`dsh` with no arguments opens a terminal conversation, and `dsh "<task>"` starts one on that task. Web remains the shipped browser surface and headless remains the one-shot automation entry; nothing about either changed.

Deployments composing `dsh-tui` must supply a TTY and a `ctx.appExit`, must name the session id of an agent their own composition creates, and may set `agentWaitTimeoutMs` when their startup latency differs from the 30-second default. A composition without `ctx.commands` still works — the editor sends every line to the model, and `/exit` is unavailable, leaving `ctrl+c` as the way out.

A terminal model picker now has a place to write: the model-selection ref is installed and owned by this front door, but no command exposes it yet.
