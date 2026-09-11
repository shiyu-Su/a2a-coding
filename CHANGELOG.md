# Changelog

本项目的所有重要变更都记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
