# Agent Note: this fork's own version line

Status: proposed

English | [中文](2026-08-27-fork-version-line.zh.md)

## Problem

This repository is a fork of DeepSeek Harness that carries roughly 20,000 lines upstream does not have, and until now it was indistinguishable from the product it forked.

- Every one of its 224 manifests read `0.1.0-rc.5`, the version of the upstream commit it branched from. Upstream has since published `0.1.0-rc.6`, `rc.7`, `rc.8`, `0.1.1-rc.1` and `0.1.1-rc.2`, so the fork's number sat *inside* a live upstream line while describing a tree upstream never had.
- The cold-open header and `dsh --version` both announced `DeepSeek Harness v0.1.0-rc.5`. A reader could not tell a local build from the released product, and a bug report from this build would have been filed against upstream's version.
- The packages are named `@deepseek-ai/*`, a scope whose npm maintainers are `imccyu` and `tianyicui-deepseek`. `pnpm release:publish` would attempt to publish 224 packages into someone else's namespace.

There was also no tag anywhere in the repository, so nothing recorded where the fork left upstream.

## Proposal

**The fork keeps its own semantic version line, and identity is carried by the name rather than by the number.**

1. **Version.** An independent line starting at `0.2.0`. The number describes what changed *in this fork*: a feature is a minor, a fix is a patch, a break is a major. Starting at `0.2.0` also lifts the whole line clear of upstream's live `0.1.x`, so no number this fork ever prints can be mistaken for an upstream release.
2. **Lockstep.** All 224 members and the workspace root move together, which is what `scripts/release/bump.ts` already enforces for the `dsh` family. Nothing here changes that.
3. **Identity.** The header and `--version` announce `DeepSeek Harness (fork)`. The marker, not the digits, is what tells a reader what they are running.
4. **Upstream base.** A tag `upstream/<version>` marks the commit the fork branched from — `upstream/0.1.0-rc.5` at `47f943859b`. `git log upstream/0.1.0-rc.5..master` is then the exact answer to "what has this fork added", and the next upstream merge adds the next such tag.
5. **Release tags.** `dsh-v<version>`, the form `bump.ts` already prints.
6. **Publishing.** Nothing is published. The scope belongs to upstream, and this build is installed by symlinking `apps/cli/lib/bin.js` onto `PATH`.

## Alternatives considered

**Track upstream's number and add a fork suffix, e.g. `0.1.1-rc.2+oliver.3`.** Rejected on a mechanical fact: SemVer ignores build metadata when comparing, so two different fork builds would compare *equal*, and the reader could not tell which was newer. Moving the marker into the prerelease field instead (`0.1.1-rc.2.oliver.3`) sorts correctly but renumbers the fork every time upstream releases, while the fork's own changes earn no increment.

**Calendar versioning, e.g. `2026.8.27`.** Never collides and always increases, which is genuinely attractive. Rejected because 224 packages depend on each other through range operators; `^` carries no meaning across a calendar line, and the release tooling reasons about `major`/`minor`/`patch`.

**Keep `0.1.0-rc.5` and change only the name.** Cheapest, and the name does carry the identity. Rejected because the number would still claim a place in upstream's live line, and the next merge from upstream would make "which 0.1.0-rc.5 is this" unanswerable.

**Rename the scope to something the author owns.** Correct, and required the day anything is published. Deferred: 224 manifests plus every internal dependency, import path and `cordis.yml` reference, for a build that is installed by symlink and published nowhere. The marker in the header closes the identity gap that actually bites today.

## Acceptance criteria

1. Root and all 224 members read `0.2.0`.
2. The header and `--version` identify the build as a fork.
3. `upstream/0.1.0-rc.5` tags the branch point, and `git log upstream/0.1.0-rc.5..master` lists only this fork's work.
4. A release is tagged `dsh-v0.2.0`.
5. Nothing publishes to npm.

## Risks

- **The scope is still upstream's.** The guard against an accidental `release:publish` is that no one runs it; a stray invocation would fail at the registry with a permission error rather than doing damage, but it should not be relied on as the only barrier. Renaming remains the real fix and is the first task if this is ever distributed.
- **`(fork)` widens the header's first line by seven columns.** The lockup layout degrades to a one-line header below 78 columns, which already truncates, so the marker is what survives.
