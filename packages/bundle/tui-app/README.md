# `@deepseek-ai/dsh-tui-app`

English | [中文](README.zh.md)

The dsh terminal-surface bundle, and the profile `dsh` boots when an invocation names none. [`cordis.patch.yml`](cordis.patch.yml) rides over [`dsh-base`](../base/README.md): it supplies the terminal persona and tool mode, disables HMR (reloading a plugin under a live screen would rebuild components the terminal is drawing), mounts Code Mode's worker as a core execution capability, and inserts this package's `tui-startup` provider plus the [`dsh-tui`](../../ui/tui/README.md) screen.

The agent plane stays where the base put it. This surface is single-session and composes one agent process-wide, so it mounts no preset roster and the base's tool, prompt, and delegation rows are that agent's own — the inverse of [`dsh-web-app`](../web-app/README.md), which moves them behind per-session presets.

## The one configured agent

The base leaves `agent-loop`'s `agents: []` for surfaces that create sessions on request. This bundle configures exactly one, fresh or resumed, and the startup provider owns which: `--resume <session>` inspects that session through persistence before publishing `resumeSessionId`, while any other launch mints a fresh `sessionId` in the invoking directory. A missing or unreadable stored log refuses startup before dependent rows activate or the screen enters alternate mode. Both the agent row and the screen row read the same id from the provider, so neither depends on the other's mount order.

## Command line

The ordinary `tui-startup` provider ([`src/startup.ts`](src/startup.ts)) injects `ctx.cmdlineArgs` ([`dsh-cmdline`](../../boot/cmdline/README.md)) and `ctx.sessionPersistence`, parses this app's flags, verifies a requested resume, and provides `tuiStartup`. Rows configured from flags inject that service, so the Loader resolves their expressions only after it exists — and `dsh --help` provides nothing, so neither an agent nor a screen is composed.

| Argument | Meaning |
|---|---|
| `[task...]` | A first task, joined by spaces; the screen opens and starts on it. |
| `--` | End app option parsing; following flag-shaped tokens are task text. |
| `--resume <session>` | Continue a persisted session instead of starting a fresh one. |
| `--model <model>` | Model id for this session. |
| `--provider <provider>` | Provider route for this session. |
| `--no-color` | Render without ANSI styling. |

## Model Experience

### Terminal persona

#### What the model sees

The `deployment:persona` section states the model's role, the model id and working directory through the `{{model}}` and `{{cwd}}` variables, and that it is talking to a person in their terminal — so answers should be short and skimmable, and doing the work is preferred over describing it. Everything else the model sees — tools, prompt sections, delegation — comes from the base rows this patch layer rides over.

#### Token effect

One prompt paragraph per session; constant per process.

#### KV Cache effect

The section sits in the system prompt's stable prefix and is fixed for the session's life (the model id is captured when the terminal installs its selection), so it does not invalidate the cache across turns.

## Known Limitations and Deferred Work

- **`ctx.appExit` is launcher-owned** — booting this profile outside the `dsh` launcher leaves `/exit` and `ctrl+c` without an exit request, so the session cannot end itself.
- **One agent per process** — the profile composes a single configured agent; running two conversations means two processes, each with its own screen.
