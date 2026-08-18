# Agent Note: the launch-time resume picker

Status: implemented

English | [中文](2026-08-18-tui-launch-resume-picker.zh.md)

## Problem

`dsh --resume <session>` carried continuity across processes, but discovering the id to pass was manual: a reader had to already know it, and the repository's own tests recovered ids by reading them off disk. The in-terminal session switcher that would also solve this was rejected — it costs the web surface's per-session preset migration redone on the terminal side — and that rejection named a launch-time picker as the recommended follow-up ([rejection](../../rejected/feature/2026-08-16-in-terminal-session-switcher.md)).

## Decision

A bare `dsh --resume` opens a keyboard list of the persistence store's top-level sessions and resumes the picked one; `--resume <session>` is unchanged. [`dsh-tui`](../../../../packages/ui/tui/README.md) owns the list (`resume-picker.ts`): the roster comes from `resumeCandidates(headers)` — subagent children dropped, newest first, id breaking ties — and every row passes `displayLine()`, because persisted metadata is untrusted text. The picker draws on the ordinary terminal ahead of the alternate-screen front door and owns stdin only while its list is up, so a startup failure still reports to a plain terminal. `esc` and `ctrl+c` both exit without resuming or creating anything: at launch there is no queued work to lose, and an abandoned picker must not substitute a fresh session for the resume the invocation asked for.

[`tui-startup`](../../../../packages/bundle/tui-app/README.md) resolves the picked id through the same persistence inspection a named resume takes. Every way the picker cannot produce a target refuses startup before dependent rows activate — no TTY on either stream (the refusal names the explicit form), an unlistable store, nothing to offer, a terminal too small for one candidate row, or a dismissed list — so nothing is resumed and no session is created by surprise.

### Aborting a pending picker on teardown

The abort cannot ride a `ctx.effect()` disposer: vendored Cordis runs a fiber's effect cleanup only after its startup callback settles, so a disposer registered from inside a pending `apply` never fires, and a picker that waits on it deadlocks tree teardown with raw-mode stdin still holding the process open. The plugin instead observes its own disposal on `internal/plugin` (`fiber === ctx.fiber && fiber.uid === null`, emitted at dispose start before the unload joins the in-flight callback) and aborts the picker from there, stopping the listener once the picker settles. This is the same mechanism [`lsp-stdio`](../../../../packages/lsp/lsp-stdio/src/index.ts) uses to cancel setup.

## Alternatives considered

**An in-terminal session switcher.** Rejected separately and unchanged: single-session is the tui-app bundle's composition contract, and a switcher costs the per-session preset migration the web surface paid ([rejection](../../rejected/feature/2026-08-16-in-terminal-session-switcher.md)).

**Abort via an effect disposer.** Cannot fire during in-flight startup in vendored Cordis; empirically, root `fiber.dispose()` never settles while a child plugin's callback awaits a gate that only its own disposer opens. The `internal/plugin` self-observation reaches the same teardown with no window where raw stdin outlives the tree.

**Refuse a bare `--resume` outright.** Keeps flag handling minimal but leaves the discovery pain the switcher rejection named as the one genuine cost of the single-session arrangement.

## Consequences

The terminal gains session discovery at launch without touching the single-agent composition: the picker is a `dsh-tui` export consumed by `tui-startup`, which keeps the TTY gate, the roster read, and the refusal-before-composition ordering in the bundle where the command line lives. The picker has no filter or search (rows scroll; numbers reach the first nine), recorded in `dsh-tui`'s README limitations. The in-terminal switcher remains rejected and the [terminal-web parity plan](2026-08-14-terminal-web-parity.md)'s Tier C session list stays deferred: launch-time picking covers resumption discovery, not switching inside a live process.

## Testing

- `packages/ui/tui/tests/resume-picker.spec.ts` covers roster derivation, row layout and sanitization, every key path, redraw/erase behavior, the too-small refusal, abort settling, and identical layout with `color` off.
- `packages/bundle/tui-app/tests/startup.spec.ts` drives the real cmdline host: the picked id resumes exactly as a named one (same persistence inspection), every refusal message, the non-TTY refusal, and the disposal abort restoring line mode. Tests await observable picker state (first draw, raw mode on) rather than assuming synchronous plugin startup — the repo-wide test invariant host defers every root plugin behind its readiness chain, so a synchronous assertion reads a picker that has not drawn yet.
- PTY journey cases in `apps/cli/tests/tui-interaction.spec.ts` cover the two-boot pick over one harness home and the esc dismissal refusal; `node-pty` does not spawn in the authoring sandbox, so those two cases are authored with the shared harness and executed outside it.
