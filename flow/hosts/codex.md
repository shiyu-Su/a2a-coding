# Codex 接入

> 本文件是 `flow/` 规范包在 Codex 宿主上的接入指引。v0.4.1 给指引，自动注册留后续版本。

## ① 注册本地 stdio MCP

Codex 的 MCP server 写在 `~/.codex/config.toml`，用 `[mcp_servers.<name>]` 表：

```toml
[mcp_servers.a2a]
command = "node"
args = ["<orch>/dist/bridge/index.js"]
env = { MACHINES_CONFIG = "<orch>/config/config.json", SESSION_DB = "<orch>/data/sessions.sqlite" }
```

把 `<orch>` 换成桥单元的实际绝对路径。桥与 Codex **必须同机**。

## ② 加载额外指令文件

Codex 的指令来源是项目根（及其上层目录）的 `AGENTS.md`。是否存在「配置级外部 instructions 引用」能力**待核实**；以 `AGENTS.md` 为事实来源。

因此本包**不会**替你改项目里的 `AGENTS.md`：需要你**自己**在其中手加一行指向规范文件的引用（示例）：

```markdown
- 需求流程与引擎映射见 `flow/spec/需求流程.md`、`flow/spec/引擎映射.md`
```

这是**用户自己的决定与手改**，安装器不代劳。v0.4.1 的 `install.mjs` 完整路径仅覆盖 opencode，对 codex 只给本指引。

## ③ 验证

重启 Codex，调用 `a2a_projects()`，能列出项目即接入成功。
