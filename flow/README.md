# 流程规范包

> **规范版本戳**：v0.10.1（2026-10-09）
>
> 本目录（`flow/`）是「需求流程规范」的可分发单元：一份内核，多个宿主适配，一条旁路引入通道。
> 它把 Step 0-3 的需求流程、步骤与 Feature 引擎的映射、以及产出物模板抽离成**与项目无关**的规范文本，供宿主加载。

## 结构

| 目录 | 作用 |
|---|---|
| `flow/spec/` | 内核（单一事实源）：`需求流程.md`（Step 0-3 骨架 / 判据 / 产出物 / planlog 与发版纪律）、`引擎映射.md`（步骤 ↔ Feature 状态 ↔ 驱动方）、`文档模板.md`（需求确认单 / 改造文档 / 派发消息模板）。 |
| `flow/hosts/` | 适配层：各宿主如何注册 MCP、如何旁路加载规范文本。 |
| `flow/install/` | 引入通道：`install.mjs` / `uninstall.mjs`，把规范旁路引入既有项目。 |

规则：**流程正文只落在 `flow/spec/`**。宿主相关差异写进 `flow/hosts/`，机械变换写进 `flow/install/`。

## 两种交付形态

### 交付 A：本仓即「完整 orch 宿主包」

本仓（`orch/` 桥 + `machine/` Launcher + `flow/` 规范 + 配置模板）本身就是一套可直接使用的 orch 宿主。使用步骤：

1. clone 本仓，分别 `npm install` `orch/` 与 `machine/`，并构建桥（`orch` 下 `npm run build`）。
2. 起 Launcher（执行机器，一律经 `machine/scripts/launcherctl.mjs`；在 machine 单元根用 `npm run start -- --no-wait` 发起 → `npm run status` 确认就绪）。
3. 填两份配置：`machine/config/config.json` 的 `projects[]`，`orch/config/config.json` 的 `machines[]`。
4. 启动宿主（如 opencode），经 `opencode.json` 的 `instructions` 加载 `flow/spec/*.md`，并注册 `mcp.a2a`。**一座桥、多个编排身份**：组身份由 url **路径首段**承载——未配组环境注册 `http://127.0.0.1:8787/mcp`（全量入口）；配了组的环境注册 `http://127.0.0.1:8787/<组名>/mcp`（该连接视野限定本组，漏写组名段被 403 拒绝），细节见各 `hosts/*.md`。
5. 验证：`a2a_projects()` 能列出项目即接入成功。

交付 A 的增量只有两件：把规范接进宿主的 `instructions`，以及本目录的接入说明。详见 [hosts/opencode.md](./hosts/opencode.md)。

### 交付 B：旁路引入既有项目

已有自己的宿主配置与项目文档时，用 `flow/install/install.mjs` 把规范**旁路**引入，不新建仓库、不覆盖任何文件：

```bash
node flow/install/install.mjs --host opencode --orch <orch 单元路径>
```

它做两件事：向宿主配置**新增** `mcp.a2a`（remote MCP）；在宿主 `instructions` 追加 `flow/spec/` 两份规范文件。配组环境加 `--group <组名>`，写入条目的 url 即为 `…/<组名>/mcp`（缺省不拼，维持现状 `/mcp`）。`--dry-run` 只打印将发生的改动。撤销：

```bash
node flow/install/uninstall.mjs --target <项目根>
```

## 不破坏承诺

引入是**旁路**，不是覆盖或合并：

- **绝不改动目标项目既有的 `CLAUDE.md` / `AGENTS.md`**，一个字节都不动。
- 写入宿主配置只做**确定性追加**（JSON 无注释，故不用标记块）：`instructions` 仅追加两条规范路径，`mcp.a2a` 仅在缺失时写入；既有条目一律不删、不改、不重排。
- **幂等**：重复运行结果一致，不产生重复块。
- **可还原**：`uninstall.mjs` 按确定性条目精确移除（含空键回收），回到运行前的字节。
- 同名 MCP 键已存在时报错并给出人工指引，不静默覆盖。

## 兼容宿主

| 宿主 | 状态 | 说明 |
|---|---|---|
| opencode | 完整可用 | 注册 remote MCP + `instructions` 旁路，`install.mjs` 自动完成。见 [hosts/opencode.md](./hosts/opencode.md)。 |
| Claude Code | 指引 | 注册 `.mcp.json`；规范靠 `CLAUDE.md` 的 `@` 导入，需你手加一行引用。见 [hosts/claude-code.md](./hosts/claude-code.md)。 |
| Codex | 指引 | 注册 `~/.codex/config.toml`；规范靠 `AGENTS.md`。见 [hosts/codex.md](./hosts/codex.md)。 |
| Cursor | 指引 | 注册 `.cursor/mcp.json`；规范靠 `.cursor/rules/` 或 `AGENTS.md`。见 [hosts/cursor.md](./hosts/cursor.md)。 |

v0.4.1 只把 opencode 路径做到完整可用，其余宿主给接入指引，自动注册留后续版本。

> ⚠️ 桥的运行形态由**桥自己读的 `config.json`** 决定，细节见各 `hosts/*.md`。

## 边界

- 本包只描述**流程与状态机语义**，实现细节（工具名、项目来源、传输）留给运行底座；换操作面、换项目来源、换传输都不改规范。
- **组 ≠ 安全边界**：桥的 MCP 端点零鉴权，url 组名段只界定该连接的可见性与派发范围，不构成鉴权/授权；真正的安全边界归「安全与治理」专项。
- 网页可视化服务（v0.8 / v0.9）尚未提供，本包不承诺任何网页操作能力。
- `flow/` 不含源码单元，不参与 `npm` 构建。
