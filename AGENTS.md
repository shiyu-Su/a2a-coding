# a2a-coding — ZCode 工作区指令

> 本文件对应 opencode 宿主根 `opencode.json` 的 `instructions` 数组（canonical 样例：`opencode.json.example`，接入说明见 `flow/hosts/opencode.md`）。ZCode 没有 `instructions` 数组机制，规范引入走本文件；宿主接入配置（MCP a2a + 守卫 hook）在 `.zcode/config.json`。

## 需求流程（Requirement Flow）

本项目的需求流程规范由 `flow/` 包提供（单一事实源），ZCode 宿主经本文件加载：

- @flow/spec/需求流程.md —— Step 0–3 骨架 / 每步判据 / 产出物 / planlog 与发版纪律
- @flow/spec/引擎映射.md —— 步骤 ↔ Feature 状态 ↔ 驱动方、两道确认门、工具面

若上面的 `@` 引用未被宿主展开为文件内容，进入需求工作前先 Read 这两份文件（守卫 hook 对这两个路径放行只读）。

## 单元路径守卫（无条件生效）

PreToolUse 守卫（`.zcode/hooks/guard-unit-paths.cjs`，对所有会话生效，不区分角色）拒绝 Read / Edit / Write / Grep：`orch/**` 与 `machine/**`（单元代码：分析经 MCP 工具由项目 agent 返回、改动经 `a2a_call` 派发，宿主不直接读写）以及 `flow/**`（流程包资产；两份规范文件对 Read/Grep 放行只读）。Bash 通道走启发式：命令串中出现 orch / machine / flow 独立路径段即拦，另盖通配混淆、Windows 8.3 短名、仓库级递归搜索（grep -r / rg）；`orch/scripts/` 运维脚本白名单（如 bridgectl.mjs）；两份规范文件请用 Read/Grep 工具而非 Bash。日常开发需要直读直改单元代码时，在 `.zcode/config.json` 将 `hooks.enabled` 置 false 临时停用本守卫，用完恢复（守卫自测：`node .zcode/hooks/guard-unit-paths.cjs --selftest`）。

a2a MCP 已在 `.zcode/config.json` 注册（远程端点 `http://127.0.0.1:8787/mcp`，会话前需桥常驻在跑，见 `orch/scripts/bridgectl.mjs`）。残余缺口与设计 rationale 见 `CLAUDE.md`「架构约束」。
