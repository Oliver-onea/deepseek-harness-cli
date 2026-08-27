# Agent Note: a reusable PTY-based terminal-interaction test harness

Status: proposed

English | [中文](2026-08-16-tui-interaction-harness.zh.md)

## Problem

`dsh --profile tui` is the shipped terminal front door. Every product-user-visible change to what it draws or how it responds to keystrokes needs a keyless, deterministic, replayable acceptance test. `packages/ui/tui/tests/pty-boot.spec.ts` already proves one happy path under a real PTY, but it is bespoke: each new interaction feature would have to reinvent PTY driving, screen reconstruction, and timing discipline.

There is no reusable harness a test author can use to say "boot the terminal, type this, press that, assert the screen contains this".

## Proposal

Add a reusable PTY harness under `apps/cli/tests/tui-interaction.harness.ts` that boots the real shipped terminal profile through the `dsh` source launcher against the existing keyless mock model, replays a scripted keystroke sequence, and asserts on the rendered screen.

### API

`createTuiHarness({ baseUrl })` returns:

- `type(text)` — send literal text without submitting it.
- `key(name)` — send a named key (`enter`, `esc`, `tab`, `backspace`, `up`, `down`, `left`, `right`, `ctrl+c`, `ctrl+r`, `ctrl+o`, `space`, `delete`, `home`, `end`, `pageup`, `pagedown`).
- `submit(line)` — type a line and press Enter.
- `waitFor(text, timeoutMs?)` — resolve once the plain-text screen contains `text`, or reject at the deadline.
- `snapshot()` — plain-text rendered screen.
- `ansiSnapshot()` — reserved for ANSI-aware snapshots; currently falls back to plain text.
- `exit()` — send `/exit` and return the process exit code.
- `dispose()` — kill the process and remove the temporary `DSH_HOME`.

The harness owns PTY geometry (`cols`/`rows`) and the per-turn timeout; callers pass only the mock-server URL and the script.

### Timing discipline

The harness waits on observable screen state, not wall-clock sleeps. Every `waitFor` subscribes to the PTY data stream, re-renders the screen after each chunk, and resolves the moment the predicate matches. This removes the main source of flake in PTY tests.

### Environment isolation

The child PTY process gets an explicit environment that does not inherit `FORCE_COLOR` or `NO_COLOR` from the parent shell. Those variables change pi-tui output and, when both are set, make Node emit a warning that pollutes stderr and snapshots.

### Screen renderer

The harness includes a minimal VT100/ANSI emulator that reconstructs the terminal grid from the byte stream. It handles cursor positioning, erase-in-display/line, carriage return, line feed, backspace, tab, and multi-byte UTF-8. It strips SGR attributes for `snapshot()` so tests assert content rather than color.

### Normalizations

Because the harness asserts on live screen state rather than checked-in snapshots, the main normalizations are internal:

- ANSI control sequences are interpreted, not stripped after the fact, so cursor placement and clearing are accurate.
- Per-row trailing whitespace is removed so empty grid cells do not bloat snapshots.
- `DSH_HOME` is a temporary directory created and deleted by the harness, so absolute paths never reach assertions.
- Session ids are generated inside the temporary home and are not rendered on screen in these cases; if future cases snapshot durable output, the harness will normalize UUIDs and the temp path before comparison.

### Process model

The spec is added to the `processBoundTests` project in `vitest.config.ts` so it runs in a forked process, isolated from thread-safe unit tests and from the existing `packages/ui/tui/tests/pty-boot.spec.ts` PTY case. `knip.json` registers `tests/**/*.harness.ts` as an entry so exported harness API constants are not reported as unused.

## Alternatives considered

- **Copy `node-pty` plumbing into every new test** — rejected: it duplicates the same spawn, cleanup, and byte-parsing code and makes timing bugs hard to fix in one place.
- **Snapshot the raw PTY byte stream** — rejected: cursor moves, color sequences, and partial redraws make byte-level comparison unstable across runs and terminal sizes. Reconstructing the grid first gives a stable content view.
- **Drive the terminal through pipes** — rejected: `dsh-tui` requires a TTY on both stdin and stdout and refuses to start otherwise. Pipes cannot prove terminal takeover, which is the whole point of this tier.
- **Use a full terminal emulator library** — rejected: the sequences emitted by pi-tui are a small, stable subset; a hand-rolled renderer keeps the harness dependency-free and avoids dragging browser-grade parsing into a CLI test.

## Acceptance criteria

- A test author can express a keystroke script and assert on rendered screen content without writing PTY plumbing.
- Two proof cases pass keylessly against the current terminal behavior.
- Ten consecutive runs pass without flake.
- `pnpm run typecheck`, `pnpm run lint`, and `pnpm run doc-sync` remain green.
- The API supports Tier B menu cases: type `/`, wait for a menu, press `down`/`enter`, assert the menu closed.

## Consequences

`apps/cli/tests/tui-interaction.harness.ts` becomes the owned place for keystroke-driven terminal acceptance. New terminal interaction features add cases there instead of reinventing PTY driving. The harness is confined to `apps/cli/tests/` and does not change `packages/ui/tui/`, so the Tier B branch can add its menu cases without coordinating on harness internals.

## Risks

- The screen emulator is intentionally minimal. If pi-tui begins emitting sequences it does not understand, the rendered screen may drift. The risk is bounded because only pi-tui and `@deepseek-ai/dsh-tui` emit control sequences, and the sequences used by the current layout are stable.
- PTY tests remain slower than pipe-based tests. They are gated to the one subject that requires them.
