/**
 * machine 侧 `taskType`（职责位）取值集合的**唯一声明源**（零依赖叶模块）。
 *
 * 只声明取值集合与派生类型，**不得 import 仓内任何其它模块**（避免 import 环 /
 * 分层倒置：`types` / `config` / `launcher` 等均可依赖本模块，本模块不反向依赖）。
 * `types.ts` 对本类型做 re-export，既有 import 站点无需改动。
 *
 * 与 orch 侧的 `TASK_TYPES` 各自派生、不共享代码；两侧一致性由回归断言
 * 「本地清单 == PROTOCOL.md 锚点」锁定（见改造文档 §2.3 F-C1 / §3.2）。
 */
export const TASK_TYPES = ["unit_agent", "product_manager", "project_manager", "dev_manager"] as const;

export type TaskType = (typeof TASK_TYPES)[number];

/** 类型守卫：入参为任意字符串时，判定是否属于 {@link TASK_TYPES} 闭集。 */
export function isTaskType(value: string): value is TaskType {
  return (TASK_TYPES as readonly string[]).includes(value);
}
