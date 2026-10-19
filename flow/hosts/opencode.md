# opencode 接入

> 本文件是 `flow/` 规范包在 opencode 宿主上的接入指引。opencode 是 v0.4.1 **完整可用**的宿主路径。

## 前提

- Node.js ≥ 22.5。
- 桥已构建：`orch` 下 `npm run build` 产出 `orch/dist/bridge/index.js`。
- 桥以 **HTTP 形态**运行（独立于宿主进程），opencode 经 `type:"remote"` 连接其 MCP 端点（见 `orch/config/config.json` 的 `transport.mode = "http"`）。

## ① 注册 remote MCP

在 opencode 配置 `opencode.json` 里新增（不改动其它键）：

```json
{
  "mcp": {
    "a2a": {
      "type": "remote",
      "url": "http://127.0.0.1:8787/mcp",
      "enabled": true
    }
  }
}
```

`url` 指向桥的 MCP HTTP 端点。**一座桥、多个身份**：组身份由 **URL 路径首段**承载，同一座桥按组写不同 url——

- `http://127.0.0.1:8787/mcp`（不带组名段）= **未配组环境的全量入口**；桥上一旦配置 `projectGroup` 组，此 url 会被 **HTTP 403（`group_identity_required`）** 拒绝。
- `http://127.0.0.1:8787/<组名>/mcp` = **组身份**（该连接的 `a2a_projects` / 任务 / Feature / 事件视野均限定本组）。组名字符集 `[A-Za-z0-9_-]+`，且不得与保留首段（`health` / `shutdown` / `runner` / `mcp`）冲突。
- ⚠️ **组不是安全边界**：桥的 MCP 端点零鉴权，分组只界定**可见性与派发范围**，不是鉴权/授权机制。

同一工作区需要两个（或多个）agent 各以本组身份接桥时，注册多个子键、url 各自带组名段即可（键名任意）：

```json
{
  "mcp": {
    "a2a-teamA": { "type": "remote", "url": "http://127.0.0.1:8787/teamA/mcp", "enabled": true },
    "a2a-teamB": { "type": "remote", "url": "http://127.0.0.1:8787/teamB/mcp", "enabled": true }
  }
}
```

> ⚠️ 桥的接入面由**桥自己读的 `<orch>/config/config.json`** 决定；remote 形态的宿主条目**不需要 `env`**（env 属于启动桥的 shell）。

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
- 只做确定性追加：`instructions` 追加两条规范路径、`mcp.a2a` 仅在缺失时写入；既有条目一律不删不改。同名 `mcp.a2a` 已存在且与预期不一致时报错，不静默覆盖。配组环境用 `--group <组名>` 让写入条目的 url 带上组名段（缺省不拼，维持现状 `/mcp`）。
- 可用 `flow/install/uninstall.mjs --target <项目根>` 按确定性条目还原（字节级）。

## ④ 验证

重启 opencode（或重载 MCP），让宿主重新读取配置与 `instructions`，然后调用：

```text
a2a_projects()
```

能列出已配置机器及其本机项目，即接入成功。以组身份（`/<组名>/mcp`）接入时，`a2a_projects()` 只列本组项目——多身份接入须逐个身份各验一次。若返回空或报错，依次检查：Launcher 是否已在 machine 单元根发起（`npm run start -- --no-wait`）并经 `npm run status` 确认就绪（见 machine 单元 README）；`orch/config/config.json` 的 `machines[]` 是否指向正确的 `launcherUrl`。
