# Claude Code 接入

> 本文件是 `flow/` 规范包在 Claude Code 宿主上的接入指引。v0.4.1 给指引，自动注册留后续版本。

## ① 注册本地 stdio MCP

Claude Code 的 MCP server 写在 `mcpServers` 对象里，位置二选一：

- 项目级：项目根的 `.mcp.json`（随仓库走，建议入库）。
- 用户级：`~/.claude.json`；或用命令 `claude mcp add a2a -- node <orch>/dist/bridge/index.js` 登记。

格式：

```json
{
  "mcpServers": {
    "a2a": {
      "command": "node",
      "args": ["<orch>/dist/bridge/index.js"],
      "env": {
        "MACHINES_CONFIG": "<orch>/config/config.json",
        "SESSION_DB": "<orch>/data/sessions.sqlite"
      }
    }
  }
}
```

把 `<orch>` 换成桥单元的实际绝对路径。桥与 Claude Code **必须同机**。

## ② 加载额外指令文件

Claude Code **没有**配置级的 `instructions` 数组，不能在配置里引用外部规范文件。它的指令来源是 `CLAUDE.md`（项目根 / 用户级），并支持 `@path` 导入语法。

因此本包**不会**替你改项目里的 `CLAUDE.md`：需要你**自己**在其中手加一行引用（示例）：

```markdown
@flow/spec/需求流程.md
@flow/spec/引擎映射.md
```

这是**用户自己的决定与手改**，安装器不代劳。v0.4.1 的 `install.mjs` 完整路径仅覆盖 opencode，对 claude-code 只给本指引。

## ③ 验证

重启 Claude Code 会话，调用 `a2a_projects()`，能列出项目即接入成功。
