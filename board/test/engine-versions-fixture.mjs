/**
 * 引擎版本台账**读投影**测试夹具（v0.10.0 B4；v0.10.1 B1 扩 project 档）。
 *
 * 已发版锁的数据源从板本地台账 `.data/versions.json` 换到**引擎版本台账投影**（改造文档 §2.3(1)）
 * ⇒ 锁类用例的喂入面随之换成本文件（本地台账夹具只保留给「版本列并集 / 台账读面」等非锁断言）。
 *
 * **恒注入**（不声明锁版时喂空投影）：缺省会打开发机的真实引擎 `GET :8787/api/versions`，
 * 锁随本机台账漂移；更糟的是写口 **fail-closed** —— 引擎一宕，所有排期写用例集体变 503。
 * 空投影 = **读到了投影且事实为「零个已发版」**（合法事实），与 {@link engineProjectionAbsentFetcher}
 * 的「读不到投影」（写口必须挡）是两档，不可混用。
 *
 * **v0.10.1 B1 两档分立（C-7 / C-12）**：project 面挂在投影内的独立字段 `projectVersions` 上，
 * 缺省档 = **不带该字段**（= 老引擎档，Group 面照常、project 面自持 absent）。既有夹具的返回值
 * **只增不改**：默认档不得注入 project 行，否则「老引擎混跑」档失去覆盖。
 *
 * **v0.10.1 B5 原始信封档**：脏形状（project 行混入 `versions[]`）经 {@link engineEnvelopeFetcher}
 * 走真解析层喂入 —— 见该导出的说明，本文件的**默认档返回值不变**。
 */
import { parseEngineVersions } from "../dist/bridge-client.js";

/** 投影捕获时刻（固定值 ⇒ 两次渲染逐字节相同，不依赖真实时钟）。 */
const CAPTURED_AT = "2026-10-08T00:00:00.000Z";

/**
 * 由「锁版清单」构造投影：项可为版本串，或 `{org, version, status?}`（`status` 缺省 `released`）。
 * `defaultOrg` = 版本串形态条目的归属档（对齐 `releasedLedgerFixture(versions, org)` 的签名）。
 * 第三参 `projectVersions`（v0.10.1 B1，**缺省 `undefined` = 老引擎档**）：传入即把 project 档
 * 装配进同一投影（三态构造器见 {@link engineProjectLiveField} / {@link engineProjectEmptyField} /
 * {@link engineProjectAbsentField}）。
 */
export function engineProjectionOf(versions = [], defaultOrg = "", projectVersions = undefined) {
  const entries = versions.map((raw) => {
    const rec = typeof raw === "object" && raw !== null ? raw : { org: defaultOrg, version: String(raw) };
    return { org: rec.org ?? "", version: String(rec.version).trim(), status: rec.status ?? "released" };
  });
  const projection = { entries, capturedAt: CAPTURED_AT };
  if (projectVersions !== undefined) projection.projectVersions = projectVersions;
  return { kind: "projection", projection };
}

/** 假投影读取器（返回 `EngineVersionsOutcome`）；`fetcher.calls` 供「一次渲染只打一次」的钉。 */
export function engineProjectionFetcher(versions = [], defaultOrg = "", projectVersions = undefined) {
  const outcome = engineProjectionOf(versions, defaultOrg, projectVersions);
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

// ---------------------------------------------------------------------------
// project 档夹具（v0.10.1 B1 · 三态 = `live` / `empty` / `absent`，与 Group 面正交）
// ---------------------------------------------------------------------------

/**
 * `live` 档：带 project 行。项可为 `{org, projectId, version}` 最小键集，或带
 * `status / releasable / openCount / completedCount / cancelledCount / reason / repoId / ref` 全键集；
 * **未给的键 ⇒ `null`（= 板显示 `—` 的缺键档），夹具不臆造缺省值**（口径同解析层）。
 */
export function engineProjectLiveField(rows = [], defaultOrg = "") {
  const entries = rows.map((raw) => {
    const rec = typeof raw === "object" && raw !== null ? raw : { org: defaultOrg, version: String(raw) };
    return {
      org: rec.org ?? "",
      projectId: rec.projectId ?? "",
      version: String(rec.version ?? "").trim(),
      status: rec.status ?? null,
      releasable: rec.releasable ?? null,
      openCount: rec.openCount ?? null,
      completedCount: rec.completedCount ?? null,
      cancelledCount: rec.cancelledCount ?? null,
      reason: rec.reason ?? null,
      repoId: rec.repoId ?? null,
      ref: rec.ref ?? null,
    };
  });
  return { status: "live", entries };
}

/** `empty` 档：字段在场 ∧ 零条目 = **合法事实**（「未登记，本版本起生效」），与 `absent` 显示必须可区分。 */
export function engineProjectEmptyField() {
  return { status: "empty" };
}

/** `absent` 档：`versions[]` 在场 ∧ project 字段缺位 ⇒ Group 面一切照常，仅 project 面降级。 */
export function engineProjectAbsentField(
  code = "project_versions_field_missing",
  error = "夹具：响应无 projectVersions[]（引擎 project 版本面未上线）",
) {
  return { status: "absent", code, error };
}

/** 「Group 有锁 ∧ project 未上线」档：混跑期主形态（Group 面照常执法、project 面独立降级）。 */
export function engineProjectionWithProjectAbsentFetcher(versions = [], defaultOrg = "") {
  return engineProjectionFetcher(versions, defaultOrg, engineProjectAbsentField());
}

/** 「Group 有锁 ∧ project 面在场有行」档。 */
export function engineProjectionWithProjectsFetcher(versions, rows, defaultOrg = "") {
  return engineProjectionFetcher(versions, defaultOrg, engineProjectLiveField(rows, defaultOrg));
}

// ---------------------------------------------------------------------------
// 原始信封档（v0.10.1 B5）：脏形状必须走真解析层，不得手拼投影
// ---------------------------------------------------------------------------

/**
 * **未解析的 `GET /api/versions` 信封** → 经真实解析层（{@link parseEngineVersions}）出 outcome。
 *
 * 存在的理由 = B5 的两条负向钉喂的是**引擎不可能给、但混跑期可能真给**的脏形状
 * （project 行混进 `versions[]`、同名两档版号并置）：这类形状只有在**解析层**才会被裁掉，
 * 手拼 projection 会绕过那道裁撤 ⇒ 断言变成自证。干净档仍用上列构造器，本通道专供脏形状。
 * `capturedAt` 缺省 {@link CAPTURED_AT}（固定值 ⇒ 两次渲染逐字节相同）。
 */
export function engineEnvelopeOf(envelope, capturedAt = CAPTURED_AT) {
  return parseEngineVersions(envelope, capturedAt);
}

/**
 * 原始信封版投影读取器（同 {@link engineProjectionFetcher} 的注入面，`fetcher.calls` 同钉）：
 * 构造时即走一次真解析 ⇒ 消费面（版本列 / 已发版锁 / 门户摘要 / project 区块）拿到的是
 * **解析后**的投影，与线上一致。
 */
export function engineEnvelopeFetcher(envelope, capturedAt = CAPTURED_AT) {
  const outcome = engineEnvelopeOf(envelope, capturedAt);
  const fetcher = async () => {
    fetcher.calls += 1;
    return outcome;
  };
  fetcher.calls = 0;
  return fetcher;
}

