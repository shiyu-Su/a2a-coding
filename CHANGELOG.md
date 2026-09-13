# Changelog

本项目的所有重要变更都记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [v0.1.1] - 2026-09-13

### Added

- **Codex 与 Claude Code 接入**（REQ-v0.1.1-2026-09-11-01）：执行层从 OpenCode 单端扩展为三端——项目 `agentKind` 配成 `codex` / `claude` 即可被同一 Launcher / 同一泛型工具面拉起、派发、执行、回传；新增依赖 `a2a-codex` / `a2a-claude`（运行时随依赖内置，无需安装全局 CLI，仅 opencode 需预装）。
- **任务风险档位**：项目可配 `risk: read | write | full`（缺省 `write`），由适配器映射为各端权限/沙箱参数（opencode `--auto-approve` 开关；codex `--sandbox` 三档；claude `--permission-mode` 三档，full 档需 `claude.dangerouslyAllowBypassPermissions`）。
- **三端会话落盘补丁**：`a2a-codex` / `a2a-claude` 经 patch-package 将 `contextId → sessionId/threadId` 落盘至 `<workspace>/.a2a/sessions.json`，agent 退出后同一 `contextId` 仍可续接（与 opencode 补丁语义一致）；配套验证脚本 `verify-session-persist-{codex,claude}.mjs`。
- **Machine 启动自检**（REQ-v0.1.1-2026-09-11-03）：Launcher 监听端口前对本机全部项目逐个 `ensure` 拉起 → 发送真实最小任务 → 校验完成且响应非空 → `stop` 回收；任一失败打印项目/阶段/原因并**非零退出**（fail-fast）。可配 `launcher.startupCheck`（缺省开）、`startupCheckTimeoutMs`（默认 120s）、`startupCheckPrompt`。
- **启动配置快照**：每次拉起 Agent 时 Launcher 日志打印配置获取层级（项目 agentConfig + 用户级配置路径）与 endpoint / 模型 id（标注来源 agentConfig / env / 用户配置），便于核对实际生效配置。
- **任务结果保障**（REQ-v0.1.1-2026-09-13-01）：桥的派发-落库-查询全链路加固——
  - 半异步预算：`SYNC_BUDGET_MS` 默认 30s（须小于 host MCP client 超时），到点返回 `working + taskId + contextId` 与轮询/恢复指引文案；
  - 后台看护（`bridge/task-watcher.ts`）：预算到点后桥继续轮询 + 租约续约**直至任务终态并落库**，无人轮询结果也不丢；按 taskId 并发去重，连续失败 30 次放弃；
  - 落库带 text：任务结果纯文本（成功 = artifacts 文本，失败 = 错误原因）随 settle 持久化，tasks 表加 `text` 列（旧库自动迁移）；
  - 查询本地快路径：`a2a_task_status` 对终结态任务直接以本地存档作答（不唤醒远端 Agent），旧记录 text 为空时从 artifactsJson 拼接兜底。

### Changed

- **Claude 默认加载用户级配置**（REQ-v0.1.1-2026-09-11-02）：`a2a-claude` 默认 `settingSources: ["user"]`，用户 `~/.claude/settings.json` 的模型 / 网关 / 认证开箱即用（与 opencode / codex 配置继承语义一致）；项目可用 `agentConfig.claude.settingSources: []` 恢复隔离。三端统一语义：默认继承用户级配置，项目 `agentConfig` 逐字段覆盖。
- README：三端部署与验证说明、工具半异步语义、`SYNC_BUDGET_MS` 与 host 超时匹配说明、codex 自定义网关配置要点（OpenAI 兼容 `base_url` + `/responses` 拼接需含版本段）。

### Verified

- 三端均完成真实模型端到端验证（含退出后同 `contextId` 续接）：opencode（v0.1.0）；claude（用户级 settings 网关认证，无 env 注入）；codex（`config.toml` 自定义 provider + 兼容网关）。
- 回归测试全量通过（报告见 `reports/v0.1.1/regression-report.json`；`reports/` 不入库）。

## [v0.1.0] - 2026-09-11

### Added

- 基于 A2A 的分布式 Code Agent 协作最小闭环，本轮以 OpenCode 打样。
- 两个自包含部署单元：`orch/`（MCP 泛型桥 + 会话/任务库）与 `machine/`（每机启动器 + 三端适配器骨架）。两者各自持有 `package.json` / `tsconfig.json` / `node_modules/` / `dist/` / `config/`，线协议类型在两侧各自声明（无 `shared/`，无跨单元 import）。
- MCP 泛型工具 `a2a_projects` / `a2a_call` / `a2a_task_status` / `a2a_cancel`。工具面恒定，新增 Agent 不需要 orch 重连，也不发 `tools/list_changed`。
- 静态「项目 → 机器」分布：orch 持机器清单（`orch/config/config.json`），每机持本机项目配置（`machine/config/config.json`）。
- 每机常驻 Launcher，暴露 `GET /health`、`GET /projects`、`POST /projects/{id}/ensure`、`POST /projects/{id}/stop`，不做服务发现。
- 按需幂等启动：`ensure` 已在运行则复用同一端点，不重复拉起。
- 执行层集成 `a2a-opencode`：launcher 先拉起前置 `opencode serve`（动态分配本机空闲端口），再启动包装器并传入 `--opencode-url`。
- 包装器配置生成：launcher 每次启动渲染 `agents/<agentKind>.<projectId>.json`，默认 `events.enabled=false`，并深合并每项目 `agentConfig`。
- trace 处理：源头关闭 `events`，bridge 侧再兜底过滤 `trace.*` artifacts，观测数据不进入 orch。
- 会话跨退出复用（方案 P）：`patch-package` 补丁让 `a2a-opencode` 把 `contextId → sessionId` 落盘到 `<workspace>/.a2a/sessions.json`，Agent 退出后同一 `contextId` 仍可恢复上下文。
- 用完退出：launcher 按 `launcher.idleStopMs` 空闲回收（默认 5 分钟，`0` 关闭）；bridge 在轮询期间按 `LEASE_RENEW_INTERVAL_MS` 周期性 re-ensure 续约，避免误杀长任务。
- 回归测试 skill：`.omo/skills/regression-test/`（`index.js + lib/ + tests/`，共 60 条断言），静态检查项目结构、单元自包含、配置样例、会话补丁、trace 处理、空闲回收与租约、入口脚本、两单元类型检查与文档收尾，输出 `reports/v0.1.0/regression-report.json`。

### Notes

- 本轮仅 OpenCode 打样：`machine/adapters/` 已含 `codex` / `claude` 骨架，依赖安装、配置生成与生命周期随后续版本补齐。
- `orch/config/config.json` 与 `machine/config/config.json` 为本地实际配置（git 忽略），模板见各自目录下的 `config.json.default`；部署到实际机器时按机器与项目替换。
- 执行层入站鉴权尚未实现，跨机 A2A 端点依赖反向代理补足（见 README「已知边界」）。
