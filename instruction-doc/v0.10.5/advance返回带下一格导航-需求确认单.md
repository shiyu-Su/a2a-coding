# 需求确认单 — advance 返回带「下一格」派生导航（让引擎回答"接下来做啥"）

**REQ-ID**: REQ-2026-10-13-02（XX = 当日全仓序号）
**版本归属**: v0.10.5（增补轨必须与主轨同 Group Version）
**Feature**: `6cc46dd2-e62e-4a6b-a438-1a4ad034febf`（增补轨 · `parentFeatureId` = `eb86d5e8-d9d0-4892-a870-27f41df82ec2`「流程一致性：引擎以 Feature state 约束流程」）
**来源**: 用户 2026-10-13 在 `eb86d5e8` 的增补讨论中提出（技术债 / 能力补齐）
**用户原话**（一字不改）:
1. 「目前 推进后 orch做啥 是全靠flow里的提示，还是 a2a_feature_advance的返回 会告诉orchagent 接下来是哪一步，要做啥吗？」
2. 「嗯 把下一个要做啥 作为advance的返回 这样子 也能更好的满足 流程一致性 这个需求吧」
3. 「那新增一个增补轨 作为eb86d5e8的补充」
**Step 0 核实**: **已完成**（2026-10-13 · orch `cb017206-9ec2-4de6-b378-54cc47da6b45` + board `0f296f2a-b907-4272-b9bf-c82703f0e66c`，均**产品经理职责位**、只读零写入；结论见下「执行单元核实结论」节）

## 要解决什么问题

> 确认点 =「我理解你要解决的是不是这个问题」—— 确认的是**问题**，不是方案。

- **当前行为**：`a2a_feature_advance` 的返回字段全集 = `{ok, featureId, from, state, [?note], [?rearmed], [?unfrozen]}`（宿主本会话多次调用真实样本，逐字一致）—— **只回答"改成了什么态"，不含"下一步是谁 / 该做啥"**。它是**纯状态机操作口，不承担导航**。
- **「推进后该做啥」今天只存在于两处，且都不在 orch agent 手上**：① **flow 规范**（`引擎映射.md` §2 驱动方表 + §7 三方驱动边界 + `需求流程.md` §2 判据）—— 靠**读**，而"不保证读到"是已登记的既有缺口（池卡 `c27db64c`）；② **板面引导行** `deriveNextStepHint` —— **显示层、给人看**，不注入 agent。
- **期望行为**：引擎在推进的返回里**直接给出「主链下一格」**（机械派生），使「接下来做啥」不再依赖 agent 读规范猜。
- **后果（为何这属"流程一致性"）**：状态机只管「能不能走」、不管「该往哪走」⇒ agent 的"下一步"全靠自己推。与跳步类漏洞叠加时尤危 —— 状态被乱跳后，agent 手里那个"下一步"**直接错位**（它以为在做 Step 1，引擎已把卡放到 Step 2）。

## 方向与可推导性（v2 校订，2026-10-13 · 用户确认）

> **v2 校订**：本卡需求原文写的「**主链下一格**」**是错的** —— `waiting_approval` 一格压着 Step 0 与 Step 1，而主链下一格（`version_planning`）**恰恰是「唯一准入」的那条边**，中间还隔着「排期写 version → 门① → Step 1（评估+边界轮+改造文档）→ 门②」四件事 ⇒ 答"下一格 = `version_planning`"是**误导**而非导航。**以本节口径为准，需求原文该处据此读。**

**方向**：把「**当前字段组合下的下一步**」作为**派生读面**放进 `advance` 的返回。

**可推导性结论**：四字段（`state` + `stage` + `approval` + `version`）**足以推出"现在该干什么"** —— `stage`/`approval`/`version` 正是把 `waiting_approval` 那一格切开的三枚。推导表（= 返回里"下一步"列的**事实源**）：

| `state` | `stage` | `approval` | `version` | 该干什么 | 谁 |
|---|---|---|---|---|---|
| `waiting_approval` | `需求分析` | `未发起` | **空** | 访谈 + 出确认单 + **先排期写 version** | 宿主/板 |
| `waiting_approval` | `需求分析` | `未发起` | vX.Y | **过门①**（用户确认是这个问题） | 用户 |
| `waiting_approval` | `改造方案` | `未发起` | vX.Y | **Step 1**：评估 + 边界轮 + 改造文档 | 宿主+各单元 |
| `waiting_approval` | `改造方案` | `待审批` | vX.Y | **过门②（`approve`）** | 用户 |
| `version_planning` | — | — | — | PjM 版本规划工序 | 宿主主持 |
| `decomposing` | — | — | — | 各 project 出本侧清单 + 登记 DAG + 同轮贴用户 | 研发经理+宿主 |
| `executing` | — | — | — | 引擎拓扑派发；宿主等（失败则处置） | 引擎/宿主 |
| `integrating` / `testing` | — | — | — | 宿主按判据清单连推（`testing` 另需真机验收） | 宿主 |
| `reviewing` | — | — | — | 等用户验收结论 | 用户 |
| `completed` | `验收`→`发版` | — | — | 等发版令（§8） | 用户 |

**三条硬约束（v2 新增）**：

1. **不许叫「主链下一格」** —— 见上方 v2 校订；给的是「**本格内的下一步**」。
2. **`version` 这一维必须带出** —— 上表行 1 与行 2 的 `state`/`stage`/`approval` 完全相同，只靠 `version` 空/非空区分；返回值若不含该维，读的人看不出"该先去排期"。
3. **语义边界：本字段只答"该往哪走"，不答"现在在不在走"** —— `state=executing` 下「正在派发」与「**失败收敛静止**」的四字段**完全相同** ⇒ 判"卡没卡"必须看 `tasks[]` / `a2a_feature_trace`。**本返回不得被读成"当前有在跑"**。

形态照既有先例「**B 派生读面**」（可观测面，非状态机态、非机器门）；不加 `state`/`stage` 值域、不加机器门、不加登记字段。

## 返回内容（提案 v2 · 待用户确认）

**设计原则**：① 只给**机械派生**的事实；② **人话归 flow / 板**，引擎不写流程文案；③ **零新枚举**（字段全部取自既有词汇）；④ **推进后的结果必须可读回**（不能改了 `stage` 却看不到 `stage`）。

**v2 相对 v1 的两处修正**（用户 2026-10-13 提出）：

- **补「登记字段回显」**：v1 只回显 `state`，而 `stage` 是**会被引擎派生的**登记字段（`改造`/`回归`/`验收`）⇒ 调用方写完之后**读不到结果**，还得再捞一次 `feature_status`。v2 把推进后的**完整字段组合**（`stage`/`approval`/`version`）一并回显。
- **`note` 不兼任指引**：`note` 是**入参**（宿主写的人判凭据），返回里回显的是「你写进去的那句」；若让引擎往同名键塞指引，就成**同名不同义**，且与"人判留痕"语义打架。故**另给 `action`**（v3 起它已是**行动级英文文案、由引擎直接给出** —— 见下方「`action` 的归属」节）。

**提案形状（v15 扁平化 · 去 `next` 包装）**：

> **★v15 语义纠正（用户 2026-10-13）**：`advance` 一执行完，卡**已经在新的阶段上**了 ⇒ **不存在"下一步"**；返回描述的应是「**推进后本阶段的状态 + 本阶段要做什么**」。故：**去掉 `next` 包装**（四枚与 `state`/`stage`/`approval`/`version` 平级）；**`next.state` 直接删除** —— 它必然等于顶层 `state`（推进后的态就是本阶段的态）；终态不再需要"无下一步"的 state 字段，用 `actor: null` 表达即可。

```jsonc
{
  "ok": true, "featureId": …, "from": …,

  "state": "…", "stage": "…", "approval": "…", "version": "…",   // 推进后【本阶段】的完整状态
  "pending": ["…"],                              // 本阶段还差哪几件事（0–n 枚）
  "gate":    "gate1" | "gate2" | null,           // 本阶段卡在 / 奔向哪道用户门
  "actor":   "host" | "user" | "engine" | null,  // 本阶段卡在谁那儿 / 等谁
  "action":  "Hook `watch-feature.mjs` to monitor the feature."   // 本阶段该做什么（英文一句）
}
```

**返回字段逐一说明**：

| 字段 | 出现时机 | 取值 | 含义 |
|---|---|---|---|
| `ok` | 恒有 | `true` / `false` | 写是否成功。**`false` ⇒ 结构化拒收、零写入**（现态逐字不变），此时只带 `code` + `error` |
| `featureId` | 恒有 | 字符串 | 被操作的 Feature 主键（回显） |
| `from` | 成功时 | `state` 值 | **变更前**的 `state`（源态） |
| `state` | 成功时 | `state` 值 | **变更后**的 `state`（目标态）。**登记字段写**（`to` = 当前态）时与 `from` 同值 |
| `note` | 传了才有 | 字符串 | **入参回显**：调用方写的推进凭据（人判留痕）。引擎**不改写、不生成** |
| `rearmed` | 仅 `retryTaskIds` 成功时 | taskId 数组 | 本次被**重新入列**的失败节点 |
| `unfrozen` | 同上 | taskId 数组 | 随之**解冻的 `blocked` 下游**节点 |
| `code` + `error` | `ok:false` 时 | 字符串 | 结构化错误码 + 文案（如 `feature_approval_required` / `feature_transition_invalid`） |
| **—— 以下为 `6cc46dd2` 提案新增 ——** | | | |
| `stage` | 成功时 | `stage` 值（中文，**逐字**） | **本阶段**的登记字段。**它会被引擎派生** ⇒ 必须回显，否则调用方写完读不回 |
| `approval` | 成功时 | `approval` 值 | 同上 |
| `version` | 成功时 | 字符串 | 同上（空 / `null` = 未排期） |
| `pending` | 成功时 | 数组（0–n 枚） | **本阶段还差的那几件事**：`requirement-doc` / `version` / `stage` / `design-doc` / `approval` |
| `gate` | 成功时 | `gate1` / `gate2` / `null` | 本阶段卡在 / 奔向**哪道用户门** |
| `actor` | 成功时 | `host` / `user` / `engine` / `null` | **本阶段（推进后）的推动方 / 执行方** —— `advance` 一执行完卡**已经在新阶段**，故报的是**那个阶段由谁推动 / 执行**（**★v22 用户更正**；v13 旧措辞"当前卡在谁那儿 / 等谁"**作废**）；终态为 `null` |
| `action` | 成功时 | 英文字符串 | **本阶段该做什么**（行动级指引、一句） |

> **两条容易混的分野，写死**：
> 1. **`note`（入参）vs `next.action`（出参）** —— 前者是**人写的凭据**、后者是**引擎派的指引**；同名不用、各归各位。
> 2. **失败时不出 `from` / `state` / `next`** —— 拒收 = 零写入 ⇒ 没有任何"推进后"的状态可回显。
>
> **待核实一项**：`ok:false` 的**完整键集** —— 同族工具的实测形状是 `{ok:false, code, error}`（如 `feature_not_found` 那发），但 `advance` 的拒收是否还带别的键（如 `from`），宿主本会话**未 inline 采样过**，由 Step 0 核实补。

**`action` 逐行草案（英文 · 行动级）**：

| 结果组合 | `next.action` |
|---|---|
| `wa · 需求分析 · 未发起 · version 空` | `"Register a version (schedule) before anything else."` |
| `wa · 需求分析 · 未发起 · version 非空` | `"Get the user to confirm the problem, then migrate `stage` (gate 1)."` |
| `wa · 改造方案 · 未发起` | `"Run Step 1 (evaluation + boundary round), then set `approval = 待审批`."` |
| `wa · 改造方案 · 待审批` | `"Wait for the user's approval, then call `approve` (gate 2)."` |
| `version_planning` | `"Run the PjM version-planning procedure, then `advance` to `decomposing`."` |
| `decomposing` | `"Register the DAG nodes, then `advance` to `executing`."` |
| **`executing`** | **`"Hook `watch-feature.mjs` to monitor the feature."`** ← 用户点名的那条 |
| `integrating` | `"`advance` to `testing`."` |
| `testing` | `"Run the on-box acceptance, then `advance` to `reviewing`."` |
| `reviewing` | `"Wait for the user's acceptance verdict, then `advance` to `completed`."` |
| `completed` | `"Wait for the release order (§8)."` |
| `needs_input` | `"Answer the clarification: `advance(to="executing", answer=…)`."` |
| `failed` | `"Archive it: `cancel`."` |
| `cancelled` | `null` |

**`action` 的归属（★v3 变化，须留意）**：v3 的 `action` 是**行动级文案、英文**（用户 2026-10-13 定），**由引擎直接给出**。代价：`action` 里会出现 `watch-feature.mjs` 这类**宿主层手段** ⇒ **`orch` 从此知道宿主侧的工具名**。两个守法（见待裁 ⑦）：

- **(i) 引擎硬编码**（本草案）—— 简单、开箱即读；但宿主换脚本名 / 多宿主并存时要改引擎。
- **(ii) 引擎给动作码、宿主层配文案** —— 解耦；但多一层映射，`action` 不再是"开箱可读"。

**宿主建议 (i)**（当前单宿主、脚本名稳定），并把 `action` 文案表登记进改造文档 §6 —— 换宿主时同轮改。

**逐行覆盖（= 方向节那张推导表的机器版）** ⚠️ **v11 起本表按「五维 + 两维切」重做，一律以「逐步骤返回样例」节为准**（本表未含 `decisions` 维，`pending` 也还是单值形态）：

| 当前字段组合 | `next.state` | `pending` | `gate` | `actor` |
|---|---|---|---|---|
| `wa · 需求分析 · 未发起 · version 空` | `waiting_approval` | `version` | — | `host` |
| `wa · 需求分析 · 未发起 · version 非空` | `waiting_approval` | `stage` | **`gate1`** | `user` |
| `wa · 改造方案 · 未发起` | `waiting_approval` | `approval` | — | `host` |
| `wa · 改造方案 · 待审批` | `waiting_approval` | — | **`gate2`** | `user` |
| `version_planning` | `version_planning` | — | — | `host` |
| `decomposing` | `decomposing` | — | — | `host` |
| `executing` | `executing` | — | — | `engine` |
| `integrating` | `testing` | — | — | `host` |
| `testing` | `reviewing` | — | — | `host` |
| `reviewing` | `completed` | — | — | `user` |
| `completed` | `null` | — | — | `null`（发版属 §8 独立流程，不在主链导航内） |
| `needs_input` | `executing` | — | — | `host`（须带 `answer`） |
| `failed` | `null` | — | — | `null`（须经 `cancel` 归档，非前进） |
| `cancelled` | `null` | — | — | `null` |

> **`actor` 三值 = `host` / `user` / `engine`**（对应 flow 里的 宿主 / 用户 / 引擎）。注意与 `stage` 的区别：`stage` 是**回显引擎自己存的值**（`需求分析`/`改造方案`/…，**必须逐字，不翻译**）；`actor` 是**引擎自己派生的枚举**，故取英文与 `state`/`pending`/`gate` 对齐。**（★v22 用户更正语义：`actor` =「本阶段（推进后）的**推动方 / 执行方**」，**不是**"此刻谁在等" —— 故 `executing` 静止格报 `engine` 不再自相矛盾（引擎是推动方；"卡没卡"仍走 `tasks[]`/`trace`）。）**

**为什么这样够用**：`state`/`stage`/`approval`/`version`（**本阶段的状态**）+ `pending`/`gate`/`actor`/`action`（**本阶段要做什么**）一出，「该干什么」的**机械骨架 + 一句可执行动作**就齐了 —— agent 不必再去读 flow 才知道"现在轮到谁、还差哪一步、本阶段做什么"；而"那一步的判据是什么"仍归 flow（引擎不越界）。

**边界（同方向节硬约束 3）**：`executing` 行的 `actor=engine` **不表示"现在有在跑"** —— 失败收敛静止时四字段与"正在派发"完全相同，返回里不含该判据；要判卡没卡仍走 `tasks[]` / `a2a_feature_trace`。

### 逐步骤返回样例（全字段 · v8 起，v15 扁平化）

> 读法：每行 = 走完该步骤后**那一次调用返回的完整载荷**。①「本阶段状态」= `state`/`stage`/`approval`/`version`；②「本阶段明细」= `pending`/`gate`/`actor`/`action`；③ 括号内 = 发起该步骤的调用。
> **★ 引擎自动的转移（`executing→integrating`、`executing→needs_input`）与"失败静止"没有 `advance` 返回** —— 它们不是宿主动作 ⇒ 那几处拿不到这四枚明细。**这正是 `executing` 的 `action` 是"挂监控"的原因**（只能从 watch / 事件 / `feature_status` 拿）。
> **★★v16：本表混了工具面 —— 只有下列行是 `advance` 的返回**：`#2`–`#6` · `#8` · `#11` · `#13`–`#16` · `异常 b`。
> **不是 `advance` 返回的行 + 其"该干什么"的来源**：`#1` 走 `a2a_feature_create`、`#7` 走 `a2a_feature_approve` —— 而这两处**恰恰是真正挪动卡的动作**，却**没有** advance 返回 ⇒ 四枚明细**要么让 create / approve 同带、要么宿主回头捞 `feature_status`**（见待裁 ②）；`#9`–`#10` 走 `a2a_call`；`异常 a`（引擎自动）· `异常 c`（失败静止）· `异常 d`（走 `a2a_feature_cancel`）⇒ 后三处的动向只能从 **`feature.failure_report` 事件 / `a2a_feature_status` / `a2a_feature_trace`** 拿。

| # | 步骤（发起调用） | `state` | `stage` | `approval` | `version` | `pending` | `gate` | `actor` | `action` |
|---|---|---|---|---|---|---|---|---|---|
| 1 | create 入板（`a2a_feature_create`；`version` 可带可不带 —— **本行与 `version` 无关**） | `waiting_approval` | `需求分析` | `未发起` | 空 **或** `vX.Y` | `["requirement-doc"]` | — | `host` | `Dispatch each project's product_manager for the requirements analysis (Step 0), and land the 需求确认单.` |
| 2 | 确认单已落文件并登记，**且 `version` 为空**（`advance(to=当前态, decisions=[需求确认单])`） | `waiting_approval` | `需求分析` | `未发起` | 空 | `["version"]` | **`gate1`** | `user` | **`Schedule a version first, then get the user to confirm the problem (gate 1).`** |
| 3 | 确认单已落文件并登记，**且 `version` 非空**（建卡即带 or 已排期） | `waiting_approval` | `需求分析` | `未发起` | `vX.Y` | `["stage"]` | **`gate1`** | `user` | `Get the user to confirm the problem, then migrate stage (gate 1).` |
| 4 | **【门①】**（`advance(to=当前态, stage="改造方案")`） | `waiting_approval` | `改造方案` | `未发起` | `vX.Y` | `["design-doc"]` | — | `host` | `Dispatch each project's dev_manager for its side-plan and the boundary round, and land the 改造文档.` |
| 5 | Step 1 进行中（无调用） | `waiting_approval` | `改造方案` | `未发起` | `vX.Y` | 同 #4 | — | `host` | 同 #4 |
| 6 | 改造文档落文件（`advance(to=当前态, approval="待审批")`） | `waiting_approval` | `改造方案` | `待审批` | `vX.Y` | `[]` | **`gate2`** | `user` | `Wait for the user's approval, then call approve (gate 2).` |
| 7 | **【门②】**（`a2a_feature_approve`） | `version_planning` | `改造方案` | `已通过` | `vX.Y` | `[]` | — | `host` | `Run the PjM procedure (each project's project_manager) and write the attribution, then advance to decomposing.` |
| 8 | PjM 结论落库后（`advance(to="decomposing")`） | `decomposing` | `改造方案` | `已通过` | `vX.Y` | `[]` | — | `host` | `Dispatch each project's dev_manager for its node list, register the DAG, then advance to executing.` |
| 9 | 登记 DAG 节点（`a2a_call(mode="execute")` 逐枚） | `decomposing` | `改造方案` | `已通过` | `vX.Y` | 同 #8 | — | `host` | 同 #8 |
| 10 | DAG 登记完毕（无独立调用，随 #11 同轮） | `decomposing` | `改造方案` | `已通过` | `vX.Y` | 同 #8 | — | `host` | 同 #8 |
| 11 | 出 decomposing（`advance(to="executing")`） | `executing` | `改造` | `已通过` | `vX.Y` | `[]` | — | `engine` | **`Hook \`watch-feature.mjs\` to monitor the feature.`** |
| 12 | **引擎自动** `executing→integrating` | `integrating` | `改造`（实测未归 `回归`） | `已通过` | `vX.Y` | — | — | — | —（无 `advance` 返回） |
| 13 | 连推（`advance(to="testing")`） | `testing` | `回归` | `已通过` | `vX.Y` | `[]` | — | `host` | `Run the on-box acceptance, then advance to reviewing.` |
| 14 | 连推（`advance(to="reviewing")`） | `reviewing` | `验收` | `已通过` | `vX.Y` | `[]` | — | `user` | `Wait for the user's acceptance verdict, then advance to completed.` |
| 15 | 用户验收（`advance(to="completed")`） | `completed` | `验收` | `已通过` | `vX.Y` | `[]` | — | `null` | `Wait for the release order (§8).` |
| 16 | 发版后（`advance(to=当前态, stage="发版")`） | `completed` | `发版` | `已通过` | `vX.Y` | `[]` | — | `null` | 同上 |
| 异常 a | **引擎自动** `executing→needs_input` | `needs_input` | 保留当时值 | `已通过` | `vX.Y` | `[]` | — | `host` | `Answer the clarification: advance(to="executing", answer=…).`（**此行动向只能从读面拿 —— 无 `advance` 返回**） |
| 异常 b | 答澄清（`advance(to="executing", answer=…)`） | `executing` | `改造` | `已通过` | `vX.Y` | `[]` | — | `engine` | **同 #11：`Hook \`watch-feature.mjs\` to monitor the feature.`** |
| 异常 c | 任务失败（停在 `executing`、**不转移**） | `executing` | `改造` | `已通过` | `vX.Y` | — | — | — | —（无 `advance` 返回） |
| 异常 d | 归档（**`a2a_feature_cancel` —— 非 `advance`**） | `cancelled` | 保留当时值 | `已通过` | `vX.Y` | — | — | — | —（**非 advance 返回**，返回形状属 cancel 面） |

> **`action` 已并入上表最后一列**（不再单列，避免翻页对照）。

**两条实现注意（一并写进表）**：

1. **#12 的 `stage` 实测仍是 `改造`** —— 半派生未覆盖引擎自动边（`O7` 报过、已登记 §6），要到 #13 那次 `advance` 才归 `回归`。
2. **#12 / 异常 a / 异常 c 没有 `advance` 返回** ⇒ 这三处拿不到那四枚明细；若要覆盖，须让 `feature_status` 也带 `pending`/`gate`/`actor`/`action`（属待裁 ② 的"口径统一范围"）。
3. **★v10：`pending` 取值扩到含产出物**（新增 `requirement-doc` / `design-doc`）—— 因为 **Step 0 / Step 1 的工序产出物是「文件」**，只按"还差哪枚登记字段"切片会**漏掉真正的下一步**。用户 2026-10-13 指出的两处错就在这里：**入板后该做的是「触发各 project 的 `product_manager` 做需求分析（Step 0）」**（不是先去排期）；**确认单落了之后才是「与用户确认需求 + 规划版本」**。
4. **★v10 由此推出（结构性的）**：本阶段明细的推导**不能只看四字段** —— 上表 **#1 与 #2 的 `state`/`stage`/`approval`/`version` 完全相同**，只差 `decisions` 里**有没有需求确认单** ⇒ **必须把 `decisions`（产出物登记）纳入推导输入**（见待裁 ⑧）。这也正是待裁 ① 的 (a) 案（门① 凭据 = 确认单已登记）所指的同一件事。
5. **★v11→v12：那一段确实要按两维切，但切点在 `#2` 不在 `#1`**（用户 2026-10-13 两轮指出）—— 维度 = **「确认单是否已登记」×「`version` 是否非空」**；但 **`#1`（确认单未登记）不按 `version` 切**：Step 0 的下一步（触发 `product_manager`）**与 `version` 无关**；`version` 只在**到达「要与用户确认需求」时**起作用 ⇒ 切点落在 `#2` / `#3`。**宿主先按 `#1` 切（`#1`/`#1′`）是错的**，已改回三行。⇒ **推导键 = 五维**：`state` · `stage` · `approval` · `version` · **`decisions`（产出物）**（`#1` 与 `#2`/`#3` 靠 `decisions` 分；`#2` 与 `#3` 靠 `version` 分）。
6. **★v11：`pending` 保留数组形态**（0–n 枚）—— 当前各行实际只有 1 枚，但保留数组以免将来又出现"两件事同时等"。
7. **★v13 →（v22 改述）`actor` 语义 =「当前（推进后）阶段的推动方 / 执行方」** —— v13 原定「当前卡在谁那儿 / 等谁」**作废**（用户 2026-10-13 二次更正：「actor应该是 当前步骤的执行方或者推动方吧（advance后已经到下一个环节了）」）；**取值枚举与推导式不变**、逐格结果同 v13。故 **`#2` 取 `user`**（它奔门① 去，门① 的归属人 = 用户），`gate` 也随之补 **`gate1`**。**代价（写进表里）**：`#2` 的 `action` 必须把**宿主自己的前置写在最前**（`Schedule a version first, then …`），否则 agent 读到 `user` 会干等用户、不去排期（而 version 空时门① 会被引擎直接拒）。

## 关键核实结论

> 「当前行为 / 影响范围 / 技术可行性假设」须经执行单元核实，宿主不得单方断言。

**已验证（宿主实测，2026-10-13）**
1. 返回字段全集如上（多次调用样本逐字一致，无 `nextStep` 类字段）。
2. 板侧确有"下一步"文案能力：`board/src/derive.ts::deriveNextStepHint(state, stage, approval)`（v0.10.5 刚为其扩过新态专属档）—— 但它只进显示层。
3. flow 侧"下一步"的事实源 = `引擎映射.md` §2 表 + §7；规范自身承认靠 agent 读。

**待核实 → 已核实**：原四项待核实（orch 的落点/体量/机器解析/异常态取值 + flow 单源 + 技术可行性假设）**已由下述两枚只读核实回执全部闭合**（原「无技术可行性假设」的预判被 board 的 **A1** 部分推翻 —— 见下）。

---

## 执行单元核实结论（Step 0 · 2026-10-13）

> 两单元均以**产品经理职责位**只读核实（`mode="inquiry"`、零写入、未改任何文件）。**本节即门①「确认单已含相关单元的核实结论」的凭据**；回执全文由宿主收敛，编号与路径为该单元自报（`orch/` 相对路径）。

### 一、orch（`cb017206-9ec2-4de6-b378-54cc47da6b45`）

**1. 返回对象的构造点与体量（本卡落点面）**
- `create`：接口 `bridge/feature-tools.ts:1087-1103`，装配 `:1188-1201`（**已回显 `stage`/`version`/`approval`**）。
- `advance`：**四处**成功出口，不是一处 —— 登记特例 `:1707-1713` / 只补归属 `:1724-1730` / 合法流转 `:1845-1853` / 重派续跑 `handleRetryResume` `:1978-1986`；成功接口 `FeatureAdvanceSuccess :1526-1536`（extends `FeatureStateChangeSuccess :1512-1518`）。
- `approve`：`:2048-2053`；**其返回类型 `FeatureStateChangeSuccess` 与 `cancel` 共用**（`cancel` 出口 `:2087-2092`）⇒ 宽化该类型会**同时改 `cancel` 出参**（连带面，须在方案里点名）。
- MCP 层不做形状白名单（序列化 `bridge/register-tools.ts:31-42`）。

**2. 读面 / 机器解析 —— 无硬依赖**
- `feature_status` 接口 `:1257-1290`、单 Feature 返回 `:1372-1381`（已带 `projects:` 归属视图）、列表 `:1400-1408`；HTTP 读面**原样透出**（`bridge/transports/web.ts:604` 注释即「不做白名单」）⇒ 加键会经 web 面抵达板与宿主脚本。
- **全库无 `outputSchema`（grep 零命中）⇒ 加字段是 additive**。
- 无人硬依赖返回形状：orch 测试锚为 `keys.includes(...)` 容差式（`test/v090-o1-registration.test.ts:621-631`）；宿主脚本 `scripts/watch-feature-loud.mjs:129-149` 白名单取键；板侧全白名单取键；根回归锚为源码子串式。

**3. 五维输入可取性（逐维）**

| 输入 | 可取？ | 落点 |
|---|---|---|
| `state` 主链序 | ✅ | `feature/state-machine.ts:39-48` `FEATURE_MAIN_CHAIN`（8 格）+ `:66-78` TRANSITIONS |
| `stage` / `approval` / `version` | ✅ | `types.ts:223-271`；`session/store.ts:1214-1215` `FEATURE_COLUMNS`；派生表 `bridge/feature-tools.ts:1551-1563` |
| `decisions` 判《需求确认单》 | ✅ | 现成判据 = 严格子串 `CONFIRMATION_DOC_MARKER :429` + `confirmationDocRegistered :436-439`（门① 执法处 `:1633-1649`） |
| **`decisions` 判《改造文档》** | ❌ **取不到** | 全库**无** `-改造文档.md` 标记常量 ⇒ **待裁 ⑧ 只落地一半**（确认单可认、改造文档不可认）—— **新事实，Step 1 须处置** |
| 归属 | ✅ | `featureProjectListByFeature`（`session/store.ts:5460-5461` / 方法 `:4457`）—— 如明细要带归属 |

**4. 异常态 / 终态的取值风险（事实，不提案）**
- `STAGE_DERIVATION :1551-1563` 对 `completed` / `needs_input` / `failed` / `cancelled` 一律写 **`null`** ⇒ 这四格 `stage` 停**最后一次真实迁移值（陈旧）**，拿它推「本阶段该干啥」在该格不是最新事实。
- **失败静止与"正常在跑"在五维内不可分**（`bridge/scheduler.ts:967-973` `featureAtRest` / `:985-992` `isFeatureSealed`）⇒ `executing` 格的 `actor` 定不出"卡没卡" —— 与本节 **硬约束 3**（只答"该往哪走"、不答"在不在走"）**同向**，实现时须守住（**待裁 ④ 已裁「不给」**）。
- `needs_input` 只在 `executing` 挂（挂载白名单 `bridge/register-tools.ts:65`）；终态三格 `TRANSITIONS` 为 `[]`，无后继可指。

**5. 体量 / 技术可行性**
- 粗估 **120–200 行**：4 枚接口 + 7–8 处返回装配（`create :1188`、`status :1372`/`:1400`、`advance :1707`/`:1724`/`:1845`/`:1978`、`approve :2048`）+ 1 个纯推导函数（读五维 + `FEATURE_MAIN_CHAIN`）+ `register-tools.ts` 四处工具 description 文案。**协议面 2.3 不动**。
- **可证伪假设（须在 Step 1 处置）**：`decisions` 是**自报自由文本、且写入是整值替换（非 append）** —— 入参 schema `bridge/register-tools.ts:553-556` 声明 `z.string()`，落库 `session/store.ts:3484-3487`（`decisions = ?` 全量覆盖）；板侧 `board/src/feature-schedule.ts:134-172` 自行做「读—并集—回写」的善后 append。**无任何文件存在性校验** ⇒ 「`decisions` 里有确认单字样」只证明**登记事实**、不证明**文件事实**；明细若以它为判据，须明写它承载的是前者。

### 二、board（`0f296f2a-b907-4272-b9bf-c82703f0e66c`）

**1. 板侧现状**
- `deriveNextStepHint` 定义 `src/derive.ts:630`（入参 `NextStepInput :499-533`，**输出 = 单一 `string`**，非结构化）；唯一装配 `src/server.ts:1054-1069` → 渲染 `src/web/views.ts:2418-2420` → `featGuideCard`（`views.ts:844`，插 `feat-main` 首位 `:857`）。孪生判据 `deriveActionAffordance`（`src/derive.ts:202`）。
- **板不依赖 orch 返回形状**：全部白名单点取、不校验键集（`mcp-client.ts:96-142` / `feature-schedule.ts:190-202` / `bridge-client.ts:529-560`）；键集类断言只在**出网请求**侧（`test/feature-schedule.test.mjs:91` 等）。
- 板**本地事实** 7 枚（`hostFaceAssembled` / `awaitingAnswer` / `turnBusy` / `latestTurn` / `receiptPresent` / `chainMonitoring` / `chainPendingCount`）—— **orch 一个都看不到**。

**2. 四条技术可行性假设（board 自核）**
- **A1 ★关键 —— 不成立**：板是**拉模型、不缓存 `advance` 返回**（`bridge-client.ts:7` 只读三面）⇒ 引擎若只把四枚明细放在 `advance` 返回，**板侧现有读路取不到**。要消费须引擎**同时**投影进 `GET /api/features/:id`（或板另设缓存）⇒ **路径分叉，待 Step 1 裁**（板侧改动面 4 处、100–200 行）。
- **A2 利好**：引擎**加返回键不破板**（归一白名单点取、键集断言只在出网侧）；真正破锚的是**改 / 删既有取值**，不是加。
- **A3**：板**不得执行迁移意图**（`test/requirement.test.mjs:211` 负钉 + `src/requirement.ts:5`「板不写状态机迁移」）⇒ 板只能显示 / 递给宿主 —— 与「引擎给机器事实、板给人话」**同向**、不冲突。
- **A4**：引擎看不到那 7 枚板本地事实 ⇒ 引擎 `action` 与板面档位集合**重叠但不相等**；且可能指向**页面上不存在的入口**（板现纪律 `src/derive.ts:612`「只指向真实存在的入口」）。

**3. 受影响锚（board 侧）**
- 直接打在 `deriveNextStepHint`：`test/derive.test.mjs` **29 个 test 块 / 56 处调用**；`test/server-bd18.test.mjs` **14 处 `nextstep` 断言**；新态面外溢 **6 文件 / 29 处**。
- 引导行**不在 `data-live` 锚内**（5 锚 = `steps`/`graph`/`exec`/`turn-prog`/`turn`）⇒ 现形态只在整页重载 / 浮层重开时更新。

### 三、核实引出的三处 Step 1 待处置项（宿主收敛）

1. **A1 路径分叉**：③ 已裁「引擎给机器事实、板给人话」，但 board 证明**板今天拿不到**引擎那四枚 ⇒ **板要不要铺读路**（引擎同时投影进 `GET /api/features/:id` / 板加缓存 / 不动）**须在边界轮定**。
2. **`decisions` 只认一半**（改造文档无标记常量）⇒ ⑧ 的五维推导里 `design-doc` 这一档**今天不可判**；须定：补标记常量 / 该档降级 / 换判据。
3. **`stage` 在四格里陈旧 + `executing` 静止不可分** ⇒ 与硬约束 3 同向；实现时须明写这些格取值的口径（避免被读成"在跑"）。

## 原型 / 流程附件

无（无用户可见界面 / 流程变化；返回是机器可读面）。

## 待用户裁决

> **★ 2026-10-13 用户裁（「嗯」= 按建议）**：下表 **②③④⑤⑦⑧ 全部按「宿主建议」列定稿**（⑥ 早前已定）⇒ **本确认单待裁清零**。
> 与之同源的那条（门① 凭据取 (a)）**已随 `bbc7ea28` 落地**（该卡 R1 定稿 + 实现 + 真机验收 + `completed`），**不属于本卡待裁**。另：`advance(to="failed")` 旁路经 `bbc7ea28` 的 R1 明判「**`cancelled`/`failed` 天然排除**」⇒ **今天仍放行、未被处理**，是否另立**待定**。

| # | 待裁项 | 说明 | 宿主建议 |
|---|---|---|---|
| ① | ~~返回是否连"谁（驱动方）"一起给~~ **（已定）** | **定了：给** —— 就是 `actor`（**v22 语义 = "本阶段推动方 / 执行方"**，与 flow `引擎映射.md` §2 表「驱动方」列**同源**）。与 flow 表成两份的风险 **归入待裁 ③ 的单源分工** | 已落表（v13；v22 改述） |
| ② | 四枚明细的**域**（哪些工具带它）—— **v16 起由「可选」升为「必需」** | `#1`（入板，`create`）与 `#7`（门②，`approve`）是**真正挪动卡**的两处，却**没有** `advance` 返回 ⇒ 若不在这两处也带四枚明细，宿主每次都得回头捞 `feature_status`，等于把"引擎告诉你该干啥"退回"宿主自己查"。另有引擎自动那几处（`#12` / 异常 a / 异常 c）只能靠读面 | **必需**：`create` / `approve` 与 `advance` **同带**；`feature_status`（或 `trace`）也带以覆盖引擎自动那几处。仅 `a2a_call` / `a2a_feature_cancel` 不带 |
| ③ | 与板侧 `deriveNextStepHint` 的**单源** | 两处都答"下一步"就会并存两份 | 明确分工：**引擎给机器事实、板给人话**；板不得自成第二事实源 |
| ④ | **要不要连"是否卡住"一起给**（v2 新增） | 给 ⇒ 必须碰任务面（`tasks[]` / `trace`），**不再是纯派生**，且与 `a2a_feature_trace` 职责重叠 | **不给** —— 本字段严守「只答该往哪走」；"卡没卡"继续走 `trace`（见方向节硬约束 3） |
| ⑤ | **返回内容的形状与字段名** | 提案 **v15**（**扁平版**）= 回显 `state`/`stage`/`approval`/`version` + **平级四枚** `pending`/`gate`/`actor`/`action`（**已去 `next` 包装、已删 `next.state`**） | **按 v15 定稿** |
| ⑥ | ~~`action` 要不要写完整人话~~ **（已定，2026-10-13）** | 用户定：**要行动级文案、英文、由引擎直接给出**（例：`executing` 行 = `"Hook \`watch-feature.mjs\` to monitor the feature."`） | 已按此落进 v3 的逐行 `action` 草案表；`action` 移入 `next` |
| ⑦ | **`action` 的文案归属**（v5 新增） | `action` 里含 `watch-feature.mjs` 这类**宿主层工具名** ⇒ `orch` 与宿主工具耦合。(i) 引擎硬编码；(ii) 引擎给动作码 + 宿主层配文案 | **(i) 引擎硬编码**（当前单宿主、脚本名稳定）；文案表登记改造文档 §6，换宿主 / 加宿主时同轮改 |
| ⑧ | **`decisions` 要不要纳入推导输入**（v10 新增） | 要推出 Step 0 / Step 1 的**真下一步**，引擎必须看 `decisions`，且须按**文件名规范**认 `*-需求确认单.md` / `*-改造文档.md` ⇒ 引擎耦合文件命名规范。替代：宿主每次调用自报一个 `docs` 事实（但那是自报字段、同门② 的旧病） | **纳入**（并按待裁 ① 的 (a) 形态落地：门① 凭据 = 需求确认单已登记） |

## 与其它需求的顺序

- 主需求 `eb86d5e8` 停在 `testing`（不占名额）。
- 同子树内已有另一条增补轨 `bbc7ea28`（唯一准入门修复）—— 按 §7 **同子树互斥**：同一主轨子树内同时至多一条活跃轨，本卡与其**串行**排队。

## 成功标准（用户语言）

1. 调 `advance` 推进后，**返回里直接能读到"下一格是什么"**，不必去翻 flow 规范。
2. 处于异常态 / 终态时，该字段给出**不误导**的值（空 / 或明确「无下一格」）。
3. 既有调用方**不受影响**（返回是机器契约 ⇒ 加字段不删不改旧字段；关联的既有测试锚全绿）。
4. 板面「下一步」文案与引擎返回**不构成两份事实源**。

## 修订历史

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-10-13 | Step 0 初稿：问题定义（`advance` 返回不带导航 + 两处靠山都不在 agent 手上）+ 已验事实 + 三项待裁（是否给驱动方 / 字段域 / 板侧单源）+ 成功标准；**定性记录**：宿主原判「加新行为 ⇒ 不进增补」被用户裁定取代（「新增一个增补轨作为 `eb86d5e8` 的补充」）；原池卡 `91a400d2` 已 cancel。**执行单元核实待补** |
| v2 | 2026-10-13 | **方向校订（用户确认）**：需求原文的「**主链下一格**」作废（`waiting_approval` 一格压两步，主链下一格恰是唯一准入的那条边 ⇒ 误导），改为「**当前字段组合下的下一步**」；新增「**方向与可推导性**」节 = 四字段推导表（`state`+`stage`+`approval`+`version` → 该干什么 / 谁）+ **三条硬约束**（不许叫主链下一格 · `version` 维必须带出 · **只答"该往哪走"、不答"现在在不在走"**）；待裁新增 ④（要不要连"是否卡住"一起给 —— 建议不给）。 |
| v3 | 2026-10-13 | **返回内容定形（提案 v1 · 待用户确认）**：新增「返回内容（提案 v1）」节 —— `next = { state, pending, gate, actor }` 四字段 + **14 行逐行覆盖表** + 设计三原则（只给机械派生事实 / 人话归 flow / **零新枚举** —— 四字段全取自既有词汇：`state` 值域 · 登记字段名 · 门名 · 驱动方三值）；待裁新增 ⑤（提案形状与字段名）。 |
| v4 | 2026-10-13 | **提案升 v2（用户两问）**：① **补登记字段回显** —— 原返回只有 `state`，而 `stage` 是会被派生的登记字段、写完读不回 ⇒ 返回带 `state`/`stage`/`approval`/`version` **完整字段组合**；② **`note` 不兼任指引**（入参写出参读、同名不同义），改**另给 `action`** = 由 `next` 机械拼装的**字段级渲染**（非人话、非事实源），完整人话单源 = 板侧 `deriveNextStepHint`。待裁新增 ⑥（`action` 要不要写完整人话 —— 建议不要）。 |
| v5 | 2026-10-13 | **提案升 v3（用户再两点）**：① **`action` 移入 `next`**（不再做兄弟键）；② **`action` 改为行动级英文文案、由引擎直接给出**（例：`executing` 行 = `"Hook \`watch-feature.mjs\` to monitor the feature."`）⇒ 新增 **14 行 `action` 逐行草案表**。随之：⑥**已定**（要人话、要英文、引擎给）；新增 ⑦ **文案归属**（引擎硬编码 vs 动作码 + 宿主配文案 —— 宿主建议前者，并把文案表登记改造文档 §6）。 |
| v6 | 2026-10-13 | **字段改名（用户）**：`hint` → **`action`** —— 字段名与内容对齐（它本身就是一条动作指令）；JSON 形状、逐行文案表、待裁 ⑦ 全文同轮跟随。 |
| v7 | 2026-10-13 | **`actor` 值改英文（用户）**：`宿主 / 用户 / 引擎` → **`host` / `user` / `engine`**，与 `state`/`pending`/`gate` 对齐；并写明与 `stage` 的分野 —— `stage` 是**回显引擎自存的值（必须逐字、不翻译）**，`actor` 是**引擎自派生的枚举（取英文）**。 |
| v8 | 2026-10-13 | **新增「逐步骤返回样例（全字段）」节**：按推进流程逐步骤（#1–#16 + 异常 a–d）给出**完整返回载荷** —— 回显四字段 + `next` 五枚 + `action` 逐行；并写明**引擎自动转移（#12 `executing→integrating` / 异常 a / 异常 c）没有 `advance` 返回**（这正是 `executing` 的 `action` 是"挂监控"的原因），以及 #12 的 `stage` 实测仍为 `改造`（`O7` 缺口，已登记主需求 §6）。 |
| v9 | 2026-10-13 | **逐步骤表合并成一张（用户：不要翻页对照）**：把「回显 / `next`」表与「`action`」表**并成一张**（11 列：`#`·步骤·`state`·`stage`·`approval`·`version`·`next.state`·`pending`·`gate`·`actor`·`action`），并补出 #12 的**实测 `stage` = `改造`** 与异常 a/c/d 三行。 |
| v10 | 2026-10-13 | **action 按职责位改正（用户两处纠错）**：① 入板后 = **`Dispatch each project's product_manager for the requirements analysis (Step 0)`**（原写"先去排期"是错的）；② 确认单落文件后 = **`Get the user to confirm the problem, and schedule a version`**。连带：**`pending` 取值扩到含产出物**（新增 `requirement-doc` / `design-doc`）—— 因为 Step 0/1 的产出物是**文件**；#4 的 action 亦补 `dev_manager`、#7 补 `project_manager`、#8 补 `dev_manager`。**结构性结论**：`next` 推导**必须纳入 `decisions` 维**（#1 与 #2 四字段完全相同、只差确认单是否登记）⇒ 新增待裁 ⑧。 |
| v11 | 2026-10-13 | **补 `#1′` 行 · 改按两维切（用户指出「`create` 可带 `version`」）**：`waiting_approval · 需求分析 · 未发起` 段按「**确认单已登记? × `version` 非空?**」交叉成**四行** —— `#1` / **`#1′`（建卡即带 `version`）** / `#2` / `#3`。**漏 `#1′` 就会把带 `version` 的卡错推成"该过门①"、跳过整个 Step 0**。连带：**推导键定为五维**（`state`·`stage`·`approval`·`version`·**`decisions`**）；**`pending` 改数组**（0–n 枚）；「返回内容」节的旧覆盖表加 **superseded** 标记（以逐步骤表为准）。 |
| v12 | 2026-10-13 | **切点改正（用户再纠）**：Step 0 段**不按 `version` 切 `#1`** —— `#1` 的下一步（触发 `product_manager` 做需求分析）**与 `version` 无关**；切点落在 **`#2`**（到达「要与用户确认需求」时才看 `version`）。**删 `#1′`，回三行**（`#1` / `#2`〔`version` 空〕/ `#3`〔`version` 非空〕）。**五维键不变**：`#1` vs `#2`/`#3` 靠 `decisions` 分，`#2` vs `#3` 靠 `version` 分。 |
| v13 | 2026-10-13 | **`#2` 改 `actor=user` + 补 `gate1`（用户）**：`actor` 语义定死 = **「当前卡在谁那儿 / 等谁」**（不是"谁该动"）⇒ `#2` 奔门① ⇒ 归 **`user`**，`gate` 补 **`gate1`**。连带把 `#2` 的 `action` 调序为 **`Schedule a version first, then get the user to confirm the problem (gate 1).`**（宿主前置写最前，防 agent 干等用户）。`#3` 原就已是 `user`（v10 那版无误，用户读的是更早一版）。 |
| v15 | 2026-10-13 | **★语义纠正 + 扁平化（用户）**：`advance` 一执行完卡**已经在新阶段上** ⇒ **不存在"下一步"**；返回应表达「**推进后本阶段的状态 + 本阶段要做什么**」。故 **去掉 `next` 包装**（`pending`/`gate`/`actor`/`action` 与 `state`/`stage`/`approval`/`version` 平级）；**删 `next.state`**（它必然 = 顶层 `state`；终态用 `actor=null` 表达）。连带：字段说明表、逐步骤表（10 列）、三处 prose 里的 `next` 措辞全部同轮改齐；顺带修掉逐步骤表 #9–#16/异常 的**列数错位**（v8 遗留）与 #9/#10 的 `pending` 笔误。 |
| v16 | 2026-10-13 | **工具面澄清（用户指出异常行混入）**：本表**混了工具面** —— 真正是 `advance` 返回的只有 `#2`–`#6` · `#8` · `#11` · `#13`–`#16` · `异常 b`（**`异常 b` 确实是 advance**：`advance(to="executing", answer=…)`）。`异常 d` 走 **`a2a_feature_cancel`**（另一工具）⇒ 该行明细改标「非 advance 返回」；`异常 c`（失败静止）与 `异常 a`（引擎自动）动向只能从 `feature.failure_report` / `status` / `trace` 拿。**最大连带**：`#1`（`create`）与 `#7`（`approve`）是**真正挪动卡**的两处却无 advance 返回 ⇒ **待裁 ② 由「可选」升为「必需」**（`create`/`approve` 必须同带四枚明细，`feature_status` 也带以覆盖引擎自动处）。 |
| v17 | 2026-10-13 | **异常 a / b 的 `action` 归位（用户指出）**：原把「**怎么走到这一步**」当成了「**这一步要干什么**」⇒ `异常 b` 的 `action` 改为**同 #11**（`Hook \`watch-feature.mjs\` to monitor the feature.` —— 推进后本阶段同为 `executing`）；「`Answer the clarification: …`」这句**归回 `异常 a`（`needs_input` 那一格）**，并标「动向只能从读面拿（无 `advance` 返回）」。**全表其余行动作已复核**：均为「该状态下该做什么」，无误。 |
| v18 | 2026-10-13 | **待裁表清理（用户问「待裁还有啥」）**：① 标**已定**（给 `actor`；两份事实源的风险归入 ③）；⑤ 由 stale 的「提案 v3 / `next = {…}`」**更新为 v15 扁平版**（去 `next` 包装、删 `next.state`）。现存待裁 = **②③④⑤⑦⑧**（本卡）+ **①（门① 凭据档）与 `advance(to="failed")` 连带**（`bbc7ea28`）。 |
| v19 | 2026-10-13 | **待裁清零（用户「嗯」= 按建议）**：**②③④⑤⑦⑧ 全部按宿主建议定稿** —— ② `create`/`approve`/`feature_status` 与 `advance` 同带四枚明细 · ③ 引擎给机器事实 / 板给人话的单源分工 · ④ 不连"是否卡住"（走 `trace`）· ⑤ 按 **v15 扁平版**定稿 · ⑦ `action` 由引擎**硬编码**英文文案（文案表登记改造文档 §6）· ⑧ `decisions` **纳入**推导输入。**并更正 v18 的清单**：`bbc7ea28` 那条已随该卡 `completed` 落地（R1 定稿 + 实现 + 真机验收），**不属本卡**；`advance(to="failed")` 旁路经其 R1 明判「天然排除」⇒ **仍放行、未被处理**，是否另立待定。 |
| v20 | 2026-10-13 | **用户门① 确认（原话「好的 需求没问题」）** —— 问题定义已获确认（记此留痕）。**但门① 的引擎动作（`stage`：需求分析 → 改造方案）暂缓执行**：按 §2 Step 0 判据，「确认单**已含相关单元的核实结论**」是过门前置 ⇒ 等本轮 **Step 0 核实**（orch `cb017206-9ec2-4de6-b378-54cc47da6b45` + board `0f296f2a-b907-4272-b9bf-c82703f0e66c`，均**产品经理职责位**、只读）回来、回填本确认单后再迁 `stage`（**不需要用户再确认一次**）。 |
| v14 | 2026-10-13 | **新增「返回字段逐一说明」表（用户要求）**：现有 8 键（`ok`·`featureId`·`from`·`state`·`note`·`rearmed`·`unfrozen`·`code`+`error`）+ 提案新增 6 键（`stage`·`approval`·`version`·`next.state`·`next.pending`·`next.gate`·`next.actor`·`next.action`）逐条给「出现时机 / 取值 / 含义」；并写死两条分野（`note` 入参 vs `next.action` 出参 · 失败时不出 `from`/`state`/`next`）＋一项待核实（`ok:false` 的完整键集，宿主未 inline 采样过）。 |
| v21 | 2026-10-13 | **Step 0 核实回填（门① 前置闭合）**：新增「执行单元核实结论」节 —— orch `cb017206…` + board `0f296f2a…` 两枚**产品经理职责位只读**回执收敛入册（头行「Step 0 核实」由「进行中」改「已完成」；原四项「待核实」全闭合）。**三条新事实进档**：① `advance` 成功出口**四处**、`approve` 与 `cancel` **共用** `FeatureStateChangeSuccess`（宽化连带改 `cancel` 出参）② **`decisions` 判《改造文档》取不到**（无 `-改造文档.md` 标记常量）⇒ 待裁 ⑧ 只落地一半，`design-doc` 档今天不可判 ③ **board A1 不成立** —— 板不缓存 `advance` 返回 ⇒ 引擎若只放在返回里，**板侧现有读路取不到**（路径分叉待边界轮裁）；另 A2 利好（加键不破板）、A3/A4（板不得执行迁移意图 / 引擎看不到 7 枚板本地事实）。**复核**：`stage` 在 `completed`/`needs_input`/`failed`/`cancelled` 四格派生写 `null` ⇒ 陈旧；`executing` 静止与在跑**五维不可分**（与硬约束 3 同向）。体量复核 **120–200 行**、协议 2.3 不动。**门① 引擎动作（`stage` → 改造方案）随之执行。** |
| v22 | 2026-10-13 | **`actor` 语义更正（用户 2026-10-13）**：「当前卡在谁那儿 / 等谁」→「**当前（推进后）阶段的推动方 / 执行方**」。**用户原话**：「actor应该是 当前步骤的执行方或者推动方吧（advance后已经到下一个环节了）」。**取值枚举与推导式不变**、逐格结果同 v13；实质收益 = **`executing` 静止格不再自相矛盾**（引擎是该格推动方；"卡没卡"仍走 `tasks[]` / `trace`，与硬约束 3 一致）。**连带改四处 live 文本**（「返回字段逐一说明」表 `actor` 行 / 「`actor` 三值」注 / 逐步骤表注 7 / 待裁 ① 行），**v13 行保留为历史不动**。此更正**同时解掉 Step 1 §E 的待裁 ⑤**（board R2 提的"责任方"加固被实质采纳 ⇒ 该条出待裁）；门② 另一枚 **④**（`executing` 的 `action` 字面是否保留宿主脚本名）**用户本轮未裁、仍在门②**。**受理方式**：按 §2 Step 1「边界变动须重新广播」，已据此**重广播 R3** 至三单元（同 `contextId`），请其确认本更正不产生实质连带（宿主初判 = 只改 JSDoc / README / 文案限定语，取值表与 10 组锚全不变）。 |
