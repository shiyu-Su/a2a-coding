/**
 * 旧宿主写面遗留的类型壳。
 *
 * v0.11.0 B1 已删除全部宿主进程、轮次和 JSON-RPC 出站路径；运行时不会再构造该对象。
 * 这里仅保留引擎无关的结局类型，供正在退场的展示函数通过类型检查。
 */
export type BoardHostFace = any;

export type TriggerDisposition =
  | "queued"
  | "awaiting_answer"
  | "succeeded"
  | "canceled"
  | "not_awaiting"
  | "busy"
  | "terminal"
  | "timeout"
  | "bridge_down"
  | "turn_failed"
  | "config_error";

export interface TriggerTurnOutcome {
  ok: boolean;
  featureId: string;
  org: string;
  disposition: TriggerDisposition;
  turnId: string | null;
  contextId: string | null;
  round: number | null;
  state: string | null;
  queued: boolean;
  summary: string | null;
  question: string | null;
  error: { code: string; message: string } | null;
  display: string;
  bridge: { pid: number; port: number; kind: string } | null;
  receipt?: { head: string[]; todo: string[]; next: string } | null;
}

export interface StopBridgeOutcome {
  ok: boolean;
  org: string;
  state: string;
  display: string;
  error: { code: string; message: string } | null;
}

export type HostStatusEntry = any;

/** 已退役端点只应答 410；保留纯映射以免未调用分支漏编译。 */
export function dispositionHttpStatus(_d: TriggerDisposition): number {
  return 410;
}

export function terminalTurnRejection(featureId: string, state: string): TriggerTurnOutcome {
  return {
    ok: false,
    featureId,
    org: "",
    disposition: "terminal",
    turnId: null,
    contextId: null,
    round: null,
    state,
    queued: false,
    summary: null,
    question: null,
    error: { code: "board_feature_terminal", message: `需求已处于终态：${state}` },
    display: "需求已进入终态",
    bridge: null,
  };
}
