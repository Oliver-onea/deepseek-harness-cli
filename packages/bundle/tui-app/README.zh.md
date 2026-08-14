# `@deepseek-ai/dsh-tui-app`

[English](README.md) | 中文

dsh 的终端界面 bundle，也是调用未指定 profile 时 `dsh` 启动的那个。[`cordis.patch.yml`](cordis.patch.yml) 覆盖在 [`dsh-base`](../base/README.md) 之上：它提供终端 persona 与工具模式，关闭 HMR（在活动屏幕下重载插件会重建终端正在绘制的组件），把 Code Mode 的 worker 作为核心执行能力挂载，并插入本包的 `tui-startup` 提供者以及 [`dsh-tui`](../../ui/tui/README.md) 屏幕。

agent 平面保持在 base 放置的位置。这个界面是单会话的，并在进程级组合一个 agent，因此它不挂载 preset 名册，base 的工具、提示与委派行就是该 agent 自己的 —— 这与 [`dsh-web-app`](../web-app/README.md) 相反，后者把它们移到每会话 preset 之后。

## 唯一配置的 agent

base 把 `agent-loop` 的 `agents: []` 留给按请求创建会话的界面。本 bundle 恰好配置一个，全新或恢复，由 startup 提供者决定是哪一种：`--resume <session>` 会先通过持久化层检查该会话，再发布 `resumeSessionId`；其他任何启动都在调用目录中铸造一个新的 `sessionId`。缺失或不可读的持久日志会在依赖行激活或屏幕进入备用模式前拒绝启动。agent 行与屏幕行从提供者读取同一个 id，因此二者互不依赖挂载顺序。

## 命令行

普通的 `tui-startup` 提供者（[`src/startup.ts`](src/startup.ts)）注入 `ctx.cmdlineArgs`（[`dsh-cmdline`](../../boot/cmdline/README.md)）和 `ctx.sessionPersistence`，解析本应用的标志，验证请求恢复的会话，并提供 `tuiStartup`。由标志配置的行注入该服务，因此 Loader 只在它存在之后才解析这些表达式 —— 而 `dsh --help` 什么都不提供，于是既不组合 agent 也不组合屏幕。

| 参数 | 含义 |
|---|---|
| `[task...]` | 首个任务，以空格连接；屏幕打开并从它开始。 |
| `--` | 结束应用选项解析；后续形似 flag 的 token 会成为任务文本。 |
| `--resume <session>` | 继续一个已持久化的会话，而不是新建。 |
| `--model <model>` | 本会话使用的模型 id。 |
| `--provider <provider>` | 本会话使用的 provider 路由。 |
| `--no-color` | 不带 ANSI 样式渲染。 |

## Model Experience

### 终端 persona

#### What the model sees

`deployment:persona` 分节说明模型的角色，通过 `{{model}}` 与 `{{cwd}}` 变量给出模型 id 与工作目录，并说明它正在与终端前的人对话 —— 因此回答应简短、易扫读，且相比描述工作更应直接完成工作。模型看到的其余一切 —— 工具、提示分节、委派 —— 都来自这一 patch 层所覆盖的 base 行。

#### Token effect

每会话一个提示段落；进程内恒定。

#### KV Cache effect

该分节位于系统提示的稳定前缀中，并在会话生命周期内固定（模型 id 在终端安装其选择时捕获），因此不会跨回合使缓存失效。

## Known Limitations and Deferred Work

- **`ctx.appExit` 由启动器拥有** —— 在 `dsh` 启动器之外启动该 profile 会让 `/exit` 与 `ctrl+c` 缺少退出请求，会话因而无法自行结束。
- **一个进程一个 agent** —— 该 profile 组合单个已配置的 agent；同时进行两个对话意味着两个进程，各自拥有自己的屏幕。
