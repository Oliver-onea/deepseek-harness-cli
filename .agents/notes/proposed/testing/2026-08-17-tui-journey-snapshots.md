# Agent Note: keyless journey snapshots for shipped terminal interactions

Status: proposed

English | [中文](2026-08-17-tui-journey-snapshots.zh.md)

## Problem

The shipped `dsh --profile tui` gained three product-user-visible interaction features — the `/` command menu, the `@` subagent-mention menu, and the `/model` picker — each backed by package-local unit tests. `docs/testing.md` asks for assembled journey snapshots that pin what a person actually sees, but those snapshots were out of scope for each individual feature PR. The gap is now the missing assembled coverage in `apps/cli/tests/`.

## Proposal

Add keyless, deterministic journey snapshots under `apps/cli/tests/tui-interaction.spec.ts` using the existing PTY harness in `apps/cli/tests/tui-interaction.harness.ts`. The cases boot the real terminal profile against the keyless mock model, replay the exact keystrokes a user would type, and compare the rendered screen.

### Scenarios

1. **Slash menu (`/`)** — type `/he`, wait for the live command registry to filter, press `enter`, and snapshot the dispatched `/help` command line.
2. **`/help` text** — submit `/help` and snapshot the live registry rendered as plain text, including command names, hints, and descriptions.
3. **Subagent mention (`@`)** — stage one deterministic running subagent child without a model turn, type `@`, pick the child, and snapshot the reference in the composer.
4. **Skill source in slash menu (`/`)** — stage one deterministic user-invocable skill without a model turn, type `/jou`, wait for the skill to appear after the command roster, press `enter`, and snapshot the resulting user prompt and mock answer in the transcript.
5. **`@` empty roster** — without the child-staging patch, type `@` and snapshot that the menu never opens and the `@` stays in the composer.
6. **Model picker (`/model`)** — open the picker, dismiss with `esc`, reopen, move down to `deepseek-official/deepseek-v4-pro`, apply with `enter`, and snapshot the confirmation.

### Staging a running child for the `@` case

The `@` menu needs a running subagent child to offer. A real model turn would make the test non-deterministic and would require a key, so a fixture plugin (`apps/cli/tests/fixtures/tui-journey/stage-subagent-child.ts`) is injected via `--patch`:

- It waits for the terminal's agent to appear.
- It creates a live child session with `origin: 'subagent'`, `parentSession` set to the terminal session, and `delegationDepth: 1`.
- It appends a `subagent/descriptor` with `mode: 'continuable'`, `provider: 'spawn'`, and `label: 'journey-child'`.

The child is live in the session store, so `subagents.listChildren` returns it with activity `running`, and the `@` menu lists `journey-child`.

### Staging a skill for the `/` skill case

The `/` menu needs a user-invocable skill to offer. A real model turn would make the test non-deterministic and would require a key, so a fixture plugin (`apps/cli/tests/fixtures/tui-journey/stage-skill.ts`) is injected via `--patch`:

- It waits for the terminal's agent to appear, using the same `TUI_STARTUP_SERVICE` pattern as the child fixture.
- It registers a runtime skill with `ctx.skills.register`, in the global layer where the agent's scope chain can see it.
- It waits for the skill to be observable through `ctx.skills.list({ scope: agent })`, the same catalog path the menu uses.

The skill is real in the registry, so the menu lists it after the command roster and a pick ships `/journey-skill` to the model as ordinary prompt text.

### Harness changes

Two small harness additions were needed for the snapshots:

- **UTF-8 decoding fix** — the previous Latin1-byte path turned multi-byte characters such as the em dash in `/help` output into spaces. The harness now decodes the PTY stream as UTF-8 before feeding the emulator.
- **`waitUntil(predicate)`** — complements `waitFor(text)` for conditions that are easier to express as a predicate, such as "the model picker is no longer on screen".
- **`cancel()`** — sends `ctrl+c` and returns the exit code. The `@` case leaves text in the composer (`@journey-child x`), so a plain `/exit` would append to the line instead of running the command. `ctrl+c` exits cleanly when no turn is running.

### Normalizations

The snapshots are plain-text renderings of the terminal grid. Only genuinely variable content is normalized:

- **`working <N>s`** in the running-turn footer is replaced with `working <N>s` because elapsed seconds vary between runs. Everything else — command roster, route names, model catalog, and child label — is deterministic under the keyless mock and default 100×30 geometry.
- ANSI sequences are interpreted by the emulator and stripped from `snapshot()`, so colors and cursor moves do not affect stability.
- Per-row trailing whitespace is removed so empty grid cells do not bloat snapshots.
- `DSH_HOME` is a temporary directory created and deleted by the harness, so absolute paths and session ids never reach assertions.

### Flake evidence

The new cases were run ten consecutive times with:

```sh
env -u FORCE_COLOR -u NO_COLOR pnpm vitest run apps/cli/tests/tui-interaction.spec.ts
```

Result: 10/10 passed.

## Alternatives considered

**A real model turn to produce the `@` child.** Rejected: it needs a key and makes the roster non-deterministic, which defeats a snapshot. The fixture creates a live child in the session store instead, so `subagents.listChildren` returns it through the same path production uses.

**A stubbed subagent roster.** Rejected: a snapshot that fakes the state it claims to prove is worse than an absent one. Staging real session-store state keeps the assertion about the wiring, not about the stub.

**A real model turn or a stubbed skill catalog to produce the `/` skill.** Rejected for the same reason: a key makes the test non-deterministic, and a stubbed catalog proves the menu rendering rather than the live skill source. The skill fixture registers a real runtime skill and asserts it is visible through `ctx.skills.list({ scope: agent })`.

**A filesystem skill instead of a runtime registration.** Rejected: it would couple the test to the filesystem provider's project-root discovery and file watching, adding nondeterminism and I/O. A runtime registration is scoped, synchronous, and tears down with the fixture.

**`/exit` for teardown in the `@` case.** Rejected: that case deliberately leaves `@journey-child x` in the composer, so `/exit` would append to the line rather than run the command. `cancel()` sends `ctrl+c`, which exits cleanly when no turn is running.

**Asserting raw PTY bytes rather than a rendered grid.** Rejected: pi-tui's differential rendering and synchronized output make byte order an implementation detail, so byte-level assertions would break on redraw changes that a reader never sees. The emulator interprets and strips ANSI so the snapshot pins what a person reads.

**Wall-clock sleeps between keystrokes.** Rejected as the usual source of CI flake. `waitUntil(predicate)` was added for conditions that are awkward to express as text, such as the model picker having left the screen.

## Acceptance criteria

- Journey snapshots exist for `/`, `/help`, `@`, `/` skill source, `@` empty roster, and `/model` and pass keylessly.
- Ten consecutive runs pass without flake.
- `pnpm run doc-sync` (28 gates), `pnpm run typecheck`, and `pnpm run hygiene` remain green.
- Baseline `pnpm vitest run packages/ui/tui packages/bundle/tui-app apps/cli/tests/tui-interaction.spec.ts` increases to 359 passed / 16 files and breaks nothing.
- `packages/ui/tui/` is not modified.

## Consequences

Assembled terminal interaction coverage now lives in `apps/cli/tests/` alongside the harness. Future shipped terminal features add journey snapshots there instead of leaving an honest gap. The fixture plugins are a reusable pattern for staging deterministic subagent children and user-invocable skills in keyless CLI tests.

## Risks

- The screen emulator remains minimal. If pi-tui changes the sequences it emits, snapshots may drift. The risk is bounded because the layout sequences used today are stable.
- The `@` case depends on the subagent list projection treating a live child session with a descriptor as running. If that projection changes, the fixture must be updated, but the snapshot itself will fail honestly.
- The `/` skill case depends on the skill registry exposing global runtime registrations to the agent's scope chain. If that visibility rule changes, the fixture must be updated, but the snapshot will fail honestly.

## Gaps

- Closed: `@` empty-roster case is now covered by a dedicated snapshot without the child-staging patch.
- Closed: `/` skill-source case is now covered by a dedicated snapshot with a real runtime skill.
- Open: the existing `/help` snapshot occasionally exits with signal 13 (SIGPIPE) under heavy aggregate-suite contention. The snapshot itself matches; the flake is in the PTY teardown of that specific test and is pre-existing on the base branch. It does not reproduce when the file runs alone, so it is recorded here rather than covered by a workaround that would mask the harness behavior.
