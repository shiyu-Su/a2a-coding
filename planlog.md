# Plan Log — a2a-coding（基于 A2A 的分布式 Code Agent 协作）

当前版本：v0.1.0 已发布（2026-09-11）；目标：打通「静态分布 + 每机启动器 + MCP 泛型桥 + 单执行 Agent（OpenCode 打样）」最小闭环

## v0.1.0 版本待办

v0.1.0 已发布（2026-09-11），已完成项见 [CHANGELOG.md](CHANGELOG.md) 与 [doc/v0.1.0/](doc/v0.1.0/)。

详情见：
- [A2A最小闭环-需求确认单](doc/v0.1.0/A2A最小闭环-需求确认单.md)
- [A2A最小闭环-改造文档](doc/v0.1.0/A2A最小闭环-改造文档.md)
- 设计说明以 [README.md](README.md) 为准

---

## 一、业务需求

### orch 工具面（MCP 泛型桥）

- [√] **MCP 薄桥** — 已实现：固定 4 个泛型工具 `a2a_projects` / `a2a_call` / `a2a_task_status` / `a2a_cancel`；按静态机器清单 + 懒加载项目索引解析「项目 → 机器」，**零重连**（不发 `tools/list_changed`）。落点：`orch/bridge/index.ts`（Node.js + TS，官方 `@a2a-js/sdk`）。

### 执行层适配（OpenCode / Codex / Claude Code）

- [√] **OpenCode 适配** — 已实现：launcher 先拉起前置 `opencode serve`（动态分配本机空闲端口），再启动 `a2a-opencode` 包装（`--config/--port/--hostname/--advertise-host/--directory/--opencode-url`）；会话由包装器按 A2A `contextId` 持有并落盘（`<workspace>/.a2a/sessions.json`）。
- [ ] **Codex 适配** — `codex exec --json --sandbox …` + `codex exec resume`；注意审批恒 `never`，权限只靠沙箱。
- [ ] **Claude Code 适配** — `claude -p --output-format json --resume`；可用 `--session-id` 预置 ID。

### 会话与任务

- [√] **会话映射持久化** — 已实现（方案 P）：`contextId → sessionId` 由 `a2a-opencode` 落盘 `<workspace>/.a2a/sessions.json`，Agent 退出重启后同一 `contextId` 仍可恢复；`sessionId` 不暴露给 orch。（桥侧 `sessions` 表 + `getSession`/`upsertSession` 休眠未接线。）
- [√] **任务态与 artifacts 回传** — 已实现：A2A 任务态映射为 `working/completed/failed/input-required` 并落 SQLite（`orch/data/sessions.sqlite`）；结果文本 + artifacts（跳过 `trace.*`）回传 orch。

### 权限与安全

- [√] **权限策略映射（适配器层）** — 已实现：`Adapter.permissionArgs(risk)` 按 `read/write/full` 映射底层 CLI 权限参数（opencode `--auto`；codex `--sandbox read-only/workspace-write/danger-full-access`；claude `--permission-mode default/acceptEdits/bypassPermissions`）；「任务风险 → 启动参数」的接线随 Codex/Claude 集成补齐。
- [ ] **跨机鉴权** — 反向代理 TLS + Bearer（预留 mTLS）；A2A 端点必须经鉴权边界。

### 多环境扩展

- [ ] **环境=构建主机模型** — Windows/iOS(Mac)/Android 各自一个 A2A Server，用能力标签路由。
- [ ] **新增 Agent 自注册零重连验证** — 验证新增 agent 不需要 orch 重连、不刷新工具面。
- [ ] **移动端反向中继（可选）** — 仅当需要"设备本身当 Agent"时；本期默认用主机代理。

### 端到端

- [ ] **E2E Demo** — 「改前端 → 改后端 → 联调」happy path + 一条「需澄清」路径。

### 配置管理（未来待办）

- [ ] **agent 配置归属迁移（machine → orch）** — 现状：每机 `launcher.<id>.json` 自维护项目/agent 配置（含 `agentConfig`：model / mcp / events / systemPrompt…）。拟改为：**orch 持「期望态」**（projectId → machine + agentKind / model / mcp / events），**machine 持「本地绑定 + 允许清单」**（workspace / a2aPort + 允许的 agentKind / mcp 白名单）；`ensure` 带 body 下发期望态，launcher 校验白名单后渲染执行。动因：集中管理、单一事实源。**前置约束：机器侧必须保留白名单/信任边界**（否则 orch 被控 = 各机 RCE）。触发条件：多机/多项目配置难管时。

### 会话/上下文管理（未来待办）

- [ ] **orch 侧 contextId 管理** — 现状：桥对 `contextId` **无状态**（`handleCall` 仅"传了就用、没传则 new UUID、结果回传"），**复用与否完全由调用方（LLM）决定**；桥不落 context 记录，`sessions` 表 + `getSession`/`upsertSession` 休眠未接线。拟（择一/组合）：(a) 桥记录 context（落表 + 列"活跃上下文"）；(b) 返回值强提示"续做请带回此 contextId"；(c) 显式工具/参数（`a2a_contexts` 列出 / `newContext:true` 明确语义）。动因：避免 LLM 遗忘或带错 contextId 导致误开新会话 / 误复用。

### 暂缓（记录，本期不实现）

- [ ] **pi 家族接入** — 上游 `pi` / `omp` 内建 `--mode rpc`（stdio JSON-RPC）；omp 另有 ACP。未来优先接入。
- [ ] **deepseek-harness 接入** — 官方 `dsh`，须用 `--profile sdk`（JSON-RPC）或 `acp`，**不要用 headless**（一次性纯文本、无会话续接）。
- [ ] **zcode 接入** — 专有 + 协议漂移；大概率指 Z.ai/Zhipu ZCode（闭源）；需确认具体所指。

---

## 二、基础层

### 测试与质量

- [√] **回归测试 skill** — `.omo/skills/regression-test/`（`index.js + lib/ + tests/`），输出 `reports/v{版本}/regression-report.json`；每个新模块补用例。（原 `scripts/regression/` 已合并移除）

### 代码质量

- [ ] **工程脚手架** — 初始化 TypeScript 项目（Node ≥ 20，ESM，禁 `any`）；lint/format 配置。
- [ ] **git 初始化** — 当前非 git 仓库；版本管理需要。

### 部署与运维

- [ ] **启动脚本** — Windows（.ps1）/ Mac（.sh）两套：拉起 `opencode serve` + A2A 包装器。
- [ ] **跨机网络配置** — `advertiseHost` / `endpointUrlOverride` / 防火墙 / 反向代理。

---

## 已知边界（暂不处理）

- 执行层入站鉴权依赖反向代理补足（`a2a-wrapper` 默认无入站鉴权）。
- Codex `exec` 无审批通道，权限粒度只能到沙箱三档。
- 设备本身当 Agent 需自建中继，非本期范围。

---

## 历史教训（备忘，非待办）

- （暂无）
