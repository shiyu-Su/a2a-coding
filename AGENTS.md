# a2a-coding — ZCode 工作区指令

> 本文件对应 opencode 宿主根 `opencode.json` 的 `instructions` 数组（canonical 样例：`opencode.json.example`，接入说明见 `flow/hosts/opencode.md`）。ZCode 没有 `instructions` 数组机制，规范引入走本文件；宿主接入配置（MCP a2a + 守卫 hook）在 `.zcode/config.json`。

## 需求流程（Requirement Flow）

本项目的需求流程规范由 `flow/` 包提供（单一事实源），ZCode 宿主经本文件加载：

- @flow/spec/需求流程.md —— Step 0–3 骨架 / 每步判据 / 产出物 / planlog 与发版纪律
- @flow/spec/引擎映射.md —— 步骤 ↔ Feature 状态 ↔ 驱动方、两道确认门、工具面

若上面的 `@` 引用未被宿主展开为文件内容，进入需求工作前先 Read 这两份文件（守卫 hook 对这两个路径放行只读）。

## 编排等待纪律（派发后必须用脚本阻塞等待）

- **派发 Feature 后**：`node scripts/watch-feature.mjs <featureId>`（`a2a_feature_approve` 之后即调用）；按退出码分流 `0/10/11/12/13/20/1`。
- **派发常规 `a2a_call` 任务后**（v0.8.2 起）：`node scripts/watch-task.mjs <taskId...>` —— 只读等待到目标 id 全部达成退出判据（`completed` / `failed` / `blocked` / `input-required`）或窗口耗尽；**入参必须是 `a2a_call` 返回的 taskId（本地 id）**（传 Feature 节点的 `remoteTaskId` 会 404）。
  - 退出码**三档**：`0` **等到了**（**`failed` / `blocked` 也退 0 —— 0 ≠ 成功**，成败看 stdout 的状态行）· `20` 窗口耗尽 · `1` 脚本错误。
  - **脚本只打印状态**：需要详情（失败原因 / 待裁决问题 / 结果全文）时**自行调用 MCP 工具 `a2a_task_status` 一次**获取；**禁止**用 `a2a_task_status` / `a2a_tasks` 手工轮询等待。
  - 默认窗口 `--interval 10000 × --max 180`（30 min）可能超过单次工具调用上限：未结束时**再次调用同一条命令**即可（只读、可重复调用）。

## 单元路径守卫（无条件生效）

PreToolUse 守卫（`.zcode/hooks/guard-unit-paths.cjs`，对所有会话生效，不区分角色）拒绝 Read / Edit / Write / Grep：`orch/**` 与 `machine/**`（单元代码：分析经 MCP 工具由项目 agent 返回、改动经 `a2a_call` 派发，宿主不直接读写）以及 `flow/**`（流程包资产；两份规范文件对 Read/Grep 放行只读）。Bash 通道走启发式：命令串中出现 orch / machine / flow 独立路径段即拦，另盖通配混淆、Windows 8.3 短名、仓库级递归搜索（grep -r / rg）；`orch/scripts/` 运维脚本白名单（如 bridgectl.mjs）；两份规范文件请用 Read/Grep 工具而非 Bash。日常开发需要直读直改单元代码时，在 `.zcode/config.json` 将 `hooks.enabled` 置 false 临时停用本守卫，用完恢复（守卫自测：`node .zcode/hooks/guard-unit-paths.cjs --selftest`）。

a2a MCP 已在 `.zcode/config.json` 注册（远程端点 `http://127.0.0.1:8787/mcp`，会话前需桥常驻在跑，见 `orch/scripts/bridgectl.mjs`）。残余缺口与设计 rationale 见 `CLAUDE.md`「架构约束」。
