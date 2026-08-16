# Agent Note: Rescope token rule cannot distinguish event names from package references

Status: proposed

English | [中文](2026-08-16-rescope-token-rule-event-name-ambiguity.zh.md)

## Problem

`scripts/rescope-vendor.ts` rewrites delimited package-name tokens — quoted or backticked strings optionally followed by `/subpath` — from upstream names like `cordis` to the rescoped `@deepseek-ai/cordis`. The same token rule also matches runtime event names such as `cordis/request-run`, `cordis/dynamic-package`, and `cordis/inspect-query`, because the rule has no way to tell a package specifier from a string that merely begins with the upstream package name.

Those `cordis/*` strings are not imports. They are Cordis event names emitted by `packages/extensions/cordis-host-runner/src/index.ts` and `inspect-registry.ts`, declared in the event map at `packages/extensions/cordis-host-runner/src/types.ts`, forwarded through `packages/api/remotes/src/remote-events.ts`, and consumed by `packages/extensions/cordis-client-runner/src/client/index.ts` and `packages/extensions/ui-cordis/src/client/index.ts`. The bare form is the wire contract: the producer and the type declaration use it, and consumers listen for it. Rewriting only the consumer side — for example, changing `ctx.remote.$on('cordis/request-run', …)` to `'@deepseek-ai/cordis/request-run'` — leaves the producer and declaration using the bare name, so the listener never fires.

The same ambiguity hits other product identifiers that share the `cordis` prefix: the UI locale namespace `cordis` used by `PropsLocale<'cordis'>`, `t('cordis')`, and `NS = 'cordis'` in `packages/extensions/ui-cordis/src/client/`; the plugin-id prefix `cordis:` stripped by `packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx`; and the event-scope key `cordis` in `scripts/gen-cordis-catalog.ts` that routes generated catalog pages.

## Proposal

Keep the runtime event names and related product identifiers bare. Add narrow `GENERIC_SKIPS` entries in `scripts/rescope-vendor.ts` for every file where the token rule otherwise rewrites a non-package string, with a one-line reason naming what the string actually is. Do not widen the token rule: narrowing exemptions keeps the gate able to catch a genuine missed package reference elsewhere.

The 26 files covered by this exemption set are:

- Event names in generated and hand-written docs (`docs/event-producer-consumer.md`, `docs/subsystems/extensions.md`, and their Chinese pairs), the forwarded-event list (`packages/api/remotes/src/remote-events.ts`), the host runner (`src/index.ts`, `src/inspect-registry.ts`, `src/types.ts`), the client runner (`src/client/index.ts`, `src/client/runtime.ts`, tests), the inspect/registry tests, the tool-cordis generated catalog and its filter, and the ui-cordis event listeners.
- The UI locale namespace `cordis` and the `@` input-trigger source id in `packages/extensions/ui-cordis/src/client/`.
- The plugin-inventory display strings in `packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx`.
- The event-scope routing key in `scripts/gen-cordis-catalog.ts`.

## Alternatives considered

**Rewrite the event names to the scoped form everywhere.** Rejected because it changes the wire contract and breaks any consumer or producer that still emits or listens for the bare name; a partial rename is worse than no rename because it fails silently.

**Change the rescope token rule to exclude `/`-separated strings that look like event names.** Rejected because the rule intentionally matches `'cordis/subpath'` for real package subpath imports such as `'@deepseek-ai/cordis-plugin-loader'`, and any heuristic for "event name" would be fragile and silently skip genuine package references.

**Leave the residues as an allowed failure.** Rejected because `rescope-vendor:check` is part of `hygiene`, and an allowed failure would steadily accumulate real missed renames.

## Acceptance criteria

- `pnpm run rescope-vendor:check` exits 0 with no residue.
- No runtime event name, component identifier, preset id, or directory name is rewritten.
- `pnpm run hygiene`, `pnpm run doc-sync`, `pnpm run typecheck`, and `pnpm run lint` pass.
- The TUI interaction test suite still reports 276 passed / 15 files.

## Risks

A future file may contain both a genuine package reference and a false-positive `cordis` string. A file-level skip would then silently miss the real reference. The remedy is to prefer exact edits (`EXACT_EDITS`) for such files, or to split the false positives into a separate file. This set was reviewed file by file and no mixed case was found.
