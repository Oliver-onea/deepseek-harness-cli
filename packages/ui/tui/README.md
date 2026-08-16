# `@deepseek-ai/dsh-tui`

English | [中文](README.zh.md)

The full-screen terminal front door. It renders one live agent's session in the alternate screen and owns terminal input; agent lifecycle, session persistence, tool execution, and the model-facing question tool remain separate composition entries.

The plugin requires both stdin and stdout to be TTYs and throws at mount instead of degrading to line-oriented output: a silent fallback would hide a deployment mistake and change interaction semantics. Pipes and automation use the [one-shot headless app](../../bundle/headless/README.md), [ACP](../../acp/acp/README.md), or [JSON-RPC](../../sdk/server/README.md).

The shipped composition is [`dsh-tui-app`](../../bundle/tui-app/README.md), the bundle behind `dsh` and `dsh --profile tui`.

## Config

| Key | Default | Meaning |
|---|---|---|
| `session` | required | The exact `SessionId` of the agent this terminal drives, as the host created it. |
| `agentWaitTimeoutMs` | `30000` | Maximum time to wait for that agent before refusing startup on the ordinary terminal. |
| `color` | `true` | Whether to emit SGR sequences; `false` renders the same layout unstyled. |
| `headLines` | `8` | Lines kept at the head of a folded tool-card body. |
| `tailLines` | `4` | Lines kept at the tail of a folded tool-card body. |
| `showReasoning` | `false` | Whether reasoning starts visible; a terminal control toggles it either way. |
| `maxSuggestions` | `8` | Candidate rows the `/` and `@` menus show before scrolling; a small terminal shows fewer. |
| `task` | — | A first prompt submitted once the screen is up, for `dsh "<task>"`. |

The plugin waits for the agent carrying `session`, bounded by `agentWaitTimeoutMs`, and enters full-screen mode only after that agent exists. A missing agent therefore becomes a startup refusal on the ordinary terminal rather than an unbounded wait or a diagnostic behind an alternate screen. It installs [`installModelSelection`](../../core/agent/README.md) on that agent, which fills the persona's `{{provider}}`/`{{model}}` variables and routes each request.

## What it draws

The transcript is folded from the **append-origin session log**, not from the model-visible surface, so a resumed session keeps every message the reader already saw and a compacted range stays readable behind its marker. It renders human turns, assistant text as Markdown, reasoning (hidden by default), tool cards, and one-line notices for turn endings, settled commands, and compactions. Rendered lines are cached per entry and invalidated by content or width change, so redrawing a long conversation costs only the entries that moved.

Tool cards come from each tool's own `presentCall`/`presentResult` ([render intent](../../core/tools/README.md)): terminal, diff, read, search, and web cards each have a terminal form, and a card shape this renderer does not know falls back to the model-facing result. A tool changes how it reads here by changing its presenter, never by a branch in this package.

The footer reports run state, the route requests actually use (from the latest `request/context`), context occupancy from [`ctx.tokenMeter`](../../llm/token-meter/README.md), the latest `todo/write` plan, queued inbox depth, the controls that currently apply, and standing session-state indicators when the composition mounts them: the current goal (except completed goals), an active or pending plan mode, and the effective permission preset.

Under the caret, the editor offers two input-trigger menus built on pi-tui's autocomplete: typing `/` at the start of the input lists the commands the live [`ctx.commands`](../../interaction/commands/README.md) registry resolves for this agent — a command registered after the screen is up appears on the next keystroke — and typing `@` at a word boundary lists the **running subagent children** of this session, the same roster the web surface's `@` source reads (`ctx.subagents.listChildren`, filtered to running; a child names itself by its durable session title, else its creation label, else its id). Without the subagent capability composed, `@` offers nothing. Both draw inside the editor block, one candidate per row with its description, and both give way before anything else on a small terminal: the menus clamp to the rows the footer, the editor, and one transcript row leave free, and a terminal with no room for a candidate row shows no menu at all — the trigger key stays inert rather than selecting from an invisible list. A picked `/` candidate completes to the command line and submits through the registry; a picked `@` candidate inserts the reference `@name ` into the input, which ships to the model verbatim as ordinary prompt text, matching the web surface's plain-text pick.

## Terminal ownership

Every string reaching pi-tui or the pane title passes through `displayText()`, which collapses carriage returns, expands tabs, and renders every other C0/DEL/C1 control as a visible `\xNN` escape. Only this package and pi-tui create ANSI control sequences, so untrusted tool output or model text cannot repaint the screen, move the cursor, or set the pane title.

The palette uses standard 16-color ANSI foregrounds and SGR attributes and keeps body text and backgrounds at terminal defaults, so a host terminal's light or dark theme remaps the whole interface; selection uses reverse video. There is no TUI-specific theme setting.

## Controls

| Key | Effect |
|---|---|
| `enter` | Submit: a resolved slash command runs through [`ctx.commands`](../../interaction/commands/README.md); anything else reaches the agent — a follow-up turn while idle, steering while a turn runs. |
| `esc` | Dismiss the open menu — the running turn and queued prompts survive; with no menu open, cancel the running turn. |
| `ctrl+c` | Cancel a running turn; with nothing to cancel, leave the session. |
| `ctrl+r` | Show or hide reasoning. |
| `ctrl+o` | Expand or fold every tool-card body. |
| `/` | Open the command menu at the start of the input; letters narrow it. |
| `@` | Open the running-subagent menu at a word boundary; letters narrow it. |
| `up` / `down` | Move the open menu's selection. |
| `tab` | Complete the selected candidate and keep typing. |
| `/exit`, `/quit` | Leave: cancel any turn, wait for the agent to settle so its session flushes, then exit. |
| `/help` | List the commands the live registry resolves for this agent; the footer's hint names it. |

## Interaction

The plugin registers the single `ctx.userQuestions` provider and answers `approval/request` **for its own agent only**, delegating every other agent's question to the rest of the chain. Both surface as one keyboard panel over the conversation: numbered options, arrow or number selection, `space` to toggle a multi-select, `tab` to type a free-text answer instead, `enter` to answer, `esc` to dismiss. A dismissed or withdrawn approval settles `cancelled`, which every caller fails closed on.

## Model Experience

None, as this package renders output and collects input: what it submits are ordinary user messages, and the persona, tools, and prompt sections belong to the composition around it.

#### KV Cache effect

No direct invalidation. The installed model selection is fixed for the session's life unless a composition changes it, so the request prefix stays stable.

## Known Limitations and Deferred Work

- **One agent per terminal** — the plugin drives the single session named by `session`; there is no in-terminal session switcher, and a second mount would contend for the same screen.
- **No terminal model picker yet** — the model-selection ref this package installs is where one would write, but no command exposes it; `--model`/`--provider` at launch is the only selection.
- **Streaming granularity is the log's** — the transcript follows `assistant/chunk` events, so a composition that logs no chunks draws each step's text when its message commits.
- **Images are not rendered** — pi-tui can place inline images in capable terminals, but attachment blocks currently contribute no terminal output.
- **Triggers fire at token starts only** — `/` opens its menu at the start of the first line and `@` at a word boundary; an inline `/` mid-line, an `@` after punctuation, and any trigger on a later line do not open a menu. pi-tui's editor owns this detection, and changing it means forking the editor.
- **An `@` query is one word** — a space ends the token, so while typing, a child whose name contains spaces matches on its first word only; the picked reference still carries the full name.
- **Menus are a flat list** — the web surface groups candidates by source under headings; the terminal lists them in roster order with no group headers.
- **`@` references are plain text** — a pick inserts `@name `, which ships to the model verbatim; the terminal has no reference codec or attachment block, and `@` consumption by the agent is future business work (the web surface defers it the same way).
- **No file completion** — no trigger or `tab` offers workspace file paths. The web surface has no file-completion source either; adding one to either surface is its own decision.
- **No skill source** — the web surface also lists skills under `/`; this terminal composes no skill source, so only commands appear there.
