# Codex 接入

> 本文件是 `flow/` 规范包在 Codex 宿主上的接入指引。v0.4.1 给指引（自动注册留后续版本）。

## 前提

- Node.js ≥ 22.5；桥已构建：`orch` 下 `npm run build` 产出 `orch/dist/bridge/index.js`（**入口在 `dist/`，未 build 起不来**）。
- `orch/config/config.json` 已存在且含 `machines[]`（模板 `config.json.default`）。
- stdio 形态要求 **Codex 与桥同机**（stdio 是子进程管道，不支持跨机；跨机执行由桥→Launcher 的 HTTP 承担，与这里无关）。

## ① 注册本地 stdio MCP

Codex 的 MCP server 写在**用户级** `~/.codex/config.toml`，用 `[mcp_servers.<name>]` 表（把 `<orch>` 换成**绝对路径**）：

```toml
[mcp_servers.a2a]
command = "node"
args = ["<orch>/dist/bridge/index.js"]
env = { MACHINES_CONFIG = "<orch>/config/config.json", SESSION_DB = "<orch>/data/sessions.sqlite" }
```

- 两个 env 可省略（桥按单元根回退），但**建议显式写出**（避免多份桥副本「库与配置分家」）。
- Windows 路径反斜杠在 TOML 里需转义（`\\`）或用正斜杠。

## ② ⚠️ 两种形态不能共用同一份 orch config

桥的接入面由**桥自己读的 `<orch>/config/config.json`** 决定，与宿主"怎么写条目"无关：

| `config.json` | 桥的运行形态 |
|---|---|
| **无 `transport` 段**（或 `mode = "stdio"`） | stdio（由宿主作为子进程拉起） |
| `transport.mode = "http"` | 常驻 HTTP（在 orch 单元根用 `npm run bridge:start -- --no-wait` 发起 → `npm run bridge:status` 确认就绪；**退出码 0 = 已发起，≠ 已就绪**） |

⇒ 要两种形态并存，需**两份 config 文件**，分别经 `MACHINES_CONFIG` 指向。
另两条易错点：**remote 形态的宿主条目不需要 `env`**（env 属于启动桥的 shell）；**stdio 桥不写 pidfile、不归 `bridgectl` 管**（`bridgectl status` 会报"未运行"）。

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
- ✅ **已核实（官方文档级）**：MCP **stdio** 键 = `command` / `args` / `env` / `env_vars` / `cwd`；**HTTP** 键 = `url` / `bearer_token_env_var` / `http_headers` / `env_http_headers`（**无 `type` 键**，按有 `command` 还是有 `url` 推断；HTTP 原生支持、**无需 feature flag**）；项目级 `.codex/config.toml` **仅在受信项目**读取；
- ⏳ **仍待真机**：上述键名在你的 Codex 版本上实际生效（含 remote 形态；本仓的 `codex.config.toml.example` 里该段仍标"未真机"）。
