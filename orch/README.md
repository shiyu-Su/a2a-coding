# orch 单元（MCP 薄桥）

> orch 侧的 MCP 薄桥：连接模型已反转为 **pull**（线协议 2.3）—— 执行机 Launcher 升格为 **Runner**，主动出站连桥（`/runner/register` → `/runner/connect` 长轮询拉命令 → `/runner/result` 回传结果）；桥只做「项目 → 机器」解析、任务入队 / claim 与结果落库，任务态与会话映射落本机 SQLite，再由执行机侧拉起仓内 ACP 桥驱动底层 CLI。启停一律经 `scripts/bridgectl.mjs`（纯 Node ESM、零第三方依赖、无需构建），入口 `dist/bridge/index.js`。

## 整体形态

- **接入面**：**常驻 stateless Streamable HTTP**（唯一形态；**stdio 已于 v0.7.1 退役**），桥经 `bridgectl` 常驻，以 **stateless Streamable HTTP** 暴露 MCP（路由 `POST /mcp`、`GET /health`、`POST /shutdown`），宿主经 MCP `type: "remote"` 连接。配组后端点亦可写成 **`POST /<组名>/mcp`**（组身份，见「连接身份与可见性」）。
- **工具面**：泛型工具 7（`a2a_projects` / `a2a_call` / `a2a_task_status` / `a2a_tasks` / `a2a_cancel` / `a2a_events` / `a2a_wait`）+ Feature 工具组 6（`a2a_feature_create` / `a2a_feature_status` / `a2a_feature_advance` / `a2a_feature_approve` / `a2a_feature_cancel` / `a2a_feature_trace`）+ 配置面 1（`a2a_config_write_group`，v0.9.4 O1），静态注册、零重连。`a2a_feature_trace`（v0.8.10 O-N3）是**只读**排队可见面，与数据面 `/api/features/:id/trace` 复用同一实现。`a2a_config_write_group` 是 `config.json` `projectGroup` 段的**受控写**面（五操作闭集：group.add/update/remove、group.member.add/remove；dry-run 与读面同源、备份 + tmp/rename 原子替换、错误码闭集六元），**全组面**工具——配置面写不受调用方组可见性限制，写后热生效（桥 per-call 现读）。
- **单实例与单调度权**：靠 core 租约（`core.lock`）—— 只有租约持有者运行 scheduler 与 task-watcher；同一 data dir 的第二个实例降级为 `follower`，照常提供 MCP 工具但不跑后台循环。`GET /health` 报当前 `role`（`owner` / `follower`）。
- **只读数据面（3300）**：常驻形态下可另起只读 HTTP 服务（默认仅 `owner`、绑 loopback），只读自桥的 SQLite（含 Runner 注册投影 `runners` / `runner_projects`），不做第二编排入口。**3300 仅剩 `/api/*` 数据面，页面已由 Board 取代**（v0.9.3 起 `GET /` 返回 404）。**它是运维全量视图，不是身份面**（见「只读数据面（3300）」）。

## 连接身份与可见性

一台桥可同时服务多个编排 agent：`config.json` 顶层 `projectGroup` 段写成**组数组**，每组 `name` + `members[]`（每项 `{machineId, projectId}`）。

- **身份载体 = URL 路径首段**：宿主侧 MCP 的 url 写 `http://<host>:<port>/<组名>/mcp`（默认端口 8787）—— 首段即连接身份，其余须**恰好等于** `transport.http.path`（缺省 `/mcp`）。**没有第二种通道**（不读 header、不复用 Runner token）。
- **未配组**（`projectGroup` 段缺省）⇒ 只有 `POST /mcp` 一个入口，**全量接纳**：列出与派发覆盖所有已配置机器 / 项目，旧配置零改动可用。
- **配了组** ⇒
  - 不带身份的 `POST /mcp` 被 **403 `group_identity_required`** 拒绝（fail-closed；文案指路 `/<组名>/mcp`），**不会**回退成全量；
  - 带身份的连接**只见本组**：`a2a_projects` / `a2a_tasks` / `a2a_task_status` / `a2a_events` / `a2a_wait` 与 Feature 工具组（**谁建谁见**：`create` 打组归属，`status` / `advance` / `approve` / `cancel` 校验归属）一律按身份收窄；事件收件箱游标随身份分离，互不推走；
  - 向非本组项目派发 / 查任务 / 取消 ⇒ `project_not_a_member`，文案能区分「非本组成员」与「属另一组（在哪个组）」。
- **组名未命中任何组**（拼错）⇒ fail-closed 空组：该连接一切操作均被拒，**绝不回退全量接纳**。
- **组间互斥**：同一 `(machineId, projectId)` 出现在两个组 ⇒ **配置期 fail-fast**（桥拒绝启动，不 bind）。
- ⚠ **组不是鉴权边界，`/mcp` 零鉴权**：`/<组名>/mcp` 上的组名只决定「视野收窄到哪」，**不决定「谁能连」** —— 任何能访问该端口的进程写上组名即取得该组视野。真正的访问控制（跨机鉴权 / 反向代理）归已登记的「安全与治理」待办，本单元不提供；桥的 loopback 绑定与 Runner 侧 Bearer 是各自独立的另一回事。

## 只读数据面（3300）

- **3300 仅剩 `/api/*` 数据面**：原内联「只读工作台」页面（`GET /`）已于 v0.9.3 退役，页面由 Board 取代；`GET /` 现返回 404 JSON。出参契约零增减：`/api/projects`（`runners` 在其出参内，非独立端点）/ `/api/features[/:id][/trace]` / `/api/tasks[/:id]` / `/api/events` / `/api/registry/projects`（**注册表全量投影**，REQ-2026-10-03-02：遍历源 = `runners` 表，含离线机与其项目，**未经任何组过滤**，与 `/api/projects` 的组视野读路刻意不交叉复用；供 Board 项目池作差集用）。
- ⚠ **3300 不作为 orch agent 的身份面**：数据面注入的是**「全量身份」的内核视图**，即**运维全量视图** —— 一眼看全桥所有组的项目 / 任务 / Feature / 事件；**不存在**「按组渲染」的数据入口，也不接受任何身份参数。
- 要**本组视野**只能走 MCP 端点 `/<组名>/mcp`（见上节），不是在 3300 上切换。
- 因此数据面侧的可见范围**始终 ⊇** 任一组身份的连接；Board 经 `/api/*` 读数据用于观察与排障，不用于编排。

## 本阶段明细（Feature 工具面出参 · v0.10.5 增补 `6cc46dd2`）

Feature 工具面的**成功出参**加带「本阶段明细」，让宿主一次调用即读到「现在这一格差什么、谁推动、该做什么」，不必再自己拼登记字段。**additive**：既有键零改动、零迁移、零新库列、`state` / `stage` 值域不动。

- **形状 = 七枚平铺在顶层**（与 `state`/`note` 同级，**无 `next` 包装对象**）：**回显三枚** `stage` / `approval` / `version` = 引擎已存登记字段**原样**回显（不翻译、不重新推导，中文值逐字）；**派生四枚** `pending` / `gate` / `actor` / `action` = `bridge/feature-tools.ts` 的 `deriveStageDetail`（五维输入 `state`·`stage`·`approval`·`version`·`decisions` 的**纯函数**，零写入 / 零查询 / 零副作用）。**摆法取平铺**（宿主裁定，合本板扁平化方向）；平铺的代价由「回显三枚 === 同层 `feature.*` / 既有回显键」的同源测试锚对冲。
- **在场范围**：`advance` **四条成功出口**（登记特例 / 只补归属 / 合法流转 / `retryTaskIds` 重派）+ `create` + `approve` + `feature_status` **单查分支**。**`cancel` 不带**（其出参基类型 `FeatureStateChangeSuccess` 逐字未宽化 ⇒ 负锚）；**`feature_status` 列表分支不带**（出参逐字不变，含 MCP / HTTP 两个面）。必带性由 TS 出口字面量的类型标注执法 ⇒ **漏装任一枚即编译报错**。
- **`actor` = 本阶段（推进后）的推动方 / 执行方**（`host` / `user` / `engine`；**终态 ⇒ `null`** = 本阶段无推动方）。它是 flow `引擎映射.md` §2 表「驱动方」列（宿主 / 用户 / 引擎）的**同源投影、非等价替身** —— 该列存在复合值「宿主（+ 用户确认）」与「主链不推进」行，而 `actor` 是**单值投影 ⇒ 投影有损**，不得拿它替代该表读。⚠ **护栏**：`actor` **不是「此刻谁在等」、也不得当「谁卡住了」的凭据** —— **静止与失败由 `tasks[]` / `a2a_feature_trace` 承载**（`executing` 格的 `engine` 只表示「该格由引擎驱动」，不表示「现在有在跑」；失败静止时 `actor` 逐字不变，`retryTaskIds` 出口同样如此）。
- **`pending` 全清单不按格过滤**：按**固定序**（确认单 → 排期 `version` → 门① 抬 `stage` → 改造文档 → `approval` 待审批）逐项扫描五枚欠账 —— 欠账的有无**只由登记字段与 `decisions` 决定，与当前 `state` 无关**（故 `executing` 格上确认单未登记 ⇒ 仍报 `requirement-doc`，函数内不引入第二套判据）。当前各行至多 1 枚（首个未清项），数组形态为将来「两件事同时等」预留、不改形状。异常 / 终态四格（`needs_input` / `completed` / `failed` / `cancelled`）⇒ **恒 `[]`**（不携带登记欠账；`needs_input` 是异常态但非终态，澄清走 `answer`、不算欠账）。
- **登记事实 ≠ 文件事实**：`pending` 里的档名项只答「`decisions` 里**登记过**那个档名」，**不证文件存在** —— `decisions` 是宿主自报的自由文本、且经 `advance` **整值替换**，故**漏重发 ⇒ 明细倒退属正常后果**（不是引擎缺陷）。判定用的严格标记：`-需求确认单.md` / `-改造文档.md`（前导连字符 = 命名规范 `{topic}-…` 的固定尾段，无 topic 前缀的裸文件名不构成命中）；口径与门① 前提 ② 共用同一函数 `docRegistered`（泛化后带 marker 参，**无第二套判据**）；**门② 的 ④⑥ 同样只用这一函数与这两枚标记**（增补 `ec93e1bd`）—— 差别只在 `approve` **不收 `decisions` 入参** ⇒ 「已落库 ∪ 本单同写」的并集豁免在 approve 侧不存在，④⑥ 只看**已落库**的当场值。
- **陈旧 `stage` 照读、不参与推导**：异常 / 终态四格的 `stage` **保持最后一次写入的值**，`deriveStageDetail` 对其**照读不臆造**，也**不另存第五枚**去标记「陈旧 `stage`」（同 `state` 不同 `stage` ⇒ 派生四枚逐字相同）。这与 flow §7「过渡判据」那条「存量卡 `stage` 滞后是已知观测面噪音」同源 —— 不得据陈旧 `stage` 判「数据异常」。
- **出口非事务（R7）**：明细装配走**写后重读**（`stageDetailAfterWrite` 按 `featureId` 取回本单全部写入落定后的那一行）—— 这是**语义要求不是实现细节**：吃 `handleFeatureAdvance` 开头那份**写前快照**就会报「**被离开的那一格**」的 `actor`，明细也系统性落后一帧（典型：门① 刚抬完 `stage` 仍报 `pending:["stage"]`；`approve` 出口则会把 `approval` 回显成「待审批」）。重读与写入是**同函数不同语句** ⇒ **出口不追求快照一致性**，不为它设错误码；`fallback` 只兜「重读落空」这一不可达形态（行刚被本单写过 ⇒ 必在）。
- **`action` = 能力陈述式**（英文一句，单源 = `STAGE_DETAIL_ACTIONS` / `WAITING_APPROVAL_ACTIONS` 两张文案表，键型逐态穷举 ⇒ 引擎加态则编译期报错、不会静默缺文案）：只写「此处**可执行的操作**」，**流程判断一个字都不进** `action`（判据清单是否满足 / 三档定性 / 名额是否空 / 载体是否旧码 ⇒ 归 flow 与人判）。

## 版本面写口执法与错误码闭集（v0.10.0 · REQ-v0.10.0-2026-09-24-01；v0.10.1 增 project 档 · REQ-2026-10-09-01）

版本状态（三态 `notstart/active/released`）与发版闸的事实源**落引擎**（板只投影）。**排期写状态锁 + `released` 锁 + 发版闸**均在引擎侧执法，**含宿主经 MCP 直写 `version` 的路径（后门不豁免 —— 引擎强制，不是板）**：

> **v0.10.1 起版本面分两级，同在引擎、同一事实源进程**：**Group 台账**（`versions`，键 `(owner_group, version)`，三态 —— 上面所有判据**一律不动**）+ **project 台账**（`project_versions`，键 `(owner_group, project_id, version)`，两态 `open` / `released`）+ **归属（承诺集）**（`feature_projects`，一条需求触达哪些 project、各自落哪个 Project Version）。project 台账**不进** `notstart → active` 自动转换（那是 Group 侧的节奏）。**两级计数不得互校**：Group 侧从需求登记字段 `features.version` 派生、project 侧从归属表派生，同名版号在两级里互不染色，**不相加、不做相等校验**。

- **写口执法**：`bridge/feature-tools.ts` 的 `checkVersionWriteLocks`（排期写状态锁 + `released` 锁，挂在 `a2a_feature_create` / `a2a_feature_advance` 写 `version` 之处，fail-fast 零写入）；发版闸 `evaluateReleaseGate`（判据 `total>0 ∧ completed+cancelled===total ∧ completed>0`，`failed` 不计收口、全 `cancelled`/全 `failed` 挡闸；写端点〔O2b〕与 `released` 同事务快照〔O7〕**共用同一判据**）。
- **`create` 初值恒定 + 门① 两前提（v0.10.5 O4 · REQ-2026-10-12-03；第二前提随增补 `bbc7ea28` O3）**：`a2a_feature_create` **不收** `stage` / `approval` 两枚入参 —— 初值由 `handleFeatureCreate` **硬编码** `stage=需求分析` + `approval=未发起`（`version` **仍是入参**：未登记桶 / 撤排期 / `released` 锁 / 板拖拽建卡都依赖它）。旧调用多带的这两枚键由 schema 层**静默丢弃**（zod strip），**不改判为拒收**；`DEFAULT_FEATURE_STAGE` / `DEFAULT_FEATURE_APPROVAL` 随之**只服务读侧归一 + ctor 脏值归一**，不再充当 create 缺省。`parseRegistration` 的两枚闭集码（`feature_invalid_stage` / `feature_invalid_approval`）因此**只剩 advance 侧可达**。**门① 前提 ①（version 守卫）**：`advance` 把 `stage` 由「需求分析」迁往它值、而该卡 `features.version` 为空 ⇒ **整单拒绝、零写入**（码 `feature_group_version_required`；判据四条件字面与插入点见 `bridge/feature-tools.ts` 的 `handleFeatureAdvance`，位置在 `retryTaskIds` / 登记特例 / 只补归属**三条分叉之前**）；拒后卡仍是「需求分析 ∧ 未发起」⇒ 排期锁仍开，补写 `version` 后同一迁移即可重试（`stage` 同值写 / 纯 `version` 写 / 存量卡 `stage` 已离开需求分析 ⇒ 三档**均不触发**守卫）。**门① 前提 ②（确认单已登记）**：同一条判据面叠第四条件 —— 可见 `decisions`（**已落库 ∪ 本单同写**的并集，不可省：宿主「同一单先登记路径、再抬 `stage`」是既有合法用法）含《需求确认单》档名（查找子串 `-需求确认单.md` = 命名规范 `{topic}-需求确认单.md` 的固定尾段，严格式令无 topic 前缀的裸文件名 `需求确认单.md` 不构成命中）；未登记 ⇒ 码 `feature_confirmation_doc_required`、**整单拒绝零写入**。**两前提顺序 = version 在前、本前提在后（缺哪报哪，不合并成一个错误码）**；本前提的**唯一豁免 = `retryTaskIds` 重派路径**（那是派发语义操作、不是过门；前提 ① 则三条分叉同受）。堵的是「登记特例直写 `stage`」把门① 降为一次纯记账动作的旁路 —— 确认**内容**的事实源仍是落文件的确认单，本前提只保证登记面留痕。
- **`approve` 目标态分流 + 归属门双挂 + 挂载集收窄（v0.10.5 O4 · REQ-2026-10-12-03）**：**① 分流** —— `handleFeatureApprove` 的目标态按 `parentFeatureId` 分流：无父（主轨）落 `version_planning`（PjM 版本规划工序自占一格），有父（增补轨 / 承接轨）直接落 `decomposing`（不重走 PjM 工序 ⇒ 跳过该格）。`approve` 的既有三条判据（非 `waiting_approval` 拒 / `approval` 须 `待审批` ⇒ 否则 `feature_approval_not_ready` / 放行同轮版本 `notstart→active`）**逐字不变**；**增补 `ec93e1bd` 起在其后另加四条 = 门② 过门条件 ③–⑥**（③ `version` 非空 ⇒ `feature_group_version_required`；④ 《需求确认单》在册 ⇒ `feature_confirmation_doc_required`；⑤ `stage` 非「需求分析」⇒ `feature_requirement_gate_not_passed`；⑥ 《改造文档》在册 ⇒ `feature_design_doc_required`；序 ③→④→⑤→⑥、缺哪报哪、任一不过 ⇒ **整单拒、零迁移**，插在 `updateFeatureState` / `updateFeatureRegistration{approval}` / `activateVersionForFeature` **三笔写之前**）。六条**只约束 `approve` 这一个动作、不约束 `approval` 的登记写侧**，且**不校验 `stage` 迁移序** —— 堵的是「省略门①、只写 `approval = 待审批` 即可直过门②」这条旁路（增补二真机探针带出）；两枚新格经 `updateFeatureState` **直写**（不经 `canTransition`），故转移表**无需**为有父轨加 `waiting_approval → decomposing` 边 —— 加了反而会让 `advance(to="decomposing")` 在 `waiting_approval` 成为一条前进边。**准入守卫已泛化（增补 `bbc7ea28` O1）**：`handleFeatureAdvance` 的这道守卫**不按 `to` 取值点名**，判据 = 三条件合取（当前态为 `waiting_approval` ∧ 目标是该态的**转移表出边** ∧ 目标在**主链行序上后于**该态）⇒ 将来给本态加任何前进边都自动被覆盖、不复现旁路（`feature_approval_required`）。写成「出边 ∧ 后于」的合取而非「凡出边即拒」，是为了让**归档边天然放行**（`cancelled` / `failed` 非主链态 ⇒ `indexOf` 为 `-1`、不大于本态索引）—— 归档边被拒会误伤发版收口的 `failed → cancelled` 路径，故此处**不得**简化。守卫位置在 `canTransition` **之后** ⇒ 非法目标仍报 `feature_transition_invalid`（错误区分）。**② 归属门双挂** —— `advance` 的**合法流转路径**上新增两处「本需求归属非空」转移守卫：`version_planning → decomposing` 与 `decomposing → executing`（后者兜跳过前格的增补 / 承接轨）。判据 = 已落库归属行数（`featureProjectListByFeature`，与归属写口内部读的是同一函数 ⇒ **无第二套判据**）**+ 本单 `projectVersions` 已通过校验的待写行数**；和为 0 ⇒ 新独立码 `feature_attribution_required`、**整单拒绝且主链零迁移**（位置在 `canTransition` 与 `feature_approval_required` 之后、任何写入之前）。**不复用** `orch_project_attribution_state_locked` —— 后者语义是「该态**不允许写**归属」（入口锁），本码是「**缺归属而不许离开**该态」（出口门），方向相反。**③ 挂载集收窄** —— `MOUNTABLE_FEATURE_STATES` 由 `["executing","waiting_approval"]` 收为 `["executing","decomposing"]`：DAG 登记时点随主链后移，唯一登记窗口 = `decomposing`（初版登记）与 `executing`（执行期增量节点）。`registerFeatureNode` 的拒因文案、`a2a_call.featureId` / `mode` 描述均由该常量 `join` 派生 ⇒ 自动同步，**不再把 `waiting_approval` 列为合法挂载态**。**`scheduler.ts` 零改动**（`state='executing'` 过滤照旧）—— 这正是「`decomposing` 内登记的节点不占机器资源」的机器凭据。
- **project 档写口（v0.10.1 · `bridge/project-versions-endpoints.ts`）**：`POST /api/project-versions`（建版，**恒 `open`** —— 入参带 `status` ⇒ `400`，project 侧没有独立发版动作）/ `DELETE /api/project-versions/{project_id}/{version}`（判序 = 存在性 → `released` 冻结 → 名下归属引用，全过才真删，**不级联删归属行**）/ `GET /api/project-versions?owner_group=&project_id=`（只读投影，`?project_id=` 是可选收窄）。**无 `PATCH …/status`**（手动设状态只属于 Group 档）；单行路径按**恰好两段**认领，其余形状不认领（落 404）。写路只在 `owner` 放行（follower ⇒ `503`），读路不受门闩；传输层码沿用 Group 档 `orch_versions_*`，信封同为 `{ok:false,error:{code,message}}`。**复用方向单向**（project 档 → `versions-endpoints.ts` 的归属解析三源 + `project_id` 第四源、统一信封、JSON 体读取；Group 档不引本模块，避免循环依赖）。
- **`GET /api/versions` 扩 `projectVersions[]`（v0.10.1）**：出参**只加顶层键** `projectVersions[]`，**`versions[]` 的成员与语义逐字不变**（板 Group 面 / 已发版锁零改动）；`count` 仍是 **Group 档**行数，project 行数由 `projectVersions.length` 自持，**两档计数不相加**。project 档同样支持可选 `?owner_group=`（缺省全表，向后兼容）。**两档分立**：project 档读失败 ⇒ **不出该键**（板取「缺位」档 = 降级条 + 根因码），不用空数组冒充「在场无行」，也不牵连 Group 面。单条形状 = `{owner_group, project_id, version, status, releasable, open_count, completed_count, cancelled_count, reason}`（snake_case），**三处共用同一实现** `projectVersionsView`（8787 `GET /api/versions` 顶层键 / 8787 `GET /api/project-versions` / 3300 `/api/project-versions` 只读投影）⇒ 形状单点、不漂移。
- **归属（承诺集）写执法（v0.10.1 · `bridge/feature-tools.ts` 的 `checkFeatureAttributionWrites` / `applyFeatureAttributions`）**：MCP `a2a_feature_advance` 新增**独立分支**入参 `projectVersions[]`（每项 `{projectId, projectVersion}`；照 `retryTaskIds` 先例 —— `to` = 当前态时跳过 `canTransition`，转移表零改动，**不入登记字段特例判据**）。判据序（任一不过 ⇒ **整单拒绝、零写入、主链零迁移**）：未过门（`approval ≠ 已通过`，**判据看 `approval`、不看 `stage`**）/ Feature 已 `cancelled` / `features.version` 为空（无 Group Version ⇒ 落不下归属）挡写；目标 project 版本行不存在 ⇒ 挡（**不隐式建版**，建版只走显式写口）；该行已 `released` ⇒ 挡（一经发版即冻结，不得复用为后续归属目标）；不变式继承（同 `(owner_group, group_version, project_id)` 名下**其它需求**已有承诺 ⇒ 本次必须继承同版号；无父主轨首条归属时读集为空 ⇒ 自选，一旦有承诺即进入继承档，**不做前瞻**）与异值 ⇒ 挡（改归属须显式「先删后建」两笔、逐笔留痕）。入参是**全量承诺集**，同值重发落幂等 no-op（`noop` 计数）⇒ 新增执行节点的同轮重发安全；**空数组 = 零写 no-op，不是「清空归属」**。`groupVersion` 不在入参里，由 `features.version` 派生（同单写定、此后不漂移）；归属行**不进 `pruneTasks`、不随 Feature 终态 / `cancel` 级联删**（长期事实源）。
- **发版只有一个动作 + 同事务级联（v0.10.1）**：发版仍是**唯一**那一个动作 = 标 **Group Version** `released`（写口 = `session/store.ts` 的 `versionLedgerMarkReleased`）；引擎在**同一事务**内经 `cascadeProjectVersionsReleased` 把它名下**被触达**的 project 版本一并置 `released`（随即按上条冻结）。级联数据源 = **归属表 `feature_projects`**（不是 `project_versions` 全表、也不是 `tasks`）⇒ 未被该版任何需求触达的 project **不产生行、不被发版**（UPDATE 不建行）；级联任一步失败 ⇒ **整个事务回滚**（Group 状态不落）⇒「Group 已 `released` 而其触达的 project 仍 `open`」这一形态在事务结束时不可能存续，**也不需要为 project 另开发版口**。事件 `version.released` 随同落，**只增键** `projectVersionsTargeted`（触达集大小）/ `projectVersionsReleased`（本次真迁行数 —— 为 0 可能是「本就都 `released`」，不是失败）。快照 `projects[]` 项形状扩为 `{projectId, version, repoId, ref}`（**新增可选键、缺省即不写该键**，同 `repoId` 口径取发版动作带入的原值，引擎**不**从归属表 / `project_versions` 反查填充）。
- **project 侧 `releasable` = 展示字段、不是发版口（v0.10.1）**：判据唯一实现 = `bridge/feature-tools.ts` 的 `evaluateProjectReleaseGate`（`total>0 ∧ completed+cancelled===total`，计数从**归属表**派生），经 `projectVersionsView` 透出。**它不产生任何拒绝码、不构成第二道发版门** —— 本版本唯一的发版判据仍是上面 Group 侧的 `evaluateReleaseGate`；板只投影本结构，**不重算**。
- **发版快照（`released` 同事务写 · O7）**：`bridge/versions-release.ts` 的 `markVersionReleased` = 发版动作的**唯一入口**（O2b 的 `PATCH /api/versions/{version}/status` 在 `released` 分支必须转进它）；判据序 = 台账事实源 → 发版闸（O4）→ `projects` 边界校验 → `session/store.ts` 的 `versionLedgerMarkReleased` 事务。该事务内 `UPDATE versions.status='released'` + `INSERT releases` 快照 + `version.released` 事件**一并成立或一并回滚**（分开写会留下「已锁无事实」或「有事实未锁」的半成品版本，两者都不可事后自动补齐；v0.10.1 起同一事务内再加一笔**级联** `cascadeProjectVersionsReleased` —— 见上条「发版只有一个动作 + 同事务级联」，级联任一步失败同样回滚整单）。快照列 `changelogAnchor` / `projects[].{repoId,ref}` / `note` / `createdAt` **取发版动作带入的原值、引擎不归一**：尤其 `repoId` **不回查 `runner_projects`** —— 那张投影表每次上报被全量替换，机未上报即空，拿它当数据源会把「上报缺位」写成「这一版不含该仓」的**假事实**，而快照不可变、写错即永久错。`releases` 无 `updated_at` 且只 INSERT ⇒ **不可变**（重复标记 = 幂等回读既有快照，入参被忽略，不再过闸，因闸是「进入 released」的准入而非「读回快照」的准入）；迁移主源导入的历史 `released` 行本就无快照 ⇒ 同一入口**补写**（事件标 `backfilled`）。读口 `releaseSnapshotGet` / `releaseSnapshotList`（后者 = 板「版本列 = 引擎 Release 清单 ∪ 卡派生版号」左半）。
- **台账状态读口**：`session/store.ts` 的 `versionLedgerStatus`（读 `versions.status`，三态闭集见 `types.ts` `VERSION_LEDGER_STATUSES`）；与 O5 `versionLedgerHas` 同族。project 档同族读口 = `projectVersionGet`（三元组定位）/ `projectVersionList`（按 `owner_group` 过滤、键序可比对），两态闭集 = `PROJECT_VERSION_STATUSES`（`session/store.ts` 自持，**不进 `types.ts`** —— 与组档三态不是同一套值域）。
- **中间态禁令（发版闸判据 · 非仅纪律）**：版号不在引擎 `versions` 台账 ⇒ 发版闸 **fail-closed**（`orch_version_unknown`），**即使该版名下卡已全部收口也挡** —— 这就是「不得发布既写本地台账又读引擎的中间态」落到引擎事实源的机器判据（引擎不持有该行 ⇒ 无从证明发版事实）。O1 已把 `versions` 表建入默认 schema ⇒ 存在性执法即时生效，无需再改代码。写口 `released` 锁 / 存在性检查仍保留 `ledgerReady=false`（未迁移历史库）的**放行**兜底（无表 ≠ 已发版/不存在，同 O5 口径），但发版闸在此路径**反向取严**（读不到引擎台账 ⇒ 挡，不放行）。

错误码闭集（MCP 面结构化 `code`；HTTP 面由 O2 端点转 `409 {ok,error:{code,message}}` —— v0.10.1 的 project 档端点**按 store 写口带回的 `status` 逐码映射** `400` / `404` / `409` / `503`，不是一律 409）。⚠ 这些是**版本面写口码**，与 `PROTOCOL.md` 的 **Runner 线协议错误族**（`failureKind` 等）正交，**不入该表**：

| code | 触发 | 发起面 |
|---|---|---|
| `board_schedule_state_locked` | 排期写状态锁：仅 `stage=需求分析 ∧ approval=未发起` 可写 `version`（改版纪律第一档）；已过需求确认门的卡再排期 ⇒ 拒 | **跨单元引用**（板 v0.9.x 起用的码，**字面不变**；v0.10.0 起改由**引擎**返回） |
| `orch_version_released_locked` | `released` 锁：目标版号在引擎台账已 `released` ⇒ 不可排入 / 不可改排期（create / advance 同挡） | 引擎（新增） |
| `orch_version_unknown` | 存在性 / 中间态：写 `version` 命中未登记版号；或发版闸要求版号在引擎台账（表未落地或未命中 ⇒ fail-closed） | 引擎（O5 引入 · O4 复用于闸） |
| `orch_version_not_converged` | 发版闸：版号名下有 `open`（含 `failed`）⇒ 未收口 | 引擎（新增） |
| `orch_version_all_cancelled` | 发版闸：版号名下全部 `cancelled`（无任何 `completed` 交付）⇒ 挡 | 引擎（新增） |
| `orch_release_projects_invalid` | 发版快照入参：`projects` 非数组 / 项非对象 / `repoId`\|`ref` 非 `string|null` ⇒ 400（校验在进事务前，挡下即零写入） | 引擎（O7 新增） |
| `orch_project_version_unknown` | project 台账无此行：`DELETE` 删不存在 ⇒ `404`（重复发的第二次也落 404，幂等由判据保证）；或归属写的目标 project 版本行未建 ⇒ 拒（**不隐式建版**） | 引擎（v0.10.1 新增 · O1 定义 / O2 复用于归属） |
| `orch_project_version_exists` | 建版判重：同 `(owner_group, project_id, version)` 已存在 ⇒ `409`。判重**不靠 `ON CONFLICT` / `INSERT OR REPLACE`**（PK 含可空列 `owner_group`，SQLite 把 NULL 视为互不相等 ⇒ 匿名档会静默插出第二行），一律 NULL-safe `IS` 自查 + 再插 | 引擎（v0.10.1 新增） |
| `orch_project_version_invalid_shape` | 建版入参形状：`project_id` 空串 / `version` 空串或非 semver 形状 ⇒ `400`（归属侧同样用它挡 trim 后为空的身份键成员） | 引擎（v0.10.1 新增） |
| `orch_project_version_released_locked` | project 版本已 `released`：删版 ⇒ `409`（发版事实不可撤销，要动须抬到未 `released` 的新号）；新增归属指向它 ⇒ 拒（一经 `released` 即冻结，不得复用为后续归属目标） | 引擎（v0.10.1 新增 · O2 定义 / O5 复用于删版） |
| `orch_project_attribution_conflict` | 归属写冲突：单内同 `projectId` 出现异值（自相矛盾，不得「后者覆盖前者」）/ 违反不变式继承（同 `(owner_group, group_version, project_id)` 已有其它需求的承诺）/ own-row 异值（改归属须先删后建）。**另复用**于删版判据「名下有归属 ⇒ 不可删」（`409`）—— C-13 闭集内没有专门的「被引用不可删」码，而「删掉一个已被承诺集引用的版本」与「改写它」是同一件事的两种写法 ⇒ 同码（**登记为偏离项**） | 引擎（v0.10.1 新增 · O2 定义 / O5 复用于删版） |
| `orch_project_attribution_state_locked` | 归属写锁：未过门（`approval ≠ 已通过`，判据不看 `stage`）/ Feature 已 `cancelled`（该轨已终止、无交付可承诺）/ `features.version` 为空（无 Group Version ⇒ 落不下归属） | 引擎（v0.10.1 新增，MCP `advance` 归属分支面） |
| `feature_group_version_required` | **门① 前提 ①（需求确认）`version` 守卫**：`advance` 把 `stage` 由「需求分析」迁往它值时该卡 `features.version` 为空 ⇒ 整单拒、**零写入**（`state`/`stage`/`approval`/`version` 四值逐字不变、零事件）。守卫只读当前行的 `stage`/`version`，**不判 `state`、不校验 stage 迁移序**。**同一枚码另挂 `approve` 侧 = 门② 条件 ③**（增补 `ec93e1bd`「照抄门① 两条前提」）：该卡 `features.version` 为空 ⇒ `approve` 整单拒、**零迁移**（`state`/`approval` 逐字不动） | 引擎（v0.10.5 新增 · O4；`approve` 侧随增补 `ec93e1bd` 挂载） |
| `feature_confirmation_doc_required` | **门① 前提 ②（需求确认）《需求确认单》已登记守卫**：与上一枚同一判据面、第四条件换为「可见 `decisions`（已落库 ∪ 本单同写）含 `-需求确认单.md` 档名」⇒ 未登记即整单拒、**零写入**。**独立成码、不与 `feature_group_version_required` 合并**（两前提「缺哪报哪」，善后动作是两笔不同的事）；唯一豁免 = `retryTaskIds` 重派路径。**同一枚码另挂 `approve` 侧 = 门② 条件 ④**（增补 `ec93e1bd`）：已落库 `decisions` 内无该档名 ⇒ `approve` 整单拒、**零迁移**（`approve` 不收 `decisions` 入参 ⇒ 并集豁免在本侧不存在，只看当场已落库值） | **MCP Feature 工具面**（`a2a_feature_advance` ∧ `a2a_feature_approve`；与 `feature_approval_required` / `feature_group_version_required` / `feature_attribution_required` 同族）——**不属版本面写口码族**（`orch_*`），也不入 `PROTOCOL.md` 的 Runner 线协议错误族（引擎 v0.10.5 新增 · 增补 `bbc7ea28` O3 · 增补 `ec93e1bd` 加挂 approve 侧） |
| `feature_requirement_gate_not_passed` | **门② 条件 ⑤ 需求确认门（门①）未过**（增补 `ec93e1bd` / 引擎映射 §3 门②行六条）：`approve` 时该卡 `stage` 仍「需求分析」⇒ 整单拒、**零迁移**（`state`/`approval` 逐字不动）。判据与 `derivePendingItems` 的 `"stage"` 欠项**同判据单源**（观测面与执法面共用一件事，**无第二套判据**）；只查当场值、**不校验 `stage` 迁移序**。**独立成码、不与 ④ 合并**（照门① 先例「缺哪报哪」：④ 的善后是补登记一笔、⑤ 的善后是过一次门①，是两件不同的事） | **MCP Feature 工具面**（`a2a_feature_approve`；`feature_*` 前缀，与 `feature_group_version_required` / `feature_confirmation_doc_required` 同族）——**不属版本面写口码族**（`orch_*`），也不入 `PROTOCOL.md` 的 Runner 线协议错误族（引擎 v0.10.5 · 增补 `ec93e1bd`） |
| `feature_design_doc_required` | **门② 条件 ⑥《改造文档》未登记**（增补 `ec93e1bd`）：`approve` 时已落库 `decisions` 内**无任一** `-改造文档.md` 档名 ⇒ 整单拒、**零迁移**。判据用同一 `docRegistered` + `DESIGN_DOC_MARKER`（**无第二套判据**）；**独立成码、不与 ④ 合并**（两枚档名**须同时在册**）。文案含两条告警：① ④⑥ 两道各自独立成码 ⇒ 只登记其一不放行；② `decisions` 是**整值替换** ⇒ 补登记时须**重发全量两枚**（只发新枚会把 ④ 打回）。**不判档名属于哪条轨**（定稿 (甲)：轨型与文档归属不执法，「增补 / 承接须登记主需求那一份」是人判纪律，落 flow 文本） | **MCP Feature 工具面**（`a2a_feature_approve`；`feature_*` 前缀，与 `feature_confirmation_doc_required` 同族）——**不属版本面写口码族**（`orch_*`），也不入 `PROTOCOL.md` 的 Runner 线协议错误族（引擎 v0.10.5 · 增补 `ec93e1bd`） |
| `feature_attribution_required` | **归属门（转移守卫）**：`advance` 离开 `version_planning`（→`decomposing`）或离开 `decomposing`（→`executing`）时，该需求**归属（承诺集）为空**（已落库 0 行 ∧ 本单 `projectVersions` 待写 0 行）⇒ 整单拒、**主链零迁移**。**与 `orch_project_attribution_state_locked` 方向相反**：那枚是「该态**不允许写**归属」（写入口锁），本枚是「**缺归属而不许离开**该态」（出口门），故独立成码、不复用 | **MCP Feature 工具面**（`a2a_feature_advance`；`feature_*` 前缀，与 `feature_approval_required` / `feature_group_version_required` 同族）——**不属上面那批版本面写口码族**（`orch_*`），也不入 `PROTOCOL.md` 的 Runner 线协议错误族（引擎 v0.10.5 新增 · O4） |

> **线协议不升版（v0.10.1）**：本版新增的键与码**全在 orch 自己的 HTTP 数据面 / MCP 面**（project 台账、归属、`projectVersions[]`），**Runner ⇄ Bridge 线协议载荷零改动** ⇒ `PROTOCOL_VERSION` 仍 **2.3**（判据 = 新增键全可选、既有语义不收紧；与 `types.ts` 常量、本节 ⚠ 条「与 Runner 线协议错误族正交」一致）。
> **板产码照旧标跨单元引用**：`board_schedule_state_locked` 一类（板 v0.9.x 起用、**字面不变**、v0.10.0 起改由引擎返回）**不并入**上面这批 `orch_project_*` 新码族；逐行区分见「发起面」列。

## Runner 反向注册（pull）

执行机在目标部署形态下**无入口**（无公网 / NAT 后），桥不再向 Launcher 拨号；改由 Runner **主动出站**连桥。

```
Runner（machine，出站）                        Bridge（orch，http transport）
  │  POST /runner/register  ─────────────────▶  Bearer 鉴权 → machineId ∈ machines[]
  │    （machineId / projects / capabilities / selfCheck / protocolVersion）→ 注册投影
  │  POST /runner/connect   ─────────────────▶  长轮询（hold 缺省 25s）：空 = 204 心跳
  │  ◀─────────────────  命令族三类：dispatch / stop / cancel-task（有则立即返回）
  │    本地 ensure（幂等复用）→ 本地 A2A message/send → 轮询至终态 → outbox 落盘
  │  POST /runner/result    ─────────────────▶  claimToken 校验 → 按 (machineId, taskId) 幂等落库 → ack
```

- **端点**：`/runner/register`（注册 / 刷新投影）、`/runner/connect`（长轮询；新任务 / 事件 `wake` 立即唤醒；空超时 204 心跳）、`/runner/result`（结果回传 + ack）。挂载于常驻 HTTP transport（复用 MCP 端口，不引第二接入面）。
- **门闩**：仅 core 租约 `owner` 提供端点；follower 一律 503 `runner_not_owner`（不抢调度权，也不给 Runner 下发命令）。
- **鉴权**：per-machine 静态 Bearer token（machine 侧 `launcher.bridge.token` ↔ orch 侧 `machines[].token`）；该机未配置 token 一律拒绝（绝不 fail-open）。
- **版本准入**：注册载荷必携 `protocolVersion`，主版本须 ∈ `SUPPORTED_PEER_PROTOCOL_MAJORS`（2.0 硬切，当前 `[2]`）；不符 ⇒ 403 `protocol_version_mismatch`（含升级指引）。
- **命令族三类**：`dispatch`（派发任务）/ `stop`（停本机**单个项目** Agent）/ `cancel-task`（取消在飞任务）；三类载荷一律携 `commandId`（桥侧 uuid，回执原样带回），`stop` / `cancel-task` 另携 `projectId`；控制命令优先于 claim 下发。
- **结果回传**：Runner 先落盘 outbox 再回传，**2xx = ack ⇒ 删文件**；桥按 `(machineId, taskId)` 幂等落库（首个终态胜出）；`stop` / `cancel-task` 的回执随下一轮 `connect` 的 `acks[]` 带回（观测通道）。
- **调度语义**：`a2a_call(mode="execute")` 登记 Feature DAG 节点后**入队**（不直接拨机器），由 Runner 领取；`mode="inquiry"` 同样经队列、`wake` 后尽快下发；无 Runner 在线照常入队、不拒绝（成员 / 配置错仍同步零 I/O fail-fast）。
- 契约全文见 [PROTOCOL.md](../PROTOCOL.md)（Runner ⇄ Bridge 线协议契约 2.3）。

## 服务启停

```bash
npm run bridge:start     # 后台启动常驻桥（已在运行则提示并退出 0）
npm run bridge:status    # 查看 pid / host:port / health / role / startedAt
npm run bridge:stop      # 停止（优先 POST /shutdown 优雅停机，超时兜底强杀）
npm run bridge:restart   # 停止后重新后台拉起
npm run bridge:logs      # 输出日志全文（支持 --lines N / --follow）
```

- `start` / `restart` 支持 `--no-wait`（语义见下）。桥恒常驻 http（stdio 已退役；显式 `transport.mode="stdio"` 会在解析期 fail-fast）。
- 端口读配置 `transport.http`；`MACHINES_CONFIG` 可指定其他配置文件，`SESSION_DB` 可指定会话库路径。
- pidfile：`data/bridge.pid`（**由桥自己写**，JSON `{ pid, mode, role, startedAt }`，非锁，陈旧无害）；日志：`data/logs/bridge.log`。
- 前台入口 `npm run bridge` 仅作调试，不作为启停手段。

## 配置

| 环境变量 | 说明 | 缺省 |
|----------|------|------|
| `MACHINES_CONFIG` | 机器清单文件路径（`machines[]`，可选 `projectGroup` / `web` / `transport`） | `config/config.json` |
| `SESSION_DB` | 会话 / 任务库 SQLite 路径；**其所在目录即桥的 data dir**（`bridge.pid` / `logs/` / `core.lock` 均落此，便于隔离实测） | `data/sessions.sqlite` |

> 实际配置 `config/config.json` 不入库，首次部署从 `config/config.json.default` 复制并填入本机真实值。

- 机器清单 `machines[]`：每项 `machineId` + 可选 `launcherUrl`（出站指挥通道已退役，仅作观测 / 兼容占位）+ `token`（Runner 出站 Bearer，须与 machine 侧 `launcher.bridge.token` 一致）；顶层可选 `runner { holdMs, heartbeatTimeoutMs, orphanTimeoutMs }`（缺省 `25000` / `60000` / `1800000`）。
  - `holdMs` = `/runner/connect` 长轮询挂起上限（空超时即心跳）；`heartbeatTimeoutMs` = 注册心跳判死阈值（超期只降在线态、不触发 stop）。两者均为正整数毫秒，非法解析期 fail-fast。
  - **`orphanTimeoutMs`（v0.8.7 新增 · 孤儿墙钟出口）** = 在飞任务的**墙钟判死**阈值：`queue_state ∈ {claimed, running}` 且 `claimed_at` 早于 `now - orphanTimeoutMs` ⇒ 桥把该任务置 `failed` + `queue_state='settled'` + `failure_kind='runner'`（v0.8.8 O1：六类闭集的「不可续跑」子类，取代二分时代的 `infra`），并发 **`task.orphaned`** 事件（payload 含 `machineId` / `projectId` / `featureId` / `claimedAt` / `elapsedMs` / `timeoutMs`）⇒ Feature 静止收敛发失败账单 ⇒ 宿主 `advance(retryTaskIds)` 重派。**与心跳清算分工不同**：心跳管「**机器死没死**」⇒ 回 `queued`（可复活）；墙钟管「**任务自己超没超**」⇒ `failed` 记账交宿主。二者挂同一 `sweepIntervalMs` timer、**同 tick 先 `sweepStale` 后墙钟**（心跳先命中者走 requeue，墙钟只收残量 ⇒ 两路竞争天然消解）。**跨单元不变量：`orphanTimeoutMs` > 机器侧最坏总框（三段构成 = 窗上限 600s + 结构余量 300s + `min(续跑余量, 窗)` ≤ 600s ⇒ 1500s）** —— 缺省 30 min 对 machine 侧 10 min 窗上限恒有 300s 边际 ⇒ **orch 不读 machine 配置**（避免跨单元配置耦合）。
- 顶层可选 `projectGroup`：**组数组** `[{ name, members[] }]`，形状与语义见「连接身份与可见性」；缺省（不写该键）= 无组 = 全量接纳。
- **两份模板文件的分工**：`config/config.json.default` = schema 缺省值 + 必填形状骨架（只放值，说明文字不进模板）；`config/config.json.example` = **完整可运行示例**（首次部署照抄它最省事 —— 键齐 + 值安全：`machines[]` 一律字面量哑值，不含真实 machineId / 真实 token / 本机路径，也不含 `projectGroup`，故可随文档外发）。**两份都不参与加载** —— 桥只读 `MACHINES_CONFIG` 所指文件（缺省 `config/config.json`），无自动复制回退。
- **`projectGroup` 的数组形态与配置期执法**（形状 = **组数组** `[{ name, members: [{ machineId, projectId }] }]`；连接身份与可见性语义见「连接身份与可见性」）：
  - **段缺省 = 全量接纳**：不写 `projectGroup` 键 ⇒ 全部已配置机器 / 项目照常列出与派发，旧配置零改动可用（`.example` 即此形态）。
  - **段存在时必须是组数组**，每个元素是一个组对象；`members` 必须是**非空**数组 —— 空数组视为配置错误（要么删掉该段、要么列出成员）。
  - **组名 `name` 必填**（身份 = 连接 URL 路径首段，无名组不可被寻址）：字符集 `[A-Za-z0-9_-]+`，且不得与保留首段 `health` / `shutdown` / `runner` 或 `transport.http.path` 的首段冲突（撞段 ⇒ 启动 fail-fast）。
  - **配组后连接必须带组名首段**：`http://127.0.0.1:8787/<组名>/mcp`（如组名 `team-a` ⇒ `http://127.0.0.1:8787/team-a/mcp`）；不带组名的裸 `/mcp` ⇒ **403 `group_identity_required`**（fail-closed，**不**回退成全量接纳）。
  - **组间成员互斥 ⇒ 配置期 fail-fast**：同一 `(machineId, projectId)` 出现在两个组 ⇒ 桥拒绝启动、不 bind；**组内重复项**由集合去重、不算冲突。
  - **成员机器名拼错的代价是全局的**：成员 `machineId` 不在 `machines[]` ⇒ 桥整体拒绝派发（`machines_config_error`），且该段解析失败会让 transport 读取一并 fail-fast（桥拒绝启动、不 bind）；`web` 各键仍回落自身缺省。改完配置先验 JSON 合法性，再起桥看日志。
  - **推荐入组机器保持 `launcher.idleStopMs > 0`（machine 侧配置，缺省 300000）**：把项目移出组成员后，靠 Launcher 空闲回收把已拉起的 agent 自动收回；配 0（显式禁用回收）时该 agent 可能长期驻留，需人工停单个项目。
- **`machines[]` 逐键口径**：
  - `launcherUrl` —— **已作废（deprecated，v0.7.0）**：入站指挥通道随 Runner 反向注册退役；解析已放宽为**可选**（缺省 / 非法仅告警，不 fail-fast、不回退全量接纳），出站路径退役前仍兼容保留（可继续填旧值，也可省略）。
  - `token` —— per-machine Runner 鉴权 token（可选）：桥按 `machineId` 校验 Runner 注册 / 领任务 / 回传携带的静态 Bearer，**须与 machine 侧 `launcher.bridge.token` 一致**；声明时须为非空字符串，该机未配置 token 一律拒绝（绝不 fail-open）。
- **不同 Agent 的配置方式**：本单元**无 Agent 配置项**（配置面不含 `agentKind` / `agentConfig`；机器侧 Agent 配置由 machine 自持、桥不下发、且在项目投影白名单中被显式剔除）。orch 仅对**来自 machine 上报**的 `agentKind` 做**闭集校验**（闭集源 = 仓库根 `PROTOCOL.md` 的 `agent-kinds` 锚点；执法三处 = 注册载荷 400 整包拒 / 投影写口拒写 / 读回脏值守卫）；合法值仅作**透传 / 投影**出现。

## 启停与就绪语义（统一口径锚点）

> 本段是启停 / 就绪语义的**持久锚点**：与 machine 侧同口径、各单元独立实现、不共享代码。运维、编排与根 README 的启停说明均以本段为准。

- **`--no-wait`：发起即返**（不等待任何就绪判据）；`exit 0` = **已发起（≠ 已就绪）**，仅 spawn 同步失败才 `exit 1`。
- **缺省 `start` 的等待目标 = 服务可答**；桥侧即 `GET /health` 返回 **HTTP 200 且 `status:"ok"`**（≤ `READY_TIMEOUT_MS` 30s；启动自检 `recover()` 为本地同步，30s 为宽裕上界）。超时 ⇒ `exit 1`。
- **`--no-wait` 后须另起 `npm run bridge:status` 确认就绪**；`--no-wait` 输出的 **pid 仅供参考**（并发竞态下可能指向被接管的败者子进程）。
- **调用拼写**：`npm run bridge:start -- --no-wait`（npm 会吞掉 script 名后的**裸** `--no-*`，必须用 `--` 分隔）。`restart` 同理：`npm run bridge:restart -- --no-wait`。
- **`restart --no-wait` 仅作用 start 段**；stop 段仍阻塞（`POST /shutdown` ≤5s + 等待端口释放 ≤45s×2，极端 ≤95s），整体重启**非瞬时返回**。
- **占用判定以 `/health` 的 `status` 为键**（不依赖 HTTP 状态码）：
  - 端口在监听但 `/health` 不可答 / 不可解析，或 `status` 缺失 / 非白名单（`ok` / `starting`）⇒ **端口被非本桥进程占用** ⇒ `exit 1`；
  - `status === "ok"` ⇒ **已在运行且已就绪** ⇒ `exit 0`；
  - `status === "starting"` ⇒ **本服务启动中（已在运行但未就绪）** —— 缺省 / `--no-wait` 均即返 `0`。
- **退出码恒 `{0,1}`**：`0` = 已发起 / 已就绪 / 已在运行；`1` = 超时 / 被非本桥占用 / spawn 失败。
- **`--wait-ready`（opt-in）**：显式等待就绪（`GET /health` 的 `status === "ok"`）后才 `exit 0`，超时 `exit 1`；可配 `--ready-timeout <ms>` 放宽就绪预算（缺省 30s，治就绪窗口假阴性）。入口探测为 `starting` 时缺省 / `--no-wait` 即返 0，而 `--wait-ready` **续等至 ok**。与 `--no-wait` 互斥（同传即报错），仅 `start` / `restart` 接受。orch 缺省 `start` 的等待目标本就等价于业务就绪（`status:"ok"`），故该开关主要用于「显式确认 / 放宽预算 / 等待 `starting` 收敛」。
