# PROTOCOL — Bridge ⇄ Launcher 线协议契约

本文件是 orch（Bridge）与 machine（Launcher）之间 HTTP 线协议的**单一事实源**。线协议类型与版本常量在两侧各自声明（`orch/types.ts` / `machine/types.ts`），以本文件 + 契约测试（`.omo/skills/regression-test/tests/test-protocol-version.js`）保持一致；修改协议时**先改本文件**，再同步两侧实现。

- 当前版本：**1.0**（两侧同名常量 `PROTOCOL_VERSION`）
- 适用范围：仅 Bridge ⇄ Launcher HTTP。桥 ⇄ 包装器（A2A 端点）走标准 A2A 协议（自带版本）；MCP 工具面（`a2a_*` 工具出入参）不属本契约。
- 约束：两部署单元自包含、无跨单元 import——因此协议以「文档 + 契约测试」对齐，不做共享 schema 包。

## 端点

### GET /health

响应 200：

```json
{ "ok": true, "protocolVersion": "1.0" }
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | boolean | 恒 `true` |
| `protocolVersion` | string | `"major.minor"`。v0.1.1 及更早的 Launcher 无此字段（桥按主版本 0 处理并拒绝）。 |

### GET /projects

响应 200：`{ "projects": ProjectStatus[] }`

ProjectStatus 字段：`projectId` / `workspace` / `agentKind`（`"opencode" \| "codex" \| "claude"`）/ `a2aPort` / `status`（`"online" \| "offline"`）/ `endpoint`（string \| null）/ `startedAt`（string \| null）/ `risk`（可选，`"read" \| "write" \| "full"`）。

### POST /projects/{projectId}/ensure

请求体：`{}`（1.0 无字段；幂等启动，已在运行则复用同一端点）。

响应 200：`{ "projectId": string, "endpoint": string, "started": boolean }`

### POST /projects/{projectId}/stop

请求体：`{}`（1.0 无字段）。

响应 200：`{ "projectId": string, "stopped": boolean }`

### 错误响应（所有端点）

非 2xx：`{ "error": { "code": string, "message": string } }`

## 版本规则

- **加可选字段**（请求或响应）→ minor +1，主版本不变，旧对端可忽略；
- **删字段 / 改字段语义 / 加必填请求体或必填参数** → major +1；
- 桥在**首触一台机器**（首个 `GET /projects` 或 `ensure` 之前）先 `GET /health` 握手：机器主版本不在桥侧 `SUPPORTED_PEER_PROTOCOL_MAJORS`（`orch/types.ts`）清单内即**拒绝派发**（结构化错误 `protocol_version_mismatch`，含机器 ID、实测版本、可支持清单与升级指引）；同主版本内 minor 差异兼容放行；
- 跨主版本一律明确拒绝（fail-fast），不做静默降级猜测；按机器版本的行为降级适配必须显式写分支（以握手缓存中的机器完整版本号为依据）。

### 握手语义

- 成功校验结果按机器进程内缓存：后续调用**不再重复握手**；
- 失败（不匹配 / 不可达 / 缺字段）**不缓存负项**：下一轮调用重试握手，机器升级后自动恢复，无需重启桥；
- 并发首触同一机器只发一次 `/health`（in-flight 去重）。

## 可支持对端版本的维护流程（每次协议变更执行）

1. 按版本规则定新版本号；
2. 若主版本升级 → 显式决策桥的 `SUPPORTED_PEER_PROTOCOL_MAJORS`：保留旧主版本支持则留在清单并维护对应行为分支；放弃支持则移出（旧机被拒绝并获升级指引）；
3. 更新下方演进记录表（含「对端最低要求」列）；
4. 同步两侧 `PROTOCOL_VERSION` 常量，并确认契约测试全部通过。

## 演进记录表

| 版本 | 变更内容 | 破坏性 | 对端最低要求 |
|------|----------|--------|--------------|
| 1.0（v0.1.2） | 初始版本化：端点与字段如 v0.1.1 现状（`GET /health`、`GET /projects`、`POST ensure/stop`）；`GET /health` 新增自报 `protocolVersion` | — | 机器 ≥ 1.0（`/health` 返回 `protocolVersion`）；桥 ≥ 1.0（首触握手校验） |
