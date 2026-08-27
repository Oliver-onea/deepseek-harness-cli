# Agent Note: refuse unknown slash lines instead of prompting the model

Status: proposed

English | [中文](2026-08-27-refuse-unknown-slash-lines.zh.md)

## Problem

The terminal routed any submitted line the command registry could not resolve to the model as conversation. `classifySubmission` returned `{ kind: 'prompt' }` for every unresolved line, including lines shaped like a slash command.

That is a secret-disclosure path. `/credential <REF> [<value>]` takes an API key as a command argument, and the command protects it: it declares `recordInput: false` so the commands service omits the arguments from the logged event, and it runs every rendered provider error through `redactValue`. **Both protections hang off the resolved command.** A reader who mistypes the name resolves nothing, so neither applies and the whole line becomes a prompt.

Measured on the integrated branch with a mock provider, submitting `/credentail DEEPSEEK_API_KEY sk-…`:

- the key was rendered in the transcript in cleartext,
- and it was carried in **both** outgoing model requests.

Against a real provider the key leaves the machine. A single transposed letter is enough.

## Proposal

Give the router a third outcome. A line whose leading token parses as a command name (`commandNameOf`: a slash, an identifier, then a word break) but which the registry cannot resolve becomes `{ kind: 'unknown-command', name }`. The shell draws `Unknown command: /<name> — run /help for the list` and sends nothing.

Two carve-outs keep existing behaviour intact:

- **A user-invocable skill is invoked as `/name` and must still reach the model as a prompt.** Skills are not registry commands, so the shell consults the skill catalog before refusing. Only this path pays that lookup; resolved commands and ordinary prose never reach it. A catalog read that throws answers "yes" — forwarding a line the reader meant as a skill is recoverable, refusing every skill because the catalog blinked is not.
- **A composition that mounts no command registry has nothing for a line to be unknown against**, so every line there stays conversation.

`commandNameOf` requires a word break after the identifier, so prose that merely opens with a path (`/usr/bin/env is where env lives`) is unaffected.

Only the parsed name is echoed in the refusal. The arguments — the secret — are never drawn.

## Alternatives considered

**Leave it and rely on `recordInput: false`.** Rejected: that flag is a property of a resolved command, and the whole failure is that nothing resolved. It cannot cover the typo by construction.

**Fuzzy-match the typo against known commands and suggest the nearest.** A better message, but it does not decide the security question — a name far enough from any command would still fall through to the model. Worth adding on top of the refusal later; not a substitute for it.

**Stop taking the secret as a command argument, and read it through an interactive panel instead.** This is the stronger fix: a secret never typed on a submitted line cannot be routed anywhere. It is also the larger change, and it does not help the reader who types `/credentail` out of habit from another tool. Recommended as follow-up; the refusal is what closes the demonstrated hole now.

**Refuse every unresolved slash line, with no skill carve-out.** Simplest, and what the first attempt did. It broke skill invocation — five tests named the behaviour explicitly — because skills reach the model precisely by being unresolved slash lines.

## Acceptance criteria

1. A command-shaped line the registry cannot resolve produces a local error notice and no model request.
2. The refusal echoes the command name only, never the arguments.
3. `/name` naming a user-invocable skill still reaches the model.
4. Prose opening with a path, and every line under a composition with no registry, still reach the model.
5. A PTY probe confirms zero outgoing requests for the mistyped credential line.

## Risks

- **The skill lookup runs on the refusal path.** It is one catalog read, on a path taken only by unresolved command-shaped lines, and the `/` menu already performs the same read. If a deployment's catalog is slow, a mistyped command becomes slow to refuse rather than wrong.
- **A reader who wanted to send a literal `/word …` to the model must now rephrase.** No prior behaviour depended on this; the refusal names `/help`, so the recovery is visible.
