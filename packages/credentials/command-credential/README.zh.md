# @deepseek-ai/dsh-command-credential

[English](README.md) | 中文

终端进入凭据 seam 的写入路径：通过 [`ctx.commands`](../../interaction/commands/README.md) 注册的一个全局 `/credential` 命令，因此每个组合出的命令适配器都能发现它。它经由 [`ctx.credentials`](../credentials/README.md) 显示或存储一个凭据引用——终端中与 web 版 Models 页面等价的能力——且从不编辑 `.env`：存储写入经由服务进入提供方管理的来源（在 [`dsh-credentials-local`](../credentials-local/README.md) 下即 `$DSH_HOME/.credentials.yaml`）。

## 命令契约

| 输入 | 结果 |
|---|---|
| `/credential` | 用法错误，点名参数形态。 |
| `/credential <REF>` | 不含值的 `describe` 事实：是否已配置、提供来源、可写性——当只读来源正在供应该引用时，附带遮蔽（shadow）警告。 |
| `/credential <REF> <value>` | 经由服务执行 `set`；确认文本只点名该引用。 |

`REF` 必须是 POSIX shell 标识符（`credentialRef` 会拒绝其他任何形式，点名出错的文本但绝不点名值）。值为该行去掉首尾空白后的剩余部分；内部空白保留；剩余为空时，存储行会转为描述请求。

优先级规则属于 seam，而不属于本命令。当启动环境以只读方式提供某引用时，`set` 会拒绝，而不是写入一个解析永远看不到的变更；本命令把该拒绝作为错误文本返回，因此被遮蔽的写入会被明确报告，而不是静默无效。同样的事实也会在 `/credential <REF>` 中预先给出（`configured read-only from env; storing a value would be shadowed by it`）。

机密永远不进入日志。该定义设置 `recordInput: false`，因此 `command/run` 省略 `args`；所有成功与错误文本都不含值；并且有一道脱敏守卫，在提供方失败信息成为命令输出之前，把值从中抹去。`command/run`/`command/done` 仍是仅有的记录，且只进日志、不进入有序 surface、`deriveMessages()` 与模型请求。终端输入行不做掩码——见「已知局限」。

本插件只注入 `commands`。注册不能等待凭据提供方完成加载——快速启动的终端在那之前就已应答 `/help`——因此处理器在执行时读取 `ctx.get('credentials')`，并在组合未挂载任何凭据服务时报告清晰错误。

## 组合

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'
- id: command-credential
  name: '@deepseek-ai/dsh-command-credential'
```

出厂的 `dsh` base 会把该命令与本地提供方一并挂载；它没有任何配置。Headless 模式、ACP 自动化与 JSON-RPC 不提供命令适配器，因此不暴露它。

## 模型体验

### 人工 `/credential` 捕获

#### 模型看到什么

什么都看不到。slash 输入、服务写入与确认文本均不出现在模型请求中：`recordInput: false` 把值挡在 `command/run` 之外，命令生命周期记录只进日志，而存储的值存放在凭据来源中——消费者按次解析，从不渲染进提示词。

#### Token 影响

零直接 token 影响。无论是存储的值还是用法错误，都不会在当前或后续回合增加模型 token。

#### KV Cache 影响

与模型请求路径无关。存储凭据只会向会话日志追加命令生命周期记录，已可复用的请求前缀保持不变；值本身从不进入请求前缀。

## 已知局限与待办工作

- **终端输入不掩码所输入的机密**——值是一个键入的命令参数；输入过程中它在输入行上可见，并保留在终端回滚缓冲里。掩码输入需要终端输入层的支持，而当前出厂表面均不具备。
- **无删除能力**——seam 的 `unset` 未暴露；已存储的引用只能通过存储新值来轮换，删除需借助 web 表面或文档本身。
- **每次调用只处理一个引用**——存储多个引用需要逐个执行。
