# machine —— 执行机单元（Launcher / Runner）

## 是什么

> machine = 每台执行机上常驻的 Launcher，同时是 Runner

- **Launcher**：在本机拉起 / 停止各项目的 Agent（仓内 ACP 桥 + 外部安装的后端 CLI），并管端口、pidfile、日志与空闲回收。
- **Runner**：以**反向注册（出站）**连到编排桥（orch）——注册 → 长轮询拉命令 → 本地执行 → 结果回传；**不做服务发现**。执行机因此无需公网入口（NAT 后可用）。
- 四条 `agentKind` 同构（`opencode` / `codex` / `claude` / `qoder-cn`），一律由本机 ACP 桥驱动后端会话。

## 有什么用

- **任务不丢、不双记账**：结果先落盘再交卷，「传输层有界重发与启动补结算」两条路分别兜住载体早夭与冷启动孤儿（至多 1 次、不产生第二次账单）。
- **并发有闸、空闲有回收**：同项目读写两把闸、排队不丢；某项目空闲到点即收，不连坐别的项目。

## 怎么用

### 起（前台 / 后台）

前台起（调试用 · 日志直接进终端）：

```bash
npm install
npm run build
# 首次：cp config/config.json.example config/config.json —— 这是**可运行起点**
#（config/config.json.default 只作**缺省值参照**，不是复制源）
npm run launcher            # = npm run build && node dist/launcher/index.js
```

后台起（日常用 · 静默脱离终端）：

```bash
npm run build
npm start                   # 后台拉起（缺 dist 先构建；已在运行则提示并退 0）
npm run start -- --wait-ready   # 等到业务就绪才返回（`/health` 的 `status === "ok"`）
npm run status              # pid / host:port / health / startedAt
npm run logs                # 日志全文（--lines N / --follow）
npm run stop                # 停止
npm run restart             # 停止后重新后台拉起
```

- 缺省 `start` 只等到 `/health` 可答、**不含启动自检** ⇒ `exit 0` ≠ 业务就绪；要业务就绪用 `--wait-ready`（与 `--no-wait` 互斥，`--ready-timeout <ms>` 仅在前者下有效）。调用拼写要用 `--` 分隔（npm 会吞掉 script 名后的裸 `--no-*`）。
- 退出码恒 `{0,1}`：`0` = 已发起 / 已就绪 / 已在运行；`1` = 超时 / 被非本服务占用 / spawn 失败。
- 配置文件路径由环境变量 `MACHINE_CONFIG` 指定（缺省 `config/config.json`）；有什么键、逐键什么语义见 [`config/配置说明.md`](config/配置说明.md)。
- pidfile `.a2a/launcher.pid`、日志 `.a2a/logs/launcher.log`。
