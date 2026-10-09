/**
 * **版本台账写端点**（v0.10.0 O2a · 改造文档 §2.1(2)）—— `POST` / `DELETE` / `GET` 三路的 HTTP 面。
 *
 * ## 落点裁定（回执已写明）
 * 本仓 HTTP 面**一桥两端口、读写分家**（既有架构，非本节点新增）：
 * - **3300 = `bridge/transports/web.ts`**：**只读**运维面 —— `handleRequest` 对非 GET 一律 405
 *   （`web.ts:451-458`），且文档明确「网页 = 非身份面 / 不做第二编排入口」。**不在这里开写口**
 *   （放开等于废掉该端口的只读契约，且会与并发在改的读面节点撞同一文件）。
 * - **8787 = `bridge/transports/http.ts`**：**可写面**（`POST /mcp` = 宿主写路径、`POST /shutdown`）。
 *   本模块以 **`/runner/*` 同款委托**接进来（`HttpTransportOptions.versions` + `handleRequest` 内
 *   `if (await options.versions.handle(…)) return;`），与 `/mcp` 同端口、同鉴权基线
 *   （MCP 面本身无额外 bearer 校验 ⇒ 本面不新增、也不降低门槛）。
 *
 * 改造文档 §2.1(2) 把 `GET` 与 `POST/PATCH/DELETE` **并列在同一条「写端点」条文内**（板的
 * 「读投影唯一来源」），故 **GET 与写路同侧落 8787**，形状一致、一处实现。
 * 板若需经 3300 读台账，由读面节点加一条薄转发（本节点不碰 `web.ts`，见回执协调项）。
 *
 * ## 路由（四段，其余一律「不认领」⇒ 落 404）
 * | 路径 | 方法 | 成功码 |
 * |---|---|---|
 * | `/api/versions` | `GET` | `200` + 清单 |
 * | `/api/versions` | `POST` | `201` + 单行 |
 * | `/api/versions/{version}` | `DELETE` | `204`（无体） |
 * | `/api/versions/{version}/status` | `PATCH` | `200` + 单行（**v0.10.0 O2c**） |
 *
 * **`PATCH …/status`（O2c）**：`{status}` ∈ 三态闭集。`released` ⇒ 转
 * {@link markVersionReleased}（发版闸 O4 + 快照同事务 O7）；`released` 是**终态、不可回退**
 * （现态 `released` 再改态 ⇒ 409 `orch_version_released_locked`）。`notstart ↔ active` ⇒
 * store 的 `versionLedgerSetStatus`。**自动转换不经本口**（引擎内部在首个节点派发 / `approve`
 * 时触发，见 `bridge/versions-activation.ts`）；本口仅承载**人工**设状态意图。
 *
 * ## 信封（统一，改造文档 §2.1(2)）
 * 成功：`{ ok: true, … }`；失败：`{ ok: false, error: { code, message } }`。
 * `code` = `orch_*` 闭集（事实源 `session/store.ts` 的 `ERR_VERSION_*` 常量）——
 * **板按「错误码显示映射表」翻译、未知码原样展示、不得 fail-closed**（§2.3(3)）。
 *
 * ## 归属（`owner_group`）解析（v0.10.0 F1 · 三个来源按优先序）
 * 写口（`POST` 建版 / `PATCH …/status` 设状态）的归属取**第一个已提供者**：
 * 1. body `ownerGroup`（camelCase · O2a 既有契约）；
 * 2. body `owner_group`（snake_case · 板 / 宿主实际发出的写法）；
 * 3. 查询参数 `?owner_group=`（与 `GET` / `DELETE` 同一写法）。
 *
 * 三者皆未提供 ⇒ **`null` = 匿名档**（照 §2.1(2)「不猜默认组」契约，行为不变），但**落 warn 留痕**：
 * `versions` 的 PK 是 `(owner_group, version)`、后续校验按组**精确匹配** ⇒ 配组环境下建出的
 * `NULL` 行永远引用不到，静默落 NULL 会让缺陷不可见。
 *
 * ## 幂等 / 判据
 * 判据**全在 store 写口内做完**（`versionLedgerCreate` / `versionLedgerDelete`），本层只做
 * 「传输层形状 + 归属门闩 + 状态码映射」⇒ 同一请求重复发不产生第二行、也不改第一行。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CoreRole } from "../runtime/core-lease.js";
import { isVersionLedgerStatus } from "../types.js";
import {
  versionLedgerCreate,
  versionLedgerDelete,
  versionLedgerList,
  versionLedgerSetStatus,
  type VersionLedgerCreateInput,
  type VersionLedgerRecord,
  type VersionLedgerSetStatusInput,
  type VersionLedgerWriteResult,
} from "../session/store.js";
import {
  markVersionReleased,
  type MarkVersionReleasedInput,
  type MarkVersionReleasedResult,
} from "./versions-release.js";
import { VERSION_ACTIVATION_THROTTLE_MS } from "./versions-activation.js";
import { bridgeLog } from "./bridge-log.js";

/** 台账集合路径（GET / POST 共用） */
export const VERSIONS_COLLECTION_PATH = "/api/versions";
/** 单行路径前缀（`DELETE /api/versions/{version}`） */
const VERSIONS_ITEM_PREFIX = "/api/versions/";
/** 设状态路径后缀（`PATCH /api/versions/{version}/status` · O2c） */
const VERSIONS_STATUS_SUFFIX = "/status";

/** 请求体上限（与 `runner.ts` 的 `RUNNER_MAX_BODY_BYTES` 同值；台账载荷本就很小） */
const VERSIONS_MAX_BODY_BYTES = 1_048_576;

/** GET 出参 `source` 串（读投影的事实源声明，与 `web.ts` 各面同风格） */
const VERSIONS_SOURCE = "引擎版本台账 `versions` 表（每请求现读；板为读投影，非事实源）";

/** 传输层自身的错误码（与 store 的 `orch_version_*` 业务码同前缀、同一映射表） */
export const ERR_VERSIONS_BAD_REQUEST = "orch_versions_bad_request";
export const ERR_VERSIONS_METHOD_NOT_ALLOWED = "orch_versions_method_not_allowed";
export const ERR_VERSIONS_NOT_OWNER = "orch_versions_not_owner";
export const ERR_VERSIONS_PAYLOAD_TOO_LARGE = "orch_versions_payload_too_large";
export const ERR_VERSIONS_STORE_ERROR = "orch_versions_store_error";

/**
 * **三护栏回执**（v0.10.0 O2c · 改造文档 §2.1(2)）—— 自动转换的护栏参数随设状态端点回执透出，
 * 供板 / 宿主留痕。`idempotent` / `nonBlocking` 是**能力声明**（写口幂等 + 触发不抛），
 * `throttleMs` 是引擎侧节流窗口（{@link VERSION_ACTIVATION_THROTTLE_MS}）。
 */
const GUARDRAILS_RECEIPT = {
  idempotent: true,
  nonBlocking: true,
  throttleMs: VERSION_ACTIVATION_THROTTLE_MS,
} as const;

/**
 * 存储端口（可注入，单测用）。默认走 `session/store.ts` 的默认存储模块面
 * （与 MCP 工具面同一进程内实例 ⇒ 无第二份缓存）。
 */
export interface VersionsStorePort {
  list(ownerGroup?: string | null): VersionLedgerRecord[];
  create(input: VersionLedgerCreateInput): VersionLedgerWriteResult;
  remove(ownerGroup: string | null, version: string): VersionLedgerWriteResult;
  /** PATCH `notstart ↔ active` 手动设状态（v0.10.0 O2c） */
  setStatus(input: VersionLedgerSetStatusInput): VersionLedgerWriteResult;
  /** PATCH `released` 分支：发版闸 + 快照同事务（v0.10.0 O2c 转 O7） */
  markReleased(input: MarkVersionReleasedInput): MarkVersionReleasedResult;
}

export interface VersionsEndpointOptions {
  /** 当前租约角色（**写路只在 `owner` 放行**，与 `/runner/*` 门闩同理由：同机双实例不得各写各的） */
  role: () => CoreRole;
  store?: VersionsStorePort;
}

export interface VersionsEndpointHandle {
  /**
   * 命中本模块路径 ⇒ 处理并返回 `true`；**不认领**返回 `false`（调用方继续往下走 / 404）。
   * 语义与 `RunnerEndpointHandle.handle` 逐字一致。
   */
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>;
}

const defaultStorePort: VersionsStorePort = {
  list: (ownerGroup) =>
    ownerGroup === undefined ? versionLedgerList() : versionLedgerList(ownerGroup),
  create: (input) => versionLedgerCreate(input),
  remove: (ownerGroup, version) => versionLedgerDelete(ownerGroup, version),
  setStatus: (input) => versionLedgerSetStatus(input),
  markReleased: (input) => markVersionReleased(input),
};

/** `owner_group` 查询参数 ⇒ store 入参（缺省 / 空串 ⇒ 全量，与 `web.ts` O3 面口径逐字一致） */
function readOwnerGroupParam(req: IncomingMessage): string | undefined {
  const raw = new URL(req.url ?? "/", "http://a2a-bridge.invalid").searchParams.get("owner_group");
  return raw === null || raw.length === 0 ? undefined : raw;
}

/** 归属在 JSON 体里的两种写法（camelCase = 本仓既有约定；snake_case = 板 / 宿主实际发出形态） */
const OWNER_GROUP_BODY_KEYS = ["ownerGroup", "owner_group"] as const;

/** {@link readOwnerGroupSource} 的返回：`undefined` = 三源皆未提供；`"invalid"` = 提供了但类型非法 */
type OwnerGroupSource = string | null | undefined | "invalid";

/** 归属缺失时回给调用方的 400 说明（body 两写法 + 查询参数，逐一点名） */
const OWNER_GROUP_BAD_REQUEST =
  "ownerGroup / owner_group 必须是字符串或 null（body 任一键，或查询参数 ?owner_group=）";

/**
 * **归属解析**（v0.10.0 F1 · 见文件头「归属解析」节）—— body `ownerGroup` → body `owner_group`
 * → 查询参数 `owner_group`，取第一个**已提供**者。
 *
 * 缺陷本体：此处只认 body `ownerGroup` ⇒ 板发出的 `owner_group` 被当缺省 ⇒ **落库恒 `NULL`**，
 * 而行按 `(owner_group, version)` 精确匹配校验 ⇒ 建出来的版号永远引用不到（`orch_version_unknown`）。
 *
 * **空串视同未提供**（`owner_group = ""` 的行既不命中身份档也不命中匿名档 ⇒ 不可引用的垃圾行）；
 * 显式 `null` = 主叫**指名**匿名档（与「未提供」区分，仅用于 warn 判定，落库同为 `NULL`）。
 * **不做 trim / 归一**（§2.1(4) 同口径）。
 */
function readOwnerGroupSource(body: Record<string, unknown>, req: IncomingMessage): OwnerGroupSource {
  for (const key of OWNER_GROUP_BODY_KEYS) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (raw === null) return null;
    if (typeof raw !== "string") return "invalid";
    if (raw.length > 0) return raw;
  }
  return readOwnerGroupParam(req);
}

export function createVersionsEndpoints(options: VersionsEndpointOptions): VersionsEndpointHandle {
  return new VersionsEndpoints(options);
}

class VersionsEndpoints implements VersionsEndpointHandle {
  private readonly options: VersionsEndpointOptions;
  private readonly store: VersionsStorePort;

  constructor(options: VersionsEndpointOptions) {
    this.options = options;
    this.store = options.store ?? defaultStorePort;
  }

  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const method = req.method ?? "GET";
    if (path === VERSIONS_COLLECTION_PATH) {
      if (method === "GET") {
        this.handleList(req, res);
        return true;
      }
      if (method === "POST") {
        await this.handleCreate(req, res);
        return true;
      }
      respondError(res, 405, ERR_VERSIONS_METHOD_NOT_ALLOWED, "本路径仅支持 GET / POST");
      return true;
    }
    if (path.startsWith(VERSIONS_ITEM_PREFIX)) {
      const rawSegment = path.slice(VERSIONS_ITEM_PREFIX.length);
      // O2c 路由：`/api/versions/{version}/status`（**恰好两段**，第二段 = `status`）。
      // 先于单段判据认领；多段但非 `…/status`（如 `a/b/c`）仍不认领、落 404。
      if (rawSegment.endsWith(VERSIONS_STATUS_SUFFIX)) {
        const versionRaw = rawSegment.slice(0, -VERSIONS_STATUS_SUFFIX.length);
        if (versionRaw.length === 0 || versionRaw.includes("/")) return false;
        const version = decodePathSegment(versionRaw);
        if (version === null) {
          respondError(res, 400, ERR_VERSIONS_BAD_REQUEST, "version 不是合法的 URI 片段");
          return true;
        }
        if (method !== "PATCH") {
          respondError(res, 405, ERR_VERSIONS_METHOD_NOT_ALLOWED, "本路径仅支持 PATCH");
          return true;
        }
        await this.handleSetStatus(req, res, version);
        return true;
      }
      // **只认单段** `/api/versions/{version}`（`DELETE`）；多段一律不认领 ⇒ 落 404。
      if (rawSegment.length === 0 || rawSegment.includes("/")) return false;
      const version = decodePathSegment(rawSegment);
      if (version === null) {
        respondError(res, 400, ERR_VERSIONS_BAD_REQUEST, "version 不是合法的 URI 片段");
        return true;
      }
      if (method !== "DELETE") {
        respondError(res, 405, ERR_VERSIONS_METHOD_NOT_ALLOWED, "本路径仅支持 DELETE");
        return true;
      }
      this.handleDelete(req, res, version);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  // GET /api/versions?owner_group=
  // ------------------------------------------------------------------

  /**
   * **板读投影唯一来源**（§2.1(2) / §2.3(1)）：台账整表（按 `owner_group` 过滤）。
   * 读路**不受 owner 门闩限制**（follower 读同一张表，无副作用）。
   * 出参形状与 `features-by-version` 面同族：`{ ok, source, observedAt, ownerGroup, count, versions[] }`。
   */
  private handleList(req: IncomingMessage, res: ServerResponse): void {
    const observedAt = new Date().toISOString();
    const ownerGroup = readOwnerGroupParam(req);
    let records: VersionLedgerRecord[];
    try {
      records = this.store.list(ownerGroup);
    } catch (err) {
      respondError(res, 500, ERR_VERSIONS_STORE_ERROR, `版本台账读失败：${toMessage(err)}`);
      return;
    }
    respondJson(res, 200, {
      ok: true,
      source: VERSIONS_SOURCE,
      observedAt,
      ownerGroup: ownerGroup ?? null,
      count: records.length,
      versions: records,
    });
  }

  // ------------------------------------------------------------------
  // POST /api/versions
  // ------------------------------------------------------------------

  /**
   * **建版**（§2.1(2)）：`201` + 新行；判据（shape / 可建态 / 重复）全在 store 写口，
   * 失败原样映射状态码（`400` / `409`）。
   *
   * 入参：`{ ownerGroup? | owner_group?, version, status?, date?, note? }` + 查询参数
   * `?owner_group=`（归属三源解析见 {@link readOwnerGroupSource}，v0.10.0 F1）。
   * 三源皆缺 ⇒ `null` = 匿名档（**不猜默认组**，另落 warn 留痕）。
   */
  private async handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.ownerGate(res)) return;
    const body = await readJsonBody(req);
    if (!body.ok) {
      respondError(res, body.status, body.code, body.message);
      return;
    }
    const ownerGroupSource = readOwnerGroupSource(body.body, req);
    if (ownerGroupSource === "invalid") {
      respondError(res, 400, ERR_VERSIONS_BAD_REQUEST, OWNER_GROUP_BAD_REQUEST);
      return;
    }
    const version = body.body["version"];
    if (typeof version !== "string") {
      respondError(res, 400, ERR_VERSIONS_BAD_REQUEST, "缺少 version（必填字符串，semver 形状）");
      return;
    }
    const status = readOptionalStringField(body.body, "status");
    if (status === "invalid") {
      respondError(res, 400, ERR_VERSIONS_BAD_REQUEST, "status 必须是字符串或 null");
      return;
    }
    const date = readOptionalStringField(body.body, "date");
    if (date === "invalid") {
      respondError(res, 400, ERR_VERSIONS_BAD_REQUEST, "date 必须是字符串或 null");
      return;
    }
    const note = readOptionalStringField(body.body, "note");
    if (note === "invalid") {
      respondError(res, 400, ERR_VERSIONS_BAD_REQUEST, "note 必须是字符串或 null");
      return;
    }
    if (ownerGroupSource === undefined) {
      bridgeLog.warn(
        "a2a-versions",
        `建版未带 owner_group（version=${version}）⇒ 落匿名档 NULL：配组环境下该行不可被按组的写口引用`,
        { version },
      );
    }
    const ownerGroup = ownerGroupSource ?? null;
    let outcome: VersionLedgerWriteResult;
    try {
      outcome = this.store.create({
        ownerGroup,
        version,
        ...(status !== undefined ? { status: status as VersionLedgerRecord["status"] } : {}),
        ...(date !== undefined ? { date } : {}),
        ...(note !== undefined ? { note } : {}),
      });
    } catch (err) {
      bridgeLog.error("a2a-versions", `建版异常（version=${version}）：${toMessage(err)}`);
      respondError(res, 500, ERR_VERSIONS_STORE_ERROR, `建版失败：${toMessage(err)}`);
      return;
    }
    if (!outcome.ok) {
      respondError(res, outcome.status, outcome.code, outcome.message);
      return;
    }
    respondJson(res, 201, { ok: true, version: outcome.record });
  }

  // ------------------------------------------------------------------
  // DELETE /api/versions/{version}?owner_group=
  // ------------------------------------------------------------------

  /**
   * **删版**（§2.1(2)）：成功 ⇒ **`204` 无体**（幂等语义由判据保证：重复发第二次落 `404`
   * `orch_version_unknown`，**不是** 500、也不会级联删 `releases`）。
   * 归属走**查询参数** `?owner_group=`（缺省 ⇒ 匿名档 `NULL`）—— 版号本身含 `.` 不宜再拼路径段。
   */
  private handleDelete(req: IncomingMessage, res: ServerResponse, version: string): void {
    if (!this.ownerGate(res)) return;
    const ownerGroup = readOwnerGroupParam(req) ?? null;
    let outcome: VersionLedgerWriteResult;
    try {
      outcome = this.store.remove(ownerGroup, version);
    } catch (err) {
      bridgeLog.error("a2a-versions", `删版异常（version=${version}）：${toMessage(err)}`);
      respondError(res, 500, ERR_VERSIONS_STORE_ERROR, `删版失败：${toMessage(err)}`);
      return;
    }
    if (!outcome.ok) {
      respondError(res, outcome.status, outcome.code, outcome.message);
      return;
    }
    sendNoContent(res);
  }

  // ------------------------------------------------------------------
  // PATCH /api/versions/{version}/status  (v0.10.0 O2c)
  // ------------------------------------------------------------------

  /**
   * **设状态**（v0.10.0 O2c · 改造文档 §2.1(2)）—— `{status}` ∈ 三态闭集。
   *
   * - `status = released` ⇒ 转 {@link markVersionReleased}：发版闸（O4 `evaluateReleaseGate`）→
   *   `projects` 形状校验 → 快照同事务（O7）。闸不过 ⇒ 原样映射状态码（`404` / `409`）；
   *   **`released` 是终态**：重复标记为幂等回读（不过闸），改态回退由 store 侧 409 挡。
   * - `status = notstart | active` ⇒ store 的 `versionLedgerSetStatus`（人工改态；现态 `released`
   *   ⇒ 409 `orch_version_released_locked`，不可回退）。
   *
   * 归属走 {@link readOwnerGroupSource} 的三源解析（body `ownerGroup` / body `owner_group` /
   * 查询参数 `?owner_group=`；皆缺 = 匿名档），与 `POST` 建版同口径。
   * 出参一律带 {@link GUARDRAILS_RECEIPT}（节流参数写进回执）。
   */
  private async handleSetStatus(
    req: IncomingMessage,
    res: ServerResponse,
    version: string,
  ): Promise<void> {
    if (!this.ownerGate(res)) return;
    const body = await readJsonBody(req);
    if (!body.ok) {
      respondError(res, body.status, body.code, body.message);
      return;
    }
    const status = body.body["status"];
    if (typeof status !== "string" || !isVersionLedgerStatus(status)) {
      respondError(
        res,
        400,
        ERR_VERSIONS_BAD_REQUEST,
        `status 必须是三态闭集之一（notstart / active / released），收到 ${JSON.stringify(status)}`,
      );
      return;
    }
    const ownerGroupSource = readOwnerGroupSource(body.body, req);
    if (ownerGroupSource === "invalid") {
      respondError(res, 400, ERR_VERSIONS_BAD_REQUEST, OWNER_GROUP_BAD_REQUEST);
      return;
    }
    const note = readOptionalStringField(body.body, "note");
    if (note === "invalid") {
      respondError(res, 400, ERR_VERSIONS_BAD_REQUEST, "note 必须是字符串或 null");
      return;
    }
    const ownerGroup = ownerGroupSource ?? null;

    if (status === "released") {
      const changelogAnchor = readOptionalStringField(body.body, "changelogAnchor");
      if (changelogAnchor === "invalid") {
        respondError(res, 400, ERR_VERSIONS_BAD_REQUEST, "changelogAnchor 必须是字符串或 null");
        return;
      }
      let outcome: MarkVersionReleasedResult;
      try {
        outcome = this.store.markReleased({
          ownerGroup,
          version,
          changelogAnchor: changelogAnchor ?? null,
          projects: body.body["projects"],
          note: note ?? null,
        });
      } catch (err) {
        bridgeLog.error("a2a-versions", `标记 released 异常（version=${version}）：${toMessage(err)}`);
        respondError(res, 500, ERR_VERSIONS_STORE_ERROR, `标记 released 失败：${toMessage(err)}`);
        return;
      }
      if (!outcome.ok) {
        respondError(res, outcome.status, outcome.code, outcome.message);
        return;
      }
      respondJson(res, 200, {
        ok: true,
        status: "released",
        version: outcome.ledger,
        statusMigrated: outcome.statusMigrated,
        snapshotWritten: outcome.snapshotWritten,
        gateCounts: outcome.gateCounts,
        guardrails: GUARDRAILS_RECEIPT,
      });
      return;
    }

    let outcome: VersionLedgerWriteResult;
    try {
      outcome = this.store.setStatus({ ownerGroup, version, status, note: note ?? null });
    } catch (err) {
      bridgeLog.error("a2a-versions", `设状态异常（version=${version}）：${toMessage(err)}`);
      respondError(res, 500, ERR_VERSIONS_STORE_ERROR, `设状态失败：${toMessage(err)}`);
      return;
    }
    if (!outcome.ok) {
      respondError(res, outcome.status, outcome.code, outcome.message);
      return;
    }
    respondJson(res, 200, {
      ok: true,
      status: outcome.record.status,
      version: outcome.record,
      guardrails: GUARDRAILS_RECEIPT,
    });
  }

  /**
   * owner 门闩（**仅写路**）：follower ⇒ `503` `orch_versions_not_owner`。
   * 与 `runner.ts#handle` 同判据同理由：同机双实例下不得两个写入面并存（避免台账写意图分叉）。
   */
  private ownerGate(res: ServerResponse): boolean {
    if (this.options.role() === "owner") return true;
    respondError(
      res,
      503,
      ERR_VERSIONS_NOT_OWNER,
      "本桥实例非 core 租约 owner（写入权在其它实例）：版本台账写口仅 owner 提供",
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// 传输层小工具（刻意自带，不从 `runner.ts` 引私有函数）
// ---------------------------------------------------------------------------

/** 失败信封：`{ ok: false, error: { code, message } }`（§2.1(2) 统一信封） */
function respondError(res: ServerResponse, status: number, code: string, message: string): void {
  respondJson(res, status, { ok: false, error: { code, message } });
}

/** 成功但无资源表示：`204`（与 `runner.ts#sendNoContent` 同处理 `headersSent` 竞态） */
function sendNoContent(res: ServerResponse): void {
  if (res.headersSent || res.writableEnded) return;
  try {
    res.writeHead(204);
    res.end();
  } catch {
    // 客户端已断开：无可写目标，忽略
  }
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  try {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(payload));
  } catch {
    // 客户端已断开：无可写目标，忽略
  }
}

function decodePathSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * 可选字符串字段：`undefined`（未提供 = 不写）/ `string` / `null` 三种合法；
 * 其它类型 ⇒ `"invalid"`（调用方据此 400）。
 */
function readOptionalStringField(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined | "invalid" {
  const raw = body[key];
  if (raw === undefined || raw === null) return raw ?? undefined;
  return typeof raw === "string" ? raw : "invalid";
}

type BodyOutcome =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; code: string; message: string };

async function readJsonBody(req: IncomingMessage): Promise<BodyOutcome> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
      size += buf.length;
      if (size > VERSIONS_MAX_BODY_BYTES) {
        return {
          ok: false,
          status: 413,
          code: ERR_VERSIONS_PAYLOAD_TOO_LARGE,
          message: `请求体超过 ${VERSIONS_MAX_BODY_BYTES} 字节上限`,
        };
      }
      chunks.push(buf);
    }
  } catch (err) {
    return {
      ok: false,
      status: 400,
      code: ERR_VERSIONS_BAD_REQUEST,
      message: `请求体读取失败：${toMessage(err)}`,
    };
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) {
    return { ok: false, status: 400, code: ERR_VERSIONS_BAD_REQUEST, message: "请求体为空（需 JSON 对象）" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, status: 400, code: ERR_VERSIONS_BAD_REQUEST, message: "请求体不是合法 JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 400, code: ERR_VERSIONS_BAD_REQUEST, message: "请求体必须是 JSON 对象" };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
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
