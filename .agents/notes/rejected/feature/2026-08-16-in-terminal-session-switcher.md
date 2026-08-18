# Agent Note: an in-terminal session switcher

Status: rejected — single-session is the tui-app bundle's composition contract, so a switcher costs the web surface's per-session preset migration redone in the terminal, while `--resume` already provides cross-process continuity.

English | [中文](2026-08-16-in-terminal-session-switcher.zh.md)

## Problem

`dsh-tui` drives the single session named by its `session` config, and [its README](../../../../packages/ui/tui/README.md) records the consequence under Known Limitations: there is no in-terminal session switcher, and a second mount would contend for the same screen. Running two conversations means two processes, each with its own screen.

The web surface has no such limit. [`ui-sidebar`](../../../../packages/client/ui-sidebar/README.md) lists sessions and offers a New Session action, so the terminal reads as the poorer surface. The [terminal-web parity plan](../../implemented/feature/2026-08-14-terminal-web-parity.md) lists a session switcher among the Tier C items precisely because it closes a documented gap.

## Proposal

Give the terminal an in-process session switcher: a roster of live and persisted sessions, a key or command to open it, and the ability to move between conversations without leaving the process — the terminal form of the web sidebar.

## Alternatives considered

**One process per conversation, which is the shipped behavior.** A second terminal tab costs the reader a tab and nothing else. `dsh --resume <session>` already carries continuity across processes: the startup provider resumes a persisted session, and the transcript, the model route recorded in the log, and torn-turn recovery all survive. This is the alternative the rejection rests on.

**A startup-time resume picker.** The one genuine pain in the current arrangement is not switching but *discovering* a session id — a reader must already know the id to pass `--resume`, and the repository's own tests recover ids by reading them off disk. A picker at launch removes that pain at a small fraction of a switcher's cost, and leaves the single-agent composition untouched. This is the recommended follow-up and is not rejected here; it shipped as the [launch-time resume picker](../../implemented/feature/2026-08-18-tui-launch-resume-picker.md).

## Why this is rejected

Single-session is not an oversight in the UI layer. It is the composition contract of the bundle, stated in three places:

- [`dsh-tui-app`](../../../../packages/bundle/tui-app/cordis.patch.yml) composes exactly one agent — `agents: !!js "[ctx.tuiStartup.agent]"`, above a comment saying the bundle composes exactly one agent at startup and the startup provider owns whether it is fresh or resumed.
- [`dsh-base`](../../../../packages/bundle/base/cordis.patch.yml) deliberately leaves `agent-loop` with `agents: []`, commented "The base stays empty; raw overlays may create agents, while Web creates sessions on client request." The create-on-request path already exists; only the web surface takes it.
- [`dsh-web-app`](../../../../packages/bundle/web-app/cordis.patch.yml) states the trade directly where it moves the agent plane behind presets: "The base keeps them for the TUI, which is single-session and composes its agent process-wide; the Web surface disables them here and lets each session mount a preset instead."

The web surface bought per-session agents by disabling every host row that composes what one agent contributes — its tools, its prompt sections, its delegation backends — and remounting them per session through a preset. A terminal switcher therefore does not cost a panel. It costs that same migration, redone on the terminal side, converting process-wide tool, prompt, and delegation scope into per-session scope.

That is a composition rewrite whose benefit over a second terminal tab is small, and it would undo the property that [`dsh-tui-app`](../../../../packages/bundle/tui-app/README.md) names as its own design: that it is the inverse of the web bundle, keeping the base's rows as its single agent's own.

## Consequences of rejecting

The terminal stays one conversation per process, and the Known Limitation stays in the `dsh-tui` README as current fact rather than pending work.

Two cheaper items outrank a switcher for the next parity work, both recorded in that same README:

- **Effort selection.** `/model` applies the picked model's default reasoning effort and offers no effort menu, while the web composer offers Model and Effort as two levels. The panel, the model-selection ref, and the `reasoningEffort` field are all already in place, so this closes a parity gap with a small change.
- **A startup resume picker**, as described above — now [implemented](../../implemented/feature/2026-08-18-tui-launch-resume-picker.md).

## Reintroduction condition

Reconsider if the terminal composition moves to per-session presets for an unrelated reason — at that point the expensive half is already paid and a switcher becomes a panel over an existing capability.
