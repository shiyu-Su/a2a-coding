# Claude Code 接入

> 本文件是 `flow/` 规范包在 Claude Code 宿主上的接入指引。v0.4.1 给指引（自动注册留后续版本）。

## 前提

- Node.js ≥ 22.5；桥已构建：`orch` 下 `npm run build` 产出 `orch/dist/bridge/index.js`（**入口在 `dist/`，未 build 起不来**）。
- `orch/config/config.json` 已存在且含 `machines[]`（模板 `config.json.default`）。
- 桥以 **HTTP 形态**运行，Claude Code 经 `.mcp.json` 的 `{ "type": "http", "url": … }` 连接其 MCP 端点。

## ① 注册 remote MCP

Claude Code 的 MCP server 写在 `mcpServers` 对象里，位置二选一：

- **项目级**：项目根的 `.mcp.json`（随仓库走，建议入库）；
- **用户级**：`~/.claude.json`；或用命令 `claude mcp add --transport http a2a http://127.0.0.1:8787/mcp` 登记（配组环境把 url 写成 `http://127.0.0.1:8787/<组名>/mcp`）。

格式（**严格 JSON，无注释** —— 说明见本文与范例文件名）：

```json
{
  "mcpServers": {
    "a2a": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

- `url` 指向桥的 MCP HTTP 端点。**一座桥、多个身份**：组身份由 url **路径首段**承载 ——
  - 未配组环境：`http://127.0.0.1:8787/mcp`（全量入口）；
  - 配组环境：`http://127.0.0.1:8787/<组名>/mcp`（该连接的项目 / 任务 / Feature / 事件视野限定本组；漏写组名段会被桥以 **403 `group_identity_required`** 拒绝）。
  - 多个 agent 各以本组身份接桥 ⇒ 注册多个 `mcpServers` 子键、url 各带组名段（键名任意，如 `a2a-teamA`）。**不需要 headers**（身份不进 header，组也不是安全边界）。

## ② 桥以 HTTP 形态运行

桥的接入面由**桥自己读的 `<orch>/config/config.json`** 决定：`transport.mode = "http"` 时桥以 HTTP 形态运行，与宿主"怎么写条目"无关。

- 宿主条目**不需要 `env`**（env 属于启动桥的 shell）。
- ⚠️ **HTTP 形态在 Claude Code 上的字段语法尚未真机核实** ⇒ 以官方文档为准（本仓目前只在 opencode 上验证过 `{ "type": "remote", "url": … }`）。

## ③ 加载额外指令文件（**已在官方文档级核实**）

Claude Code **没有**「列出额外指令文件路径」的配置字段 —— 设置里与记忆相关的只有 `claudeMd`（**managed-only，且是内容字符串**，非路径列表）与 `claudeMdExcludes`（**只做排除**）。可用的三条路：

1. **`CLAUDE.md` + `@path` 导入**（最常用）：在 `CLAUDE.md`（项目根 / 用户级）里手加一行 ——
   ```markdown
   @flow/spec/需求流程.md
   @flow/spec/引擎映射.md
   ```
   （`@` 导入在启动时展开，最多 4 跳；需反引号包裹可抑制展开。）
2. **`.claude/rules/*.md`（与 opencode `instructions[]` 对等的接缝）**：把规范文件放进项目级 `.claude/rules/`（或用户级 `~/.claude/rules/`），**递归发现的 `.md` 会自动加载**；**不带 `paths:` frontmatter** 的规则在**启动时**加载、优先级同 `.claude/CLAUDE.md`。⇒ 这是"**不必改 `CLAUDE.md`**"也能注入规范的正规做法，将来 `install.mjs` 可据此扩 `--host claude-code`。
3. **`--append-system-prompt-file <file>`**（CLI 启动参数）："Load additional system prompt text from a file and append to the default prompt" ⇒ 适合**编排方以 headless（`claude -p`）方式拉起**时注入，无需改任何仓库文件。

**不适用的机制**（避免误用）：**插件**不能带 `CLAUDE.md`（官方明确：插件根的 `CLAUDE.md` 不作为项目上下文加载，插件只通过 skills / agents / hooks 贡献上下文）；**skills** 是**按需**加载（非常驻）；**subagents** 上下文隔离；**output styles** 是"选一个命名风格"（改角色/语气/格式），不是文件列表。

> 本包**不会**替你改 `CLAUDE.md`（那是你的文档）；`install.mjs` 目前仅覆盖 opencode —— **但注意第 2 条**：将来可走 `.claude/rules/` 做自动注入而**不碰** `CLAUDE.md`。

## ④ 验证

重启 Claude Code 会话，调用 `a2a_projects()`，能列出项目即接入成功。

## 待真机核实（**文档级已核实，真机仍未验**）

- ✅ **已核实（官方文档级）**：无"额外指令文件列表"字段；对等接缝 = `.claude/rules/*.md`；`--append-system-prompt-file` 可注入；
- ✅ **已核实（官方文档级）**：`.mcp.json` 的 remote 写法 `{"type":"http","url":…}`（`streamable-http` 为别名；**有 `url` 无 `type` 会报错**）；支持 `${VAR}` / `${VAR:-default}` 展开；**同名 `claude mcp add` 报错不覆盖**；优先级 **local > project > user > plugin > connectors**；
- ⏳ **仍待真机**：上述字段在你的 Claude Code 版本上实际生效（配置读入 / 加载顺序 / `.claude/rules/` 是否如期常驻）。
