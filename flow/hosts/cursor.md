# Cursor 接入

> 本文件是 `flow/` 规范包在 Cursor 宿主上的接入指引。v0.4.1 给指引，自动注册留后续版本。

## ① 注册 remote MCP

Cursor 的 MCP server 写在 `.cursor/mcp.json`（项目级）或 `~/.cursor/mcp.json`（用户级）：

```json
{
  "mcpServers": {
    "a2a": {
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

`url` 指向桥的 MCP HTTP 端点；Cursor 的 remote 字段语法**待真机核实**。

## ② 加载额外指令文件

Cursor 的规则来源是 `.cursor/rules/*.mdc`（带 frontmatter，如 `alwaysApply: true`），新版本也识别 `AGENTS.md`。是否存在「从配置引用外部规范文件」的机制**待核实**。

因此本包**不会**替你改项目里的 `AGENTS.md` 或 `.cursor/rules/`：需要你**自己**新增一条规则，或加一行引用，指向 `flow/spec/需求流程.md`。这是**用户自己的决定与手改**，安装器不代劳。v0.4.1 的 `install.mjs` 完整路径仅覆盖 opencode，对 cursor 只给本指引。

## ③ 验证

重启 Cursor，调用 `a2a_projects()`，能列出项目即接入成功。
