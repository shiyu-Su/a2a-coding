/**
 * MCP 工具注册与 server 工厂（v0.4.1 §2.2：`registerTools(server, core)` + `createServer(core)`）。
 *
 * 为什么单独成模块：stateless Streamable HTTP 惯例是**每请求新建 server + transport**，
 * 故 server 不能再是 `bridge/index.ts` 里的模块作用域单例。本模块**只做「注册 + 建 server」**：
 * 不持有任何领域状态、不 import core 的运行时实现（`BridgeCore` 仅**类型**引用），
 * 因此 HTTP 接入面可安全复用，且 import 本模块无副作用
 * （唯一外部读取是 `../version.ts` 读 `package.json` 的版本，纯读、无副作用）。
 *
 * 分层边界（§2.2）：transports 层只做「参数 → 调 core → 结果格式化」，
 * **零领域逻辑**（不碰 SQL / 状态机 / scheduler）。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BRIDGE_VERSION } from "../version.js";
import type { BridgeCore } from "./index.js";
import type { FeatureState } from "../types.js";
import { CONFIG_WRITE_GROUP_OPS } from "./config-write.js";

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

function textResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

function internalError(err: unknown): CallToolResult {
  return errorResult({ ok: false, code: "internal_error", error: toMessage(err) });
}

/** `MachinesView | Failure` 判别（`MachinesView` 无 `ok` 字段，故不能直接读 `.ok`） */
function isFailure(v: unknown): v is { ok: false } {
  return typeof v === "object" && v !== null && "ok" in v && (v as { ok?: unknown }).ok === false;
}

/**
 * Feature 挂载态（**常量集合驱动**）：仅这些态的 Feature 可挂 `a2a_call(mode="execute")` 的 DAG 节点。
 * 登记 ≠ 派发（调度器 `tick` 只看 `executing`，见 `bridge/scheduler.ts`）。
 * 变更本数组即自动更新工具描述 / `to` 描述 / 挂载门错误文案（均经 `join` 取用）。
 * `analyzing`（分析扇出）已随"引擎只做需求实现"的收敛**有意撤销**（REQ-v0.4.1-2026-09-16-01；
 * 枚举本身的收紧在 N2b）。
 * （实际挂载门在 `bridge/index.ts` 的 `registerFeatureNode`，N1c 起复用本常量。）
 */
export const MOUNTABLE_FEATURE_STATES: readonly FeatureState[] = ["executing", "waiting_approval"];

/**
 * `a2a_call` 的执行意图（**必填，无缺省** —— REQ-v0.4.1-2026-09-16-01 §2.5）：
 * - `inquiry` = 只读询问 / 核实（Step 0/1；**不得带 `featureId`**，立即派发）；
 * - `execute` = 执行型派发（**必带 `featureId`**，登记 Feature DAG 节点，由调度器派发）。
 *
 * 选"必填"而非任一缺省：缺省 `inquiry` 会让"忘带 mode 的执行"**沉默漏过**；缺省 `execute` 会
 * **误伤流程自身**（Step 0/1 的只读核实此刻无 Feature）。必填 = 无漏无伤 + 工具签名自描述。
 */
export const A2A_CALL_MODES = ["inquiry", "execute"] as const;

/** `a2a_call` 的 `mode` 取值（由 {@link A2A_CALL_MODES} 派生，单一事实源） */
export type A2aCallMode = (typeof A2A_CALL_MODES)[number];

/**
 * `a2a_call` 入参形状（**导出以便单测不经 MCP 层直接断言**：`mode` 必填、枚举收窄、未知键被 strip）。
 * SDK 以 `z.object(shape)` 解析（zod 默认 strip）⇒ 未知键被丢弃而非报错。
 */
export const a2aCallSchema = {
  project: z.string().min(1).describe("目标项目 ID（静态分布配置中的 projectId）"),
  message: z.string().min(1).describe("发给执行 Agent 的任务内容"),
  mode: z
    .enum(A2A_CALL_MODES)
    .describe(
      '**必填**：`"execute"` = 执行型派发（必带 featureId，登记 Feature DAG 节点）；`"inquiry"` = 只读询问 / 核实（不得带 featureId，立即派发）',
    ),
  contextId: z
    .string()
    .optional()
    .describe("会话上下文 ID；续接同一上下文时传入，省略则自动新建并在返回中给出"),
  wait: z
    .boolean()
    .optional()
    .describe(
      "true/省略=半异步（同步等待至多 SYNC_BUDGET_MS 再返回）；false=全异步，立即返回 working + taskId + contextId，由后台看护在终态时落库",
    ),
  featureId: z
    .string()
    .optional()
    .describe(
      `挂载到 Feature（**仅 mode="execute" 可用，且必填**）：任务作为 DAG 节点登记（返回本地 taskId），由调度器在依赖满足后自动派发；可挂载态 = ${MOUNTABLE_FEATURE_STATES.join(" / ")}`,
    ),
  dependencies: z
    .array(z.string())
    .optional()
    .describe('前置任务本地 taskId 数组（仅 mode="execute" 生效；前一任务终态后才派发下一个）'),
  inputs: z
    .array(
      z.object({
        producerTaskId: z.string().optional().describe("上游节点本地 taskId"),
        name: z.string().optional().describe("产物名（配 producerTaskId 定位）"),
        artifactId: z.string().optional().describe("产物主键（优先，支持后缀匹配）"),
      }),
    )
    .optional()
    .describe(
      '本节点引用的上游产物（仅 mode="execute" 生效）：{producerTaskId, name} 或 {artifactId}；派发时解析并注入完成的上游产物内容/引用',
    ),
  readOnly: z
    .boolean()
    .optional()
    .describe(
      'true = 声明本节点为**只读**（落 `tasks.lane=read`，machine 按只读档放行）；缺省 / false = 按写档（保守）',
    ),
};

/**
 * `a2a_config_write_group` 入参形状（导出以便单测直接断言 schema：op 闭集收窄、
 * members 项 `{machineId, projectId}` 必填非空）。成员集对 add/update/member.* 必带
 * ——「哪_op_需要_成员」的按-op 校验在 `config-write.ts`（闭集错误码 `..._dry_run_rejected`），
 * schema 层不做 union 收窄以保持错误面单一。
 */
export const configWriteGroupSchema = {
  op: z
    .enum(CONFIG_WRITE_GROUP_OPS)
    .describe(
      "**必填**，单组操作闭集：group.add / group.update（members 整集替换）/ group.remove / group.member.add / group.member.remove",
    ),
  groupName: z.string().min(1).describe("目标组名（group.add = 新组名，字符集 [A-Za-z0-9_-]+）"),
  members: z
    .array(
      z.object({
        machineId: z.string().min(1).describe("成员机器 id（必须 ∈ config.machines[]）"),
        projectId: z.string().min(1).describe("成员项目 id"),
      }),
    )
    .optional()
    .describe(
      "成员集：group.add / group.update（整集替换）/ group.member.add / group.member.remove 必带非空；group.remove 不消费",
    ),
};

/** 准入判定结果：通过 → `{ ok: true }`；拒绝 → 结构化错误（桥转 `errorResult`） */
export type CallAdmission = { ok: true } | { ok: false; code: string; error: string };

/**
 * `a2a_call` **对偶校验**（纯函数、无副作用、可单测）：
 * - `mode="execute"` ⇒ **必带 `featureId`**（执行必走 Feature DAG；码 `feature_required_for_execute`）；
 * - `mode="inquiry"` ⇒ **不得带 `featureId`**（禁止用"询问"往 DAG 塞执行节点；码
 *   `feature_not_allowed_for_inquiry`）。
 *
 * `mode` 的"必填 + 枚举收窄"由 {@link a2aCallSchema} 在 schema 层强制（缺参 / 非法值在 MCP 层即被拒，
 * 见 `test/register-tools.test.ts`）。
 */
export function validateCallMode(args: {
  mode: A2aCallMode;
  featureId?: string | undefined;
}): CallAdmission {
  const hasFeatureId = args.featureId !== undefined && args.featureId.length > 0;
  if (args.mode === "execute" && !hasFeatureId) {
    return {
      ok: false,
      code: "feature_required_for_execute",
      error:
        'mode="execute" 必须携带 featureId（执行必走 Feature DAG 登记）；' +
        'Step 0/1 的只读核实 / 调研请改用 mode="inquiry"。',
    };
  }
  if (args.mode === "inquiry" && hasFeatureId) {
    return {
      ok: false,
      code: "feature_not_allowed_for_inquiry",
      error:
        'mode="inquiry" 不得携带 featureId（询问不得往 Feature DAG 登记执行节点）；' +
        '确需执行请改用 mode="execute"。',
    };
  }
  return { ok: true };
}

/**
 * 把全部工具（泛型 7 + Feature 工具组 6 + 配置面 1〔v0.9.4 O1 `a2a_config_write_group`〕，
 * 共 14）注册进给定 server。
 *
 * **既有工具名 / 描述 / 入参 schema 与原实现逐字一致**；静态注册、不发 `tools/list_changed`（零重连）。
 * 新增的 `a2a_feature_trace` 是**只读**出口（v0.8.10 O-N3）：复用 `feature-tools.ts` 的
 * `handleFeatureTrace`，与工作台端点同一实现 —— **工作台不得成为第二编排入口**，故排队可见面
 * 必须挂进 MCP 面（也**不新增第 8 个泛型工具**：它是 Feature 级查询，归属 Feature 工具组）。
 */
export function registerTools(server: McpServer, core: BridgeCore): void {
  server.registerTool(
    "a2a_projects",
    {
      description:
        "聚合列出所有已配置机器及其本机项目（含运行态与 A2A 端点）。机器不可达时该项目列表为空并带 error 字段。" +
        "**列出项目组成员**：未配置 `projectGroup`（全量接纳）时列出全部；配置后只列成员机器及其成员项目（无成员的机器整条消失）。",
    },
    async () => {
      try {
        const result = await core.projects();
        return isFailure(result) ? errorResult(result) : textResult(result);
      } catch (err) {
        return internalError(err);
      }
    },
  );

  server.registerTool(
    "a2a_tasks",
    {
      description:
        "按项目列出本地任务记录（默认按 updatedAt 倒序、默认 20 条）。用于句柄丢失后找回任务；prompt 为落库片段。",
      inputSchema: {
        project: z.string().min(1).describe("目标项目 ID"),
        state: z
          .enum(["working", "completed", "failed", "input-required", "blocked"])
          .optional()
          .describe("按任务态过滤；省略返回全部"),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("返回条数上限，默认 20，最大 100"),
      },
    },
    async (args) => {
      try {
        const outcome = await core.tasks(args.project, args.state, args.limit);
        return "ok" in outcome && outcome.ok === false ? errorResult(outcome) : textResult(outcome);
      } catch (err) {
        return internalError(err);
      }
    },
  );

  server.registerTool(
    "a2a_call",
    {
      description:
        "向目标项目派发一轮任务：解析项目→机器，**任务入队**（Runner 反向注册后经 `/runner/connect` 领取并在目标机本地执行），返回文本结果 + artifacts。传入相同 contextId 可续接上下文；返回 contextId 便于继续追问。wait=false 时立即返回句柄（全异步，不进入同步等待）。" +
        `**mode 必填（无缺省）**：mode="execute" = 执行型派发，**必带 featureId**，任务作为 Feature DAG 节点登记（不立即派发），由调度器按 dependencies 串行自动派发（可挂载态 = ${MOUNTABLE_FEATURE_STATES.join(" / ")}）；mode="inquiry" = 只读询问 / 核实（Step 0/1 用），**不得带 featureId**，经队列立即下发。` +
        "**即时性说明**：任务入队后桥经 `/runner/connect` 的 wake 信号**尽力立即下发**；目标机 Runner 未连接时，照常入队（**不拒绝**），最长等其下一轮轮询周期（约 `runner.holdMs`，默认 25s）被领取。" +
        "**只读声明**：`readOnly=true` 标记节点为只读档（machine 侧只读闸内放行、不占写忙集）；缺省 / false = 按写档（保守）。inquiry 恒为只读档，无需声明。" +
        "**仅项目组成员可派发**：非成员 ⇒ 返回 `project_not_a_member`（零出站请求即失败）。",
      inputSchema: a2aCallSchema,
    },
    async (args) => {
      try {
        const admission = validateCallMode(args);
        if (!admission.ok) return errorResult(admission);
        if (args.mode === "execute") {
          const featureId = args.featureId;
          if (featureId === undefined || featureId.length === 0) {
            // 不可达：`validateCallMode` 已拦下该组合；此处仅作类型收窄（不用非空断言）
            return errorResult({
              ok: false,
              code: "feature_required_for_execute",
              error: 'mode="execute" 必须携带 featureId',
            });
          }
          const outcome = core.registerFeatureNode(
            args.project,
            args.message,
            args.contextId,
            featureId,
            args.dependencies ?? [],
            args.inputs,
            args.readOnly,
          );
          return outcome.ok ? textResult(outcome) : errorResult(outcome);
        }
        const outcome = await core.call(
          args.project,
          args.message,
          args.contextId,
          args.wait ?? true,
        );
        return outcome.ok ? textResult(outcome) : errorResult(outcome);
      } catch (err) {
        return internalError(err);
      }
    },
  );

  server.registerTool(
    "a2a_task_status",
    {
      description: "查询任务态（A2A tasks/get），并回写本地任务存储；返回状态、文本与 artifacts。",
      inputSchema: {
        taskId: z.string().min(1).describe("a2a_call 返回的 taskId"),
      },
    },
    async (args) => {
      try {
        const outcome = await core.taskStatus(args.taskId);
        return outcome.ok ? textResult(outcome) : errorResult(outcome);
      } catch (err) {
        return internalError(err);
      }
    },
  );

  server.registerTool(
    "a2a_cancel",
    {
      description: "取消任务（A2A tasks/cancel），并回写本地任务存储；返回取消后的任务态。",
      inputSchema: {
        taskId: z.string().min(1).describe("a2a_call 返回的 taskId"),
      },
    },
    async (args) => {
      try {
        const outcome = await core.cancel(args.taskId);
        return outcome.ok ? textResult(outcome) : errorResult(outcome);
      } catch (err) {
        return internalError(err);
      }
    },
  );

  server.registerTool(
    "a2a_events",
    {
      description:
        "读取事件收件箱增量（任务结算/阻塞、Feature 流转）。省略 since 则自进程读游标起；无变化时廉价空返回。" +
        "**按连接身份过滤**（v0.8.6 §2.4）：已配组连接只见本组可见事件（孤儿机器级事件全体可见）。",
      inputSchema: {
        since: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("游标：仅返回 eventId 大于它的新事件；省略则用进程读游标"),
      },
    },
    async (args) => {
      try {
        const outcome = core.events(args.since);
        return outcome.ok === false ? errorResult(outcome) : textResult(outcome);
      } catch (err) {
        return internalError(err);
      }
    },
  );

  server.registerTool(
    "a2a_wait",
    {
      description:
        "长轮询等待新事件（推送优先唤醒 + 定时对账），最多 timeoutMs（内部上限低于同步预算）；超时无事件则 timedOut=true。" +
        "**按连接身份过滤**（v0.8.6 §1.3 R-2）：游标与「有新事件」判定都只算本组可见事件 ⇒ 他组事件不会让本组空转或误唤醒。",
      inputSchema: {
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("最长等待毫秒；省略用内部上限（cap < SYNC_BUDGET_MS）"),
      },
    },
    async (args) => {
      try {
        const outcome = await core.wait(args.timeoutMs);
        return outcome.ok === false ? errorResult(outcome) : textResult(outcome);
      } catch (err) {
        return internalError(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Feature 工具组（静态注册，零重连）
  // -------------------------------------------------------------------------

  server.registerTool(
    "a2a_feature_create",
    {
      description:
        "新建 Feature（一条需求，**初始态 waiting_approval** = 主链起点 / 审批门停靠点）。返回 featureId 供后续 advance/approve/cancel/status 引用；方案确认后请用 a2a_feature_approve 放行（唯一准入）。",
      inputSchema: {
        title: z.string().min(1).describe("Feature 标题（需求的简短摘要）"),
        requirement: z.string().optional().describe("需求原文（可选）"),
        contextId: z
          .string()
          .optional()
          .describe("Feature 级会话上下文（落 features.context_id，跨任务 / 跨 worker 启停复用）"),
        // v0.9.0 B1″ 登记字段：**schema 侧不收口**（`z.string()` 而非 `.enum()`），闭集校验在 handler
        stage: z
          .string()
          .optional()
          .describe(
            "阶段登记（观测面，**不是状态机态**）：需求分析 / 改造方案 / 改造 / 回归 / 发版。" +
              "**缺省「改造方案」**⇒ 不传时既有行为不变；板建需求显式传「需求分析」。非法值 ⇒ feature_invalid_stage",
          ),
        version: z
          .string()
          .optional()
          .describe("版本登记（自由文本，如 v0.9.0；缺省空）：仅供看板 / 台账展示，引擎不解释"),
        approval: z
          .string()
          .optional()
          .describe(
            "审批门状态登记：未发起 / 待审批 / 已通过（单向、无回边）。**缺省「待审批」**⇒ 既有调用建完即可过审；" +
              "板建需求显式传「未发起」。非法值 ⇒ feature_invalid_approval",
          ),
        // v0.9.3 O1：父需求登记（增补轨挂主需求）。校验在 handler（存在性 + 带身份过滤可见性，
        // 不可见 ⇒ 同 feature_not_found，不新增第二拒绝码）；schema 侧仅收成串入参
        parentFeatureId: z
          .string()
          .optional()
          .describe(
            "父 Feature ID（可选）：增补轨挂主需求时传，落 features.parent_feature_id（单值、**只存不解析**" +
              "—— 不递归父链、不判环）。不存在或不可见 ⇒ feature_not_found",
          ),
      },
    },
    async (args) => {
      try {
        const outcome = core.featureCreate({
          title: args.title,
          requirement: args.requirement,
          contextId: args.contextId,
          stage: args.stage,
          version: args.version,
          approval: args.approval,
          parentFeatureId: args.parentFeatureId,
        });
        return outcome.ok ? textResult(outcome) : errorResult(outcome);
      } catch (err) {
        return internalError(err);
      }
    },
  );

  server.registerTool(
    "a2a_feature_status",
    {
      description:
        "查询 Feature 详情（state + tasks 摘要 + artifacts）；省略 featureId 时列出全部 Feature（含任务数）。",
      inputSchema: {
        featureId: z.string().optional().describe("Feature ID；省略则列出全部"),
      },
    },
    async (args) => {
      try {
        const outcome = core.featureStatus({ featureId: args.featureId });
        return outcome.ok ? textResult(outcome) : errorResult(outcome);
      } catch (err) {
        return internalError(err);
      }
    },
  );

  server.registerTool(
    "a2a_feature_advance",
    {
      description:
        "orch agent 驱动 Feature 主链推进（如 integrating→testing→reviewing→completed）；状态机校验合法后继，非法流转被拒。**waiting_approval→executing 已禁用**（唯一准入 = a2a_feature_approve，错误码 feature_approval_required）。needs_input 恢复用 to=executing 并携带 answer。**重派失败节点**用 retryTaskIds（须显式 to=executing，与 answer 互斥；重派 + 解冻闭包外 blocked 下游，不改 Feature 态）。**登记字段**用 stage / version / approval（`to` = 当前态时 = 只写登记、不动主链；无终态守卫，completed 后仍可写「发版」）。",
      inputSchema: {
        featureId: z.string().min(1).describe("Feature ID"),
        to: z
          .string()
          .min(1)
          .describe(
            "目标状态：waiting_approval / executing / integrating / testing / reviewing / completed / needs_input / failed / cancelled（非法后继被状态机拒绝；**waiting_approval→executing 须改用 a2a_feature_approve**）",
          ),
        note: z
          .string()
          .optional()
          .describe("统一方案 / 备注：落 Feature Context 的 plan（供审批与派发注入）"),
        decisions: z
          .string()
          .optional()
          .describe("决策记录（JSON 字符串；落 Feature Context 的 decisions）"),
        contracts: z
          .string()
          .optional()
          .describe("契约（JSON 字符串；落 Feature Context 的 contracts）"),
        answer: z
          .string()
          .optional()
          .describe("needs_input→executing 时的人工澄清内容，以同 contextId 续接待澄清任务"),
        retryTaskIds: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "重派与解冻（失败上收 §2.3）：给一组**本 Feature 内当前 `failed`** 的节点 id ⇒ 重派（复用 rearmForRetry，同 contextId 续接）+ 解冻其依赖闭包**外**的 `blocked` 下游。" +
              "须显式 `to=\"executing\"`（本参数是派发语义操作，不是状态流转）；与 `answer` **互斥**（同传 ⇒ feature_conflicting_args）；" +
              "空数组 / 任一 id 非法 ⇒ feature_nothing_to_resume（**整单拒绝，不做部分重派**，Feature 态不变）。",
          ),
        // v0.9.0 B1″ 登记字段写入：`to` **等于当前态** ∧ 带任一登记字段 ⇒ 只写登记、不动主链
        // （照 retryTaskIds 的「显式特例」先例，状态机转移表零改动；**无终态守卫**）
        stage: z
          .string()
          .optional()
          .describe(
            "阶段登记（闭集：需求分析 / 改造方案 / 改造 / 回归 / 发版；非法值 ⇒ feature_invalid_stage）。" +
              "**观测面，不是状态机态**：不改主链、不发状态事件；序与回退都不校验。",
          ),
        version: z.string().optional().describe("版本登记（自由文本，无闭集；引擎不解释）"),
        approval: z
          .string()
          .optional()
          .describe(
            "审批门状态登记（闭集：未发起 / 待审批 / 已通过；非法值 ⇒ feature_invalid_approval）。" +
              "写完改造文档后置「待审批」= 过审的前置；a2a_feature_approve 放行时落「已通过」。",
          ),
      },
    },
    async (args) => {
      try {
        const outcome = core.featureAdvance({
          featureId: args.featureId,
          to: args.to,
          note: args.note,
          decisions: args.decisions,
          contracts: args.contracts,
          answer: args.answer,
          retryTaskIds: args.retryTaskIds,
          stage: args.stage,
          version: args.version,
          approval: args.approval,
        });
        if (!outcome.ok) return errorResult(outcome);
        core.kickScheduler();
        return textResult(outcome);
      } catch (err) {
        return internalError(err);
      }
    },
  );

  server.registerTool(
    "a2a_feature_approve",
    {
      description:
        "审批门（**唯一准入**）：waiting_approval → executing；非该态调用被拒。该操作 = 记录**已发生**的用户确认（一对一映射：不可预领、不可补领）—— 禁止在用户确认方案前调用。",
      inputSchema: {
        featureId: z.string().min(1).describe("Feature ID"),
      },
    },
    async (args) => {
      try {
        const outcome = core.featureApprove({ featureId: args.featureId });
        if (!outcome.ok) return errorResult(outcome);
        core.kickScheduler();
        return textResult(outcome);
      } catch (err) {
        return internalError(err);
      }
    },
  );

  server.registerTool(
    "a2a_feature_cancel",
    {
      description:
        "取消 Feature（非收口态 → cancelled；failed 亦可经此归档为 cancelled，completed/cancelled 拒绝）；调度器随之停止该 Feature。",
      inputSchema: {
        featureId: z.string().min(1).describe("Feature ID"),
      },
    },
    async (args) => {
      try {
        const outcome = core.featureCancel({ featureId: args.featureId });
        return outcome.ok ? textResult(outcome) : errorResult(outcome);
      } catch (err) {
        return internalError(err);
      }
    },
  );

  server.registerTool(
    "a2a_feature_trace",
    {
      description:
        "**只读**：回答「这个 Feature 为什么还没完成」——逐非终态节点给出" +
        "`waitReason`（闭集：awaiting_user / running_remote / queued / upstream_dependencies / feature_not_executing / project_busy / read_lane_running / ready_pending_dispatch）" +
        "· `position`（排队位次，**与实领序同键** = `queued_at`；未入队 = 「此刻入队会排第几」的投影）" +
        "· `waitedSince`（等待起点）· `projectBusy`（**写门**占用者 + 占位机，可跨 Feature）· `lane`（并发档）。" +
        "**读写分道口径（v0.8.10）**：`projectBusy` 只反映写门 ⇒ 写门没挡却没开工时看 `readOccupants[]`" +
        "（同项目未落定的只读档占位；`waitReason='read_lane_running'`）—— 实际挡人的是 machine 侧同 project 读并发闸，" +
        "**两个时钟不得相加**（orch 领取队列的等待 ≠ machine 闸内等待）。纯读：不落库、不触发调度。",
      inputSchema: {
        featureId: z.string().min(1).describe("Feature ID"),
      },
    },
    async (args) => {
      try {
        const outcome = core.featureTrace({ featureId: args.featureId });
        return outcome.ok ? textResult(outcome) : errorResult(outcome);
      } catch (err) {
        return internalError(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 配置面工具组（v0.9.4 O1；**全组面** —— 不受调用方组可见性限制，静态注册零重连）
  // -------------------------------------------------------------------------

  server.registerTool(
    "a2a_config_write_group",
    {
      description:
        "**受控写** orch config.json 的 `projectGroup` 段（项目组台账的唯一机器写手）。" +
        "**单组操作指令五操作**（拒绝整文档替换）：group.add / group.update（members 整集替换）/ group.remove / " +
        "group.member.add / group.member.remove（增删成员各带 members=[{machineId, projectId}]；" +
        "组在 config 的出现由成员条目派生，改名语义不做，挪成员 = member.remove + member.add 组合）。" +
        "**写路径**：互斥内 read → mutate → dry-run（parseProjectGroups 同源校验，坏写不落盘）→ backup → tmp+rename 原子替换；" +
        "成功出参带 `backedUpTo`（写前备份路径）。" +
        "**错误码闭集**（板侧映射 HTTP 状态）：`config_write_dry_run_rejected`→422（带校验原 message）/ " +
        "`config_write_unknown_machine`→422 / `config_write_group_not_found`→409 / `config_write_duplicate_member`→409 / " +
        "`config_write_concurrent_modification`→409（config 处理途中被外部改动，调用方可重读后重试一次）/ " +
        "`config_write_io_failed`→500（当前 config 原样）。" +
        "**全组面语义**：配置面写不受调用方连接身份的组可见性限制（写后热生效：桥 per-call 现读，无需重启）。",
      inputSchema: configWriteGroupSchema,
    },
    async (args) => {
      try {
        const outcome = await core.configWriteGroup({
          op: args.op,
          groupName: args.groupName,
          members: args.members,
        });
        return outcome.ok ? textResult(outcome) : errorResult(outcome);
      } catch (err) {
        return internalError(err);
      }
    },
  );
}

/** 新建一个 MCP server 并完成工具注册（stateless「每请求新建 server + transport」用）。 */
export function createServer(core: BridgeCore): McpServer {
  // server 标识的 version 与 `/health` 同源（`../version.ts` 读 `package.json`），不再硬编码
  const server = new McpServer({ name: "a2a-coding-bridge", version: BRIDGE_VERSION });
  registerTools(server, core);
  return server;
}
