# board —— Web 看板单元

本仓第四个单元目录（与 `orch/`、`machine/` 同级），独立进程、独立 `package.json`。

## 定位

- **板 = 人的唯一入口**：建需求、提需求、点确认都经板；板架在 orch agent 前面。
- **独立进程 + 独立进程树 + 端口 3400**（3300 保持只读运维视图不动）。
- **板不写状态机迁移**：状态机写只有「建需求」那一次 `a2a_feature_create`（v0.9.0 BD7 已 `POST /requirements` 接线）；`approve` / `cancel` 与「把主链 `advance` 到非当前态」只由编排 agent 经 MCP 执行，板侧不提供路径。唯一放开的登记字段写 = `version` 排期写（v0.9.2 M2/M3 · 经 `feature-schedule.ts` 用 advance「`to` = 当前态」特例，仅 `version` 一字段、不携带 stage/approval；HTTP 端点 `POST /features/:id/schedule` 已接线 · **增补 ⑤：本端点与提需求口同受已发版锁执法**）。

> 本 README 描述的当前进度 = **BD1 骨架 + BD3 只读视图 + BD2 建需求封装 + BD4a 宿主桥进程托管 + BD7 写面接线（提需求）+ BD8 宿主轮（触发一轮 / 状态页 / 停桥）+ BD9 人工确认与澄清回答入口 + BD11 组织名进表单（板级配置降为可选默认）+ BD12″ 板配置化（config.json + 模板 + 加载器，argv/env 配置通道撤销）+ BD13″ 板服务化（`scripts/boardctl.mjs` 静默启停 / `POST /shutdown` 优雅停机 / pidfile 板自写 / 日志行级时间戳）+ 收口轨 14 写按钮防误触（内联提交守卫 · 详情页占用轮渲染禁用 · `board_turn_busy` 409 同需求防重）+ **v0.9.2 排期写面（`POST /features/:id/schedule` · M3）与已发版版本锁（增补 ⑤ · config `releasedVersions` 事实源 · 提需求/排期两写口 409 执法 + 列头 🔒 徽标）+ v0.9.4 A 档建组织（`POST /orgs` · 板侧组织台账 `.data/orgs.json` · 组织名单一纯函数校验 + 三源重名闸）**+ v0.9.4 A3/A4 组织停用（BD3：「删除」= 台账标记停用，同一条 `POST /orgs` 靠 `action` 分建 / 停用（写端点条数不变）· 拒删前置闸 = 名下有活跃宿主桥 ⇒ 409 引导先逐桥 stop，**不隐式连带停桥** · 停用闸落 host-face spawn/ensure 唯一入口（`board_org_disabled`，`prepareWorkspace` 不动）· 停用组织不可提新需求 · 同名重建 = 复活零迁移）**：最小 HTTP 服务（`GET /health` + 只读页面 + 八条业务写端点 + 一条运维写端点 `POST /shutdown`，见「页面路由」）+ 对桥的**只读** API 客户端 + `createRequirement` / `scheduleFeature` / `group-admin`（成员写）三个 MCP 写封装 + 「一组织一宿主桥」的起 / 停 / 查 / 空闲回收 + 板侧对话轮台账 + 纯单测。**确认与回答都是「给宿主 agent 的一轮消息」，不是状态机写口**（边界见下）。

## 如何起

### 前台起（调试用 · 日志直接进终端）

```bash
npm install
npm run build          # tsc → dist/
# 首次：cp config/config.json.default config/config.json 再按需修改
npm run start:foreground   # = node dist/index.js（Ctrl+C / SIGTERM 走同一条优雅停机链）
```

### 后台起（日常用 · 静默脱离终端）

```bash
npm run build
npm start              # 后台拉起（等待运行中）；等价 node scripts/boardctl.mjs start
npm run status         # 三态：运行中 / 端口被占 / pidfile 陈旧 / 未运行
npm run logs           # 尾部若干行；npm run logs -- -n 50 / -- -f 跟随
npm run stop           # 优雅停机 → 超时强杀兜底
npm run restart        # stop + start
```

| 落点 | 值 | 谁写 / 谁读 |
|---|---|---|
| 配置文件 | `config/config.json`（模板 `config/config.json.default`；env `BOARD_CONFIG` **只覆盖路径**） | 板启动期读一次；`boardctl` **不解析内容**，只把 `BOARD_CONFIG` 原样透传给子进程 |
| 监听端口 | 配置 `port`，缺省 **3400**，恒 loopback | 板绑定；`boardctl` 探测端点取自 **pidfile 的 `port`/`host`**，无 pidfile 才回落 3400 |
| pidfile | `.a2a/board.pid` = JSON `{ pid, port, host, startedAt }` | **板自己写**（listening 之后）、停机时删；`boardctl` 只读不写（陈旧文件由 `stop`/`status` 识别清理） |
| 日志 | `.a2a/logs/board.log`（stdout + stderr **合并追加**） | `boardctl start` 的重定向目标；**每行带 `[ISO 时间] [tag]` 行级时间戳**（`src/log.ts` 包装 `process.stdout/stderr`，`tag ∈ board / shutdown / error`） |

`boardctl.mjs` 子命令与旗标：`start [--no-wait | --wait-ready] [--ready-timeout <ms>]`、`stop`、`restart`、`status`、`logs [-n|--lines <N>] [-f|--follow]`。**退出码恒 ∈ {0,1}**（`status` 报「未运行」不是错误 ⇒ 退 0）。

- **`stop` 的两条路径**：① **优雅** = `POST /shutdown`（请求超时 5s）→ 等收敛（缺省 45s），**收敛判据 = 端口释放 ∧ pidfile 指向的进程已退出**；② 优雅不可达 / 未收敛 → **强杀兜底**（Windows `taskkill /T /F` 树杀，POSIX 进程组 SIGKILL）后再等一轮收敛。**只有达标才清 pidfile**；定位不到进程（pidfile 缺失 / 陈旧）⇒ **不盲杀**，保留现场并退 1。
- **Windows 脱壳** = WMI `Win32_Process.Create` 建**隐藏 powershell 壳**（挂 `WmiPrvSE`，脱离调用方进程树，避免"等自己作业清空"卡住），壳内 `cmd /c "node dist/index.js >> board.log 2>&1"`，powershell 侧用 `-EncodedCommand`（UTF-16LE + Base64）规避多层引号。**WMI 不可用 ⇒ 显式降级 `spawn(detached)+unref()` 并在 stdout 打警告**（不静默降级）。
- **退出卫生**：板主流程**不用 `process.exit`**，只设 `process.exitCode`（治 Windows 退出期退出码被污染）；`POST /shutdown` 的 **200 仅代表「受理」**（≠ 已停），停机链 = **先停已托管的宿主桥 → 关卡的 HTTP → 删 pidfile**（SIGINT/SIGTERM 与 `/shutdown` 共用同一条链，重入守卫幂等）。

### 配置项在哪（逐项语义）

- **配置只从文件读（BD12″ · 用户裁定「而非启动参数」）**：生效配置 = `config/config.json`（活配置，gitignored），模板 = `config/config.json.default`（入库、`_comment` 族键逐项标注语义/缺省/是否 fail-fast）。**启动期读一次**（热改不生效、须重启）；**env `BOARD_CONFIG` 只覆盖配置文件路径**，`--port` / `--orgs-dir=` / `--group=` / `--host-kind=` 等 argv 与 `BOARD_PORT` / `BOARD_ORGS_DIR` / `BOARD_MCP_GROUP` / `BOARD_HOST` 等 env 的**配置内容通道已全部撤掉**（写了无效）。非法值以 `[config] <字段路径> …` 文案 fail-fast、不静默降级；**缺文件不裸崩**（文案提示从 `.default` 复制）。启动横幅回显「配置来源路径 + 逐键生效值」。
- **`port`**：缺省 `3400`。**绑定地址恒为 loopback**（`host` 可覆盖为 `::1` / `localhost`；非 loopback 一律拒起）。写端点随服务同绑定，**绝不暴露到 `0.0.0.0`**。**loopback-only 是刻意封的，不是遗漏**：板带真写面（提需求 / 触发一轮 / 发确认 / 停桥）而**零鉴权**，放开非 loopback 的**前置 = 先有鉴权**（跨机鉴权归 **V4**，其落地前不松）。确需远程访问 ⇒ 不动绑定，在板前挂一层**反向代理**做鉴权（Basic Auth / 内网白名单，只放 `/` 到板），板自身仍只 listen loopback。
- **`bridgeUrl`（读面桥基址）**：缺省 `http://127.0.0.1:3300`（只读运维视图 `/api/*`）。**`mcpBaseUrl`（写面 MCP 基址）**：缺省 `http://127.0.0.1:8787`（编排桥 MCP 面，与读面 3300 是两个端口）。
- **组织名 = 用户在提需求表单里创建/指定**（BD11，用户裁定 2026-09-24：「组织名 用户板上自己创建就好」）：表单的 `group` 字段即本条需求的组身份，**写进 MCP URL 首段**（`/<组名>/mcp` = 身份链 S1）并决定组织目录名。**第一次填写某组织名 = 在板上创建该组织**（落点 = 板侧台账 + `<orgsDir>/<组织名>` 目录；**不是**改 orch/machine 配置）。
- **`group`（板级默认组织 · 可选默认，BD11 由「必填配置」降级）**：仅当**表单留空**时作为兜底；**未配置不是错误**——板照常起、`GET /host` 与读面不受牵连，只是表单的组织名变成必填。**空串 / 纯空白一律按未配置算**。**绝不猜、绝不回落任何兜底组名**（静默猜组名会把需求建到别的组里去）。
- **`orgsDir`（组织目录根 · BD8 · §3.8 裁定 9 · BD15 两层分职）**：**配置文件里同样无兜底缺省**：留空 / 缺键 ⇒ **宿主面不装配**：板不去 spawn 任何后端进程，`GET /host` 如实显示「宿主面未装配」，宿主写端点返回结构化 503 `host_face_disabled`。**根 = 部署面配置，必须预先存在**（不存在 / 不是目录 ⇒ 启动期明确 warn + 触发期结构化 503 `board_orgs_dir_missing`，配错必须可见，**板刻意不代建根**）；**`<orgsDir>/<组织名>` = 数据，缺失时由板自动创建**（BD15：触发一轮时代建该组织子目录，用户不必先回终端 `mkdir`；已有目录不碰；建不出来才报 `org_workspace_missing`，文案含**绝对路径 + 根因**）。**停用闸（v0.9.4 A4 · BD3）**：组织在板台账被标记停用 ⇒ host-face 的 **spawn/ensure 唯一配置入口 `orgBridgeConfig`** 返回结构化 503 `board_org_disabled`（不起桥、不 spawn 任何后端进程；触发一轮与轮内重拉桥同闸）；`prepareWorkspace` 的代建纯函数**不携组织状态知识、保持不动** —— 停用组织的工作区供给能力仍在该层，只是没有任何入口能把桥拉到那一步。恢复 = 同名重新建组织（复活，零迁移）。
- **`hostKind`（宿主后端 kind · BD8）**：缺省 `claude`。仅作为**新建桥的缺省 kind**（`kind → 后端命令` 的映射唯一事实源在 machine 侧 `getAdapter()`，板不自拼 argv）。**`machineDist`**：machine 运行时产物目录，缺省按仓根推导 `<仓根>/machine/dist`。**`turnTimeoutMs`**：单轮有界等待毫秒，未配置交下游缺省（10 min）。
- **`repoRoot`（主仓根 · BD10 读文档面）**：**单文档打开**（`/features/:id/docs?file=`）的**源 A** 锚点 = `<repoRoot>/doc/{version}/`，源 B = `<orgsDir>/<org>/doc/{version}/`。缺省 = 板根上一级（由模块位置反推，源码与 dist 运行落同一仓根）。不填 = 用推导缺省；非法类型 ⇒ `[config] repoRoot` fail-fast。⚠ **目录不存在不是错误**：读取按结构化 `not_found` 降级（B3 口径），板不代建、启动期不报错。读取受守卫四件套约束（根内收 / version 白名单 `v\d+\.\d+\.\d+` / 仅 `.md` / 256KiB 上限，超限截断标记），见 `src/docs-read.ts`。**v0.9.2 按需求归约后本键不再承载目录扫描**（详情页「阶段产出」改由 `decisions` 驱动，板不列 `doc/{版本}/` 全目录）。
- **`releasedVersions`（已发版锁版清单 · REQ-v0.9.2 增补 ⑤ N1/N2/N3）**：**板前台版本锁的唯一事实源**（人工在发版收尾时登记，语义见 `config/config.json.default` 的 `_releasedVersionsComment`）。**锁判据 = trim 后精确串匹配**（不前缀连坐、不做 semver 归一），命中即锁两条写口：**提需求**（目标 ∈ 锁版 ⇒ 409 `board_version_released`）与**排期写**（`POST /features/:id/schedule` 三分判：现 ∉ 锁版 ∧ 目标 ∈ 锁版 = 入锁拒；现 ∈ 锁版 ∧ 目标 ≠ 现版本 = 出锁拒，**含清空回池**；现 = 目标 ∈ 锁版 = **幂等放行**）。空 version（未排期）恒不参与锁 ⇒ 未排期 ↔ 未锁版间的一切变动照常；**已发版版本内存量的非终态需求仍可触发一轮 / 确认 / 澄清 / 推进收尾**（锁只作用于 `version` 写，不锁生命周期）。缺省（整键删除 / 空数组）⇒ 无锁。⚠ **只锁板前台**，宿主经 MCP 直写 `version` 是已知后门；改动须重启板进程生效。
- **配置缺失的后果（两句同口径，互不牵连）**：
  - **默认组织未配置 ⇒ 什么都不牵连**（BD11：它已从「写面必填」降为「可选默认」，**启动期零硬失败**）。校验点在**请求期**：表单组织名留空 **且** 无板级默认 ⇒ `POST /requirements` 返回 **400 `board_group_required`**（不猜、不回落）；宿主面在桥侧 `ownerGroup` 也为空、且默认组织也未配置时返回结构化 503 `board_org_not_resolved`（**不猜组织名**）；
  - 组织目录根**未配置也不拒起**：宿主面不装配，起桥 / 触发一类的写端点返回结构化 503 `host_face_disabled`。
  两者都会在启动日志里**各打印一行明示**（不静默；默认组织那一行是**提示**不是报错），并如实反映在 `GET /host` 的配置行上。
- `version` 从 `package.json` 读取，不硬编码。

### 组织的语义边界（BD11 · 本版做到哪、不做到哪）

**「创建组织」在本版 = 在板上首次使用该组织名**。其落点只有两处，都在板侧：

1. **板建需求时的 MCP 组身份**（= `/<组织名>/mcp` URL 首段）⇒ 引擎侧该 Feature 的 `owner_group` 即此名；
2. **组织目录** `<orgsDir>/<组织名>` ⇒ 宿主桥 `--workspace`（经 `resolveOrgWorkspace`，含防逃逸校验；**该子目录缺失时由板自动创建** —— BD15，「第一次填写组织名」自此不需要人工先建目录）。**v0.9.4 §9-a 增补**：建组织的成功路径**当场建该一级目录**（`POST /orgs` 写台账后立即 `mkdir`，幂等 —— 已在不碰、**根仍不代建**），目录不再等「首次起桥」才出现；建不出来 ⇒ 结构化 503 `board_org_dir_create_failed`（含绝对路径 + 根因 + 同名重建对策），不静默假装就绪。

**不包含**：组织管理页 / 增删成员 / 在 machine 侧建 project / 写 `projectGroup` / 改 orch·machine 配置 —— **全归 V2**。
**板仍不写引擎状态机迁移**：`a2a_feature_approve` / `a2a_feature_cancel` 两个真·迁移工具名在 `src/**` 的引用数恒为 **0**；
`a2a_feature_advance` 命中文件集合恒 == **`feature-schedule.ts` 一处**（排期写唯一封装，只借「`to` = 当前态 ∧ 仅 `version`」登记字段特例，不迁移状态机）；
`a2a_config_write_group` 命中文件集合恒 == **`group-admin.ts` 一处**（v0.9.4 B 档 · BD4 起组织成员写唯一封装 —— 板上打向 orch `config.json` 的**唯一受控通路**，故该文件命中集合扩一个即出声）。
（`test/requirement.test.mjs` 纪律扫描 + `test/server-write.test.mjs` 的 BD11-⑥ 负向锚：写面白名单里不存在任何 approve / cancel 路径，`/features/:id/advance` 亦非写路径 → 404）。

开发：`npm run typecheck`（0 错）· `npm test`（纯单测，不依赖桥在跑）· `npm run build`。

## 页面路由（BD3 只读视图 + BD7 / BD8 / BD9 写端点 + BD11 读文档面）

| 路径 | 方法 | 数据源（桥） | 内容 |
|---|---|---|---|
| `/` | GET | 组织台账（`.data/orgs.json`）+ `/api/features`（**复用列表 `getFeatures()` 派生计数 ⇒ 零新桥接口、零缓存**） | **项目组门户首页**（REQ-2026-09-27-06 §9-b · 首页形态 B→A）：一行一张组织卡，卡清单 = 纯函数 `orgs-view.portalOrgNames` 口径 = **台账在用名（板台账 ∪ 宿主桥托管）∪ 需求归属 `ownerGroup` ∪ 板级默认，剔除停用名**（与侧栏二级项目组清单**同一函数、同一口径**；**磁盘一级目录不再进** ⇒ 盘遗留目录与外机组不构成板可见组织）；卡头 = 组织名链进 `/org/<名>/`（D 档空间），计数摘要 = `排期中`（`version` 非空）/ `需求`（名下总数）/ `任务`（各需求 `taskCount` 之和，列表未带 ⇒「—」不臆造）；建组织 = 页头**「＋ 建项目组」按钮**（服务端 `hidden`，无 JS 不显死按钮）+ `<dialog id="new-org-dialog">` 弹窗（§9.5 增补六；表单与校验原样复用，**写口仍 `POST /orgs`，服务端零改动**；无 JS 回退 = 正文 `#new-org-inline` 内联表单照旧）；orgsDir 状态行故障两档（err/warn）可见、ready 档不再展示（增补三 REQ-2026-10-02-03）。本页只注入**泛化后的弹窗脚本**（`NEW_REQUIREMENT_DIALOG_SCRIPT` 一枚，闭集仍六元，见「渲染」段），排期看板的浮层 / 拖拽 / mermaid 三枚不跟（随 `/schedule` 走）。旧首页书签落本页（不做 303） |
| `/schedule` | GET | `/api/features`（**复用列表 `getFeatures()`，零新桥接口**） | **全局排期看板**（v0.9.2 M4 起为本页正主；REQ-v0.9.2 增补 ④ N1 起曾由首页 `/` 承载，**§9-b 起首页改渲染组织门户、看板整体迁回本页**；浮层 / 新增需求弹窗 / 拖拽 / mermaid 四枚脚本同迁，注入组合不变）：**v0.9.2 M4** 板内存按 `version` 归组（`version-order.ts`：semver 数值序、非 `x.y.z` 字典序垫底）；列头 = 版本号 + **版本状态徽标（增补 ⑤ N4 · `version-status.ts`：锁版命中 ⇒「🔒 已发版」、未锁版按派生态 ⇒「进行中」/「已收尾」（增补 ② 补渲染，样式区分：锁=棕 🔒 / 进行中=蓝 / 已收尾=绿；「已收尾」判据与发版闸**同口径** = `completed + cancelled === total ∧ completed > 0`，含 `failed` 回落「进行中」），**仅显示提示、不参与执法**，tooltip = 派生 note）** + 卡片数，卡片 = title + 状态徽标 + stage/approval + taskCount（按状态分列不做）；未排期（`trim()===""` 单一判据）不占版本列，集中本页末列「需求池」（M5）。**详情浮层（REQ-v0.9.2-2026-09-26-02 增补 ④）**：点卡片标题 = `FEATURE_DETAIL_OVERLAY_SCRIPT`（页面脚本白名单内联字面量常量之一，见「渲染」段口径）拦截 → fetch 同 URL → 抽详情页 `<main>` 内层搬进 `<dialog>` `showModal()`（Esc / 关闭按钮 / 点 backdrop 收起；fetch 失败降级原生导航）；卡片仍是真 `<a href="/features/:id">` ⇒ **浮层脚本失效 / 链接直达 = 整页详情**（渐进增强回退面）；浮层内同源链接（文档页 / 回到需求详情 / 渲染原文切换）同样在浮层内展示，浮层内表单提交（触发一轮 / 确认 / 保存排期）也在浮层内完成 —— fetch 承接响应：成功（303 跟随后）换入新详情正文，4xx/5xx **不换 body**（表单与已填输入原样保留）、只抽 errorOverlay 卡**叠加为 `<dialog>` 的直接子元素**（`position: fixed` 居中 + 超大 spread shadow 当半透明遮罩 ⇒ 悬浮在浮层内容之上，**不进 `.fd-body` 文档流、不把表单顶下去**；浮层内换页时先摘残留卡，「知道了」摘卡后本表单已由脚本复位〔重新启用提交按钮 + 摘「已提交…」提示行〕⇒ 可改后重提；抽不到卡才回退换入错误页正文）；浮层内提交**不跳页**，故提交守卫的禁用态由 `FEATURE_DETAIL_OVERLAY_SCRIPT` 在响应处理完后主动恢复（降级原生提交前同样先恢复）；两处 fetch **必须带 `Accept: text/html`**（文档读面按 Accept 双档分流，缺省 `*/*` 拿到 `text/plain` 无 `<main>` ⇒ 会降级成整页跳转）；网络异常才回落原生提交 / 原生导航（同无 JS）|
| `/requirements` | **GET** | `/api/features`（含板内存过滤） | **需求列表页**（增补 ④ N1 起自旧 `/` 迁入）：提需求表单（**含组织名字段** · BD11；**`version` 去必填 · v0.9.2 M6**：留空 = 未排期，建卡即进需求池）+ 需求列表：登记 `stage`+`version`+`approval` + **派生阶段**（`derive.ts` 单点规则）+ 列表自带 `taskCount`（无 N+1）+ 过滤表单。**与下行 POST 同路径双义**（方法门先于页面匹配：同 URL GET ⇒ 列表页、POST ⇒ 建需求）|
| `/requirements` | **POST** | MCP `a2a_feature_create`（经 `requirement.ts`）+ 建卡成功后自动点一发首轮（宿主面 `triggerTurn`，fire-and-forget） | 提需求：建一条初态 `waiting_approval` 的需求（详见下节）；**目标组织在板台账已停用 ⇒ 409 `board_org_disabled` 零出网**（v0.9.4 A4 · BD3，判据 = `orgs-ledger.isOrgDisabled`；表单 `group` 与回落的板级默认组同口径）|
| `/features/:id` | GET | `/api/features/:id` + `:id/trace`（**v0.9.2 起不再扫本地 `doc/` 目录**） | 需求详情 + **阶段产出**（**REQ-v0.9.2-2026-09-26-01 按需求归约**：数据源 = 本需求 `decisions`，旧「产出登记」并入本区 ⇒ 逐条渲染、含 `doc/…/*.md` 路径者成可点条目（版本取当前排期值）；**登记的文档版本 ≠ 当前版本 ⇒ 区首渲染失联警示行**（M6，纯文案警示，不新增页面脚本）；**无含 doc 路径的条目 ⇒ 「无（本需求未登记产出）」，不回落版本目录清单**）+ 任务列表 + **trace 三面**（在等谁 / 位次 / 为什么没跑）+ **排期表单（M6 · `POST /features/:id/schedule` 的 GET 面）** + 宿主轮表单（触发一轮 / 确认指令；**回答框仅在该需求有 `awaiting_answer` 轮时出现**；**该需求已有在飞 / 排队轮 ⇒ 两按钮渲染为 disabled + 原因**，收口轨 14）|
| `/features/:id/docs?file=<name>[&src=A\|B][&mode=render\|raw]` | GET | **本地 `doc/{version}/`**（`docs-read.ts`） | **单文档内容**（BD11 · **BD14 渲染/原文双档**）：版本与归属组织取自桥侧详情（**不接受调用方传版本**）；默认 `text/plain; charset=utf-8` + `no-store` 原文直出（`text/plain` 档不受 `mode` 影响），`Accept: text/html` ⇒ 整页：**缺省 `mode=render`**（markdown 子集渲染 + ```mermaid 围栏走流程图渲染），**`mode=raw`** ⇒ 现行 `<pre>` 转义原文，页头两档互链。守卫 = 四件套（根内收 / version 白名单 / 仅 `.md` / 256KiB 截断），越界或缺失 ⇒ **400 / 404 且响应不携根路径** |
| `/static/<名>` | GET | **本地 vendored 资产**（`src/web/static/`，白名单闭集 `docs-render.VENDORED_ASSETS`） | **BD14 · 第三方静态资产端点**（当前唯一 = `mermaid.min.js`）：文件名精确匹配白名单，白名单外 / 越界段 / 缺文件 ⇒ **404**（不列目录、不越界读）；非 GET ⇒ 405。响应带同源 CSP（`script-src 'self'` 放行加载） |
| `/tasks[?project=]` | GET | `/api/tasks`（`project` 桥侧必填） | 任务视图（无参 = 选单页）|
| `/projects` | GET | `/api/projects` | 项目 / 机器 / Runner 快照（快照语义标注）|
| `/agents` | GET | `/api/projects` + **逐项目并发** `/api/tasks` + **MCP 基址的桥 `GET /health`**（`mcpBaseUrl`） | **Agent View（REQ-2026-09-26-02 B-T3 · 只读）**：① **页头 = 编排桥 identity/version**（role / pid / startedAt / version —— 原 3300 页面退役后的**唯一承载位**；`/health` 未带的键如实显示「—」，板不读他单元 pidfile）；② **机器表** = `/api/projects` 的 `runners` ∪ `machines` 按 `machineId` 归并（无 runner 登记 ⇒ 「未知」不判离线）；③ **在飞任务区** = 逐项目并发拉 `/api/tasks`（**不加 state / limit 过滤**，在飞筛选在板侧纯函数：终态闭集之外即在飞）、按 `claimedAt` 升序（缺键沉底）、单项超时 / 失败 ⇒ 该项目「**不可达 ≠ 没有在飞**」灰化不炸页；④ **页脚口径行** = 闸内排队与 machine 读席占用 orch 不可见、两个时钟不得相加。零写、零缓存、零新增存储 |
| `/host` | GET | （不触桥；本板进程宿主面） | 宿主桥状态页：五态 + 结构化错误 + 轮队列（BD8）|
| `/orgs` | GET | （不触桥；重定向不读任何数据源） | **§9-c 退役**（REQ-2026-09-27-06 N3）：整页下架 ⇒ **303 回组织门户 `/`**（同 `/requirements` 退役先例：PRG 用 303 不用 301，留反悔余地；重定向不触桥 ⇒ 桥宕时照样 303）。原页职能分三处落点：**建组织表单** = 门户 `/`（§9-b 已迁）；**逐组需求 / 项目 + 成员写 + 停用** = 空间内管理页 `/org/<名>/manage`（下行）；**组织清单与切换** = 门户卡清单 + 侧栏二级项目组清单（件1 起，原「顶栏切换器」形态已删，`portalOrgNames`）。**非 GET 同径仍 405**（`PUT /orgs` 的「405 文案列全写面」锚保持；`POST /orgs` 在更前面的写面白名单已分流，见下）|
| `/requirements` | **POST** | MCP `a2a_feature_create`（经 `requirement.ts`）+ 建卡成功后自动点一发首轮（宿主面 `triggerTurn`，fire-and-forget） | 提需求：建一条初态 `waiting_approval` 的需求（详见下节）；**目标组织在板台账已停用 ⇒ 409 `board_org_disabled` 零出网**（v0.9.4 A4 · BD3，判据 = `orgs-ledger.isOrgDisabled`；表单 `group` 与回落的板级默认组同口径）|
| `/org/<组织名>/requirements` | **POST** | 同上（归一后命中全局写路由，`WRITE_ROUTES` 不扩前缀变体） | **组织空间提需求（v0.9.4 D 档 · BD6 归一 + BD8 免选）**：前缀在路由入口剥离并校验（组织不存在/段非法 404、停用 410，先于入参校验），其后与上行**同一处理链**；空间档以路径组织为准 —— 表单组织不一致 ⇒ **409 `board_org_mismatch`** 零出网、禁板级默认回落；表单侧 = 免选形态（只读展示 + hidden 值必发，action 带前缀 ⇒ 无 JS 原生 POST 同路成立）|
| `/org/<组织名>/manage` | GET | `/api/features`（`ownerGroup` 板内存归并，零新桥接口）+ **逐组只读** `a2a_projects` + **全组只读枚举** `GET /api/groups`（3300） + 本地组织台账 | **组织空间管理页（REQ-2026-09-27-06 §9-c · 承接原 `/orgs` 页的写宿主职能）**：只在**归一层放行**的在用组织上渲染（组织不存在 / 段非法 404、**已停用 410** 同 D 档空间口径，不另立档位）。区块 = ① **成员区**（**声明面**清单 = 3300 `GET /api/groups` 该组成员投影 `machineId`/`projectId` + 成员数 + `observedAt` + `warnings[]` 小字**不入判定**；未装配 ⇒「未查询」、3300 宕 ⇒ 本区整块灰显「组数据不可用」而**不阻断本页**、声明面无该组 ⇒ 如实「未声明」并指向「加成员首次写入即建组带首成员」的 §9-a 兜底）+ ② **成员写表单**（增 / 删两枚，`action` 复用全局 `POST /orgs/{org}/members`，字段 `action=add|remove` + `machineId` + `projectId`）+ ③ **停用本组织**（`action=disable` 走既有 `POST /orgs`，同一条路由靠 `action` 分流）+ ④ 本组织需求表 + ⑤ 本组运行态项目表（只读 `a2a_projects`，与 ① 的声明面**并存、不替代**；单组超时 ⇒「不可达」灰化不炸页）。**空间内导航行**（`renderSpaceNav`）自此含四枚链接 = 排期 / 需求 / 任务 / **管理**。**表单 `action` 一律全局路径**（归一层不扩前缀写变体）；**零新脚本**（内联脚本闭集仍六枚）；除上述写口外零写、零缓存、零新增存储 |
| `/features/:id/turn` | **POST** | 宿主桥 A2A 面（经 `host-face.ts`） | 触发一轮：起桥 + 投首轮提示词，**不等排队轮**（BD8）；该需求已有在飞 / 排队轮 ⇒ **409 `board_turn_busy`** 不重复入队（收口轨 14）|
| `/host/:org/stop` | **POST** | 同上（进程侧） | 停桥（BD8）|
| `/features/:id/confirm` | **POST** | 同 turn 通道（`triggerTurn(kind=confirm)`） | 人工确认指令：投「用户已确认改造文档，请核对后执行放行」的一轮消息给宿主 agent（BD9，**板不批准**）；占用时同 **409 `board_turn_busy`**（收口轨 14）|
| `/features/:id/answer` | **POST** | `answerTurn`（同 `contextId` 续推） | 澄清回答：仅当最新轮 `awaiting_answer` 可投，否则结构化 409（BD9）；占用时同 **409 `board_turn_busy`**（收口轨 14）|
| `/features/:id/schedule` | **POST** | MCP `a2a_feature_advance`（经 `feature-schedule.ts` 唯一封装，「`to` = 当前态」特例） | **排期写（v0.9.2 M3 · 唯一放开的登记字段 `version` 写）**：表单 `version` 键必传（空串 = 清空回池，服务端 `trim()`）；身份 = 该需求 `ownerGroup`（缺失 ⇒ 503 `board_schedule_owner_group_missing`，**绝不回落板级默认组**）；**已发版锁（增补 ⑤ N3）**= 出网前「现版本 × 目标版本」三分判：入锁 / 出锁（含清空）⇒ **409 `board_version_released`**（回填目标 + 现版本）、同锁版无变化 ⇒ **幂等放行**；**双条件状态闸（v0.9.3 B-T5）**= 版本改动（`trim` 后非等串）仅当 `stage = 需求分析 ∧ approval = 未发起`（想法挪版档）放行，否则 **409 `board_schedule_state_locked`**（`stage`/`approval` **只作读判**，来自 `getFeature`，**不进装配载荷**；老桥缺字段 ⇒ fail-closed 拒写；同版重提豁免；两把锁**叠加、互不替代**，先判版本锁）；**改版自动善后（v0.9.3 B-T6）**= 写成功 ∧ 确实改版 ⇒ `decisions` 登记的主仓 `doc/{旧版}/*.md` 自动搬至 `doc/{新版}/` 并第二跳 advance 追加新路径（幂等 / 守卫见下「受限 mv」段，回执进 JSON 出参 `docMoves`，**善后失败不回滚排期写、不裸 5xx**）；桥拒 ⇒ 502 如实弹（不自动重试）；成功 = PRG 303 回详情页 / JSON 档 200|
| `/orgs` | **POST** | （不触桥；板侧组织台账 `.data/orgs.json` · `orgs-ledger.ts` 原子写） | **组织写（v0.9.4 A 档 · BD1 建 + A3/BD3 停用）**：**一条路由靠表单 `action` 分流**（缺省 / `create` = 建，`disable` = 停用；写端点白名单**不扩条** ⇒ 405 文案仍与全局 `WRITE_ROUTES` 单点同步（BD4 起共八条业务 POST）；`action` 值不在闭集 ⇒ **400 `board_org_action_invalid`**，不猜动作）。**建**：CSRF 同规格；组织名校验单一纯函数（`write-guard.validateOrgName` · 字符集闭集 = 中文 / Latin 字母 / 数字 / `-` `_` `.`，禁空格与 `#` `?` `%` `/`）；写入前置闸 = `diagnoseOrgsDir` 根存在性（**根不代建**，未配置/不可用 ⇒ 503）；三源重名闸 = 盘枚举 ∪ 在用台账 ∪ 需求 ownerGroup（命中 ⇒ **409 `board_org_exists`** 文案点名来源；桥读不动 ⇒ fail-closed 502 不建）；**已停用名豁免查重** ⇒ 同名提交 = 复活（`disabledAt` 归零、目录与需求不动，零迁移）。**停用（= 板上的「删除」）**：CSRF + 同名校验 → **前置闸：名下有活跃宿主桥（`running` / `starting` / `unreachable`）⇒ 409 `board_org_has_active_bridge`** + 浮层引导「先逐桥 stop 再删」，**绝不隐式连带停桥**（停桥仍只经 `POST /host/:org/stop`）；宿主面未装配 ⇒ 无桥可拦、照常放行；过闸后写台账 `disabledAt`（**不物理删目录**；重复停用幂等 ⇒ 保留首次停用时刻）。两档均**不触桥、不写状态机、不写 machine 配置**（ownerGroup 不是板可写数据）；成功 = PRG 303 回 `/orgs` / JSON 档 201（建）· 200（停用）。**§9-c 起本行零改动、只改落点体验**：`/orgs` 已退役 ⇒ 浏览器跟随 303 后由该路径再 303 一跳落组织门户 `/`（**写口不改 `Location`**，反悔 / 旧书签同源）|
| `/orgs/{org}/members` | **POST** | MCP 配置面组写工具（经 `group-admin.ts` 唯一封装，组身份 = 目标组织名） | **成员写（v0.9.4 B 档 · BD4 · 第三个 MCP 写封装）**：**一条路由靠表单 `action` 分「增 / 删」**（`add` → `group.member.add`、`remove` → `group.member.remove`；表单路径**无法产出** `group.add` / `group.update` / `group.remove` —— 唯一例外见下「组不存在兜底」）。落点 = **orch `config.json` 的 `projectGroup` 段**（**板绝不直写该文件**；桥不可达 ⇒ 502 结构化报错 + 浮层引导，**不降级本地直写**）。`action` **无缺省**：缺失 / 越界 ⇒ **400 `board_member_action_invalid`**；成员对 `{machineId, projectId}` 不全 ⇒ **400 `board_member_pair_missing`**（`machineId` 合法性**不在板上判**，判据唯一在桥 dry-run）。URL 段组织名仍经 `validateOrgName` 单一事实源（不合法 ⇒ 400）。CSRF 同规格（先于入body）。**错误映射读面**：闭集六元 → 422 / 409 / 500，其中 `config_write_group_not_found` → **保守文案**「目标组不存在（或已被移除）」（不转译桥原文）；**组不存在兜底（v0.9.4 §9-a 死锁修复）**：`add` 撞 `config_write_group_not_found` ⇒ 封装内**自动改发一次 `group.add`**（`{op:"group.add", groupName, members:[同一成员条目]}` = 建组带首成员一次写入，解「新组织第一个成员永远加不进」的鸡生蛋死锁；O1 契约零改动、仍单工具单封装）—— 成功即当成功处理（JSON 回执 `groupCreated: true`），兜底**只对 `add` 一次**（`remove` 撞组不存在仍是 409 保守文案，不得翻译成建组），兜底自身失败 ⇒ 如实上报该次错误码、不级联第三次；`config_write_concurrent_modification` ⇒ 封装内**单次自动重读重试**（O1 每次现读 config、板不缓存成员清单 ⇒ 同一 op / 同一成员对重投恰好一次），重投仍拒 ⇒ 409 + hint 说明；非闭集码（transport / jsonrpc / 坏信封）⇒ **502**。成功回执：**有内容**（`changed` / 操作后成员 / `backedUpTo` **仅展示不解析** / `retriedOnce` / `groupCreated`）⇒ 表单档出整页成功卡（口径同 N7），JSON 档 200；**加成员**附 G11 驻留引导（目标机未登记该 project 仍须**人工重启该机 Launcher**）。写后**热生效**（桥 per-call 现读，无需重启）|
| `/shutdown` | **POST** | （不触桥；本板进程） | **运维路径**：优雅停机 —— 先停宿主桥 → 关卡口 → 删 pidfile；**仅 loopback 来源**（否则 403 `loopback_only`），**200 = 受理 ≠ 已停**（BD13″）|

**方法门是白名单，不是一刀切**：读面仅 GET，写面只放开上表八条业务 POST（`write-guard.isWriteRoute`，清单单点 = `WRITE_ROUTES`）；其余任何路径 × 任何非 GET 方法一律 405，未知路径 404。**`POST /shutdown` 不在这条业务白名单里** —— 它是同服务上单独登记的**运维路径**（不经 CSRF 守卫头，改以「socket 远端地址必须 loopback」把关，非 loopback 一律 403）。板**不写状态机迁移** —— 无 approve / cancel 任何路径、也不把主链 `advance` 到非当前态：确认与回答都只是**给宿主 agent 的一轮消息**，状态机推进归编排 agent（`src/**` 对 approve / cancel 两个迁移工具名引用数 = 0，`a2a_feature_advance` 只收敛于 `feature-schedule.ts` 一处排期写封装、`a2a_config_write_group` 只收敛于 `group-admin.ts` 一处成员写封装，均由 `test/requirement.test.mjs` 纪律扫描钉死；`version` 排期写端点 `POST /features/:id/schedule` = 该封装的唯一 HTTP 前台，**已发版锁版在此端点与提需求口一并执法**，见「配置项」`releasedVersions`）。

**读文档面（BD11 · 唯一的本地**读**面扩权）**：`/features/:id` 的「阶段产出」区与 `/features/:id/docs` 让板**第一次读本地文件**。它是**纯读**（本面自己不写文件、不改 `orgsDir`，恒 GET ⇒ 不过 CSRF，与其余读面同口径；板上非 HTTP 的本地写见下「排期改版的本地写」，HTTP 面的本地写 = v0.9.4 起 `POST /orgs` 的组织台账），且参数只能落到 `doc/{version}/*.md` 子树：版本段白名单 `v\d+\.\d+\.\d+`、文件名段卫生 + `.md` 闭集、resolve 后根内收核验（Windows 大小写不敏感）、256KiB 读上限（超限截断提示）。任一不过 ⇒ 结构化降级（区块显示「无」/ 400 / 404），**降级不报错、响应不携根路径**。`decisions` 里提取到的路径**不进条目展示**（v0.9.2 条目样式简化：条目 = 单链接、文字为剥去 `doc/{版本}/` 后的文件名），打开仍走上述守卫。**v0.9.2 按需求归约**：区块条目 = 本需求 `decisions` 登记（不再由目录扫描得出），`docs-read.ts` 的 `listDocs` / `classifyDoc` 已作废删除，板本地读收窄为**单文件读取**一条路径。

**排期改版的本地写（v0.9.3 B-T6 · 受限 mv · `src/docs-move.ts`）**：板第一次**写**本地文件，且**不是 HTTP 面** —— 没有新增任何写路由、`/static/` 白名单不扩，它是排期写成功后的**服务端文件动作**（同函数链内联执行）。守卫与读面同族但更严（动作对象是盘上文件）：

- **只动主仓（源 A）**：判据 = 该登记文件在 `<repoRoot>/doc/{版本}/` 树内**确实存在**。登记文本对源 A / 源 B 是同一形态（读面先查主仓、未命中回落组织工作区），板**无法从文本区分双源** ⇒ 主干未命中一律**不碰**，列入回执 `manual` 交宿主手工（组织工作区文档天然落在这里，**不自动搬、不凭它造新文件**）；
- **只动 `decisions` 登记路径**：非登记文件永不成为动作对象；目标已存在 ⇒ **跳过 mv、仅登记**（不覆盖），重放同一次改版结果稳定；
- **段卫生 + 根内收**：`doc/` 只认独立起点（前面紧挨 `/` `\` `:` 或词字符 ⇒ 是别的路径的后缀，拒）；`..` / 盘符 / 绝对 / 反斜杠 / `%` / 非 `.md` / `doc/` 下多于一层 ⇒ 逐条列入 `rejected`（**不静默吞**），拒在规划层，不给文件动作机会；目标版本不合 `v\d+\.\d+\.\d+`（含清空回池 = 空串）⇒ 整体不搬，文档留原目录（详情页 M6 失联警示行仍如实显示）；
- **登记追加只收搬成项**（`moved` + `registerOnly` 去重）；无搬成项 ⇒ **不发空 `decisions` 的第二跳**。第二跳失败 ⇒ 进 `docMoves.failed` 并写明「文档已搬、请宿主手工补登记」。

`mv` / `plan` 两级为纯函数 + 可注入文件谓词（离线自测，见 `test/server-schedule-docs-move.test.mjs`）。

### 排期看板的版本维护（v0.9.4 · 版本台账 + 框头删除入口）

**事实源已换**：版本状态不再读 `config.json` 的 `releasedVersions`（该键已退役，残留时一次性 warn 不双读），改读**板侧版本台账** `.data/versions.json`（`src/versions-ledger.ts`，三态闭集 `notstart` / `active` / `released`，热生效免重启）。**唯一键 = `(组织, 版本)`**（v0.9.6 B1 起 schema 2）⇒ 不同组织可各有 `v0.9.5`。写口 = **一条** `POST /versions`，靠表单 `action` 三支分流（`create` / `remove` / `setStatus`，`write-guard.parseVersionActionForm` 值域单点）；组织空间页的表单提交到 `POST /org/<名>/versions`（`src/org-space.ts` 归一层剥前缀后命中**同一条**写口 ⇒ `WRITE_ROUTES` 十一条零扩，路由表零改）。

**页头「＋ 新版本」**（增补七 a · 增补八 §9.3 弹窗化 · 增补十一 E1 §9.6 起为唯一入口 · **v0.9.6 B4 起该入口归组织空间排期页 `/org/<名>/`**）：服务端 `hidden`、由内联脚本显形后打开同款弹窗 `#new-version-dialog`（表单 `action=/org/<名>/versions`，隐藏字段 `action=create`）；**表单零 org 字段** —— 归属只由服务端按**请求路径**注入（伪造 `org` / `group` 字段不改落点），成功 303 回**本空间排期页**。无 JS ⇒ 按钮不显（不显死按钮），建版仍可由编排侧/台账路径完成。全局 `/schedule` 页头那份按钮与弹窗骨架已撤（该页无组织上下文，挂在那里只会把新版本落进未归属空串桶；页壳留待 B5a 退役），`POST /versions` 直投仍可用（落未归属桶，删 / 设状态按「不限组织」取首个命中）。**看板尾「新版本」拖拽虚列（`data-newversion` 哨兵 + drop → `prompt()` 路径）已撤除** —— 拖拽只保留「拖到已有版本列 / 需求池列 = 改排期」一种语义。

**删除入口 ×（框头右上角）**（增补七 b 曾引入列头操作行 · **增补十一 E2 §9.6 删除入口上框** · **增补十一 E3 §9.6 操作行整体撤除**，`views.renderVersionDelete`）：小表单**只接线、写口仍是同一条**（隐藏字段 `action` / `version`；空间页 action 带 `/org/<名>/` 前缀，全局档仍 `/versions`），`data-ov="1"` ⇒ 被拒时抽 `.err-ov-card` 出浮层（无 JS 回落原生 PRG 整页回显）。可见性判据与服务端的闸**一一对应**（不出必 409 的死按钮）：

| 入口 | 出现条件 | 闸（执法在服务端） |
|---|---|---|
| 框头 `×`（`h3` 内，`class="vdel"`） | 台账有该 (组织, 版本) 条目 ∧ 非 `released` ∧ **本组织名下没有任何已确认卡**（`stage ≠ 需求分析` 全假 = 「未开始」，与「首卡过确认门才转 active」同源） | 可删判据（E2 口径变更）= **该组织该版本名下无已确认卡**（v0.9.6 B4 · 口径 30：数卡加 `ownerGroup` 过滤 ⇒ 他组织的同版号卡既不挡本组织删版，也不被本组织的 × 回池）；删除时其下**想法卡自动回需求池**（逐张清空 `version`，不丢卡）；有已确认卡 ⇒ 409 `board_version_remove_confirmed_cards`；回池写失败 ⇒ 502 且不删条目（fail-closed） |
| 版本状态（`released` / 重开 / `notstart`） | **前台零入口**（E3 撤「标记已发版」、增补十 §9.5 撤「重开」）⇒ 三列均不渲染 `setStatus` 表单，`released` 列仅 🔒 徽标 | 服务端 `POST /versions` 的 `setStatus` **保留为后台直投写口**（迁移矩阵五条边照旧执法；**发版闸数卡集合按组织切片** = 「**该组织该版本**名下全部收尾」∧ **有交付**：`total > 0 ∧ completed + cancelled === total ∧ completed > 0`；`failed` 不计入收尾 ⇒ 含 failed 拒，全 `cancelled`（无任何交付）亦拒）；真发版动作待「发版」按钮（另立需求 · 归 v0.9.5） |
| 台账无该版（历史脏列，只由卡片派生） | 无 × | — |

× 的「二次确认」取**明确文案**档（`aria-label` + `title` 写闸 + 提交回显），未引入新内联脚本常量（闭集仍六元）；列头徽标与卡片数结构原样（× 绝对定位在 `h3` 右上角）。单测见 `test/version-column-ops.test.mjs`。

### 文档渲染与 vendored 静态资产（BD14 · REQ-v0.9.1-2026-09-25-04 增补）

文档页（`Accept: text/html`）由「原文直出」升级为「渲染 / 原文双档」，渲染缺省。三块：

- **markdown 子集渲染器**（`src/docs-render.ts`，板侧纯函数，零 HTTP）：**escape-first** —— 输入先**整体 HTML 转义**，再按白名单语法加格式（标题 / 有序·无序列表 / 粗体·斜体 / 行内码 / 围栏代码块 / 表格 / 引用 / 链接）。**链接 href 只放行 `http`/`https`/站内相对路径/锚点**，`javascript:` / `data:` / 协议相对 `//host` 等**整串降级为纯文本**。未识别语法（HTML 内联块、脚注、任务列表……）转义后按段落原样呈现 —— **产出中的任何标签字面量都出自白名单模板**，这是可核对的安全不变量（`test/bd14-markdown-render.test.mjs` 用「产出标签集合 ⊆ 白名单」的负例钉死）。
- **mermaid 流程图**：```mermaid 围栏 ⇒ 占位 `<div class="mermaid-block">` + 源文本经 **`<script type="application/json">` 安全通道**注入（JSON 串里 `<`/`>` 落 `\u003c`/`\u003e`，**绝不拼进 HTML**），页面脚本读 `textContent → JSON.parse → mermaid.render`，配置 **`securityLevel:'strict'`**。渲染失败 / 无 JS ⇒ 保留源文本 `<pre>`（降级可见，不整页崩）。非 mermaid 围栏照常 `<pre><code>`。
- **双档切换**：页头「渲染视图 / 原文视图」互链（`mode=render|raw`，`src` 随链保留）；`raw` 档 = 现行 `<pre>` 转义原文**逐字节原样保留**；`text/plain` 档不受 `mode` 影响（恒原文）。

**vendored 静态资产（板首个第三方静态资产）**：

| 项 | 值 |
|---|---|
| 文件 | `src/web/static/mermaid.min.js`（**入库**，tsc 不拷非 ts 文件 ⇒ `defaultStaticRoot` 从 `dist/` 回落 `src/`）|
| 上游版本 | **mermaid `11.17.2`**（钉死；常量单点 = `docs-render.ts` 的 `MERMAID_ASSET.upstreamVersion`）|
| 取法 | `npm pack mermaid@11.17.2` → 取包内 `dist/mermaid.min.js` → 整文件放入上表路径（**不引 CDN、不进 `package.json` 依赖**：板运行期零第三方 npm 依赖，资产是仓库内的静态字节）|
| 端点 | `GET /static/mermaid.min.js`，文件名 = `VENDORED_ASSETS` 白名单闭集；白名单外 / 越界 / 缺文件 ⇒ 404 |
| CSP | 经 `script-src 'self'` 放行（同源；见上节 BD14 明示放宽）|

**升级纪律**（换 mermaid 版本时）：

1. `npm pack mermaid@<新 11.x 稳定版>`，取 `dist/mermaid.min.js` **整文件覆盖** `src/web/static/mermaid.min.js`（不得手改压缩包内容）；
2. 同步更新 `docs-render.ts` 的 `MERMAID_ASSET.upstreamVersion`（版本钉单点）；
3. 核对 `mermaidRenderScript` 用的 API（`initialize` / `render` / `securityLevel:'strict'`）在新版仍成立；
4. 跑 `npm test`（`bd14-*` 断言占位与 JSON 安全注入，离线即绿，不实际断言 SVG 形状）。

> **离线自测口径**：单测与 HTTP 档均只断言「占位 div + 源文本经 JSON 安全通道注入 + 同源 `<script src>` + CSP 放宽」，**不在 CI 里执行真实 mermaid 渲染 / 不比对 SVG 输出**（无浏览器环境）。真机浏览器渲染验证归 Step 3 用户测试。

### 写端点 `POST /requirements`（BD7）

- **入参**（`application/x-www-form-urlencoded`）：`group`（**BD11 起进表单**：本条需求的组织名；留空则用板级默认组织）/ `title`（必填）/ `version`（**v0.9.2 M6 起去必填**：留空 = 未排期，建卡后进需求池；发送前 `trim()`，空白串归一为空 ⇒ 不会自成一「空格版本列」）/ `requirement`（可选）。
  - **组织空间免选（v0.9.4 D 档 · BD8）**：`/org/<名>/` 空间页的提需求弹窗 = 组织字段**只读展示 + hidden 字段**（hidden 的 `value` 必须仍发出 —— 回落链「表单 > 板级默认 ⇒ 皆空 400」不可绕过），表单 `action` 带空间前缀 `POST /org/<名>/requirements`（归一层剥前缀后命中本写路由，`WRITE_ROUTES` 不扩前缀变体；**无 JS 原生 POST 同路成立**，`NEW_REQUIREMENT_DIALOG_SCRIPT` 按 `form.action` 提交零改动）。空间档服务端**以路径组织为准**：表单组织不一致（含不填落板级默认、篡改 hidden）⇒ **409 `board_org_mismatch`** 零出网；**禁板级默认回落**；错误浮层回填**隐去组织字段**（路径决定、非用户可改提交值；全局档回填不变含组织）。停用组织在空间入口即 410（BD6 归一层），本写口的 `board_org_disabled` 409（BD3）继续兜全局档直投；
  - 空 `title` ⇒ **400 `requirement_form_invalid`**（M6 起空 `version` 不再 400）；
  - `group` 留空 **且** 板级默认组织未配置 ⇒ **400 `board_group_required`**（校验点在**请求期**，文案给出可照做的两条路：表单填组织名 / 配 `config.json` 的 `group`）；
  - `version` 命中已发版锁（config `releasedVersions` · **增补 ⑤ N2**）⇒ **409 `board_version_released`**（零出网不建卡，错误浮层回填「版本」字段）；
  - 全部校验先于任何出网调用（不静默创建）。请求体上限 256 KiB，超限 413。
- **成功回显**：浏览器表单 ⇒ **303 跳转 `/features/:id`**（PRG 三态码，刷新不重复建，且复用既有只读详情页作结果页）；API 调用方带 `accept: application/json` ⇒ **201 + `{featureId, group, state, stage, version, approval}`**（`group` = 本条实际生效的组织名，归属可核对）。
- **建卡即自动首轮（v0.9.5 增补三）**：建卡成功后，板以**本条实际生效的组织名**经宿主面既有 `triggerTurn` 通道自动点一发**纯触发**（不带补充文本 ⇒ 轮消息与动作区「留空 = 只说『继续』」逐字节同档；不扩表单字段、不新增写路由）。三点口径：① **不等收口**（`void`，不 await `submitted.done`）⇒ 上面两档回显的**时延与语义与本功能前完全一致**；② **不污染建卡**（宿主面未装配 / 桥不可达 / 起桥抛错一律不上抛，各留一行 `[auto-first-turn] featureId=… org=… 结果=…` 结构化日志）；③ **防重复用宿主面既有同需求 occupant 判定**（已有在飞 / 排队轮 ⇒ `board_turn_busy`、**不起桥、不入队**，日志记「放弃」）。**人工入口 `/features/:id/turn` 原样保留**（自动那一轮没点着时仍可手工补点）。落点 = `handleWriteRequirement` 的 `fireAutoFirstTurn` 点火口。
- **失败透传**：桥的业务错误码（`feature_invalid_stage` / `project_not_a_member` …）与传输异常（`transport_error`）一律**原样结构化透出**（HTTP 502 + `{ok:false, code, error}`），不吞、不改写成通用错误。
- **CSRF 防线（两档，任一成立即放行）**：
  1. 自定义头 **`X-Board-Write: 1`** —— 跨站表单无法携带自定义头，故这一档足以放行；供 API / 脚本调用方使用；
  2. **同源判定** —— `Origin` 与请求 `Host` 归一后逐字节相等（补全缺省端口、host 小写、IPv6 带括号，故端口写法差异不误判）；`Origin` **不可用**（缺失 / 空串 / 字面 `null` —— 隐私扩展、sandboxed iframe 等会发字面 `"null"`，属**来源不可知**而非跨站，BD16）时退 `Referer` 前缀。供**零 JS 的表单**使用。
  两档皆不成立 ⇒ 403，**两个码可分辨**（`write_guard_origin_unknown` = Origin 与 Referer 皆不可用，文案给出可操作的三条补救：板上表单 / API 带 `X-Board-Write` 头 / 浏览器白名单；`write_guard_origin` = **有名 Origin 且不同源**，明确跨站，**恒拒不放宽**）。CSRF 判定**先于**读请求体与板配置检查，未认证请求既不消耗 body 也不泄露「组配了没」。
- **`Referrer-Policy` = `same-origin`（BD17 · 兜底信号的前提）**：板**同时**以响应头 `Referrer-Policy: same-origin` 与页面内 `<meta name="referrer" content="same-origin">` 给出（同值单点 = `web/layout.ts` 的 `BOARD_REFERRER_POLICY`）。**不得回退成 `no-referrer`** —— 那会让浏览器连**同源表单提交都不发 `Referer`**，而 `Origin` 在隐私扩展 / sandboxed iframe 下可能就是字面 `null`，两档来源信号同时归零 ⇒ 板把自己的「页面上提交需求」这条路掐死（收口轨 11 修的是判定，轨 12 修的是信号源）。`same-origin` **不削弱 CSRF**：跨站请求本来就发不出可冒充同源的 `Referer`，第一档自定义头同样发不出。
- **为什么不是「只认自定义头」**：HTML 表单**不能**携带自定义请求头（规范限制），而列表页要求同源、无构建、**不依赖 JS**（收口轨 14 加的那段内联守卫只是体验层，脚本被禁用 / 失效时表单档必须照样能提交）。故采用上面的 (2) 档：**表单走同源 Origin 校验，自定义头留给 API 调用方**。
- **对 CSP 的影响（收口轨 14 + BD14 + 增补轨 2 · 三处**明示**放宽）**：
  - **轨 14（第一次）**：写表单提交后是整页跳转 + 服务端同步等（触发一轮可跑数分钟），期间零反馈 ⇒ 用户连点。页面因此新增**一段同源内联脚本**（提交守卫，单点常量 = `web/layout.ts` 的 `SUBMIT_GUARD_SCRIPT`，**逐字节同一份、每页注入一次、不含用户数据 ⇒ 无注入面**），CSP 相应新增 `script-src 'unsafe-inline'`（与既有 `style-src` 同款内联程度）。守卫**只是体验层**：禁用本表单的提交按钮 + 就地显示「已提交…」，整页跳转后自然复位；**无 JS / 脚本失效时表单照常提交**，CSRF 两档判定也**不依赖它**，服务端防重另有 `board_turn_busy` 409 硬闸。
  - **BD14（第二次 · 板 CSP 首次从「无外源脚本」放宽到「可加载同源脚本」）**：文档页渲染 ```mermaid 流程图需加载**同源 vendored 资产**（`/static/mermaid.min.js`），故 `script-src` 追加 **`'self'`**：最终 = **`script-src 'unsafe-inline' 'self'`**。放宽面**仅此一条**：`'self'` = **同源**（板恒绑 loopback，无外网主机可被加载），仍 **无任何外源主机 / 无 `*`**；`default-src 'none'` / `style-src 'unsafe-inline'` / `base-uri 'none'` / `form-action 'self'` **四条一律不动**。文档内容**不进 `<script>` 字面量**——mermaid 源文本经 `<script type="application/json">` 安全通道注入（页面脚本 `textContent → JSON.parse` 取回，不拼 HTML），且 mermaid 以 `securityLevel:'strict'` 初始化（详见下节）。
  - **增补轨 2（第三次 · REQ-v0.9.2-2026-09-26-02 · 用户真浏览器反馈）**：排期页详情浮层（增补 ④ · `FEATURE_DETAIL_OVERLAY_SCRIPT`）以 `fetch(同 URL)` 拉整页再摘取详情区，而本 CSP 此前**无 `connect-src` 指令** ⇒ 按 CSP 规范回落 `default-src 'none'`，**同源 fetch 被浏览器静默拦截**（无控制台错误可依赖），浮层总是走降级整页导航。故新增 **`connect-src 'self'`**：最终 = **`default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'`**。放宽面**仅此一条**：`'self'` = **同源**（板恒绑 loopback，fetch 打不到外源主机）；不带 `unsafe-inline` 之外的任何新增档位，其余指令（含前两次放宽的 `script-src` 两档）**一律不动**。断言钉 = `test/web.test.mjs`「增补轨2-CSP」正例锚 + `test/server-write.test.mjs` 响应头全串精确断言。

### 写端点 `confirm` / `answer`（BD9 · 人工确认入口 + 澄清回答入口）

两入口与 BD7 / BD8 写端点**同规格**（同一 `hostWriteGate`：CSRF 两档判定 → body 上限排空 → 宿主面装配检查），且**复用 BD8 的触发通道**，不新写一条链：

- `POST /features/:id/confirm` —— 「人工确认」= 板把「用户已确认改造文档，请核对后执行放行（approve 语义）」作为**一轮消息**投给该需求的宿主 agent（`BoardHostFace.confirmTurn` = `triggerTurn(kind=confirm)`），**由 agent 决定是否真的放行**：条件不满足（如 approval 非「待审批」）agent 会拒绝放行并回报原因，结果如实回显（含 agent 回复摘要 / 错误码）。详情页按钮文案诚实标注「给 agent 的指令 · 不存在『板上批准』」。
- `POST /features/:id/answer`（body `answer=…`）—— 「澄清回答」**仅当**该需求**最新一轮**处于 `awaiting_answer`（= 桥的 `input-required`）时可用：经 `answerTurn` 续推**同一 `contextId`**（组织取该轮记录的 `org`，不重猜）；否则结构化拒绝 **409 `board_no_awaiting_turn`**（一条消息都不投、不起桥）；空答案 ⇒ **400 `answer_empty`**。回答框仅在适用时渲染（判据 = `awaitingTurnOf`）。
- 结局分流沿用 `dispositionHttpStatus` 单点：`succeeded/awaiting_answer/canceled` ⇒ 200 · `queued` ⇒ 202 · `not_awaiting` / **`busy`** ⇒ 409 · `bridge_down/turn_failed` ⇒ 502 · `timeout` ⇒ 504 · `config_error` ⇒ 503。
- **HTML 档的受理成功改 303（REQ-v0.9.2 N7）**：`Accept` 为表单档且结局 = **`queued`（受理成功、本轮排队未开跑）** ⇒ **303 跳转 `/features/:id`**（PRG，同 `POST /requirements` 先例 —— 该档结果页除「排队中」外无内容，详情页的轮次进度行才是它该有的落点，刷新也不重复烧一轮）。**有内容回执的档仍出整页**：`succeeded` 摘要 / `awaiting_answer` 问题原文 / 各失败档根因，跳转会把 agent 的回答与失败原因丢掉。JSON 档不受影响（`queued` 照旧 202 + 结构化载荷）。
- **详情页轮次进度行（REQ-v0.9.2 N7）**：该需求有在飞 / 排队轮时，详情页在「下一步」引导行下方渲染一行 `轮次进度：第 N 轮 在飞` / `第 N 轮 排队中 · 队列第 K 位`（数据 = 板侧轮台账 `round` + 该桥队列可见面 `waiting`，**位次查不到就不显示位次、不臆造**；规则源 = `derive.ts` 的 `deriveTurnProgress`）。**不做 meta-refresh / 自动刷新**（页面脚本 = 白名单化内联字面量常量（无 `src=`、不含用户数据、单点常量可审计；纪律钉见增补 ④ N3），自动刷新不在闭集内 + 与 ~30s 调度拍错拍，登记遗留项），刷新方式 = 重载本页 **或拖一次卡**（改版成功即 `location.reload()`），文案已写明。
- **排期卡拖拽改排期（REQ-2026-09-26-02 B-T5 · 搭头）**：排期看板（`/schedule` 与组织空间排期页；§9-b 起首页 `/` 已是组织门户、不再承载看板）的卡片可**拖到目标版本列**改 `version`（拖进末列「需求池」= 清空排期；池列 `data-version=""`）。**卡片是否可拖 = 派生判据**（`derive.ts` 的 `deriveScheduleGateOpen`：`stage = 需求分析 ∧ approval = 未发起` ⇒ 想法挪版档），闸锁的卡**置灰 + 紧凑标记「🔒 排期已锁」**（v0.9.3 增补 ① 降噪：完整说明——为何锁/板上无解除入口/确需挪版走 cancel 从 Step 0 新建——只在拖拽被拒的 409 错误卡呈现）且不出 `draggable`/`data-*` 属性（不是「拖了再拒」；卡片标题仍可点开详情 —— 拖不动 ≠ 打不开）。**脚本只是体验层**：提交仍复用 `POST /features/:id/schedule`（**不新增写路由**、write-guard `kind=schedule` 原样复用、载荷仅 `version`），执法全在服务端（双条件闸 + 已发版锁 409）；成功 ⇒ 重载，失败 ⇒ 复用错误浮层卡（`.err-ov-card` 居中叠加）。**无 JS / 禁脚本 ⇒ 该通路整体不存在，卡面排期表单照旧可用**（回退不降级为「看起来能拖」）。落点：`src/web/layout.ts` 的 `DRAG_SCHEDULE_SCRIPT`（内联脚本闭集第六枚，与两枚弹窗常量分立、不可共置）+ `src/web/views.ts` 的 `renderSchedule`（`#schedule-board` 容器与列 `data-version`）+ `src/server.ts` 排期写处理链。
- **同需求防重（收口轨 14 ③）**：`turn` / `confirm` / `answer` 三入口在**该需求已有在飞或排队轮**时一律 **409 `board_turn_busy`**（与 `board_no_awaiting_turn` 同族、同 `error{code,message}` 形状，载荷回显**占用轮**的 `turnId` / `round` / `state`，HTML 与 JSON 同码），**不起桥、不发轮、不重复入队**。占用判据 = `running` ∨ `queued` 两值闭集；**`awaiting_answer` 不占**（等人回答不占闸位 —— 否则澄清链路被自己锁死）。落点两层、同一事实源（BD4b 轮闸）：宿主面**前置查** `busyTurnOf`（判据不满足不惊动托管器），`submitTurn` 的**同步段**再查一次并一体入队（连点两发哪怕同一 tick 到达也只放行一条；第二发带 `occupant` 回来 ⇒ 收口成同一个 409）。被拒的提交**不推进轮计数**（检查在 `openSession` 之前）、**不落台账**。
- **渲染态禁用（收口轨 14 ②）**：详情页在占用时把「触发一轮」「发送确认指令」渲染为 `disabled + aria-disabled` + 原因行（**不隐藏入口**）；confirm 的占用原因**优先于** `approval` 判据展示（它直接对应「点了会白点」），无占用时回到既有 approval 三态。规则源 = `derive.ts` 的 `deriveTurnBusyAffordance`，视图不内嵌判据。

渲染 = 同源服务器端单文件模板（`src/web/layout.ts` + `src/web/views.ts`，内联 style、强 CSP、零重型框架；页面脚本 = **白名单化内联字面量常量**（无 `src=`、不含用户数据、单点常量可审计）= 提交守卫 + 错误浮层关闭 + mermaid 渲染 + 排期页详情浮层 + 弹窗（新增需求 / 建组织**两枚 dialog 共用一枚常量**，§9.5 泛化）+ 排期拖拽**六枚**（v0.9.3 B-T5 闭集五→六元；§9-b 起浮层 / 拖拽 / mermaid 三枚随 `/schedule`，门户 `/` 只随弹窗一枚 ⇒ 闭集不扩），纪律钉 = `test/n3-regression-anchors.test.mjs` N3-⑦/⑧ 钉死「全站可执行内联脚本 ⊆ 该闭集且每枚恰好 1 处」；CSP 见上条）。桥不可达 ⇒ 502 页面如实显示错误，不静默。**全站 UI 只保浅色**（`:root { color-scheme: light }`，不提供深色档，浏览器 / 系统深色偏好下亦维持浅色）；**外壳 = 固定侧栏双列**（REQ-2026-09-30-04 件1 · 原型 v2.3 样张①：`body` 走 grid〔216px `position: sticky` 全高侧栏 | `minmax(0,1fr)` 主区〕，侧栏含品牌区 + 一级菜单 + 二级项目组清单；详情页正文内的「主栏 + 侧栏」两栏（`.feat-cols`）在窄窗 `≤900px` 回落单列，与外壳侧栏无关）。

**侧栏导航与项目组清单（v0.9.4 D 档 · BD7 起源；REQ-2026-09-30-04 件1 外壳由顶栏改固定侧栏、导航随之重排）**：**一级菜单**单点事实源 = `layout.ts` 的 `NAV`，件1 起**仅一枚**「项目组门户」（`/`）——「排期 / 任务 / 宿主桥」三键自 v0.9.6 B5a 已退导航、「项目」（`/projects`）与「Agent」（`/agents`）件1 起**只撤导航、不撤路由**（深链与正文链接照常可达，口径 33/38 同款处置）；`NavKey` 类型仍保留全体键（`active` 高亮 + 视图路由用），`navHrefFor` / `ORG_SPACE_VIEWS` 已随 B5a 退役。**二级菜单 = 侧栏项目组清单**（`layout.ts` 的 `renderSideOrgs`）= 各在用组织 → `/org/<名>/`（= 该空间排期）的**纯服务端渲染链接列表**、当前空间项标 `class="on"`（左圆点高亮）、清单为空 ⇒ 整块不渲（不留空占位）、零新脚本（内联闭集保持六元）；**替换原「顶栏组织切换器」形态** —— `renderOrgSwitcher`（顶栏文字组 + 空间正文行右档）随件1 删除，全站只有一处侧栏 ⇒ 空间正文不再重复挂组清单。**空间内导航行**（`server.ts` 的 `renderSpaceNav`）件1/件2 起 = 排期 · 任务 · 管理 **三枚**（「需求」枚随 `/org/<名>/features` 整页退役、「← 回全局」撤〔回全局动线归侧栏一级菜单〕），显示文案「组织空间」→「项目组空间」（**URL `/org/<名>`、台账键名、目录名、代码标识符一律不动**）；`view = null` 档（需求详情页也携本行作空间上下文与返回口）不高亮任一枚；当前视图除 inline `font-weight:700` 外另挂 `class="fl on"`（空间页位置唯一断言钩子）。**清单口径与组织门户卡同源单点** = 纯函数 `orgs-view.portalOrgNames`（台账在用名〔板台账 ∪ 宿主桥托管〕∪ 需求归属 `ownerGroup` ∪ 板级默认，剔停用名；**盘一级目录不再进** —— 盘遗留目录与外机组不构成板可见组织）；`featureGroups` 只由**已持有需求列表**的页面喂入（门户 / 排期 / 空间页〔含管理页〕⇒ 零新增触桥面），其余页面（项目 / Agent / 宿主桥 / 写口回执）退化为「台账 ∪ 默认」——不为一条导航链给全站页面各加一次桥查询。**旧锚翻向**：原「顶栏组织切换器挂位三态」（B5b-①/②）随形态变更整批重指侧栏二级菜单；「NAV 六条 href」「NAV 七项含组织」「首页 ≡ `/schedule` 逐字节同构」三枚旧锚已翻（门户 ≠ 看板：`/` 高亮「项目组门户」、`/schedule` 不再进一级菜单，看板四枚页面脚本只在 `/schedule`）。钉 = `test/web.test.mjs`（REQ-04 Q2 一级菜单收一枚 + 件1 侧栏二级菜单正钉 + `.org-switch` / `<details>` 整块撤除负钉）、`test/org-space-bd7-nav.test.mjs`、`test/org-portal.test.mjs`、`test/n3-regression-anchors.test.mjs` N3-②/⑤；空间上下文随空间内**所有**应答走（含 405 / mismatch 409 / 桥宕页）。

**已知边界（收口轨 14 刻意不做的部分）**：**「提需求」被连点 = 建出两条 Feature** —— 本轨只靠前端禁用缓解，**服务端幂等键不做**（要做得给表单发一个一次性 token 并在板侧记账去重，属写面幂等设计，不在「防误触」范围内）。轮类入口（turn / confirm / answer）已由 `board_turn_busy` 硬闸封住，不受此边界影响。

**显示口径（B13，规则集中在 `src/derive.ts`）**：

1. 等待时长**只取 `waitedSince`**（单时钟差值 `formatWaitedSince`；orch 领取队列与 machine 闸内是两个时钟，**不得相加**）；
2. `inFlightCount` ≠ 实际在跑数 ⇒ 凡涉及处伴随口径标注（`INFLIGHT_CALIBRATION_NOTE`；当前桥 web 面无 `/health` 路由，板**不显示该数字**、只挂口径脚注）；
3. `projectBusy` **只反映写门**：写门未挡却没开工 ⇒ 显式渲染 `readOccupants[]`（「读档占位」）；`waitReason` 八值闭集**原样透出**，不自造中文词。

**并行度文案（§2.2-13）**：`PARALLELISM_NOTE` 常量统一挂载 —— 编排侧并行 ≠ 改造侧并行；写串行不变；读并行需「节点 read 档 ∧ machine `maxConcurrentReads ≥ 2`」（缺省 1/1）⇒ DAG 拆宽 ≠ 并行；不承诺多需求并行。

**已知缺口（运行中的桥 = 重启前 v0.8.10 时）**：`/api/features` 未透出 `stage`/`version`/`approval`（板容错显示「—」，不臆造）。

**写表单的反馈缺口（收口轨 14 已缓解、未根除）**：写端点是**同步整页跳转**模型（提交 → 等服务端跑完那一轮 → 结果页），因此「处理中」只能由页面内联提交守卫就地显示，服务端排队可见性仍靠 `/host` 状态页与轮台账承载；`POST /requirements` 的双击幂等键**刻意不做**（见上「已知边界」）。

**各态分布（BD6 收口）**：桥 `GET /api/features` 的聚合口径是 **per-feature**（每项自带 `stateCounts` + `taskCount`），全局分布由板侧把各项按状态**本地累加**得到，**不做任何额外查询**；`stateCounts` **在场即可用**（`{}` = 零任务的正常值，渲染为空分布），**只有字段整体缺失**（老桥）才显示降级文案。

## 与桥的关系（只读 `/api/*`）

`src/bridge-client.ts` 封装对编排桥（缺省 `http://127.0.0.1:3300`，端口/基址可配）的**只读**调用，**仅 GET**：

| 方法 | 路径 | 用途 |
|---|---|---|
| `getFeatures()` | `GET /api/features` | Feature 列表（含登记三字段容错解析 + 各项 `stateCounts` 本地累加为全局分布） |
| `getFeature(id)` | `GET /api/features/:id` | 单 Feature 详情 + 任务摘要（v0.9.1 BD11 起解析 `decisions` / `contracts`，缺失容错 `null`）|
| `getFeatureTrace(id)` | `GET /api/features/:id/trace` | 进展三面：`waitReason` / `position` / `waitedSince` / `projectBusy` / `readOccupants[]` |
| `getProjects()` | `GET /api/projects` | 项目 / 机器 / Runner 快照 |
| `getTasks(project, opts?)` | `GET /api/tasks?project=…` | 单项目任务列表（`project` 桥侧必填） |

硬约束：**本节的 `bridge-client.ts` 严禁调用任何非 GET**；**严禁触碰事件游标语义**（桥 `/api/events` 之外一律不碰，事件读取由后续节点专门处理）。解析逻辑（`parse*` 纯函数）与网络调用分离，可脱离桥单测。BD7 的写面**不走本节客户端**，只经 MCP 写封装打编排桥 MCP 面（8787）——**MCP 写封装清单共八处调用面**：`requirement.ts`（`a2a_feature_create` 建需求）+ `feature-schedule.ts`（`a2a_feature_advance` 排期写，v0.9.2 M2/M3，HTTP 端点 `POST /features/:id/schedule` 已接线）为**仅有的两个** `a2a_feature_*` 写点；**第三个 MCP 写封装 = `group-admin.ts`**（v0.9.4 B 档 · BD4 组织成员写，打配置面组写工具、**不碰 `a2a_feature_*`**，HTTP 端点 `POST /orgs/{org}/members`，**板对 orch 配置的唯一写通路**）；其余四条业务写端点（turn / stop / confirm / answer）经宿主桥 A2A 面而非 MCP。

## 与宿主 agent 的关系

**BD4a 已落 = 宿主桥的进程托管**（只做进程生命周期，**不做 RPC / 不做对话轮**）；对话轮与「组织管理」HTTP 写面归下一节点。此处不写组织配置（`workspace` / `kind` / `idleStopMs` 全部由调用方传入）。

### 一组织一桥（`src/host-bridge.ts`）

`HostBridgeManager` 提供 **起 / 停 / 查 / 空闲回收 / 记账** 五件事，一切进程与网络动作经 `HostBridgeDeps` **注入** ⇒ 单测在不起真桥的前提下断言全部生命周期语义。

| 动作 | 语义 |
|---|---|
| `ensureStarted(config)` | 幂等起桥：在线即复用（不再 spawn）· 进程在但端口不通 ⇒ 判「桥已断」先收干净再重拉。起不来**不抛**，返回 `ok=false` + `state="failed"` + 结构化 `error{code,message}` |
| `stop(org, reason)` | **先 `SIGTERM`**（桥自带优雅停机）→ 等 `termGraceMs`（缺省 5s）→ **超时才树杀**。板 spawn 的是「桥 + 后端」两级进程（Windows 还多一层 `cmd.exe`），**只杀桥会留后端孤儿** ⇒ 兜底走 `taskkill /T /F` / POSIX 组杀 |
| `health(org)` | 主动探活并刷新状态：进程消失 ⇒ `exited`（账单带 exit code）· 进程在端口不通 ⇒ `unreachable`。两种都出「**宿主桥已断**」文案，**不得静默** |
| `beginRound` / `endRound` | 板**自己的在飞轮数**记账（对话轮节点调用）；`inFlightRounds > 0` ⇒ 期间绝不回收 |
| `sweepIdle()` / `stopAll()` | 空闲回收扫一遍（**不自建定时器** ⇒ 不留常驻句柄）· 板退出路径收尾 |

**命令行形状**（argv **全部由 `getAdapter(kind).buildLaunch()` 产出**，板只在尾部追加 `--mcp-servers-json`；下例为 `kind=claude` 的脱敏形状）：

```text
node <仓根>/machine/dist/acp-bridge/index.js \
  --port <板分配的空闲端口> \
  --workspace <该组织目录> \
  --project-id host-<组织名> \
  --backend-cmd <后端可执行> --backend-args ["<后端入口>"] \
  --risk write --mode acceptEdits \
  --mcp-servers-json [{"type":"http","name":"a2a","url":"http://127.0.0.1:8787/<组织名>/mcp","headers":[]}]
```

- **`--risk` 恒 `write`**：宿主必须能写需求确认单 / 改造文档，不得降 `read`；
- **`--mcp-servers-json` 必须是 ACP tagged-union**（带 `type` 键）—— 缺 `type` 能过桥的启动期校验，却在运行期 `session/new` 才炸（M2b 实测，改造文档 §3.7）；
- **板不自拼 argv**：`kind → 后端命令` 的唯一事实源是 `getAdapter()`。`src/**` 中 `.getAdapter(` 调用点**唯一**（落在 `host-bridge.ts`），且后端命令 / 权限模式字面量**一律不得出现**在板代码里 —— 两条都由 `test/host-bridge.test.mjs` 的源码扫描钉死。

### 「查」的口径（与节点描述的一处差异，如实登记）

节点写「读桥 `/health`」，但 `machine/acp-bridge` 的 A2A 服务面**只接受 POST**（非 POST ⇒ 405）、**没有 `/health` 路由**，其模块头亦注明「listen 即就绪，不依赖 `/health`」。
⇒ 板的可用性判据落为 **进程存活 ∧ 桥端口 TCP 可连**（`host-process.ts` 的 `probeTcpPort`，语义等价 machine 侧 `launcher/ports.ts` 的 `waitForPort`）。**不臆造不存在的 HTTP 端点**；探测函数可注入 ⇒ 未来桥若补 `/health`，换实现不动托管语义。

### 板侧私有台账（`src/host-bridge-ledger.ts`）

本地 JSON 文件（缺省 `<board>/.data/host-bridges.json`，已入 `.gitignore`），**不用引擎的 `features` 表**：

```text
组织 → { pid, port, workspace, kind, mcpUrl, startedAt, stoppedAt, stopReason,
         cliSessionIds[], docPaths[] }
```

⚠ **CLI 会话句柄与文档路径只落本台账** —— `features` 的 `requirement` / `plan` / `context_id` 一类列是执行节点的**注入源**，句柄一旦落进去会被拼进每个派发消息。写入为「临时文件 + rename」原子替换；**标量是覆盖语义、`cliSessionIds`/`docPaths` 是追加去重语义**（只写生命周期的补丁不得抹掉已积累句柄）。坏 JSON ⇒ 按空台账起但 `corrupt=true` 如实回报。

### 空闲回收与依赖解析

| 键 | 缺省 | 说明 |
|---|---|---|
| `host.idleStopMs`（调用方传入） | **15 分钟** | `0` = 常驻不回收；**按组织可覆盖**。判据 = **板自己的在飞轮数**，**不是** Launcher 台账（板管的桥不进 Launcher 台账，拿它的口径会误判「空闲」而腰斩会话）|
| `BOARD_MACHINE_DIST`（env） | `<仓根>/machine/dist` | machine 运行时产物目录（**已知耦合面**）|

`machine/dist/{acp-bridge,adapters}` 是**构建产物**（`src/host-runtime.ts` 收口）：路径可配置 + **启动时检查存在性**，缺失即抛 `machine_dist_missing`，文案逐个列出缺哪个入口、并给出两条补救路径（machine 侧 `npm run build` 或改 `BOARD_MACHINE_DIST`），**不静默失败**。产物经**动态 `import`** 加载 ⇒ 静态不依赖 machine 源码。

### 本节点未覆盖（归下一节点）

对话轮（prompt / cancel / 结果回收）、`cliSessionIds` 的实际写入、组织管理 HTTP 写面与宿主桥状态页，以及**真机端到端起桥**（本节点单测一律用注入的假 spawn / 假探活，不起真桥）。

## 工程约定

- **零重型框架**：照 `orch/bridge/transports/web.ts` 路线，用 `node:http` + 单文件模板，无 Express / Nest / React / Vite；前端同源、无构建工程。
- **`tsconfig.json`**：与 `orch/` `machine/` 对齐（二者本身逐字节相同：`target ES2022` / `module+moduleResolution NodeNext` / `strict` / `noUncheckedIndexedAccess` / `outDir dist`）。唯一有意偏差 = `rootDir: "src"` + `include: ["src/**/*.ts"]`，使编译产物落在 `dist/index.js`（与本单元启动命令一致）；测试以 `.mjs` 直测编译产物（`orch` 亦有 `test/*.test.mjs` 先例），故无需把 `test/` 纳入 `rootDir`。
- `.a2a/` 是引擎产物（ACP 会话映射），非既有资产、不写入；`.data/` 是板侧私有台账落点（宿主桥记录 + CLI 会话句柄），同样不入库。
