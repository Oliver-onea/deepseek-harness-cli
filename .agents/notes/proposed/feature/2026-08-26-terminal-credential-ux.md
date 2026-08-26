# Agent Note: Terminal Credential UX and /key Slash Command

Status: proposed

English | [中文](2026-08-26-terminal-credential-ux.zh.md)

## Problem

A user launching `dsh` in an interactive terminal without an API key configured could enter the session successfully, but submitting any prompt failed silently with no visible feedback or error in the terminal transcript. The underlying agent loop threw a `MISSING_CREDENTIAL` error and caught it, logging a `turn/end` event with error reason, but the terminal transcript did not fold that failed turn into a visible error notice.

Furthermore, the existing error messages in the LLM adapters instructed users to configure credentials through "the web Models page", which is useless and misleading advice for a user sitting in a CLI terminal session. There was no CLI flag, slash command, or in-terminal mechanism to store an API key into the managed `$DSH_HOME/.credentials.yaml` document without manually editing files.

## Proposal

1. **Terminal failure visibility**:
   - In `packages/ui/tui/src/transcript.ts`, fold failed turns ending in error reasons into an error-toned notice in the terminal transcript.
   - When consecutive resends against an unchanged credential failure occur, replace the existing error notice rather than stacking redundant identical notices across user turns. Live rendering and session log resume converge on the same folded view.

2. **In-terminal `/key` command**:
   - Register a `/key` slash command (`/key [<ref>] <value>`) in `@deepseek-ai/dsh-credentials-local` when the `commands` service is present.
   - Running `/key <secret>` defaults to storing `DEEPSEEK_API_KEY`, while `/key <ref> <secret>` allows storing any named credential reference into `$DSH_HOME/.credentials.yaml`.
   - The command specifies `recordInput: false`, ensuring typed secret arguments are never recorded in `command/run` lifecycle events, durable session logs, or model requests.
   - The command respects precedence: if a credential is shadowed read-only by the launching environment, it returns an explicit error explaining that the variable is read-only in the environment rather than silently performing a shadowed write.

3. **Actionable guidance across surfaces**:
   - Update error messages across LLM adapters and search providers (`llm`, `llm-deepseek`, `llm-pi-ai`, `web-search-deepseek`) to mention both `/key` in the terminal and the web Models page honestly.

## Alternatives considered

**Prompt for secret via interactive masked readline.** Rejected because the current terminal input layer does not support masked inputs or modal text prompts inside slash command handlers without invasive changes across TUI and pi-tui. Taking the key as a command argument is simple, standard, and clearly documented in READMEs.

**Wire the `/key` command directly inside `packages/ui/tui`.** Rejected because commands should be modular plugin contributions registered through the `commands` capability seam, owned by the package managing credentials (`credentials-local`), not hardcoded special cases in the UI front door.

**Edit `.env` files directly from the command.** Rejected because `$DSH_HOME/.credentials.yaml` is the provider-managed writable credential store with file locking, 0600 permissions, and clean precedence above project and user `.env` files.

## Acceptance criteria

- Launching `dsh` keyless remains supported; submitting a prompt without a key displays a clear `MISSING_CREDENTIAL` notice in the terminal transcript and the session remains usable.
- Resending a prompt against the same missing key replaces the error notice rather than accumulating duplicates.
- The error notice survives `--resume <session>`.
- The `/key` command is discoverable in `/help` and the `/` autocomplete menu.
- `/key <value>` and `/key <ref> <value>` write to `$DSH_HOME/.credentials.yaml` and hot-publish the updated credential.
- Secrets never leak into session events, command done text, or transcripts.
- Unit tests, journey snapshot tests, typecheck, lint, and doc-sync all pass.

## Risks

- Terminal input does not mask typed arguments; secrets typed on screen remain in the local terminal scrollback buffer until cleared. This is explicitly documented in the package README.
- Concurrent writes to `$DSH_HOME/.credentials.yaml` remain last-write-wins under cross-process file locking.
