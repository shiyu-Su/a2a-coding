/**
 * **版本自动转 `active`**（v0.10.0 O2c · 改造文档 §2.1(2)）—— 引擎内部触发点，**三护栏**落点。
 *
 * 触发方 = 引擎自身（**首个节点派发 / `approve` 放行**），**不开放板写口** —— 板只读结果。
 * 真实写口在 `session/store.ts` 的 {@link versionLedgerActivate}（幂等 + 事件同事务）；本模块把它
 * 包成「调用方永不被拖垮」的护栏层：
 *
 * 1. **幂等** —— 写口内判：非 `notstart` ⇒ 零写入、零事件（`activated = false`）。本层不重复判。
 * 2. **不阻断**（渲染 / `approve` / 派发）—— {@link VersionActivator.activate} **绝不抛出**：
 *    写口异常在此吞掉、仅 `bridgeLog.warn` 留痕，立即返回 `activated = false`。调用方
 *    （`handleFeatureApprove` / `dispatchFeatureNode`）因此不必 try/catch，也不会因版本面故障失败。
 * 3. **节流** —— 进程内 `Map<(ownerGroup, version), ms>`：同一键在
 *    {@link VERSION_ACTIVATION_THROTTLE_MS} 窗口内**至多尝试一次**（失败也记录时刻，避免每 tick 反复
 *    打库）；一旦真的转成功则**立即解除**该键（不再是 `notstart`，无需再节流）。
 *    窗口参数经设状态端点回执透出（`guardrails.throttleMs`）。
 *
 * 复合键分隔符 = NUL（U+0000）：`ownerGroup` / `version` 都是自由文本，常规字符拼接会撞键。
 */
import type { VersionLedgerStatus } from "../types.js";
import {
  versionLedgerActivate,
  type VersionActivationResult,
} from "../session/store.js";
import { bridgeLog } from "./bridge-log.js";

/** 自动转换的**进程内节流**窗口（同一 `(ownerGroup, version)` 两次尝试的最小间隔，毫秒）。 */
export const VERSION_ACTIVATION_THROTTLE_MS = 30_000;

/** 自动转换所需的**最小存储面**（单测可注入假 store；缺省走 `session/store.ts` 默认存储）。 */
export interface VersionActivationPort {
  activate(ownerGroup: string | null, version: string): VersionActivationResult;
}

/** 一次触发的结果（三护栏可读面）。 */
export interface VersionActivationOutcome {
  /** 本次是否真的完成 `notstart → active`。 */
  activated: boolean;
  /** 事务后 `status`（行不存在 / 台账未就绪 ⇒ `null`）。 */
  status: VersionLedgerStatus | null;
  /**
   * 台账是否就绪。⚠ 节流跳过 / 写口异常路径**未现读台账**，此处置 `true` 表示「不因台账未就绪
   * 而跳过」，**不代表**台账一定就绪（仅作报告，不参与任何判定）。
   */
  ledgerReady: boolean;
  /** 本次因节流窗口未过而跳过（未触达写口）。 */
  throttled: boolean;
}

/** `(ownerGroup, version)` 复合键（NUL 分隔，杜绝常规字符拼接撞键）。 */
export function versionActivationKey(ownerGroup: string | null, version: string): string {
  return (ownerGroup ?? "") + String.fromCharCode(0) + version;
}

export interface VersionActivatorOptions {
  /** 存储写口（缺省 = `session/store.ts` 默认存储的 `versionLedgerActivate`） */
  port?: VersionActivationPort;
  /** 节流窗口 ms（缺省 {@link VERSION_ACTIVATION_THROTTLE_MS}） */
  throttleMs?: number;
  /** 时钟（缺省 `Date.now`；单测注入以断言节流窗口） */
  now?: () => number;
}

/** 自动转换护栏器（进程内单例见 {@link versionActivator}；单测可自建隔离实例）。 */
export class VersionActivator {
  private readonly port: VersionActivationPort;
  private readonly throttleMs: number;
  private readonly now: () => number;
  private readonly throttle = new Map<string, number>();

  constructor(options: VersionActivatorOptions = {}) {
    this.port = options.port ?? { activate: versionLedgerActivate };
    this.throttleMs = options.throttleMs ?? VERSION_ACTIVATION_THROTTLE_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 触发一次「`notstart → active`」。**绝不抛出**（护栏 2）。
   * 空版本串 ⇒ 直接 no-op（未排期卡不针对任何版号）。
   */
  activate(
    ownerGroup: string | null,
    version: string | null | undefined,
  ): VersionActivationOutcome {
    const v = (version ?? "").trim();
    if (v.length === 0) {
      return { activated: false, status: null, ledgerReady: true, throttled: false };
    }
    const key = versionActivationKey(ownerGroup, v);
    const nowMs = this.now();
    const last = this.throttle.get(key);
    if (last !== undefined && nowMs - last < this.throttleMs) {
      return { activated: false, status: null, ledgerReady: true, throttled: true };
    }
    this.throttle.set(key, nowMs);
    try {
      const result = this.port.activate(ownerGroup, v);
      if (result.activated) this.throttle.delete(key);
      return { ...result, throttled: false };
    } catch (err) {
      bridgeLog.warn(
        "a2a-versions",
        `版本自动转 active 失败（owner_group=${ownerGroup === null ? "NULL" : `"${ownerGroup}"`} · version=${v}）：${toMessage(err)}（不阻断调用方，下一节流窗口再试）`,
      );
      return { activated: false, status: null, ledgerReady: true, throttled: false };
    }
  }
}

/** 进程内单例（桥进程生命周期；节流表随桥常驻）。 */
export const versionActivator = new VersionActivator();

/** 便捷函数：触发 `(ownerGroup, version)` 的自动转 active。 */
export function activateVersion(
  ownerGroup: string | null,
  version: string | null | undefined,
): VersionActivationOutcome {
  return versionActivator.activate(ownerGroup, version);
}

/** 便捷函数：按 Feature 的归属组 + 版号触发（`approve` / 派发钩子用）。 */
export function activateVersionForFeature(feature: {
  ownerGroup: string | null;
  version: string | null | undefined;
}): VersionActivationOutcome {
  return versionActivator.activate(feature.ownerGroup, feature.version);
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
