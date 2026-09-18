# opencode 接入

> 本文件是 `flow/` 规范包在 opencode 宿主上的接入指引。opencode 是 v0.4.1 **完整可用**的宿主路径。

## 前提

- Node.js ≥ 22.5。
- 桥已构建：`orch` 下 `npm run build` 产出 `orch/dist/bridge/index.js`。
- **stdio 形态**要求桥与 opencode **必须同机**：桥是本地 stdio MCP server，由 opencode 作为子进程拉起；**常驻（remote）形态**则桥以独立进程运行，opencode 经 `type:"remote"` 连接（见 `README.md` 的「常驻部署形态」与 `orch/config/config.json` 的 `transport.mode = "http"`）。

## ① 注册 stdio MCP

在 opencode 配置 `opencode.json` 里新增（不改动其它键）：

```json
{
  "mcp": {
    "a2a": {
      "type": "local",
      "command": ["node", "<orch>/dist/bridge/index.js"],
      "environment": {
        "MACHINES_CONFIG": "<orch>/config/config.json",
        "SESSION_DB": "<orch>/data/sessions.sqlite"
      },
      "enabled": true
    }
  }
}
```

把 `<orch>` 换成桥单元的实际绝对路径。`MACHINES_CONFIG` / `SESSION_DB` 缺省时分别回退到 orch 单元根的 `config/config.json` 与 `./data/sessions.sqlite`。**仓库根 [`opencode.json.example`](../../opencode.json.example) 是 canonical 宿主样例**（含 stdio 与 remote 两形态 + `instructions`）；`orch/opencode.json.example` 则是 **orch 单元自身**的历史配置样例（v0.4.1 由 `orch/opencode.json` 改名而来，用于避免 worker 侧再拉起第二座桥），**不是宿主接入样例**。

> ⚠️ **两种形态不能共用同一份 orch config**：桥的接入面由**桥自己读的 `<orch>/config/config.json`** 决定 —— 无 `transport` 段（或 `mode="stdio"`）⇒ stdio；`transport.mode="http"` ⇒ 常驻 HTTP。若 config 是 http 而宿主仍按 stdio 拉起该条目，子进程会去 `listen 8787`（与常驻桥冲突或变成没人再说 JSON-RPC 的进程）。**要并存需两份 config**，分别经 `MACHINES_CONFIG` 指向。另：remote 形态的宿主条目**不需要 env**（env 属于启动桥的 shell）；**stdio 桥不写 pidfile、不归 `bridgectl` 管**。

## ② 旁路加载流程规范

在同一个 `opencode.json` 顶层 `instructions` 数组追加两份规范文件：

```json
{
  "instructions": [
    "flow/spec/需求流程.md",
    "flow/spec/引擎映射.md"
  ]
}
```

路径相对于宿主进程的工作目录（仓库根）。**不修改任何 `AGENTS.md` / `CLAUDE.md`**：`instructions` 是额外引用，项目自己的文档原封不动。

## ③ 与 install.mjs 的对应

上面 ①②就是 `flow/install/install.mjs` 自动做的事：

```bash
node flow/install/install.mjs --host opencode --orch <orch 单元路径>
```

- 幂等：重复运行结果一致，不产生重复块。
- 只做确定性追加：`instructions` 追加两条规范路径、`mcp.a2a` 仅在缺失时写入；既有条目一律不删不改。同名 `mcp.a2a` 已存在且与预期不一致时报错，不静默覆盖。
- 可用 `flow/install/uninstall.mjs --target <项目根>` 按确定性条目还原（字节级）。

## ④ 验证

重启 opencode（或重载 MCP），让宿主重新读取配置与 `instructions`，然后调用：

```text
a2a_projects()
```

能列出已配置机器及其本机项目，即接入成功。若返回空或报错，依次检查：Launcher 是否已在 machine 单元根发起（`npm run start -- --no-wait`）并经 `npm run status` 确认就绪（见 machine 单元 README）；`orch/config/config.json` 的 `machines[]` 是否指向正确的 `launcherUrl`。
