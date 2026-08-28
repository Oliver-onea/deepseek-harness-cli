# Agent Note: A Tauri desktop shell over the web frontend

Status: proposed

English | [中文](2026-08-28-tauri-desktop-shell.zh.md)

## Problem

`dsh --profile web` serves the built frontend over HTTP and prints a URL: reaching the product means opening a browser and keeping the launching terminal alive. The repository ships a terminal surface (`dsh --profile tui`) and a browser surface, and has no decision on whether a desktop surface should exist, what it would own, or how it would relate to either.

## Proposal

Add a Tauri shell that hosts the existing `apps/web` build in a native WebView and owns the local harness process, so starting the application is one action and quitting the window ends the run. The frontend is not rewritten and not forked: the shell is a delivery surface over `@deepseek-ai/dsh-client-web`, in the same relationship to it that `apps/web` already has.

### What the web surface owns today

`@deepseek-ai/dsh-web-app` ([packages/bundle/web-app](../../../../packages/bundle/web-app)) resolves the built `apps/web` dist as workspace knowledge rather than user config, mounts it as the `frontend-static` fallback owner over `webServer`, prints the URL line, registers the `app:web-surface` prompt section and the shell-visible `DSH_WEB_URL`, and carries this invocation's `--trusted-host` authorities. `PROFILE_TEMPLATES.web` composes `@deepseek-ai/dsh-base` with that bundle; `headless` adds `@deepseek-ai/dsh-headless` over the same pair.

### Prior art for native source

`native/landlock-run/` is a Rust workspace inside the root pnpm workspace and lockfile, published as an entry package plus per-platform packages held as npm `optionalDependencies`, with the `Landlock Run` and `Landlock Run Release` workflows owning build, per-architecture test, and release. A Tauri crate follows that placement and release precedent instead of introducing a second convention for native code.

### Open decisions

1. **Crate placement.** Under `native/` or a new root directory, and its relationship to the root pnpm workspace, the lockfile, and the TypeScript face configs.
2. **Process ownership.** Whether the shell spawns `dsh --profile web` as a Tauri sidecar or attaches to a server the user already runs. A sidecar makes the shell a process supervisor, so its lifecycle, cancellation, and teardown follow [docs/defensive-patterns.md](../../../../docs/defensive-patterns.md) and the one-controller-per-operation rule.
3. **Trust.** How the `--trusted-host` fence, the bind address, and any credential resolve for a desktop launch. Local delivery is not a reason to widen the fence silently, and a missing or ambiguous value fails loud at the earliest resolvable point.
4. **Model-visible surface.** `app:web-surface` and `DSH_WEB_URL` are written for the model, orienting it in a browser. Under a desktop shell that text may be false; where it is, the shell registers its own surface section rather than reusing an inaccurate one, and the sections stay reconstructable from the session log.
5. **Composition.** Whether a `desktop` profile and its own bundle patch layer exist, or the `web` profile is reused with shell-supplied values. Deployment-varying choices are validated `Config` fields settable from `cordis.yml`, not constants in the plugin.

## Alternatives considered

**Electron.** Electron is the better-trodden path for wrapping a React frontend and needs no Rust knowledge, and the label taxonomy already treats browser and Electron delivery as one `area/web` domain, so it is in scope. It loses on artifact size — a Chromium per application — and on repository fit: this repository already builds, tests, and releases Rust across architectures, so a Tauri crate reuses machinery that exists rather than adding a second packaging stack.

**A script that starts the server and opens the default browser.** Far cheaper, needs no native code, and delivers the one-action launch. It loses because it gives the product no window identity, no lifecycle ownership, and no single quit path, and because it cannot answer decision 4: the surface stays a browser tab, so nothing about the model-visible orientation text changes and the desktop question is deferred rather than settled.

**Rewriting the frontend as a native UI.** Discards a working client and duplicates every surface it already covers, with no user-visible gain over the same pages in a WebView. The terminal case is already served by the TUI surface.

**A Rust crate outside the root pnpm workspace.** Isolates the native build from Node tooling, at the cost of a second lockfile, a second CI shape, and a version skew between the shell and the harness it launches. The `landlock-run` precedent chose the opposite trade and is the one this repository already maintains.

## Acceptance criteria

- A build produces a runnable desktop application that opens the existing frontend, with behavior matching `dsh --profile web`.
- The five open decisions above are settled and recorded as decisions, and this note moves to `implemented/architecture/` in the change that lands the work.
- The repository gates pass on macOS. Platforms the change could not verify are named in the pull request rather than reported as passing.
- The user-visible GUI change carries a GIF recorded from the real server and model flow, per [docs/testing.md](../../../../docs/testing.md).

## Risks

- A WebView toolchain widens the build matrix per platform. Linux needs `webkit2gtk-4.1`, which the cloud container used for this repository's agent sessions does not have, so Linux builds cannot be verified there and the work belongs on a developer machine.
- A sidecar process can outlive an abnormal shell exit. Orphan cleanup is a design obligation of decision 2, not a follow-up.
- The coverage gate is per-file 100% over `packages/*/*/src` and covers TypeScript only. Rust needs its own test signal, or a stated gap under `## Known Limitations and Deferred Work` in the owning README.
- A desktop shell invites shipping harness credentials and host access under a friendlier surface than the browser fence assumes. Decision 3 is the control, and it is settled before the shell ships rather than after.
