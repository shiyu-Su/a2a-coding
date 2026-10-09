/**
 * 引擎版本台账**读投影**测试夹具（v0.10.0 B4）。
 *
 * 已发版锁的数据源从板本地台账 `.data/versions.json` 换到**引擎版本台账投影**（改造文档 §2.3(1)）
 * ⇒ 锁类用例的喂入面随之换成本文件（本地台账夹具只保留给「版本列并集 / 台账读面」等非锁断言）。
 *
 * **恒注入**（不声明锁版时喂空投影）：缺省会打开发机的真实引擎 `GET :8787/api/versions`，
 * 锁随本机台账漂移；更糟的是写口 **fail-closed** —— 引擎一宕，所有排期写用例集体变 503。
 * 空投影 = **读到了投影且事实为「零个已发版」**（合法事实），与 {@link engineProjectionAbsentFetcher}
 * 的「读不到投影」（写口必须挡）是两档，不可混用。
 */

/** 投影捕获时刻（固定值 ⇒ 两次渲染逐字节相同，不依赖真实时钟）。 */
const CAPTURED_AT = "2026-10-08T00:00:00.000Z";

/**
 * 由「锁版清单」构造投影：项可为版本串，或 `{org, version, status?}`（`status` 缺省 `released`）。
 * `defaultOrg` = 版本串形态条目的归属档（对齐 `releasedLedgerFixture(versions, org)` 的签名）。
 */
export function engineProjectionOf(versions = [], defaultOrg = "") {
  const entries = versions.map((raw) => {
    const rec = typeof raw === "object" && raw !== null ? raw : { org: defaultOrg, version: String(raw) };
    return { org: rec.org ?? "", version: String(rec.version).trim(), status: rec.status ?? "released" };
  });
  return { kind: "projection", projection: { entries, capturedAt: CAPTURED_AT } };
}

/** 假投影读取器（返回 `EngineVersionsOutcome`）；`fetcher.calls` 供「一次渲染只打一次」的钉。 */
export function engineProjectionFetcher(versions = [], defaultOrg = "") {
  const outcome = engineProjectionOf(versions, defaultOrg);
  const fetcher = async () => {
    fetcher.calls += 1;
    return outcome;
  };
  fetcher.calls = 0;
  return fetcher;
}

/** 「无锁」档：读到投影 ∧ 零条目 ⇒ 写口照常放行、读面无锁样式。用于不测锁的用例。 */
export function engineNoLockFetcher() {
  return engineProjectionFetcher([]);
}

/** 「读不到投影」档：fail-closed 用例专用（写口 ⇒ 503；读面 ⇒ 无最后一次投影可退）。 */
export function engineProjectionAbsentFetcher(
  code = "versions_unreachable",
  error = "假投影：引擎版本台账不可达",
) {
  const fetcher = async () => {
    fetcher.calls += 1;
    return { kind: "absent", code, error };
  };
  fetcher.calls = 0;
  return fetcher;
}
