# @deepseek-ai/dsh-command-credential

English | [中文](README.zh.md)

The terminal's write path into the credential seam: one global `/credential` command registered through [`ctx.commands`](../../interaction/commands/README.md), so every composed command adapter discovers it. It shows or stores one credential reference through [`ctx.credentials`](../credentials/README.md) — the terminal's equivalent of the web Models page — and never edits a `.env`: a store write goes through the service into the provider-managed source (`$DSH_HOME/.credentials.yaml` under [`dsh-credentials-local`](../credentials-local/README.md)).

## Command contract

| Input | Result |
|---|---|
| `/credential` | A usage error naming the argument shape. |
| `/credential <REF>` | The value-free `describe` facts: configured state, supplying source, writability — and a shadow warning when a read-only source supplies the reference. |
| `/credential <REF> <value>` | `set` through the service; the acknowledgement names the reference only. |

`REF` must be a POSIX shell identifier (`credentialRef` rejects anything else, naming the offending text but never a value). The value is the remainder of the line after discarding outer whitespace; inner whitespace survives, and an empty remainder turns a store line into a description request instead.

Precedence is the seam's, not this command's. When the launching environment supplies a reference read-only, `set` rejects rather than writing a change resolution would never show; the command returns that rejection as its error text, so a shadowed write is reported instead of silently no-op'ing. The same facts answer `/credential <REF>` up front (`configured read-only from env; storing a value would be shadowed by it`).

The secret never reaches the log. The definition sets `recordInput: false`, so `command/run` omits `args`; every success and error text is value-free; and a redaction guard strips the value from any provider failure message before it becomes command output. `command/run`/`command/done` stay the only records, log-only and absent from the ordered surface, `deriveMessages()`, and model requests. The terminal input line is not masked — see Known Limitations.

Only `commands` is injected. Registration must not wait for the credentials provider to finish loading — a fast terminal answers `/help` before that — so the handler reads `ctx.get('credentials')` at execution time and reports a clear error when a composition mounts no credentials service.

## Composition

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'
- id: command-credential
  name: '@deepseek-ai/dsh-command-credential'
```

The shipped `dsh` base mounts the command beside the local provider; it has no configuration. Headless mode, ACP automation, and JSON-RPC provide no command adapter, so they do not expose it.

## Model Experience

### Human `/credential` capture

#### What the model sees

Nothing. The slash input, the service write, and the acknowledgement are absent from model requests: `recordInput: false` keeps the value out of `command/run`, the command lifecycle records are log-only, and the stored value lives in the credential source, which consumers resolve per operation and never render into a prompt.

#### Token effect

Zero direct token effect. Neither a stored value nor a usage error adds model tokens, in the current turn or any later one.

#### KV Cache effect

Independent of the model request path. Storing a credential appends only command lifecycle records to the session log, leaving an already-reusable request prefix untouched; the value itself never enters a request prefix.

## Known Limitations and Deferred Work

- **Terminal input does not mask typed secrets** — the value is a typed command argument; it is visible on the input line while typed and remains in the terminal's scrollback. A masked prompt would need terminal-input support no shipped surface has today.
- **No removal surface** — the seam's `unset` is not exposed; a stored reference is rotated by storing a new value, and removing it needs the web surface or the document itself.
- **One reference per invocation** — storing several references takes one line each.
