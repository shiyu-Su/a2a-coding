# a2a-coding — ZCode 工作区指令

> 本文件对应 opencode 宿主根 `opencode.json` 的 `instructions` 数组（canonical 样例：`opencode.json.example`，接入说明见 `flow/hosts/opencode.md`）。ZCode 没有 `instructions` 数组机制，规范引入走本文件；宿主接入配置（MCP a2a + 守卫 hook）在 `.zcode/config.json`。

## 需求流程（Requirement Flow）

本项目的需求流程规范由 `flow/` 包提供（单一事实源），ZCode 宿主经本文件加载：

- @flow/spec/需求流程.md —— Step 0–3 骨架 / 每步判据 / 产出物 / planlog 与发版纪律
- @flow/spec/引擎映射.md —— 步骤 ↔ Feature 状态 ↔ 驱动方、两道确认门、工具面

若上面的 `@` 引用未被宿主展开为文件内容，进入需求工作前先 Read 这两份文件（守卫 hook 对这两个路径放行只读）。

## 编排等待纪律（派发后必须用脚本阻塞等待）

- **派发 Feature 后**：`node scripts/watch-feature.mjs <featureId>`（`a2a_feature_approve` 之后即调用）；按退出码分流 `0/10/11/12/13/20/1`。
- **派发常规 `a2a_call` 任务后**（v0.8.2 起）：`node scripts/watch-task.mjs <taskId...>` —— 只读等待到目标 id 全部达成退出判据（`completed` / `failed` / `blocked` / `input-required`）或窗口耗尽；**入参必须是 `a2a_call` 返回的 taskId（本地 id）**（传 Feature 节点的 `remoteTaskId` 会 404）。
  - 退出码**三档**：`0` **等到了**（**`failed` / `blocked` 也退 0 —— 0 ≠ 成功**，成败看 stdout 的状态行）· `20` 窗口耗尽 · `1` 脚本错误。
  - **脚本只打印状态**：需要详情（失败原因 / 待裁决问题 / 结果全文）时**自行调用 MCP 工具 `a2a_task_status` 一次**获取；**禁止**用 `a2a_task_status` / `a2a_tasks` 手工轮询等待。
  - 默认窗口 `--interval 10000 × --max 180`（30 min）可能超过单次工具调用上限：未结束时**再次调用同一条命令**即可（只读、可重复调用）。

## 失败处置纪律（v0.8.8）

v0.8.8 起任务失败在账面携带 `failureKind`（六类闭集，事实源 = `PROTOCOL.md`）。宿主处置失败（`watch-feature` 退码 `10` / `watch-task` 状态行 `failed` / `task.settled` 事件）时按类别分流，不得笼统按「失败 ⇒ 重派」处理。

**1. 六类含义与处置（一句话版）**

| 类别 | 含义（一句话） | 处置 |
|---|---|---|
| `agent` | 后端 agent 本身起不来/不认：spawn 失败、进程退出、后端 `rpc`/`protocol` 语义拒绝 | 不自动重试；先查项目配置 / 后端状态，再由宿主重派 |
| `transport` | launcher↔编排桥的 HTTP 传输层失败（send / poll 阶段） | machine 已有有界重发（v0.8.7，仅零输出时重发）；落到 `failed` 后宿主重派 |
| `runner` | 载体侧事实：launcher deadline 抛错、`ensure` 抛错、启动补结算孤儿 | 不自动重试；查 launcher 状态（含其 `/health degraded`）后由宿主重派 |
| `model_queue` | 疑似模型侧排队 / 配额限流 —— **启发式标注**，本版 machine 恒不产出该值、由 orch 侧启发式推断 | **不做任何自动动作**；提示方向 = 等窗 / 换模型 / 换后端 |
| `timeout` | 满窗。子键 `timeoutScope` 分家两条路径：`acp-prompt` = 桥 prompt 满窗（可能有产出）；`runner-deadline` = launcher 派发窗耗尽（无产出证据） | **唯一可能自动重试的类别**，见第 2 条 |
| `business` | 后端正常收敛但 outcome 命中失败块 = 任务级业务失败（旧 `"task"` 的直系继承） | 不重试；重派须宿主决策（通常需改做法/改方案） |

> 混跑期注意：未升级的 2.2 机上报缺键/旧值（`infra`/`task`）会被 orch 兜底落 `business`（安全类、不拒收），warn 带原值 `failure_kind_fallback=<原值>` 留痕 —— 过渡期须区分「真 business」与「兜底 business」；两侧同升后消失。

**2. 可自动重试的场景闭集 = 只有一条**

`timeout` ∧ `timeoutScope="acp-prompt"` ∧ **有实质产出** ⇒ machine 自动**续跑至多一次**（stop→重拉→同 `contextId` 续跑；只消费剩余预算、**不延长 deadline**，只保证「不白烧」、不保证「续得完」）。
- **结构性前提**：该机制**只对显式配了 `agentConfig.sessionTimeoutMs` 的项目生效** —— 未配窗项目缺省 660s 派发窗只剩 60s 余量、低于续跑剩余预算闸，**结构性不触发**（属设计限制，不是实现 bug）。
- `timeout` × `timeoutScope="runner-deadline"` **不可重试**（策略表显式登记为「同 Timeout 类但不可自动重试」）。
- 其余全部类别、以及 `acp-prompt` **无实质产出**（疑似排队，与续跑互斥）⇒ **一律不自动重试**，保持 `failed` 等宿主裁决。
- 数值阈值（产出门槛 / 剩余预算 / 轮数上限）归 machine 常量，本文档不复述，避免两侧漂移。

**3. 分工（谁执行、怎么记账）**

- 自动重试（续跑）的**执行全在 machine（launcher）**；**orch 不新增自动重派路径、不新增端点**（避免「两台重试器」）。
- `retry_count` **只记宿主重派**（`a2a_feature_advance(retryTaskIds)` 口径）；**续跑不进** —— 续跑经 **`task.continued` 事件**（`continueAttempts` / `continueTrigger`）留痕。读账时二者正交、不可混为一谈。

**4. `model_queue` 只标注、不动作**

`model_queue` 本版是 orch 侧**启发式标注**（machine 恒不产出）；宿主见到该标签**不做任何自动动作**，其用途仅为解释「满窗零产出更像排队而非任务太大」。

**5. 降级可见的查法（两个面互不相通）**

orch `/health degraded[]`（编排桥进程内降级登记器）与 machine `/health degraded`（launcher 本机 loopback 运维面）是**两个互不相通的面** —— machine 的降级到不了 orch（push 通道 v0.8.3 已退役、注册载荷不扩字段）。排查「系统在降级运行吗」须**两处分别查**，各自只反映本进程内事实。

## 单元路径守卫（无条件生效）

PreToolUse 守卫（`.zcode/hooks/guard-unit-paths.cjs`，对所有会话生效，不区分角色）拒绝 Read / Edit / Write / Grep：`orch/**` 与 `machine/**`（单元代码：分析经 MCP 工具由项目 agent 返回、改动经 `a2a_call` 派发，宿主不直接读写）以及 `flow/**`（流程包资产；两份规范文件对 Read/Grep 放行只读）。Bash 通道走启发式：命令串中出现 orch / machine / flow 独立路径段即拦，另盖通配混淆、Windows 8.3 短名、仓库级递归搜索（grep -r / rg）；`orch/scripts/` 运维脚本白名单（如 bridgectl.mjs）；两份规范文件请用 Read/Grep 工具而非 Bash。日常开发需要直读直改单元代码时，在 `.zcode/config.json` 将 `hooks.enabled` 置 false 临时停用本守卫，用完恢复（守卫自测：`node .zcode/hooks/guard-unit-paths.cjs --selftest`）。

a2a MCP 已在 `.zcode/config.json` 注册（远程端点 `http://127.0.0.1:8787/mcp`；桥配置了项目组（v0.8.6 一桥多组）时 url 把组名写在路径首段 = `http://127.0.0.1:8787/<组名>/mcp`，身份由连接 url 决定、未配组仍写 `/mcp`，见 `orch/README.md`「连接身份与可见性」），会话前需桥常驻在跑，见 `orch/scripts/bridgectl.mjs`。残余缺口与设计 rationale 见 `CLAUDE.md`「架构约束」。
