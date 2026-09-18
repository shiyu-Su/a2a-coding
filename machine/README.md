# machine 单元（Launcher）

> 每台执行机器常驻一个 Launcher，管理本机项目 Agent 的生命周期（`GET /projects`、`POST /projects/{id}/ensure`、`stop`、`health`）；不做服务发现。启停一律经 `scripts/launcherctl.mjs`（纯 Node ESM，零第三方依赖、无需构建），入口 `dist/launcher/index.js`。

## 服务启停

```bash
npm run start     # 后台启动（已在运行则提示并退出 0）
npm run status    # 查看 pid / host:port / health / startedAt
npm run stop      # 停止（POSIX 发 SIGTERM 优雅退出；Windows taskkill /T /F 强制树杀）
npm run restart   # 停止后重新后台拉起
npm run logs      # 输出日志全文（支持 --lines N / --follow）
```

- 端口读配置 `launcher.port`；`MACHINE_CONFIG` 可指定其他配置文件。
- pidfile：`.a2a/launcher.pid`（由 Launcher 写，JSON `{ pid, port, host, startedAt }`，非锁，陈旧无害）；日志：`.a2a/logs/launcher.log`。
- 前台入口 `npm run launcher` 仅作调试，不作为启停手段。

## 启停与就绪语义（统一口径锚点）

> 本段是启停 / 就绪语义的**持久锚点**：与 orch 侧同口径、各单元独立实现、不共享代码。运维、编排与根 README 的启停说明均以本段为准。

- **`--no-wait`：发起即返**（不等待任何就绪判据）；`exit 0` = **已发起（≠ 已就绪）**，仅 spawn 同步失败才 `exit 1`。
- **缺省 `start` 的等待目标 = L1（`/health` 可答 = HTTP 200）**，**不含启动自检**；因此**缺省 `exit 0` ≠ 业务就绪** —— 自检未过时 `/health` 报 `status:"starting"`，业务路由（`/projects*`）仍返回 `503`。
- 需要业务就绪时用 **`--wait-ready`**：等待 `/health` 的 `status === "ok"` 才 `exit 0`；超时 / 自检失败 ⇒ `exit 1`。
  - 缺省整段硬上限 = `max(60s, N × startupCheckTimeoutMs + 60s)`（`N` = 本机 `projects` 数，`startupCheckTimeoutMs` 缺省 120s；该上界未计入启动对账清理耗时）；`--ready-timeout <ms>` 可覆盖。
  - `--wait-ready` 与 `--no-wait` **互斥**（同传 ⇒ 显式报错）；`--ready-timeout` 仅在 `--wait-ready` 下有效。
  - 失败诊断按 `自检失败` / `[self-check]` **过滤行**输出（非 tail N）。
- **`--no-wait` 后须另起 `npm run status` 确认**运行态；`--no-wait` 输出的 **pid 仅供参考**（并发竞态下可能指向被接管的败者子进程）。
- **调用拼写**：`npm run start -- --no-wait`（npm 会吞掉 script 名后的**裸** `--no-*`，必须用 `--` 分隔）。
- **`restart --no-wait` 仅作用 start 段**；stop 段仍阻塞（`POST /shutdown` ≤5s + 等待端口释放 ≤15s，machine 实测 ≈ ≤20s），整体重启**非瞬时返回**。
- **占用判定以 `/health` 的 `status` 为键**（不依赖 HTTP 状态码）：
  - 端口在监听但 `/health` 不可答，或 `status` 缺失 / 非白名单（`ok` / `starting`）⇒ **端口被非本 Launcher 占用** ⇒ `exit 1`；
  - `status === "ok"` ⇒ **已在运行且已就绪** ⇒ `exit 0`；
  - `status === "starting"` ⇒ **本服务启动中（已在运行但未就绪）** —— 缺省 / `--no-wait` 即返 `0`，`--wait-ready` 续等至 `ok`。
- **退出码恒 `{0,1}`**：`0` = 已发起 / 已就绪 / 已在运行；`1` = 超时 / 被非本服务占用 / spawn 失败。
