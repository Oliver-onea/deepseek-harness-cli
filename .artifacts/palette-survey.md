# TUI Palette Survey

## Product Summary

| Product | Distinct Foregrounds | Distinct Backgrounds | Attributes Used | Notes |
|---------|---------------------|----------------------|-----------------|-------|
| **claude** | 5 (truecolor) | 1 (truecolor) | bold, dim | Heavily utilizes distinct background for its header. |
| **kimi** | 5 (truecolor) | 0 | bold | Clean layout, colored file paths and instructions. |
| **qwen** | 4 (truecolor) | 1 (truecolor) | bold | Uses distinct background behind text on the prompt line. |
| **codex** | 0 (no truecolor) | 0 | bold, dim | Minimal styling. |
| **agy** | - | - | - | (Capture Failed - stalls at terminal capability queries) |
| **opencode**| - | - | - | (Capture Failed - stalls during environment/DA checks) |
| **dsh** (us) | 6 (truecolor) | 0 | bold, dim, reverse | Duplicate hues used for multiple roles. |

## Role-by-Role Table

| Semantic Role | claude | kimi | qwen | dsh (current) |
|---------------|--------|------|------|---------------|
| **user** | Normal | Normal | Normal | 0x56, 0xc8, 0xe8 (Cyan) |
| **assistant / accent** | 215,119,87 (Orange) bg | 79,168,255 (Blue) | 139,92,246 (Purple) | 0x4d, 0x6b, 0xfe (Blue) |
| **tool name** | Normal | Normal | Normal | 0x4d, 0x6b, 0xfe (Blue - same as accent) |
| **tool result** | Normal | Normal | Normal | Normal |
| **file path** | Normal | 245,245,245 (White) | Normal | Normal |
| **error** | Yellow/Red? | Normal | 221,76,76 (Red) | 0xf8, 0x51, 0x49 (Red) |
| **warning** | 255,193,7 (Yellow) | Normal | Normal | 0xe0, 0xaf, 0x68 (Orange/Yellow) |
| **success** | Normal | Normal | Normal | 0x3f, 0xb9, 0x50 (Green) |
| **heading** | Bold + Color? | Bold | Bold | Bold |
| **link** | Underline | Normal | Normal | Normal |
| **quote** | Dim | Normal | Normal | Dim |
| **inline code** | Normal | Normal | Normal | 0xa7, 0x8b, 0xfa (Purple - same as code block) |
| **code syntax** | Yes (tokens) | Yes | Yes | No (flat purple) |
| **diff add** | Green FG | Green FG | Green FG | 0x3f, 0xb9, 0x50 (Green - same as success) |
| **diff remove**| Red FG | Red FG | Red FG | 0xf8, 0x51, 0x49 (Red - same as error) |
| **selection** | Reversed | Highlighted | Highlighted | Reversed |
| **dim / meta** | 136,136,136 | 107,107,107 | 151,160,176 | Dim (SGR 2) |
| **backgrounds**| Header bg (orange)| None | Prompt bg (gray) | None |

## Gap List

Roles where we have no distinct treatment and at least two reference products do:
1. **Backgrounds**: Both `claude` and `qwen` use colored backgrounds for UI regions (headers, prompts). We currently use none. Note: All measured products use foreground coloring rather than background tinting for diff lines.
2. **Distinct Hues for Duplicate Pairs**: We currently overload the same color for `tool`/`accent`, `success`/`added`, and `error`/`removed`.
3. **Headings/Markdown Elements**: We don't color headings, links, and quotes distinctively from normal text or dim text.
4. **Code Syntax Highlighting**: Reference products highlight syntax tokens; we currently use a flat color for all code.
