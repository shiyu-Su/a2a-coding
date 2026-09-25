# board —— Web 看板单元

本仓第四个单元目录（与 `orch/`、`machine/` 同级），独立进程、独立 `package.json`。

## 定位

- **板 = 人的唯一入口**：建需求、提需求、点确认都经板；板架在 orch agent 前面。
- **独立进程 + 独立进程树 + 端口 3400**（3300 保持只读运维视图不动）。
- **板不写状态机**：唯一的状态机写是「建需求」那一次 `a2a_feature_create`（v0.9.0 BD7 已经 `POST /requirements` 接线）；`approve` / `advance` / `cancel` 只由编排 agent 经 MCP 执行，板侧连内核路径都不提供。

> 本 README 描述的当前进度 = **BD1 骨架 + BD3 只读视图 + BD2 建需求封装 + BD4a 宿主桥进程托管 + BD7 写面接线（提需求）+ BD8 宿主轮（触发一轮 / 状态页 / 停桥）+ BD9 人工确认与澄清回答入口 + BD11 组织名进表单（板级配置降为可选默认）+ BD12″ 板配置化（config.json + 模板 + 加载器，argv/env 配置通道撤销）+ BD13″ 板服务化（`scripts/boardctl.mjs` 静默启停 / `POST /shutdown` 优雅停机 / pidfile 板自写 / 日志行级时间戳）+ 收口轨 14 写按钮防误触（内联提交守卫 · 详情页占用轮渲染禁用 · `board_turn_busy` 409 同需求防重）**：最小 HTTP 服务（`GET /health` + 只读页面 + 五条业务写端点 + 一条运维写端点 `POST /shutdown`，见「页面路由」）+ 对桥的**只读** API 客户端 + `createRequirement` 封装 + 「一组织一宿主桥」的起 / 停 / 查 / 空闲回收 + 板侧对话轮台账 + 纯单测。**确认与回答都是「给宿主 agent 的一轮消息」，不是状态机写口**（边界见下）。

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
- **`orgsDir`（组织目录根 · BD8 · §3.8 裁定 9 · BD15 两层分职）**：**配置文件里同样无兜底缺省**：留空 / 缺键 ⇒ **宿主面不装配**：板不去 spawn 任何后端进程，`GET /host` 如实显示「宿主面未装配」，宿主写端点返回结构化 503 `host_face_disabled`。**根 = 部署面配置，必须预先存在**（不存在 / 不是目录 ⇒ 启动期明确 warn + 触发期结构化 503 `board_orgs_dir_missing`，配错必须可见，**板刻意不代建根**）；**`<orgsDir>/<组织名>` = 数据，缺失时由板自动创建**（BD15：触发一轮时代建该组织子目录，用户不必先回终端 `mkdir`；已有目录不碰；建不出来才报 `org_workspace_missing`，文案含**绝对路径 + 根因**）。
- **`hostKind`（宿主后端 kind · BD8）**：缺省 `claude`。仅作为**新建桥的缺省 kind**（`kind → 后端命令` 的映射唯一事实源在 machine 侧 `getAdapter()`，板不自拼 argv）。**`machineDist`**：machine 运行时产物目录，缺省按仓根推导 `<仓根>/machine/dist`。**`turnTimeoutMs`**：单轮有界等待毫秒，未配置交下游缺省（10 min）。
- **配置缺失的后果（两句同口径，互不牵连）**：
  - **默认组织未配置 ⇒ 什么都不牵连**（BD11：它已从「写面必填」降为「可选默认」，**启动期零硬失败**）。校验点在**请求期**：表单组织名留空 **且** 无板级默认 ⇒ `POST /requirements` 返回 **400 `board_group_required`**（不猜、不回落）；宿主面在桥侧 `ownerGroup` 也为空、且默认组织也未配置时返回结构化 503 `board_org_not_resolved`（**不猜组织名**）；
  - 组织目录根**未配置也不拒起**：宿主面不装配，起桥 / 触发一类的写端点返回结构化 503 `host_face_disabled`。
  两者都会在启动日志里**各打印一行明示**（不静默；默认组织那一行是**提示**不是报错），并如实反映在 `GET /host` 的配置行上。
- `version` 从 `package.json` 读取，不硬编码。

### 组织的语义边界（BD11 · 本版做到哪、不做到哪）

**「创建组织」在本版 = 在板上首次使用该组织名**。其落点只有两处，都在板侧：

1. **板建需求时的 MCP 组身份**（= `/<组织名>/mcp` URL 首段）⇒ 引擎侧该 Feature 的 `owner_group` 即此名；
2. **组织目录** `<orgsDir>/<组织名>` ⇒ 宿主桥 `--workspace`（经 `resolveOrgWorkspace`，含防逃逸校验；**该子目录缺失时由板自动创建** —— BD15，「第一次填写组织名」自此不需要人工先建目录）。

**不包含**：组织管理页 / 增删成员 / 在 machine 侧建 project / 写 `projectGroup` / 改 orch·machine 配置 —— **全归 V2**。
**板仍不写引擎状态机**：`a2a_feature_approve` / `advance` / `cancel` 三个工具名在 `src/**` 的引用数恒为 **0**
（`test/requirement.test.mjs` 纪律扫描 + `test/server-write.test.mjs` 的 BD11-⑥ 负向锚：写面白名单里也不存在任何 approve / advance / cancel 路径）。

开发：`npm run typecheck`（0 错）· `npm test`（纯单测，不依赖桥在跑）· `npm run build`。

## 页面路由（BD3 只读视图 + BD7 / BD8 / BD9 写端点）

| 路径 | 方法 | 数据源（桥） | 内容 |
|---|---|---|---|
| `/` | GET | `/api/features` | 提需求表单（**含组织名字段** · BD11）+ 需求列表：登记 `stage`+`version`+`approval` + **派生阶段**（`derive.ts` 单点规则）+ 列表自带 `taskCount`（无 N+1）|
| `/features/:id` | GET | `/api/features/:id` + `:id/trace` | 需求详情 + 任务列表 + **trace 三面**（在等谁 / 位次 / 为什么没跑）+ 宿主轮表单（触发一轮 / 确认指令；**回答框仅在该需求有 `awaiting_answer` 轮时出现**；**该需求已有在飞 / 排队轮 ⇒ 两按钮渲染为 disabled + 原因**，收口轨 14）|
| `/tasks[?project=]` | GET | `/api/tasks`（`project` 桥侧必填） | 任务视图（无参 = 选单页）|
| `/projects` | GET | `/api/projects` | 项目 / 机器 / Runner 快照（快照语义标注）|
| `/host` | GET | （不触桥；本板进程宿主面） | 宿主桥状态页：五态 + 结构化错误 + 轮队列（BD8）|
| `/requirements` | **POST** | MCP `a2a_feature_create`（经 `requirement.ts`） | 提需求：建一条初态 `waiting_approval` 的需求（详见下节）|
| `/features/:id/turn` | **POST** | 宿主桥 A2A 面（经 `host-face.ts`） | 触发一轮：起桥 + 投首轮提示词，**不等排队轮**（BD8）；该需求已有在飞 / 排队轮 ⇒ **409 `board_turn_busy`** 不重复入队（收口轨 14）|
| `/host/:org/stop` | **POST** | 同上（进程侧） | 停桥（BD8）|
| `/features/:id/confirm` | **POST** | 同 turn 通道（`triggerTurn(kind=confirm)`） | 人工确认指令：投「用户已确认改造文档，请核对后执行放行」的一轮消息给宿主 agent（BD9，**板不批准**）；占用时同 **409 `board_turn_busy`**（收口轨 14）|
| `/features/:id/answer` | **POST** | `answerTurn`（同 `contextId` 续推） | 澄清回答：仅当最新轮 `awaiting_answer` 可投，否则结构化 409（BD9）；占用时同 **409 `board_turn_busy`**（收口轨 14）|
| `/shutdown` | **POST** | （不触桥；本板进程） | **运维路径**：优雅停机 —— 先停宿主桥 → 关卡口 → 删 pidfile；**仅 loopback 来源**（否则 403 `loopback_only`），**200 = 受理 ≠ 已停**（BD13″）|

**方法门是白名单，不是一刀切**：读面仅 GET，写面只放开上表五条业务 POST（`write-guard.isWriteRoute`，清单单点 = `WRITE_ROUTES`）；其余任何路径 × 任何非 GET 方法一律 405，未知路径 404。**`POST /shutdown` 不在这条业务白名单里** —— 它是同服务上单独登记的**运维路径**（不经 CSRF 守卫头，改以「socket 远端地址必须 loopback」把关，非 loopback 一律 403）。板**不写状态机** —— 无 approve / advance / cancel 任何路径：确认与回答都只是**给宿主 agent 的一轮消息**，状态机推进归编排 agent（`src/**` 对三个状态推进工具名的引用数 = 0，由 `test/requirement.test.mjs` 纪律扫描钉死）。

### 写端点 `POST /requirements`（BD7）

- **入参**（`application/x-www-form-urlencoded`）：`group`（**BD11 起进表单**：本条需求的组织名；留空则用板级默认组织）/ `title`（必填）/ `version`（必填）/ `requirement`（可选）。
  - 空 `title` 或空 `version` ⇒ **400 `requirement_form_invalid`**；
  - `group` 留空 **且** 板级默认组织未配置 ⇒ **400 `board_group_required`**（校验点在**请求期**，文案给出可照做的两条路：表单填组织名 / 配 `config.json` 的 `group`）；
  - 全部校验先于任何出网调用（不静默创建）。请求体上限 256 KiB，超限 413。
- **成功回显**：浏览器表单 ⇒ **303 跳转 `/features/:id`**（PRG 三态码，刷新不重复建，且复用既有只读详情页作结果页）；API 调用方带 `accept: application/json` ⇒ **201 + `{featureId, group, state, stage, version, approval}`**（`group` = 本条实际生效的组织名，归属可核对）。
- **失败透传**：桥的业务错误码（`feature_invalid_stage` / `project_not_a_member` …）与传输异常（`transport_error`）一律**原样结构化透出**（HTTP 502 + `{ok:false, code, error}`），不吞、不改写成通用错误。
- **CSRF 防线（两档，任一成立即放行）**：
  1. 自定义头 **`X-Board-Write: 1`** —— 跨站表单无法携带自定义头，故这一档足以放行；供 API / 脚本调用方使用；
  2. **同源判定** —— `Origin` 与请求 `Host` 归一后逐字节相等（补全缺省端口、host 小写、IPv6 带括号，故端口写法差异不误判）；`Origin` **不可用**（缺失 / 空串 / 字面 `null` —— 隐私扩展、sandboxed iframe 等会发字面 `"null"`，属**来源不可知**而非跨站，BD16）时退 `Referer` 前缀。供**零 JS 的表单**使用。
  两档皆不成立 ⇒ 403，**两个码可分辨**（`write_guard_origin_unknown` = Origin 与 Referer 皆不可用，文案给出可操作的三条补救：板上表单 / API 带 `X-Board-Write` 头 / 浏览器白名单；`write_guard_origin` = **有名 Origin 且不同源**，明确跨站，**恒拒不放宽**）。CSRF 判定**先于**读请求体与板配置检查，未认证请求既不消耗 body 也不泄露「组配了没」。
- **`Referrer-Policy` = `same-origin`（BD17 · 兜底信号的前提）**：板**同时**以响应头 `Referrer-Policy: same-origin` 与页面内 `<meta name="referrer" content="same-origin">` 给出（同值单点 = `web/layout.ts` 的 `BOARD_REFERRER_POLICY`）。**不得回退成 `no-referrer`** —— 那会让浏览器连**同源表单提交都不发 `Referer`**，而 `Origin` 在隐私扩展 / sandboxed iframe 下可能就是字面 `null`，两档来源信号同时归零 ⇒ 板把自己的「页面上提交需求」这条路掐死（收口轨 11 修的是判定，轨 12 修的是信号源）。`same-origin` **不削弱 CSRF**：跨站请求本来就发不出可冒充同源的 `Referer`，第一档自定义头同样发不出。
- **为什么不是「只认自定义头」**：HTML 表单**不能**携带自定义请求头（规范限制），而列表页要求同源、无构建、**不依赖 JS**（收口轨 14 加的那段内联守卫只是体验层，脚本被禁用 / 失效时表单档必须照样能提交）。故采用上面的 (2) 档：**表单走同源 Origin 校验，自定义头留给 API 调用方**。
- **对 CSP 的影响（收口轨 14 · 一处**最小**放宽，明示）**：写表单提交后是整页跳转 + 服务端同步等（触发一轮可跑数分钟），期间零反馈 ⇒ 用户连点。页面因此新增**一段同源内联脚本**（提交守卫，单点常量 = `web/layout.ts` 的 `SUBMIT_GUARD_SCRIPT`，**逐字节同一份、每页注入一次、不含用户数据 ⇒ 无注入面**），CSP 相应从 `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'` 变为 **`… ; script-src 'unsafe-inline'; …`** —— **只放开 `'unsafe-inline'` 一档**（与既有 `style-src` 同款内联程度），**不引入任何外源**（无 `http(s)://`、无 `*`，`default-src 'none'` / `base-uri 'none'` / `form-action 'self'` 三条一律不动）。守卫**只是体验层**：禁用本表单的提交按钮 + 就地显示「已提交…」，整页跳转后自然复位；**无 JS / 脚本失效时表单照常提交**，CSRF 两档判定也**不依赖它**（同源表单照旧走 Origin/Referer 档），服务端防重另有 `board_turn_busy` 409 硬闸。

### 写端点 `confirm` / `answer`（BD9 · 人工确认入口 + 澄清回答入口）

两入口与 BD7 / BD8 写端点**同规格**（同一 `hostWriteGate`：CSRF 两档判定 → body 上限排空 → 宿主面装配检查），且**复用 BD8 的触发通道**，不新写一条链：

- `POST /features/:id/confirm` —— 「人工确认」= 板把「用户已确认改造文档，请核对后执行放行（approve 语义）」作为**一轮消息**投给该需求的宿主 agent（`BoardHostFace.confirmTurn` = `triggerTurn(kind=confirm)`），**由 agent 决定是否真的放行**：条件不满足（如 approval 非「待审批」）agent 会拒绝放行并回报原因，结果如实回显（含 agent 回复摘要 / 错误码）。详情页按钮文案诚实标注「给 agent 的指令 · 不存在『板上批准』」。
- `POST /features/:id/answer`（body `answer=…`）—— 「澄清回答」**仅当**该需求**最新一轮**处于 `awaiting_answer`（= 桥的 `input-required`）时可用：经 `answerTurn` 续推**同一 `contextId`**（组织取该轮记录的 `org`，不重猜）；否则结构化拒绝 **409 `board_no_awaiting_turn`**（一条消息都不投、不起桥）；空答案 ⇒ **400 `answer_empty`**。回答框仅在适用时渲染（判据 = `awaitingTurnOf`）。
- 结局分流沿用 `dispositionHttpStatus` 单点：`succeeded/awaiting_answer/canceled` ⇒ 200 · `queued` ⇒ 202 · `not_awaiting` / **`busy`** ⇒ 409 · `bridge_down/turn_failed` ⇒ 502 · `timeout` ⇒ 504 · `config_error` ⇒ 503。
- **同需求防重（收口轨 14 ③）**：`turn` / `confirm` / `answer` 三入口在**该需求已有在飞或排队轮**时一律 **409 `board_turn_busy`**（与 `board_no_awaiting_turn` 同族、同 `error{code,message}` 形状，载荷回显**占用轮**的 `turnId` / `round` / `state`，HTML 与 JSON 同码），**不起桥、不发轮、不重复入队**。占用判据 = `running` ∨ `queued` 两值闭集；**`awaiting_answer` 不占**（等人回答不占闸位 —— 否则澄清链路被自己锁死）。落点两层、同一事实源（BD4b 轮闸）：宿主面**前置查** `busyTurnOf`（判据不满足不惊动托管器），`submitTurn` 的**同步段**再查一次并一体入队（连点两发哪怕同一 tick 到达也只放行一条；第二发带 `occupant` 回来 ⇒ 收口成同一个 409）。被拒的提交**不推进轮计数**（检查在 `openSession` 之前）、**不落台账**。
- **渲染态禁用（收口轨 14 ②）**：详情页在占用时把「触发一轮」「发送确认指令」渲染为 `disabled + aria-disabled` + 原因行（**不隐藏入口**）；confirm 的占用原因**优先于** `approval` 判据展示（它直接对应「点了会白点」），无占用时回到既有 approval 三态。规则源 = `derive.ts` 的 `deriveTurnBusyAffordance`，视图不内嵌判据。

渲染 = 同源服务器端单文件模板（`src/web/layout.ts` + `src/web/views.ts`，内联 style、强 CSP、零前端框架；脚本只有一段**同源内联**的提交守卫，见上条 CSP）。桥不可达 ⇒ 502 页面如实显示错误，不静默。

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
| `getFeature(id)` | `GET /api/features/:id` | 单 Feature 详情 + 任务摘要 |
| `getFeatureTrace(id)` | `GET /api/features/:id/trace` | 进展三面：`waitReason` / `position` / `waitedSince` / `projectBusy` / `readOccupants[]` |
| `getProjects()` | `GET /api/projects` | 项目 / 机器 / Runner 快照 |
| `getTasks(project, opts?)` | `GET /api/tasks?project=…` | 单项目任务列表（`project` 桥侧必填） |

硬约束：**本节的 `bridge-client.ts` 严禁调用任何非 GET**；**严禁触碰事件游标语义**（桥 `/api/events` 之外一律不碰，事件读取由后续节点专门处理）。解析逻辑（`parse*` 纯函数）与网络调用分离，可脱离桥单测。BD7 的写面**不走本节客户端**，只经 `requirement.ts` 打编排桥 MCP 面（8787），且只有 feature 创建这一个调用点。

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
