# Agent Note: TUI visual richness pass

Status: proposed

English | [中文](2026-08-26-tui-visual-pass.zh.md)

## Problem
The terminal UI felt crude (不夠圓潤，感覺很粗糙) and lacked distinct coloring for various markdown and structural elements compared to other products in the space. The initial palette overloaded several semantic roles into the same few hues and omitted background colors entirely.

## Proposal
Based on a survey of other terminal agents (`claude`, `kimi`, `qwen`), we propose visual improvements to the terminal UI:
1. **Split the duplicate pairs**: Increased the distinct hue count from 6 to 11. Added Fuchsia (`0xd9, 0x46, 0xef`) for `tool` distinct from `accent` blue. Since diff colors are semantically identical to `success` and `error`, the `added` and `removed` roles were deleted and replaced with `success` and `error` respectively.
2. **Syntax Highlighting**: Added a lightweight RegEx-based `highlightCode` function using `pi-tui`'s `MarkdownTheme` support, supporting TS/JS, JSON, shell, markdown, and diff without heavyweight dependencies.
3. **Markdown Elements**: `heading`, `quote`, `link`, `italic`, and `strikethrough` received distinct colors and styles (SGR).
4. **Diff Background Tinting**: Rejected. We measured reference products (`kimi`, `qwen`) under real workloads emitting diffs, and confirmed they use foreground colors (e.g. `\x1b[32m`) rather than background tinting (`\x1b[48;...`) for diff lines.
5. **Rounded Corners**: Changed the square `└` elbow in `tool-card.ts` to `╰`.

## Acceptance criteria
- All tests in `packages/ui/tui` pass.
- New roles are defined and distinctly styled across 16-color, 256-color, and truecolor depths.
- A lightweight RegExp syntax highlighter works without pulling large dependencies.

## Risks
The regex-based highlighter may mis-highlight complex edge cases, but it provides a "good enough" approximation that vastly improves the perceived richness of the UI.

## Alternatives considered
None.
