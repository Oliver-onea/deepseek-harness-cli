# Agent Note: 终端凭据交互体验与 /key 斜杠命令

Status: proposed

[English](2026-08-26-terminal-credential-ux.md) | 中文

## Problem

用户在未配置 API key 的情况下启动 `dsh` 交互式终端，可以正常进入会话，但发送消息后没有任何响应或错误提示，终端如同假死。底层 agent loop 实际上抛出并捕获了 `MISSING_CREDENTIAL` 错误并记录了带错误原因的 `turn/end` 事件，但终端 transcript 未能将该失败的 turn 折叠渲染为可见的错误通知。

此外，现有 LLM 适配器中的错误提示仅引导用户通过「web Models page」进行配置，对于身处 CLI 终端的用户而言该指引毫无用处且令人困惑。之前没有任何 CLI 标志、斜杠命令或终端内机制可以直接向受管的 `$DSH_HOME/.credentials.yaml` 写入 API key，用户只能手动编辑文件。

## Proposal

1. **终端错误可见性**：
   - 在 `packages/ui/tui/src/transcript.ts` 中，将以 error 结尾的 turn 折叠为终端 transcript 中的 error 级别通知条目。
   - 针对未解决的凭据缺失重复发送时，替换现有错误通知而不是在多轮用户输入间重复堆叠相同的错误信息。实时视图与会话恢复重放视图保持一致。

2. **终端内 `/key` 命令**：
   - 在 `@deepseek-ai/dsh-credentials-local` 中，当 `commands` 服务可用时注册 `/key` 斜杠命令（`/key [<ref>] <value>`）。
   - 运行 `/key <secret>` 默认存储 `DEEPSEEK_API_KEY`，而 `/key <ref> <secret>` 允许存储任意具名凭据引用至 `$DSH_HOME/.credentials.yaml`。
   - 命令显式声明 `recordInput: false`，确保键入的机密参数绝不进入 `command/run` 生命周期事件、持久化会话日志或模型请求。
   - 命令遵循优先级规则：如果凭据被启动环境以只读形式遮蔽，将返回明确错误指出环境变量只读，而不是静默执行无生效的写入。

3. **跨界面的准确操作引导**：
   - 更新 LLM 适配器与搜索提供方（`llm`、`llm-deepseek`、`llm-pi-ai`、`web-search-deepseek`）中的错误信息，真实覆盖终端中的 `/key` 命令与 Web 端的 Models 页面。

## Alternatives considered

**通过交互式遮蔽 readline 提示输入机密。** 已拒绝。目前的终端输入层不支持在斜杠命令处理流程中发起遮蔽输入或模态文本提示，若引入此特性需要对 TUI 和 pi-tui 进行侵入式修改。将密钥作为命令参数接收简单标准，并在 README 中做出了明确提示。

**直接在 `packages/ui/tui` 内部硬编码 `/key` 命令。** 已拒绝。命令应当作为模块化插件贡献，通过 `commands` capability seam 注册，由管理凭据的包（`credentials-local`）拥有，而不是在 UI 入口处做特殊硬编码。

**通过命令直接编辑 `.env` 文件。** 已拒绝。`$DSH_HOME/.credentials.yaml` 是受管可写的凭据存储，具备文件锁、0600 权限以及明确高于项目与用户 `.env` 的优先级保障。

## Acceptance criteria

- 无 key 启动 `dsh` 仍受支持；在未配置 key 时发送消息会在终端 transcript 中明确展示 `MISSING_CREDENTIAL` 通知，且会话保持可用。
- 针对相同缺失 key 重新发送消息会替换错误通知而非无限制堆叠重复项。
- 错误通知在 `--resume <session>` 恢复时能够正常重放。
- `/key` 命令可在 `/help` 与 `/` 自动补全菜单中被发现。
- `/key <value>` 与 `/key <ref> <value>` 能够写入 `$DSH_HOME/.credentials.yaml` 并热发布更新后的凭据。
- 机密绝不泄露到会话事件、命令完成文本或 transcript 中。
- 单元测试、旅程快照测试、类型检查、代码规范检查及 doc-sync 全部通过。

## Risks

- 终端输入不会对键入的参数进行掩码遮蔽；屏幕上键入的机密会保留在本地终端回滚缓冲区中直至被清除。该点已在包 README 中明确说明。
- 在跨进程文件锁控制下，对 `$DSH_HOME/.credentials.yaml` 的并发写入仍遵循后写胜出。
