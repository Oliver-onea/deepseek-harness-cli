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
| `task` | — | A first prompt submitted once the screen is up, for `dsh "<task>"`. |

The plugin waits for the agent carrying `session`, bounded by `agentWaitTimeoutMs`, and enters full-screen mode only after that agent exists. A missing agent therefore becomes a startup refusal on the ordinary terminal rather than an unbounded wait or a diagnostic behind an alternate screen. It installs [`installModelSelection`](../../core/agent/README.md) on that agent, which fills the persona's `{{provider}}`/`{{model}}` variables and routes each request.

## What it draws

The transcript is folded from the **append-origin session log**, not from the model-visible surface, so a resumed session keeps every message the reader already saw and a compacted range stays readable behind its marker. It renders human turns, assistant text as Markdown, reasoning (hidden by default), tool cards, and one-line notices for turn endings, settled commands, and compactions. Rendered lines are cached per entry and invalidated by content or width change, so redrawing a long conversation costs only the entries that moved.

Tool cards come from each tool's own `presentCall`/`presentResult` ([render intent](../../core/tools/README.md)): terminal, diff, read, search, and web cards each have a terminal form, and a card shape this renderer does not know falls back to the model-facing result. A tool changes how it reads here by changing its presenter, never by a branch in this package.

The footer reports run state, the route requests actually use (from the latest `request/context`), context occupancy from [`ctx.tokenMeter`](../../llm/token-meter/README.md), the latest `todo/write` plan, queued inbox depth, and the controls that currently apply.

## Terminal ownership

Every string reaching pi-tui or the pane title passes through `displayText()`, which collapses carriage returns, expands tabs, and renders every other C0/DEL/C1 control as a visible `\xNN` escape. Only this package and pi-tui create ANSI control sequences, so untrusted tool output or model text cannot repaint the screen, move the cursor, or set the pane title.

The palette uses standard 16-color ANSI foregrounds and SGR attributes and keeps body text and backgrounds at terminal defaults, so a host terminal's light or dark theme remaps the whole interface; selection uses reverse video. There is no TUI-specific theme setting.

## Controls

| Key | Effect |
|---|---|
| `enter` | Submit: a resolved slash command runs through [`ctx.commands`](../../interaction/commands/README.md); anything else reaches the agent — a follow-up turn while idle, steering while a turn runs. |
| `esc` | Cancel the running turn. |
| `ctrl+c` | Cancel a running turn; with nothing to cancel, leave the session. |
| `ctrl+r` | Show or hide reasoning. |
| `ctrl+o` | Expand or fold every tool-card body. |
| `/exit`, `/quit` | Leave: cancel any turn, wait for the agent to settle so its session flushes, then exit. |

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
