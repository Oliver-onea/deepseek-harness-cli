# Agent Note: Terminal Credential UX — Keyless Failure Visibility and Setting the Key from the Terminal

Status: proposed

English | [中文](2026-08-26-terminal-credential-ux.zh.md)

## Problem

A new user launching `dsh` in a terminal without an API key could enter the session — that part is right and stays — but sending a prompt produced nothing: no answer, no error, no hint. The headless app already prints an actionable `MISSING_CREDENTIAL` failure for the same scenario. The terminal had machinery at both ends: the agent loop logs `turn/end` with an error reason, and the transcript owns an error notice tone — but nothing folded the failed turn into a drawn line, so the failure never reached the screen.

The same user then has no way to fix the situation from where they sit. The credential guidance inside the LLM errors told a terminal user to open "the web Models page" — a surface they are not running — and no CLI flag, slash command, or subcommand exposed the credentials service's write path, even though the service can write the managed `$DSH_HOME/.credentials.yaml` store.

## Proposal

1. **The transcript draws failed turns.** `Transcript` folds a `turn/end` whose reason is an error into one error-toned notice carrying the code and the actionable message — the same facts headless prints. A resend against an unchanged failure replaces the identical notice instead of stacking another; the replacement reaches back only across `user` entries, so any assistant, tool, or other notice in between keeps the earlier failure visible. Live rendering and `--resume` replay run the same fold over the same logged event, so the failure survives resume without a second event type.
2. **A terminal write path into the credentials seam.** A new package `@deepseek-ai/dsh-command-credential` registers one global `/credential` command through the `commands` service, mounted by the base bundle beside `credentials-local`. `/credential <REF>` answers with the value-free `describe` facts; `/credential <REF> <value>` stores through `ctx.credentials.set` — the managed store, never a `.env`. The definition sets `recordInput: false`, so `command/run` omits `args`; every success and error text is value-free; a redaction guard strips the value from any provider failure message before it becomes command output. When the launching environment shadows the reference read-only, the command returns the service's loud rejection instead of silently no-op'ing, and the describe path warns about the shadow up front.
3. **Registration must not wait for the provider.** The plugin injects only `commands` and reads `ctx.get('credentials')` at execution time. Gating on the credentials provider delays registration until that provider finishes loading — which, in a fast terminal, is after `/help` has already answered — so the command would miss the very listing that makes it discoverable. A composition with no credentials service gets a clear error at use time.
4. **The guidance names both writers honestly.** The `MISSING_CREDENTIAL` messages of `llm-deepseek` and `llm-pi-ai` and the two `INVALID_CREDENTIAL` strings in `assertUsableApiKey` now say: store the reference through the credentials service — in the terminal `/credential <REF> <value>`, in the web app the Models page writes it — or export it in the launching environment. The strings are shared across surfaces, so each keeps the writer the other surface's user can reach.

## Alternatives considered

- **A new session event or notice kind for the failure.** Rejected: `turn/end` with an error reason already logs the failure, and model-visible ⟺ logged is satisfied by drawing the existing event. A second event would duplicate state and still need the same resume fold.
- **A `/key <value>` command with a default reference.** Rejected: one-token input is ambiguous — `/key DEEPSEEK_API_KEY` would store the literal reference name as the secret. `/credential <REF> [<value>]` parses deterministically and describes as well as stores, matching the seam's `describe`/`set` surface.
- **Registering the command inside `credentials-local`.** Rejected: it puts a UI role in a provider, adds `dsh-agent`/`dsh-session` peers to a file backend, and couples command availability to provider load order; the repo's convention is one thin package per command (`command-feedback`, `command-goal`, `command-compact`).
- **Masking the typed secret.** Rejected: no shipped terminal input surface supports masked entry, so the command takes the value as an argument and the README states that the input line does not mask it, instead of pretending otherwise.
- **Updating the `web-search-deepseek` credential message in the same change.** Deferred: it is not one of the messages the terminal credential failure shows, and it already offers environment and literal-config alternatives. A follow-up can align it with the both-writers phrasing.

## Acceptance criteria

- Launching `dsh` keyless remains supported; sending a prompt without a resolvable credential draws an error notice carrying the code and the actionable message, and the session stays usable.
- A repeated send against the unchanged failure leaves exactly one visible notice.
- The failure survives `--resume`, reconstructed from the logged `turn/end`.
- `/credential` is discoverable in `/help`, writes through the credentials service into the managed store, never into a `.env`, and reports the shadowed-by-environment case instead of silently no-op'ing.
- The secret appears in no logged event, result text, transcript line, or model request.
- The credential guidance no longer tells a terminal user that the web Models page is their only option.

## Risks

- The terminal input line does not mask typed values: a secret typed as a command argument is visible while typed and remains in terminal scrollback. The README states this; a masked prompt is deferred until a terminal input surface supports one.
- `/help` snapshots depend on every command plugin having registered; a slow-loading registration could in principle truncate the listed roster. The keyless scenario settles the view with a follow-up notice before snapshotting, and registration deliberately avoids waiting on the credentials provider.
- The `web-search-deepseek` credential message still names only the web writer; a follow-up should align it with the both-writers phrasing.

## Verification

- Unit and real-Loader-composition tests for the command, including assertions that the secret appears in no logged event, result text, or rendered line, and that a shadowed reference is reported.
- Keyless PTY snapshots through the shipped terminal profile: the failure notice after a keyless send, one notice after a repeated send, the resume replay, the `/help` listing including `/credential`, and the store flow ending in the managed document.
- Re-recorded headless keyless fixtures pinning the new guidance text.
