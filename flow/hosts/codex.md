# Codex 接入

> 本文件是 `flow/` 规范包在 Codex 宿主上的接入指引。v0.4.1 给指引（自动注册留后续版本）。

## 前提

- Node.js ≥ 22.5；桥已构建：`orch` 下 `npm run build` 产出 `orch/dist/bridge/index.js`（**入口在 `dist/`，未 build 起不来**）。
- `orch/config/config.json` 已存在且含 `machines[]`（模板 `config.json.default`）。
- 桥以 **HTTP 形态**运行，Codex 经 `~/.codex/config.toml` 的 `url` 连接其 MCP 端点。

## ① 注册 remote MCP

Codex 的 MCP server 写在**用户级** `~/.codex/config.toml`，用 `[mcp_servers.<name>]` 表：

```toml
[mcp_servers.a2a]
url = "http://127.0.0.1:8787/mcp"
```

- 按 `url` 识别，**无 `type` 键**。

**一座桥、多个身份**（v0.8.6 起组身份由 url **路径首段**承载，除 `url` 外不需要任何其它键）：

- 未配组环境：`url = "http://127.0.0.1:8787/mcp"`（全量入口）；
- 配了组的环境：`url = "http://127.0.0.1:8787/<组名>/mcp"`（该连接的项目 / 任务 / Feature / 事件视野限定本组；漏写组名段会被 **403 `group_identity_required`** 拒绝）。组名字符集 `[A-Za-z0-9_-]+`，且不得与保留首段（`health` / `shutdown` / `runner` / `mcp`）冲突。
- 多个身份 = 多张 `[mcp_servers.<键名>]` 表、各写各的 url（键名任意）。
- ⚠ **组不是安全边界**：桥端点零鉴权，分组只界定可见性与派发范围。

## ② 桥以 HTTP 形态运行

桥的接入面由**桥自己读的 `<orch>/config/config.json`** 决定：`transport.mode = "http"` 时桥以 HTTP 形态运行，与宿主"怎么写条目"无关。

- 宿主条目**不需要 `env`**（env 属于启动桥的 shell）。

## ③ 加载额外指令文件（**已在官方文档级核实**）

Codex **没有**「列出额外指令文件路径」的配置键：

- `instructions` = **保留未启用**（官方原话：reserved for future use；推荐改用 `model_instructions_file` 或 `AGENTS.md`）；
- `model_instructions_file` = **替换**内置指令的**单个文件**（官方/源码注明 **STRONGLY DISCOURAGED**，会丢掉基础指令）；
- （历史）`experimental_instructions_file` 已**改名**为 `model_instructions_file`、随后**移除**。

因此 Codex 的规范加载只能走 **`AGENTS.md` 链**：

| 作用域 | 位置与顺序 |
|---|---|
| **全局** | `$CODEX_HOME`（缺省 `~/.codex`）下：`AGENTS.override.md` → `AGENTS.md`（**只取第一个非空**） |
| **项目** | 从**项目根（通常 git 根）逐目录向下到 cwd**；每目录顺序：`AGENTS.override.md` → `AGENTS.md` → `project_doc_fallback_filenames` 里的文件名；**每目录至多取一个** |
| **合并** | 自根向 cwd **拼接**，越靠近 cwd 越靠后（优先级更高）；空文件跳过；总长受 **`project_doc_max_bytes`（默认 32 KiB）** 限制 |

唯一"扩展发现"是 **`project_doc_fallback_filenames`**（数组，**只追加"文件名"**、用于没有 `AGENTS.md` 的目录），**不能**写任意路径列表。

⇒ 需要你**自己**在 `AGENTS.md` 里手加一行引用（示例）：

```markdown
- 需求流程与引擎映射见 `flow/spec/需求流程.md`、`flow/spec/引擎映射.md`
```

这是**用户自己的决定与手改**，安装器不代劳；且**Codex 侧没有"不改 `AGENTS.md` 就能注入规范"的干净接缝**（对比 Claude Code 的 `.claude/rules/`）。v0.4.1 的 `install.mjs` 完整路径仅覆盖 opencode。

## ④ 验证

重启 Codex，调用 `a2a_projects()`，能列出项目即接入成功。

## 待真机核实（**文档级已核实，真机仍未验**）

- ✅ **已核实（官方文档级）**：无"额外指令文件列表"键；`instructions` 保留未启用；`model_instructions_file` 是**替换**且不鼓励；`AGENTS.md` 链与 32 KiB 上限；
- ✅ **已核实（官方文档级）**：MCP **HTTP** 键 = `url` / `bearer_token_env_var`（**无 `type` 键**，按有 `url` 推断；HTTP 原生支持、**无需 feature flag**）；项目级 `.codex/config.toml` **仅在受信项目**读取；
- ⏳ **仍待真机**：上述键名在你的 Codex 版本上实际生效（本仓的 `codex.config.toml.example` 里该段仍标"未真机"）；**url 携带组名路径段（`/<组名>/mcp`）的连通性同样待真机各验一次**。
