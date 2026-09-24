/**
 * ACP 桥内存任务台账（REQ-v0.8.0-2026-09-19-01 · 节点 B1）。
 *
 * 语义（对齐 `launcher/a2a-client.ts` + Runner 派发链）：
 * - `send`：建 A2A Task（初态 `working`）→ **后台**执行（`TaskExecutor`）→ 终态回写；
 *   `configuration.blocking === true` 时等待终态，否则**立即返回 working 句柄**。
 * - `get`：按 id 取任务（Runner `tasks/get` 轮询至终态）。
 * - `cancel`：置 `canceled` + 尽力通知执行器；终态一经落定**不被迟到结果覆盖**。
 *
 * 依赖全部经构造注入（executor / clock / idFactory），便于单测确定性。
 */
import { randomUUID } from "node:crypto";
import { buildArtifacts } from "./artifacts.js";
import { parseOutcome } from "./outcome.js";
import type {
  A2AMessage,
  A2ATask,
  Clock,
  TaskExecutionResult,
  TaskExecutor,
  TextPart,
} from "./types.js";

/** 一条任务的内部记录（`updatedAt` 供观测 / 后续持久化；不属 A2A 线形状）。 */
interface TaskRecord {
  task: A2ATask;
  /** 在飞执行 promise（`blocking:true` 等待用） */
  pending: Promise<void>;
  updatedAt: string;
  /**
   * 该轮已被执行器**放弃**、但后端那一轮可能仍在烧（v0.8.10 · M-N3 · B16′）。
   * 来源 = `TaskExecutionResult.abandoned`（ACP 执行器的 prompt 满窗出口置位）。
   * 用途：允许**终态支路**的迟到取消（见 {@link TaskRegistry.cancel}）。
   * **不落 captures 窗** —— 窗是执行器内部的一格，台账侧要的是「这条 record 该不该再通知」的事实。
   */
  abandoned: boolean;
}

/** `message/send` 解析后的入参。 */
export interface MessageSendParams {
  message: A2AMessage;
  configuration?: { blocking?: boolean };
}

export interface TaskRegistryOptions {
  /** 任务执行器（**必填**，可注入） */
  executor: TaskExecutor;
  /** 可注入时钟（缺省 `() => new Date()`） */
  now?: Clock;
  /** 任务 id 生成（缺省 `randomUUID`；注入便于单测确定性） */
  idFactory?: () => string;
}

/** 内存任务台账。 */
export class TaskRegistry {
  private readonly executor: TaskExecutor;
  private readonly now: Clock;
  private readonly idFactory: () => string;
  private readonly records = new Map<string, TaskRecord>();

  constructor(options: TaskRegistryOptions) {
    this.executor = options.executor;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
  }

  /**
   * 处理 `message/send`。非 blocking 时**立即**返回 `working` 句柄；
   * blocking 时等待执行器终态后返回同一（已更新）任务对象。
   */
  async send(params: MessageSendParams): Promise<A2ATask> {
    const taskId = this.idFactory();
    const task: A2ATask = { id: taskId, status: { state: "working" }, artifacts: [] };
    const pending = this.run(taskId, textFromParts(params.message.parts), params.message);
    this.records.set(taskId, {
      task,
      pending,
      abandoned: false,
      updatedAt: this.now().toISOString(),
    });
    if (params.configuration?.blocking === true) {
      await pending;
    }
    return task;
  }

  /** 按 id 取任务；未知返回 `null`。 */
  get(taskId: string): A2ATask | null {
    return this.records.get(taskId)?.task ?? null;
  }

  /**
   * 取消任务：`working` → `canceled`（并尽力通知执行器）；已是终态则幂等返回。
   * 未知 id 返回 `null`。
   *
   * **终态支路（v0.8.10 · M-N3 · B16′）**：`state ∈ 终态 ∧ 该轮标 `abandoned`` ⇒
   * **仍向执行器发一次通知，但 state 不变**。为什么必须这一支：launcher 的定向取消常常迟到于
   * 桥自判满窗（record 已 `failed`），而**纯 launcher 侧覆盖不了**这种「台账已终态、后端仍在烧」
   * 的幽灵轮 —— 旧实现在终态直接跳过通知 ⇒ 取消永远到不了执行器 ⇒ 那一轮白烧到自然结束。
   *
   * ⚠ 三条硬约束（与 launcher 侧同源，缺一即开「第二条结果」的口子）：
   * ① **只走控制通道**（`executor.cancel` = ACP notification，不等响应、不产出结果文本）；
   * ② **不得改 record 的 state**（改 state 即触终态 CAS / 与 `applyResult` 抢写 = 第二条结果的成因）；
   * ③ **必须排在 `outbox.deliver()` 之后**（账单先行；launcher 侧纪律，见 `runner-exec.ts`）。
   * 三条同时成立 ⇒ 本支路结构上不可能产生第二条结果。
   */
  async cancel(taskId: string): Promise<A2ATask | null> {
    const record = this.records.get(taskId);
    if (record === undefined) return null;
    if (record.task.status.state === "working") {
      try {
        await this.executor.cancel?.(taskId);
      } catch {
        // 取消为 best-effort：执行器通知失败不影响台账置 canceled（任务仍按本地节奏收敛）。
      }
      if (record.task.status.state === "working") {
        record.task.status = { state: "canceled" };
        record.updatedAt = this.now().toISOString();
      }
      return record.task;
    }
    if (record.abandoned) {
      // 硬约束 ②：本支路**不写** `record.task.status`、也不写 `updatedAt`（纯通知）。
      try {
        await this.executor.cancel?.(taskId);
      } catch {
        // 同样 best-effort：通知失败不改台账（该轮早已按 failed 收敛）。
      }
    }
    return record.task;
  }

  /** 后台执行并回写终态。 */
  private async run(taskId: string, text: string, message: A2AMessage): Promise<void> {
    try {
      const result = await this.executor.execute({
        taskId,
        text,
        contextId: message.contextId ?? "",
        messageId: message.messageId,
      });
      // 放弃标记须在终态回写**之前**落：`applyResult` 之后这条 record 即进入「终态支路」的判定窗口。
      if (result.abandoned === true) {
        const rec = this.records.get(taskId);
        if (rec !== undefined) rec.abandoned = true;
      }
      this.applyResult(taskId, result);
    } catch (err) {
      this.applyResult(taskId, {
        state: "failed",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 终态回写（v0.8.1 M3 去重口径）：仅当仍为 `working`（`canceled` 等已落定终态优先，
   * 不被迟到结果覆盖）。
   * - **completed / canceled** ⇒ `status.message` **不带结果文本**，全文只落 artifact
   *   （orch `resultText` 会把 message 与 artifacts **拼接**，双填即回归）；
   * - **input-required / failed** ⇒ message = `question`/`reason` 短文（缺短文回退全文），
   *   artifact = 剥块全文（短重复沿 wrapper 现状不修）；
   * - artifact 恒为 `name="response"` 单 text part，text = `parseOutcome` 剥块后全文
   *   （对执行器已剥块的文本为幂等再解析）。
   */
  private applyResult(taskId: string, result: TaskExecutionResult): void {
    const record = this.records.get(taskId);
    if (record === undefined) return;
    if (record.task.status.state !== "working") return;
    const full = parseOutcome(result.text ?? "").text;
    const short =
      result.state === "input-required" ? (result.question ?? full)
        : result.state === "failed" ? (result.reason ?? full)
          : "";
    const status: A2ATask["status"] = { state: result.state };
    if (short.length > 0) {
      status.message = { role: "agent", parts: [{ kind: "text", text: short }], messageId: taskId };
    }
    record.task.status = status;
    record.task.artifacts = [
      ...buildArtifacts([{ name: "response", text: full }]),
      ...(result.artifacts ?? []),
    ];
    record.updatedAt = this.now().toISOString();
  }
}

/** 拼接 v0.3 parts 中的 text 段（忽略非 text / 非法项）。 */
export function textFromParts(parts: readonly TextPart[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.kind === "text" && part.text.length > 0) chunks.push(part.text);
  }
  return chunks.join("\n");
}
