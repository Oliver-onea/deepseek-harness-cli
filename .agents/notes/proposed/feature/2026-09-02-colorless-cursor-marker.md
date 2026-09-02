# Agent Note: mark the cursor row by shape, not only by color

Status: proposed

English | [中文](2026-09-02-colorless-cursor-marker.zh.md)

## Problem

Under `--no-color`, and under `colorDepth: none` once that rung was fixed, the `/model` picker and the question panel drew every row identically. Nothing said which row `enter` would apply to, so the reader had to guess or exit.

Both surfaces styled the cursor row with `palette.selected(row)`, and `createPalette(false).selected` is the identity function — deliberately, and asserted by an existing test. Reverse video was the only thing carrying the cursor, and the colorless rung has no reverse video to give. The `/` command menu is unaffected: pi-tui's autocomplete emits its own `\x1b[7m` even with color off.

Found by the round-2 adversarial review of the terminal, which called it the worst remaining user-facing issue and declined to fix it as a maintainer judgment rather than a plain defect.

## Proposal

A `▸` in the row's first column names the cursor, and `palette.selected` continues to style it where color exists.

`cursorRow(row, isCursor, palette)` in `theme.ts` is the single place that decides this, replacing the same three-way expression duplicated across `model-picker.ts` (twice) and `questions.ts`. Rows now open with a two-column gutter, so the marker occupies a column of its own rather than abutting the number, and it replaces the first column rather than widening the row — the caller's `slice` to the panel width still holds.

The result is redundant encoding where color exists and shape alone where it does not:

```
--no-color   "▸ 2.   deepseek-official/deepseek-v4-pro"
truecolor    "\x1b[7m▸ 2.   deepseek-official/deepseek-v4-pro\x1b[27m"
```

State that a person must read should never rest on color alone; that is the general rule this follows, and the colorless rung is only where its absence became visible.

## Alternatives considered

**Make `palette.selected` emit reverse video at every rung, including colorless.** One line, and it fixes the picker. Rejected because it contradicts what the README promises for `color: false` — "renders the same layout unstyled" — and reverse video is styling. It would also flip an existing test that asserts the identity function on purpose.

**Accept it and document the limitation.** Honest and free. Rejected because the affected surface is how a reader picks a model; a menu whose cursor is invisible is not a limitation so much as a menu that does not work.

**Give only the colorless rung a marker.** Keeps every other rung byte-identical. Rejected because two rendering rules for one component drift apart, and the marker is an improvement with color too — shape reads faster than a reverse-video block at a glance.

## Acceptance criteria

1. The cursor row of `/model` and of the question panel is distinguishable with color off.
2. The same row carries both reverse video and the marker where color exists.
3. One helper decides this for all three call sites.
4. Row width is unchanged by the marker.

## Risks

- **The two-column gutter shifts every row one column right**, costing one column of content at narrow widths. The rows already truncate to the panel width, so the loss is a character of the longest model name.
