# DeepSeek Harness

[English](README.md) | 中文

> **这是一份个人 fork，不是 DeepSeek 的发布版。**
>
> 它从上游的 `0.1.0-rc.5` 分叉而来（标记为 `upstream/0.1.0-rc.5`），并带有上游没有的工作：终端的视觉层与配色、无密钥首次运行时会报出缺失的凭据而不是沉默、`/credential` 命令，以及 Python SDK 的交互能力对齐。`git log upstream/0.1.0-rc.5..master` 是完整清单。
>
> 它不向 npm 发布任何东西，因此 **`npx @deepseek-ai/dsh` 得到的是上游发布版，不是这棵树**。运行这份 fork 的唯一方式是下面的“从源码运行”。它的版本线是自己的——这里的 `0.2.0` 与上游的 `0.1.x` 无关，终端也会自称 `DeepSeek Harness (fork)`，使一份本地构建不会被误认为已发布的产品。

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 开发者预览

DeepSeek Harness 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

## 运行

### 通过 `npm` 运行 —— 仅限上游

`npx` 从登录源安装，而这份 fork 不向那里发布任何东西，所以这些命令得到的是**上游的 DeepSeek 发布版**。列出它们是因为那是运行上游的方式，不是运行这份 fork 的方式；对这棵树请使用下面的“从源码运行”。

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh
```

该命令会打开终端界面；`dsh "run the tests"` 会打开它并从该任务开始。详见[终端前门](packages/ui/tui/README.md)。

如需改用浏览器界面：

```sh
npx @deepseek-ai/dsh web
```

该命令会启动 Web UI，默认地址为 `http://127.0.0.1:3080`。详见 [Web UI 指南](docs/user/guide/index.md)。

### 从源码运行

这才是运行**这份 fork** 的方式。它需要 Node `^22.19.0 || >=24.0.0` 与 pnpm 11：

```sh
git clone https://github.com/Oliver-onea/deepseek-harness-cli.git
cd deepseek-harness-cli
pnpm install
pnpm run build
pnpm dsh
```

`pnpm dsh` 会打开终端。若想在 `PATH` 上得到一个裸的 `dsh`，把构建出的可执行文件链接过去：

```sh
ln -s "$PWD/apps/cli/lib/bin.js" ~/.local/bin/dsh
```

启动不需要 API key。没有 key 时发送消息，终端会报出缺失的凭据；用 `/credential DEEPSEEK_API_KEY <值>` 就地存入，或在启动前导出 `DEEPSEEK_API_KEY`。

如需改为克隆上游，请使用 `https://github.com/deepseek-ai/deepseek-harness.git`。

## 社区与支持

- **这份 fork 没有 issue 追踪**，而它的改动也不该由上游负责支持。上游的 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 面向 DeepSeek 发布版；在向那里报告之前，请先对照上游确认问题是否存在。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="assets/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="assets/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="assets/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发

请先阅读[开发指南](docs/development.md)与[架构文档](docs/architecture.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
