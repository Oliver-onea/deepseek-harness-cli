---
title: TUI visual richness pass
status: proposed
author: agent
created: 2026-08-26
---

# TUI visual richness pass

English | [中文](2026-08-26-tui-visual-pass.zh.md)

This note proposes and documents visual improvements to the terminal UI, based on a survey of other terminal agents (`claude`, `kimi`, `qwen`).

## Motivation
The terminal UI felt crude (不夠圓潤，感覺很粗糙) and lacked distinct coloring for various markdown and structural elements compared to other products in the space. The initial palette overloaded several semantic roles into the same few hues and omitted background colors entirely.

## Palette Survey Findings

| Product | Distinct Foregrounds | Distinct Backgrounds | Attributes Used | Notes |
|---------|---------------------|----------------------|-----------------|-------|
| **claude** | 5 (truecolor) | 1 (truecolor) | bold, dim | Heavily utilizes distinct background for its header. |
| **kimi** | 5 (truecolor) | 0 | bold | Clean layout, colored file paths and instructions. |
| **qwen** | 4 (truecolor) | 1 (truecolor) | bold | Uses distinct background behind text on the prompt line. |
| **codex** | 0 (no truecolor) | 0 | bold, dim | Minimal styling. |
| **agy** | 0 (no truecolor) | 0 | none | Minimal styling. |
| **opencode**| 0 (no truecolor) | 0 | none | Minimal styling. |
| **dsh** (old) | 6 (truecolor) | 0 | bold, dim, reverse | Duplicate hues used for multiple roles. |

### Gap List
1. **Backgrounds**: Both `claude` and `qwen` use colored backgrounds for structural regions. We used none.
2. **Duplicate Pairs**: We overloaded the same color for `tool`/`accent`, `success`/`added`, and `error`/`removed`.
3. **Markdown Elements**: Headings, links, and quotes lacked distinct treatment.
4. **Code Syntax Highlighting**: Reference products highlight syntax tokens; we used a flat color for all code.

## Alternatives considered
1. **Adding a heavyweight syntax highlighter**: Ruled out if it adds too much bundle size and startup time. We should only use token-level styling if the vendored `pi-tui` supports it natively.
2. **Copying other palettes exactly**: Ruled out as we want to maintain our own brand identity while reaching parity in richness.
