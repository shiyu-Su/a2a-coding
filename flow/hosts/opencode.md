# opencode 接入

> 本文件是 `flow/` 规范包在 opencode 宿主上的接入指引。opencode 是 v0.4.1 **完整可用**的宿主路径。

## 前提

- Node.js ≥ 22.5。
- 桥已构建：`orch` 下 `npm run build` 产出 `orch/dist/bridge/index.js`。
- 桥与 opencode **必须同机**：桥是本地 stdio MCP server，由 opencode 作为子进程拉起，当前不支持远端 HTTP 连接。

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

把 `<orch>` 换成桥单元的实际绝对路径。`MACHINES_CONFIG` / `SESSION_DB` 缺省时分别回退到 orch 单元根的 `config/config.json` 与 `./data/sessions.sqlite`。仓库内 `orch/opencode.json` 是一份把 `mcp.a2a` 配进 orch 的样例。

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

能列出已配置机器及其本机项目，即接入成功。若返回空或报错，依次检查：Launcher 是否已 `npm run start` 且 `/health` 为 `ok`；`orch/config/config.json` 的 `machines[]` 是否指向正确的 `launcherUrl`。
