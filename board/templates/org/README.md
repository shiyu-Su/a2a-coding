# 组织目录模板（板侧资产 · B8 / B14）

> **归属**：改造文档 `doc/v0.9.0/Web看板与确认入口-改造文档.md` §2.2-8（组织目录内容）与 §2.2-14（组织版 `AGENTS.md` 模板归**板侧资产**）。
> **本目录只放模板，不铺设任何真实组织目录。** 组织目录 = 宿主 agent 的 workspace（**不含代码仓**），将来由**板上建组织（V2）渲染复制**，V1 阶段由人按 `SETUP.md` 手工铺。
> **本版零代码接入**：`board/src/` 内**没有**任何读取本目录的代码；V2 的建组织节点负责按同一份清单渲染（⇒ 不返工）。

## 1. 本目录的文件

| 文件 | 作用 | 铺设到组织目录 |
|---|---|---|
| `AGENTS.template.md` | **组织版 `AGENTS.md` 模板** —— 规范旁路引入（指向 `flow/`）+ 组织工作区指令 | ✅ → `AGENTS.md` |
| `CLAUDE.template.md` | **`CLAUDE.md` 模板** —— 薄壳：「以 `AGENTS.md` 为准」+ 宿主角色说明 | ✅ → `CLAUDE.md` |
| `planlog.template.md` | **`planlog.md` 模板** —— 版本待办（含「当前步骤」列）+ 登记项 + 已实现清单 | ✅ → `planlog.md` |
| `CHANGELOG.template.md` | **`CHANGELOG.md` 模板** —— Keep a Changelog 三段（Added / Changed / Removed）+ 版本待办收口表 | ✅ → `CHANGELOG.md` |
| `SETUP.md` | **V1 人工铺设步骤**（逐条可执行，含每步前置与预期结果） | ❌ 板侧文档，不进组织目录 |
| `README.md` | 本文件：清单与来源、占位符总表、明确不放、疑点登记 | ❌ 板侧文档，不进组织目录 |

## 2. 组织目录清单 ↔ 改造文档 §2.2-8（逐项对照）

| # | §2.2-8 条目 | 来源 | 铺设方式 | 模板是否提供 |
|---|---|---|---|---|
| 1 | `flow/`（**10 文件 + 版本戳**） | a2a-coding 仓 `flow/`（规范**单一事实源**） | 整体复制**被 git 跟踪的 10 个文件**：`README.md` 1 + `spec/` 3 + `hosts/` 4 + `install/` 2 | ❌ 不在本目录另存副本 —— 由 `SETUP.md` 第 3 步负责复制，并核对顶部**规范版本戳** |
| 2 | **组织版 `AGENTS.md`**（≠ 本仓那份） | 本目录 `AGENTS.template.md` | 复制 + 替换占位符 | ✅ |
| 3 | `CLAUDE.md`（由 `CLAUDE.template.md` 生成、写明「以 AGENTS.md 为准」） | 本目录 `CLAUDE.template.md` | 同上 | ✅ |
| 4 | `planlog.md` | 本目录 `planlog.template.md` | 同上 | ✅ |
| 5 | `CHANGELOG.md` | 本目录 `CHANGELOG.template.md` | 同上 | ✅ |
| 6 | `doc/` | 空目录 | `mkdir doc`；内容由 Step 0/1 落文件（`doc/{版本}/{topic}-*.md`） | — 无需模板（模板本体在 `flow/spec/文档模板.md`） |
| 7 | `scripts/watch-feature.mjs` + `scripts/watch-task.mjs` | a2a-coding **仓根 `scripts/`**（规范等待纪律的直接引用对象） | 复制这两个文件；**缺省打 3300 ⇒ 3300 须保持可用** | ⚠ 脚本本体**不在**本目录另存一份（避免第二份真相），来源见 §5 疑点 1 |
| 8 | `.git`（`init` + 首提交 = **一组织一仓**、版本自治） | `git init` | `SETUP.md` 第 8 步 | — |
| 9 | `.a2a/`（**不预置**、运行时自动落、须可写、建议 gitignore） | 编排桥运行时 | 不创建，只保证目录**可写** | — |

**明确不放**（§2.2-8 原文四条，逐条落点）：

| 不放 | 为什么 | 模板里如何体现 |
|---|---|---|
| 本仓 `AGENTS.md` / `CLAUDE.md` **原件** | 那是**本仓开发纪律**（单元路径守卫 / 宿主角色 / 版本号同升），照抄会误导组织宿主 | `AGENTS.template.md` §6 显式列出「不适用的纪律」，并说明看到别处有**不要顺手补齐** |
| **MCP 配置** | 由**板注入**，写进文档 = 第二份真相 | `AGENTS.template.md` §2 只描述注入机制与身份语义，不写配置块 |
| **代码仓** | 组织目录 = 编排 workspace，代码改动经派落在成员项目 | `AGENTS.template.md` §1 表 + `CLAUDE.template.md` 角色表 |
| machine / orch 的任何内容 | 单元内容不归组织 | 模板只引用「编排桥地址」「只读工作台 3300」这类**底座缺省口径**，不引用任何单元路径 |

## 3. 占位符总表

**约定**：占位符 = 花括号 `{UPPER_SNAKE}`，与 `flow/spec/需求流程.md` 内核「花括号 `{...}` 为占位符」的既有写法一致。**板渲染（V2）只替换下表 6 个键**；替换后仍残留的 `{...}`（如 `{topic}`、`{需求一句话}`、`{YYYY-MM-DD}`）一律是**使用期占位**，由编排 agent / 人在真实需求落地时填。

| 占位符 | 含义 | 谁填 | 出现于 |
|---|---|---|---|
| `{ORG_NAME}` | 组织名 —— **一名三用**：`projectGroup.name` = MCP URL 首段 = 组织目录名。字符集 `^[A-Za-z0-9_-]+$`，且不得占用保留首段 `health` / `shutdown` / `runner` | V2 = 板的建组织表单；V1 = 人（`SETUP.md` 第 1 步） | 四个模板 |
| `{ORG_MEMBER_PROJECTS}` | 成员项目清单，建议逐行 `<machineId>/<projectId>`（与 `projectGroup.members` 同形） | V2 = 板读 `projectGroup.members`；V1 = 人 | `AGENTS` · `CLAUDE` |
| `{HOST_KIND}` | 该组织宿主端 kind ∈ `claude` / `opencode` / `qoder-cn` / `codex`（**组织级缺省 `claude`**，§3.5 裁定 4） | V2 = 板读组织配置 `agentKind`；V1 = 人 | `AGENTS` · `CLAUDE` |
| `{FLOW_SPEC_STAMP}` | 随包 `flow/` 的**规范版本戳**（如 `v0.9.0（2026-09-24）`），须与 `flow/README.md` 顶部一致 | 从复制来的 `flow/README.md` 读取后回填（**不得手填凭记忆**） | `AGENTS` |
| `{CURRENT_VERSION}` | 该组织当前版本号（三段、不带 `v` 前缀）；新建组织建议 `0.1.0` | V1 = 人；V2 = 板若提供版本字段则填 | `planlog` |
| `{CREATED_AT}` | 铺设日期 `YYYY-MM-DD` | V2 = 板渲染时间戳；V1 = 人 | `planlog` |

**校验口径**：`SETUP.md` 每步都带「预期结果」；渲染完成后的通用自检 = `grep -n "{ORG_NAME}\|{ORG_MEMBER_PROJECTS}\|{HOST_KIND}\|{FLOW_SPEC_STAMP}\|{CURRENT_VERSION}\|{CREATED_AT}"` 在组织目录内**零命中**。

## 4. 单一事实源纪律（后人勿破）

- **流程正文只在 `flow/spec/`**。组织版 `AGENTS.md` **指向** `flow/`（`@` 引用 + 要点索引表），**不复制全文**；索引表每条都带「事实源」列，冲突时以 `flow/` 原文为准（该句已写进模板本身）。
- **不改 `flow/` 包**（它必须保持项目无关）：组织特化的内容一律落在本目录模板里，不落 `flow/`。
- **模板内不写死**任何具体组织名 / 机器名 / 项目名（一律占位符）；出现的 `8787`（MCP）与 `3300`（只读工作台）是**底座缺省口径**，不是某台机器的地址。
- **零新依赖**：本目录纯文本，无 `package.json`、无构建、无脚本。

## 5. 疑点登记（供改造文档回填，模板本身未擅自动作）

| # | 疑点 | 本模板的处置 |
|---|---|---|
| 1 | **`scripts/watch-*.mjs` 的「从哪来」§2.2-8 未定**：事实源在 a2a-coding 仓根 `scripts/`，但组织目录可能在**另一台机**（板 spawn 宿主的 workspace），届时无仓可拷 | 不在模板目录另存脚本副本（避免第二份真相）；`SETUP.md` 第 6 步以「本仓 `scripts/` 为来源」写清命令，并把跨机分发登记为 **V2 待裁**（板内嵌资源 or 由板写出） |
| 2 | `doc/_templates/` **不在 §2.2-8 清单**，但本仓 `doc/_templates/需求确认单.md` 实为 `flow/spec/文档模板.md` §1 的**逐字复制**（`flow/` 自己也这么建议） | 遵清单**不生成** `doc/_templates/`；组织宿主直接用 `flow/spec/文档模板.md`。若希望就近有模板 ⇒ 需先给 §2.2-8 **+1 条**（属方案变更，不自行加） |
| 3 | `.gitignore` 也不在 §2.2-8 清单，但条目 9 要求「`.a2a/` 建议 gitignore」⇒ 无落点 | 不提供 `.gitignore` 模板文件（免得「多」出一项），改为 `SETUP.md` 第 8 步内联给出内容 |
| 4 | 组织目录**没有自述 README**（清单里没有 ⇒ 按「别漏别多」未加） | 未加。影响：新宿主进目录只看到 `AGENTS.md`/`CLAUDE.md` —— 二者已足以自述，可接受 |
| 5 | **失败处置细则不在 `flow/`**：`failureKind` 六类 / 续跑余量 / 超时总框的事实源是本仓 `CLAUDE.md` 与 `PROTOCOL.md`，而 §2.2-8 明确不放本仓文档 | `AGENTS.template.md` §3.1 末显式声明「本工作区不带、也不自行发明该口径」，只保留 `引擎映射.md` §4 / §6 的粗口径（不猜重试策略）。若组织宿主需要该细则 ⇒ 需由底座随包分发一份，登记待裁 |
| 6 | 3300（只读工作台）是 `watch-*.mjs` 的缺省依赖，属「底座在跑」前提、不是目录内容 | `AGENTS.template.md` §4 与 `SETUP.md` 前置条件均已写明；板上应可见 |
