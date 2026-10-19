# 流程规范包

> **规范版本戳**：v0.10.8（2026-10-16）

## 是什么

一份内核、多个宿主适配、一条旁路引入通道——把需求流程规范抽成与项目无关的文本，按各宿主注册方式落地，用 `install/` 脚本旁路引入既有项目，不新建仓库、不覆盖任何文件（`spec/` 内核 = 单一事实源、`hosts/` 适配层、`install/` 引入通道，流程正文只落在 `spec/`）。引入是**旁路**：幂等、可还原（`uninstall.mjs` 回到运行前字节）、对宿主配置只做**确定性追加**、绝不改动目标项目 `CLAUDE.md`/`AGENTS.md`、同名 MCP 键已存在则报错不静默覆盖。

## 怎么用

### 交付 A：起停本仓这套宿主

```bash
npm install                 # 分别在 orch/ 与 machine/ 下执行，orch 再 npm run build
npm run start -- --no-wait  # 在 machine 单元根发起 Launcher，随后 npm run status 确认就绪
npm run stop                # 同一单元根停止（就绪语义与退出码见 machine 单元 README）
```

宿主（如 opencode）经 `opencode.json` 的 `instructions` 加载 `flow/spec/*.md` 并注册 `mcp.a2a`；填 `machine/config` 的 `projects[]`、`orch/config` 的 `machines[]`；`a2a_projects()` 能列出项目即接入成功。细节见 [hosts/opencode.md](./hosts/opencode.md)。

### 交付 B：把规范旁路引入既有项目

```bash
node flow/install/install.mjs --host opencode --orch <orch 单元路径>   # 配组加 --group <组名>；--dry-run 只预览
node flow/install/uninstall.mjs --target <项目根>                      # 撤销：一条命令
```

### 兼容宿主

| 宿主 | 状态 | 说明 |
|---|---|---|
| opencode | 完整可用 | 注册 remote MCP + `instructions` 旁路，`install.mjs` 自动完成。见 [hosts/opencode.md](./hosts/opencode.md)。 |
| Claude Code | 指引 | 注册 `.mcp.json`；规范靠 `CLAUDE.md` 的 `@` 导入。见 [hosts/claude-code.md](./hosts/claude-code.md)。 |
| Codex | 指引 | 注册 `~/.codex/config.toml`；规范靠 `AGENTS.md`。见 [hosts/codex.md](./hosts/codex.md)。 |
| Cursor | 指引 | 注册 `.cursor/mcp.json`；规范靠 `.cursor/rules/` 或 `AGENTS.md`。见 [hosts/cursor.md](./hosts/cursor.md)。 |

### 边界

本包只描述流程与状态机语义，实现细节（工具名 / 项目来源 / 传输）留给运行底座；`flow/` 不含源码、不参与 `npm` 构建。
> ⚠️ **组 ≠ 安全边界**：桥的 MCP 端点零鉴权，url 组名段只界定该连接的可见性与派发范围，不构成鉴权/授权。

## 本包自有配置

本包无 `config.json`，配置面只有两处：宿主 `instructions` 挂载 `flow/spec/*.md` 并注册 `mcp.a2a`；端点 url 由**路径首段**承载组身份——未配组环境 `http://127.0.0.1:8787/mcp`（全量入口），配组环境 `http://127.0.0.1:8787/<组名>/mcp`（该连接视野限定本组，漏写组名段被 403 拒绝）。
