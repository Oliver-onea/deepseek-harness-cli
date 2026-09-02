# Agent Note: TUI `colorDepth: none` pins the colorless rung

Status: proposed

English | [中文](2026-09-02-tui-color-depth-none-colorless.zh.md)

## Problem

The TUI config table advertises `colorDepth: truecolor | 256 | 16 | none`, where `none` pins the colorless rung of the degradation ladder (truecolor → 256 → 16 → no color). `resolveColorDepth` already honored that contract: it returns `undefined` for `none` and for `color: false`. But the single call site that built the palette folded that `undefined` back into a depth with `depth ?? '16'`, then passed the raw `color` flag, so `colorDepth: none` with `color: true` built the 16-color tier and emitted 616 SGR sequences on a cold open — indistinguishable from `colorDepth: 16` and the opposite of the documented colorless rung.

A PTY probe against the built CLI confirmed it: `--patch` setting `colorDepth: none` emitted 616 SGR sequences, identical to `colorDepth: 16`, while `--no-color` emitted 52 (pi-tui's own editor resets and reverse-video selection, which this package does not control). The README was correct; the code was not.

## Proposal

Lift the palette composition into `createTerminalPalette(color, colorDepth, env)`, the one place that turns the configured depth and the live terminal environment into the palette the renderer draws with. It resolves the depth through `resolveColorDepth`, then builds the palette with `depth !== undefined` as the emit-SGR flag and `depth ?? '16'` as the tier, so an `undefined` depth — `none` or `color: false` — yields the colorless (identity) palette rather than dropping through to 16-color. `createPalette` keeps its contract: a direct caller omitting depth still gets the 16-color tier, because the default parameter is `'16'`, not `undefined`.

After the fix, the same PTY probe emits 52 SGR sequences for `colorDepth: none`, matching `--no-color` and leaving only pi-tui's own sequences. A regression test asserts `createTerminalPalette(true, 'none', env)` is colorless.

## Alternatives considered

### Why not change `createPalette` to treat `undefined` depth as colorless?

`createPalette`'s default parameter is `'16'`, and JavaScript applies a default whenever the argument is `undefined`, so `createPalette(true, undefined)` would still receive `'16'` and return the 16-color tier. Distinguishing an explicit `undefined` from an omitted argument would require dropping the default and forcing every direct caller (`createPalette(false)`, `createPalette(true)`, and the resume picker) to pass an explicit depth — churn across test suites for no gain, and it would break the documented convenience that a direct caller gets a palette.

### Why not fix only the call site, without a new function?

The one-line call-site fix (`createPalette(depth !== undefined, depth ?? '16')`) is correct but untestable without booting the whole CLI under a PTY, because the composition lives inline in `start()`. Extracting `createTerminalPalette` gives the regression test a pure seam and names the operation the renderer actually performs: build the palette from the terminal config and environment.

## Risks

`colorDepth: none` now renders no SGR from this package, so the `/model` picker's cursor row — which uses `palette.selected` — is no longer distinguished by reverse video under `none`, the same as under `--no-color`. That is consistent with the colorless axis the reader asked for and matches the existing, tested behavior of `color: false`; whether a colorless palette should keep reverse video for selection is a separate design question, not addressed here.

## Acceptance criteria

- `createTerminalPalette(true, 'none', env)` returns a colorless palette: every style is identity, so `error`, `accent`, and `selected` emit no SGR.
- `colorDepth: 16 | 256 | truecolor` with `color: true` still draws the matching tier, and `color: false` still forces a colorless palette regardless of the pinned depth.
- A PTY boot under `colorDepth: none` emits no SGR from this package's palette, matching the `--no-color` count.
