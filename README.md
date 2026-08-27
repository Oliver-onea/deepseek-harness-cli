# DeepSeek Harness

English | [中文](README.zh.md)

> **This is a personal fork, not the DeepSeek release.**
>
> It branched from upstream at `0.1.0-rc.5` (tagged `upstream/0.1.0-rc.5`) and carries work upstream does not have: the terminal's visual layer and colour palette, a keyless first run that reports the missing credential instead of falling silent, a `/credential` command, and interactive parity for the Python SDK. `git log upstream/0.1.0-rc.5..master` is the full list.
>
> It publishes nothing to npm, so **`npx @deepseek-ai/dsh` gives you the upstream release, not this tree**. The only way to run this fork is the "Run from source" section below. Its version line is its own — `0.2.0` here is unrelated to upstream's `0.1.x`, and the terminal announces itself as `DeepSeek Harness (fork)` so a build is never mistaken for the released product.

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm` — upstream only

`npx` installs from the registry, and this fork publishes nothing there, so these commands give you **the upstream DeepSeek release**. They are listed because they are how upstream is run, not how this fork is run; for this tree, use "Run from source" below.

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

This is how you run **this fork**. It needs Node `^22.19.0 || >=24.0.0` and pnpm 11:

```sh
git clone https://github.com/Oliver-onea/deepseek-harness-cli.git
cd deepseek-harness-cli
pnpm install
pnpm run build
pnpm dsh
```

`pnpm dsh` opens the terminal. To get a bare `dsh` on your `PATH`, link the built binary:

```sh
ln -s "$PWD/apps/cli/lib/bin.js" ~/.local/bin/dsh
```

No API key is needed to start. Send a message without one and the terminal reports the missing credential; `/credential DEEPSEEK_API_KEY <value>` stores it, or export `DEEPSEEK_API_KEY` before launching.

To clone upstream instead, use `https://github.com/deepseek-ai/deepseek-harness.git`.

## Community and support

- **This fork has no issue tracker**, and its changes are not upstream's to support. Upstream's [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) are for the DeepSeek release; check a problem against upstream before reporting it there.
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
