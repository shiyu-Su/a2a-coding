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
    this.records.set(taskId, { task, pending, updatedAt: this.now().toISOString() });
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
      this.applyResult(taskId, result);
    } catch (err) {
      this.applyResult(taskId, {
        state: "failed",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 终态回写：仅当仍为 `working`（`canceled` 等已落定终态优先，不被迟到结果覆盖）。 */
  private applyResult(taskId: string, result: TaskExecutionResult): void {
    const record = this.records.get(taskId);
    if (record === undefined) return;
    if (record.task.status.state !== "working") return;
    const parts: TextPart[] = [{ kind: "text", text: result.text ?? "" }];
    record.task.status = {
      state: result.state,
      message: { role: "agent", parts, messageId: taskId },
    };
    record.task.artifacts = result.artifacts ?? [];
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
