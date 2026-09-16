/**
 * 条件更新（CAS）原语 —— 「读-改-写」的原子替代（v0.4.1 桥常驻化加固）。
 *
 * 为什么需要：桥常驻后同一库会有多个写入者（桥请求处理 + Feature 调度器，乃至多进程）。
 * 「先读状态、再按读到的状态写」的读-改-写序列会在两步之间被插队，造成丢失更新
 * （典型：A 读到 working、B 也读到 working，A 写 completed，B 写 failed —— A 的写入被抹掉）。
 *
 * 替代做法：把前置条件压进**单条 SQL**，由 SQLite 在一条语句内完成「比对 + 写入」：
 *
 *   UPDATE <table> SET <赋值...> WHERE <keyColumn> = ? AND state = ?
 *
 * 受影响行数是唯一判据：1 = 前置状态仍成立、写入生效；0 = 读与写之间状态已被并发改写，
 * 本次写入**没有发生**（调用方应重读后决定重试或放弃，而不是盲目覆盖）。
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/** `conditionalStateUpdate` 入参 */
export interface ConditionalStateUpdateOptions {
  /** 目标表（本单元仅 `tasks` / `features`） */
  table: "tasks" | "features";
  /** 主键列（`task_id` / `feature_id`） */
  keyColumn: "task_id" | "feature_id";
  /** 主键值 */
  key: string;
  /** 读到的前置状态（作为 `WHERE state = ?` 条件；不匹配即不写入任何行） */
  expectedState: string;
  /** 目标状态 */
  nextState: string;
  /** 除 `state` 外需同写的列赋值片段（如 `updated_at = ?` / `text = COALESCE(?, text)`） */
  assignments?: readonly string[];
  /** `assignments` 中占位符按出现顺序对应的参数 */
  assignmentParams?: readonly SQLInputValue[];
}

/**
 * 执行单语句条件更新，返回受影响行数（0 = 前置状态不匹配，未写入任何行）。
 * 表名 / 列名 / 赋值片段均来自代码内常量（非外部输入），值一律走占位符绑定。
 */
export function conditionalStateUpdate(
  db: DatabaseSync,
  opts: ConditionalStateUpdateOptions,
): number {
  const assignments = ["state = ?", ...(opts.assignments ?? [])];
  const params: SQLInputValue[] = [opts.nextState, ...(opts.assignmentParams ?? [])];
  params.push(opts.key, opts.expectedState);
  const info = db
    .prepare(
      `UPDATE ${opts.table} SET ${assignments.join(", ")}
       WHERE ${opts.keyColumn} = ? AND state = ?`,
    )
    .run(...params);
  return Number(info.changes);
}
