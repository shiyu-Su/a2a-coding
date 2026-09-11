# 回归测试用例 — a2a-coding v0.1.0

执行方式与约定见 [SKILL.md](SKILL.md)。每条用例通过 `report(name, ok, detail)` 记录，
全部通过才算发版前置条件满足（CLAUDE.md 发版流程步骤 2、3）。
全部用例均为静态检查，无需启动任何服务。

| 用例 | 检查点 | 预期 |
|------|--------|------|
| TC1 项目结构完整性 | 根 `package.json` / `planlog.md` / `CLAUDE.md` 存在；`doc/v0.1.0/A2A最小闭环-需求确认单.md`、`doc/v0.1.0/A2A最小闭环-改造文档.md` 存在；`orch/`、`machine/` 目录存在 | 全部存在 |
| TC2 单元自包含（orch / machine） | `orch/package.json`、`orch/tsconfig.json`、`machine/package.json`、`machine/tsconfig.json` 存在且为合法 JSON；orch scripts 含 `bridge`+`build`+`typecheck`，machine scripts 含 `launcher`+`build`+`typecheck`；`machine/package.json` 含 `"postinstall": "patch-package"` 且 devDependencies 声明 `patch-package`；每单元各有 `node_modules/` 与 `dist/` | 全部符合 |
| TC3 单元间无交叉 import | 扫描 `orch/`、`machine/` 下全部 `.ts`（跳过 node_modules/dist/点目录），仅匹配 import/from/import() 说明符，先剥注释；orch 不得引用 `machine/`，machine 不得引用 `orch/` | 两单元各自 >0 个 `.ts` 被扫描，且 0 条跨单元引用 |
| TC4 配置样例（机器清单 / 启动器） | `orch/config/config.json.default` 合法 JSON 且含非空 `machines[]`，每项含 `machineId`+`launcherUrl`；`machine/config/config.json.default` 合法 JSON 且含 `machineId`+`launcher.port`（数值）+非空 `projects[]`，每项含 `projectId`/`workspace`/`agentKind`/`a2aPort`（本地实际 `config/config.json` 如存在则一并校验为合法 JSON） | 全部符合 |
| TC5 a2a-opencode 会话持久化补丁 | `machine/patches/a2a-opencode+*.patch` 存在；若 `machine/node_modules/a2a-opencode/dist/opencode/session-manager.js` 存在，则必须含 `loadPersisted` 与 `persist(`（补丁已生效） | 补丁文件存在；已安装时补丁生效 |
| TC6 trace 产物处理（源头 + 兜底） | `orch/bridge/index.ts` 含 `isTraceArtifact` 且过滤 `startsWith("trace.")`；`machine/launcher/agent-config.ts` 存在且默认配置为 `events: { enabled: false }` | 全部符合 |
| TC7 空闲回收与租约续约 | `machine/launcher/manager.ts` 含 `idleStopMs`、`resetIdleTimer`、「空闲超时」回收日志；`orch/bridge/index.ts` 含 `LEASE_RENEW_INTERVAL_MS` 与 `renew?: () => Promise<void>` 回调（轮询期续约） | 全部符合 |
| TC8 入口脚本契约 | `orch` 的 `scripts.bridge`、`machine` 的 `scripts.launcher` 均运行构建产物（`node dist/...`），且不使用 `--experimental-strip-types` | 全部符合 |
| TC9 TypeScript 类型检查（两单元） | 在 `orch/`、`machine/` 分别执行 `npm run typecheck`（`tsc --noEmit`，cwd=单元目录，stdio pipe，超时 180s） | 两单元均退出码 0；node_modules 缺失时失败并给出明确提示 |
| TC10 文档收尾（final / planlog） | 版本号可解析（根 `package.json`，回退 CHANGELOG）；`doc/v{版本}/A2A最小闭环-改造文档.md` 存在；改造文档含「修订历史」且含 `final` 行；`planlog.md` 顶部版本待办含 `✅ 已完成` 需求行 | 全部符合 |
