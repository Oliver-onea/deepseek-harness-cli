# DeepSeek Harness

English | [中文](README.zh.md)

## About this fork

This repository is a personal fork of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), **kept for learning and reference only**. It is frozen, is not maintained, and is not a source of `dsh` — install the upstream package instead.

It left upstream at `47f943859` (2026-08-13) and does not track it. Over that point it adds:

- `packages/ui/tui` and `packages/bundle/tui-app` — a full-screen alternate-screen terminal front door, booted as the default `dsh --profile tui`.
- `packages/credentials/command-credential` — a terminal `/credential` command.
- `session/steer` and `approval/request` over the JSON-RPC SDK, with matching Python-client methods.

It lacks everything upstream has shipped since that date: over 10,000 commits as measured on 2026-08-29. Upstream has since generalized the launcher so that a terminal surface installs as an out-of-tree plugin (`dsh plugin --profile tui add <package>`), which is the supported way to do what this fork wired in by hand.

The desktop-client work once proposed here moved to a separate repository; its rationale stays in [the rejected Agent Note](.agents/notes/rejected/architecture/2026-08-28-tauri-desktop-shell.md).

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh
```

The command opens the terminal interface; `dsh "run the tests"` opens it and starts on that task. See the [terminal front door](packages/ui/tui/README.md).

For the browser interface instead:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI, served at `http://127.0.0.1:3080` by default. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh
```

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
