# Agent Note: TUI color depth ladder replaces the 16-color-only palette

Status: proposed

English | [中文](2026-08-26-tui-color-depth-ladder.zh.md)

## Problem

`dsh-tui` documented a palette stance: standard 16-color ANSI foregrounds and SGR attributes only, body text and backgrounds at terminal defaults, no theme setting. The stance was deliberate. It bought host-theme remapping — a light or dark terminal recolors the whole interface through its own palette, so contrast is whatever the reader already chose — monochrome safety, since every terminal that can run the product can render every run state with its meaning intact, and zero theme-configuration surface.

The stance cost the product any visual identity. Every role color is whatever the host terminal calls cyan or blue; the DeepSeek mark (`#4D6BFE`) appears nowhere; chrome that should read as the product — the cold-open header, the whale, turn markers — reads as generic terminal output. The cold-open screen was judged unacceptable on looks alone, and identity is now the stated priority. pi-tui renders truecolor without help, so the limit was always the stance, not the framework.

## Proposal

Keep the palette role-keyed and semantic — `dim`, `bold`, `user`, `tool`, `accent`, `success`, `warn`, `error`, `removed`, `added`, `code`, `selected` — and draw each role at the deepest color depth the deployment supports. The ladder, in order:

1. **Truecolor** when `COLORTERM` is `truecolor` or `24bit`: roles carry the brand palette directly (`#4D6BFE` for `tool`/`accent`).
2. **256-color** when `TERM` names 256 colors: the nearest xterm-256 approximations.
3. **16-color** everywhere else: the ANSI foregrounds the old stance used.
4. **No color** when `color` is off: identity styles, identical layout.

A validated `colorDepth` config field (`auto`, `truecolor`, `256`, `16`, `none`; default `auto`) pins one rung for deployments whose environment misreports, so the depth is a deployment decision, not only a sniff.

What the ladder guarantees in place of the old stance:

- **Role meaning survives every rung.** A failure reads as the error color and a success as the success color at all four rungs; only the shade degrades, never the meaning.
- **Host-theme contrast survives.** Body text and backgrounds stay at terminal defaults at every rung; selection stays reverse video, so it inverts whatever the host uses.
- **Monochrome safety survives.** `color: false` renders the same layout unstyled, exactly as before.
- **`displayText()` still sanitizes every untrusted string** — model text, tool output, file names, session titles, skill and command labels; only package-authored chrome is trusted literal source. This rule is untouched by the reversal.

## Alternatives considered

**Keep the 16-color-only stance.** It still buys everything it always bought, but the product now needs an identity more than it needs the last degree of host-theme remapping. The rung structure keeps the old palette as the third tier, so the reversal gives up nothing the stance bought for 16-color terminals — only the refusal to draw deeper where the terminal allows it.

**Truecolor only, no degradation.** A TUI that demands truecolor excludes ssh sessions, tmux under older `TERM` values, and any terminal that stops at 256 or 16 colors. Degradation is the part of the ladder that keeps the monochrome-safety promise alive; shipping without it would be a stricter requirement than the old stance it replaces.

**A user-selectable theme setting.** A palette picker is configuration surface nobody asked for; the roles already concentrate the aesthetic decision in one module, and depth is a terminal capability, not a preference. `colorDepth` overrides detection for broken environments; it does not open theme choice.

**Background colors for chrome and panels.** Coloring backgrounds forfeits host-theme remapping for the regions it touches and risks unreadable combinations on terminals the palette never tested against. Foreground-only color with default backgrounds keeps the contrast guarantee; selection keeps reverse video for the same reason.

## Acceptance criteria

- `packages/ui/tui/src/theme.ts` builds the role palette at truecolor, 256, 16, and no-color rungs, with tests asserting each rung's sequences and the detection order.
- The plugin validates `colorDepth` and resolves it against `COLORTERM`/`TERM` in one place.
- `packages/ui/tui/README.md` and its Chinese counterpart describe the ladder in place of the 16-color-only stance, and the Config table lists `colorDepth`.
- The cold-open header and whale consume the ladder: drawn at truecolor/256, replaced by the one-line identity header at 16/no-color.

## Risks

The truecolor and 256 shades are chosen for dark terminals, the common case; on a light host some mid-tone shades may read softer than intended. Foreground-only color, default backgrounds, and reverse-video selection bound the damage, and `colorDepth: none` remains the escape hatch. Detection can misread an exotic `TERM`; the pinned override answers that, which is why it is config, not code.
