# Agent Note: Rescope 的 token 规则无法区分事件名与包引用

Status: proposed

[English](2026-08-16-rescope-token-rule-event-name-ambiguity.md) | 中文

## Problem

`scripts/rescope-vendor.ts` 会把带定界符的包名 token（被引号或反引号包围、可选后跟 `/subpath` 的字符串）从上游名称如 `cordis` 改写为 rescope 后的 `@deepseek-ai/cordis`。同一个 token 规则也会匹配运行时事件名，例如 `cordis/request-run`、`cordis/dynamic-package` 和 `cordis/inspect-query`，因为该规则无法区分一个字符串到底是包说明符，还是仅仅以上游包名开头。

这些 `cordis/*` 字符串并不是 import。它们是 Cordis 事件名，由 `packages/extensions/cordis-host-runner/src/index.ts` 和 `inspect-registry.ts` 发出，在 `packages/extensions/cordis-host-runner/src/types.ts` 的事件映射中声明，通过 `packages/api/remotes/src/remote-events.ts` 转发，并被 `packages/extensions/cordis-client-runner/src/client/index.ts` 和 `packages/extensions/ui-cordis/src/client/index.ts` 消费。裸形式就是 wire 契约：生产者和类型声明都使用它，消费者监听它。如果只改写消费端——例如把 `ctx.remote.$on('cordis/request-run', …)` 改成 `'@deepseek-ai/cordis/request-run'`——而生产者和声明仍使用裸名，监听器就永远不会触发。

同样的歧义也出现在其他共享 `cordis` 前缀的产品标识符上：`packages/extensions/ui-cordis/src/client/` 中 UI 语言命名空间 `cordis`（用于 `PropsLocale<'cordis'>`、`t('cordis')`、`NS = 'cordis'`）; `packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx` 剥离的插件 id 前缀 `cordis:`; 以及 `scripts/gen-cordis-catalog.ts` 中用于路由生成目录页面的事件作用域键 `cordis`。

## Proposal

保持运行时事件名和相关产品标识符为裸名。在 `scripts/rescope-vendor.ts` 中为每个 token 规则会改写非包字符串的文件添加窄范围的 `GENERIC_SKIPS` 条目，并在一行说明中写明该字符串实际是什么。不要放宽 token 规则：窄豁免能让 gate 仍然能够在别处捕获真正的漏改包引用。

本次豁免集覆盖的 26 个文件包括：

- 生成和手写文档中的事件名（`docs/event-producer-consumer.md`、`docs/subsystems/extensions.md` 及其中文版本）、转发事件列表（`packages/api/remotes/src/remote-events.ts`）、Host runner（`src/index.ts`、`src/inspect-registry.ts`、`src/types.ts`）、Client runner（`src/client/index.ts`、`src/client/runtime.ts`、测试）、inspect/registry 测试、tool-cordis 生成目录及其过滤器，以及 ui-cordis 事件监听器。
- `packages/extensions/ui-cordis/src/client/` 中的 UI 语言命名空间 `cordis` 和 `@` 输入触发源 id。
- `packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx` 中的插件清单显示字符串。
- `scripts/gen-cordis-catalog.ts` 中的事件作用域路由键。

## Alternatives considered

**把所有事件名都改写成带 scope 的形式。**  rejected，因为这会改变 wire 契约，并破坏仍在发出或监听裸名的生产者或消费者；局部重命名比不重命名更糟，因为它会静默失败。

**修改 rescope token 规则以排除看起来像事件名的 `/` 分隔字符串。** rejected，因为该规则原本就需要匹配 `'cordis/subpath'` 这种真实包子路径引用（如 `'@deepseek-ai/cordis-plugin-loader'`），任何“事件名”启发式都脆弱，并会静默跳过真正的包引用。

**把这些残留作为允许的失败保留。** rejected，因为 `rescope-vendor:check` 是 `hygiene` 的一部分，允许的失败会逐渐累积真正的漏改重命名。

## Acceptance criteria

- `pnpm run rescope-vendor:check` 退出 0 且无残留。
- 不改写任何运行时事件名、组件标识符、preset id 或目录名。
- `pnpm run hygiene`、`pnpm run doc-sync`、`pnpm run typecheck` 和 `pnpm run lint` 通过。
- TUI 交互测试套件仍报告 276 passed / 15 files。

## Risks

未来某个文件可能同时包含真正的包引用和误报的 `cordis` 字符串。文件级 skip 会静默漏掉真正的引用。补救措施是对这种文件优先使用精确编辑（`EXACT_EDITS`），或将误报拆到单独文件。本集合已逐文件审查，未发现混合情况。
