# Agent Note: Bound CLI startup refusals and preserve app-owned option terminators

Status: proposed

English | [中文](2026-08-14-bounded-cli-startup-refusals-and-option-terminators.zh.md)

## Problem

The shipped terminal profile accepts `--resume <session>` before it knows whether persistence can read that session. Its screen then waits without a deadline for `agent/created`. A missing session or corrupt durable log prevents agent creation, so those two independent lifecycle gaps compose into a silent process that never enters the alternate screen, prints no diagnostic, and never exits.

Startup failures caused by an invocation or deployment configuration also reach the CLI as ordinary rejected `Error` values. Loader and boot add entry, stage, and cause context, and Node consequently prints a complete uncaught stack for deliberate refusals such as a non-TTY terminal, an unknown profile, or a missing overlay path. Flattening every failure would hide internal crashes, while matching message text would couple the launcher to plugin wording.

The launcher owns only its flag prefix and hands the remaining arguments to the selected app. Commander consumes a `--` that appears at the launcher boundary, however, so the app sees a following `--help` as its own option instead of literal task text. A terminator appearing after the app boundary already reaches the app, leaving the same syntax with different behavior depending on where the boundary was established.

## Proposal

`@deepseek-ai/dsh-app-boot/errors` defines `StartupRefusalError` as the cross-package marker for a startup failure that a user can correct. `classifyStartupFailure(error)` follows standard `Error.cause` links because Loader and boot wrappers add context. The `dsh` process edge prints a marked message as exactly one stderr line and sets exit status 1. It rethrows the original unmarked value unchanged, preserving its stack and Node's crash diagnostics.

Known durable and invocation failures use the marker at the layer that owns the relevant knowledge. Profile lookup marks an unknown profile; patch readers mark unreadable or invalid requested overlays; the TUI marks its intentional TTY refusal. The launcher does not inspect message strings and does not classify arbitrary plugin exceptions as expected.

The `tui-startup` provider injects session persistence and calls its non-mutating `inspect(SessionId)` operation before publishing startup values for a resumed session. Persistence therefore owns existence, decompression, and durable-format validation. A failure names the requested id, includes the persistence diagnostic, and tells the user to check the id or log or omit `--resume`. Dependent agent and screen rows cannot activate before that validation succeeds.

The TUI's second defense is independent of resume validation. Its wait for the configured agent is bounded by a positive-integer `agentWaitTimeoutMs` config field with a 30-second default. Expiry throws a typed startup refusal before alternate-screen entry, naming the session and the setting. Tree disposal still settles the wait without reporting a refusal. Unexpected renderer failures retain the existing logger and `ctx.appExit(1)` path.

Option termination follows one-parser ownership. A `--` at the launcher boundary is restored as the first inner argument; a `--` after the app boundary remains in the verbatim suffix. In both cases the selected app parser consumes the terminator and treats following flag-shaped tokens as positional text. The first unrecognized token still establishes the app boundary, so `dsh --profile web -h` continues to select Web help.

## Verification

Package tests cover persistence inspection before service publication, missing and unreadable resume targets, the bounded agent wait, refusal classification through wrapper causes, unmarked crash preservation, circular causes, and both option-terminator positions. Real Loader composition and PTY tests cover redirected stdin and stdout, missing and corrupt resume logs before alternate-screen entry, and exact one-line stderr behavior. A keyless snapshot pins the shipped non-TTY refusal, while the built CLI suite pins unknown-profile and missing-overlay reporting and submits literal `--help` to the mock model through the headless app.

## Alternatives considered

**Validate resume by checking the JSONL path in the startup provider.** Rejected because file layout and readability belong to the configured persistence provider; a direct filesystem check would cross the package boundary and would not cover alternate persistence implementations or durable decoding.

**Only add resume validation.** Rejected because any future composition failure that prevents agent creation would retain the unbounded TUI wait.

**Only add an agent timeout.** Rejected because it would delay a directly resolvable persistence error and replace a precise corrupt-or-missing-session diagnostic with a vague missing-agent refusal.

**Use a fixed timeout constant.** Rejected because acceptable startup latency varies by deployment. The default is part of validated plugin config and can be changed from `cordis.yml`.

**Print only `error.message` for every startup rejection.** Rejected because an internal bug must retain its stack. The typed marker is an explicit promise by the throwing owner that the failure is an expected refusal.

**Match known message prefixes in the launcher.** Rejected because plugin wording is presentation, not a stable classification mechanism, and new plugins would require launcher edits.

**Let the launcher consume `--`.** Rejected because the terminator then protects no app argument. Requiring `-- --` would expose parser layering to users and make equivalent app argument suffixes depend on the launcher's boundary position.

## Acceptance criteria

- Missing and corrupt resume targets fail nonzero with a session-specific remedy before any alternate-screen control sequence.
- A configured agent that never appears fails within `agentWaitTimeoutMs`; the field is validated and documented.
- Expected TTY, profile, and overlay refusals produce exactly one stderr line and no stack, internal path, or Node banner.
- An unmarked internal startup error is rethrown unchanged and retains its stack.
- `--` before or after the app boundary reaches the app parser, while `dsh --profile web -h` remains Web help.
- `dsh --profile headless -- --help` submits the literal `--help` task.

## Risks

A deployment whose agent creation legitimately exceeds the default can receive a refusal; the validated config field makes that choice explicit. Persistence inspection adds one startup read for resumed sessions, so the persistence implementation should reuse its inspection result where it already caches reads. A plugin that incorrectly marks an internal exception can suppress its stack, which is why the marker is limited to direct user-correctable conditions and classification tests preserve unmarked values by identity.

This proposal extends the [terminal front-door decision](../../implemented/feature/2026-08-13-terminal-front-door-returns.md) and the [app-owned command-line decision](../../implemented/architecture/2026-08-06-app-owned-command-line.md); both remain authoritative for their broader surfaces. It applies the existing [fail-loud terminal release](../../implemented/bug-fix/2026-07-31-fail-loud-releases-the-terminal.md) and [cause-chain diagnostics](../../implemented/bug-fix/2026-07-20-error-cause-chain-diagnostics.md) mechanisms without superseding them. No active note is archived or deleted.
