/**
 * **Project Version 台账端点**（v0.10.1 O5 · 改造文档 §2 C-6 / C-7 / C-13 / §3 orch 段）——
 * `POST` / `DELETE` / `GET` 三路的 HTTP 面。
 *
 * ## 为什么另立文件
 * Group 档的 `versions-endpoints.ts` 已近 600 行、且其 `versions[]` 出参形状是**硬约束**（逐字不可变）。
 * 本模块与它**同族不同档**（键多一维 `project_id`、态值域 `open|released`、发版不经本口），
 * 混改一处容易把两档的判据互相污染 ⇒ 另立文件，**复用方向单向**（本模块 → `versions-endpoints.ts`
 * 的归属解析三源 / 统一信封 / JSON 体读取），Group 档不引本模块（避免循环依赖）。
 *
 * ## 与 Group 档的三条语义差（不得混谈）
 * 1. **两级键**：身份 = `(owner_group, project_id, version)`（Group 档 = `(owner_group, version)`）；
 *    ⇒ 归属解析之外**再加第四源 `project_id`**（body `projectId` → body `project_id` →
 *    查询参数 `?project_id=`，与归属解析同族、同一实现）。
 * 2. **没有发版口**：本模块**不**提供 `PATCH …/status` —— project 侧的 `released` 只能由
 *    **Group 级发版动作在同事务内级联**置入（C-4）。故**建版恒 `open`**（入参带 `status` ⇒ 400），
 *    值域只有两态（`open` / `released`），也**不进** `notstart → active` 自动转换（那是 Group 侧节奏）。
 * 3. **`releasable` 是展示字段、不是门**：本模块的任何拒绝码都与它无关（判据唯一来源
 *    = `feature-tools.ts#evaluateProjectReleaseGate`，经 {@link projectVersionsView} 透出）。
 *
 * ## 路由（三段，其余一律「不认领」⇒ 落 404）
 * | 路径 | 方法 | 成功码 |
 * |---|---|---|
 * | `/api/project-versions` | `GET` | `200` + 清单（可选 `?owner_group=` / `?project_id=` 收窄，**缺省全表**） |
 * | `/api/project-versions` | `POST` | `201` + 单行 |
 * | `/api/project-versions/{project_id}/{version}` | `DELETE` | `204`（无体） |
 *
 * **单行路径按恰好两段**认领（两段皆 URL 片段解码）；一段或多段 ⇒ 不认领（落 404，不预占别的形状）。
 * `version` 含 `.` 不宜作路径段 ⇒ 与 Group 档同款：**集合路径 + 查询参数**做读写的归属定位，
 * 只有 `DELETE` 用路径段（`project_id` 也是标识符，可安全作段）。
 *
 * ## 信封 / 门闩（与 Group 档逐字同构）
 * 成功 `{ ok: true, … }`；失败 `{ ok: false, error: { code, message } }`。
 * `code` ∈ `orch_*` 闭集（C-13）：`orch_project_version_invalid_shape` / `_exists` / `_unknown` /
 * `_released_locked` / `orch_project_attribution_conflict`，传输层码沿用 `orch_versions_*`。
 * **写路只在 `owner` 放行**（follower ⇒ `503`），读路不受门闩 —— 与 `/runner/*`、`/api/versions*` 同判据。
 *
 * ## 删版判据（C-6 ③④，本模块执法在 store 纯存在性口之上）
 * `404` 无此行 → `409` 已 `released`（一经发版即冻结）→ `409` **名下有归属**（一经被归属引用即不可删）
 * → 通过才真删（**不级联删归属行**，C-16）。判序即「先问在不在、再问冻没冻、最后问被引用没」。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CoreRole } from "../runtime/core-lease.js";
import {
  ERR_PROJECT_VERSION_UNKNOWN,
  featureProjectStateCounts,
  projectVersionCreate,
  projectVersionDelete,
  projectVersionGet,
  type ProjectVersionCardCounts,
  type ProjectVersionCreateInput,
  type ProjectVersionRecord,
  type ProjectVersionWriteResult,
} from "../session/store.js";
import { ERR_ATTRIBUTION_CONFLICT, ERR_PROJECT_VERSION_RELEASED_LOCKED } from "./feature-tools.js";
import {
  decodePathSegment,
  ERR_VERSIONS_BAD_REQUEST,
  ERR_VERSIONS_METHOD_NOT_ALLOWED,
  ERR_VERSIONS_NOT_OWNER,
  ERR_VERSIONS_STORE_ERROR,
  OWNER_GROUP_BAD_REQUEST,
  projectVersionsView,
  readFieldSource,
  readJsonBody,
  readOptionalStringField,
  readOwnerGroupParam,
  respondError,
  respondJson,
  sendNoContent,
  toMessage,
  type FieldSource,
  type ProjectVersionViewEntry,
} from "./versions-endpoints.js";
import { bridgeLog } from "./bridge-log.js";

/** 集合路径（GET / POST 共用） */
export const PROJECT_VERSIONS_COLLECTION_PATH = "/api/project-versions";
/** 单行路径前缀（`DELETE /api/project-versions/{project_id}/{version}`） */
const PROJECT_VERSIONS_ITEM_PREFIX = "/api/project-versions/";

/** `project_id` 在 JSON 体里的两种写法（同族于归属的 camel / snake 双式） */
const PROJECT_ID_BODY_KEYS = ["projectId", "project_id"] as const;

/** GET 出参 `source` 串（读投影的事实源声明，与 Group 档同风格） */
const PROJECT_VERSIONS_SOURCE =
  "引擎 project 台账 `project_versions` 表（每请求现读；板为读投影，非事实源）" +
  " + `releasable` 判据现算（归属表 `feature_projects` 派生，展示字段、不构成发版口）";

/** `project_id` 缺失 / 类型非法时回给调用方的 400 说明（body 两写法 + 查询参数，逐一点名） */
export const PROJECT_ID_BAD_REQUEST =
  "projectId / project_id 必须是字符串（body 任一键，或查询参数 ?project_id=）";

export interface ProjectVersionsEndpointOptions {
  /** 当前租约角色（**写路只在 `owner` 放行**，与 Group 档门闩同理由：同机双实例不得各写各的） */
  role: () => CoreRole;
}

export interface ProjectVersionsEndpointHandle {
  /**
   * 命中本模块路径 ⇒ 处理并返回 `true`；**不认领**返回 `false`（调用方继续往下走 / 404）。
   * 语义与 `VersionsEndpointHandle.handle` 逐字一致。
   */
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>;
}

export function createProjectVersionsEndpoints(
  options: ProjectVersionsEndpointOptions,
): ProjectVersionsEndpointHandle {
  return new ProjectVersionsEndpoints(options);
}

class ProjectVersionsEndpoints implements ProjectVersionsEndpointHandle {
  private readonly options: ProjectVersionsEndpointOptions;

  constructor(options: ProjectVersionsEndpointOptions) {
    this.options = options;
  }

  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const method = req.method ?? "GET";
    if (path === PROJECT_VERSIONS_COLLECTION_PATH) {
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
    if (path.startsWith(PROJECT_VERSIONS_ITEM_PREFIX)) {
      const rest = path.slice(PROJECT_VERSIONS_ITEM_PREFIX.length);
      // **只认恰好两段** `/api/project-versions/{project_id}/{version}`；其余形状不认领 ⇒ 落 404。
      const slash = rest.indexOf("/");
      if (slash <= 0 || slash === rest.length - 1) return false;
      if (rest.indexOf("/", slash + 1) !== -1) return false;
      const projectId = decodePathSegment(rest.slice(0, slash));
      const version = decodePathSegment(rest.slice(slash + 1));
      if (projectId === null || version === null) {
        respondError(res, 400, ERR_VERSIONS_BAD_REQUEST, "project_id / version 不是合法的 URI 片段");
        return true;
      }
      if (method !== "DELETE") {
        respondError(res, 405, ERR_VERSIONS_METHOD_NOT_ALLOWED, "本路径仅支持 DELETE");
        return true;
      }
      this.handleDelete(req, res, projectId, version);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  // GET /api/project-versions?owner_group=&project_id=
  // ------------------------------------------------------------------

  /**
   * **project 档读投影**：与 `GET /api/versions` 的顶层 `projectVersions[]` **同一实现**
   * （{@link projectVersionsView} ⇒ 形状单点，两处不漂移）。
   * 过滤语义照 Group 档：`?owner_group=` 缺省 ⇒ **全表**、空串 ⇒ 全表、字符串 ⇒ 本组；
   * `?project_id=` 为**可选收窄**（改造文档 §6 登记的体量对策）。
   * 读路**不受 owner 门闩限制**。本口**就是** project 档 ⇒ 读失败直接 `500`（两档分立只适用于
   * Group 面的合并出参，不适用于本口自身）。
   */
  private handleList(req: IncomingMessage, res: ServerResponse): void {
    const ownerGroup = readOwnerGroupParam(req);
    const projectIdFilter = readFieldSource({}, req, PROJECT_ID_BODY_KEYS[0], PROJECT_ID_BODY_KEYS[1], "project_id");
    let entries: ProjectVersionViewEntry[];
    try {
      entries = projectVersionsView(ownerGroup);
    } catch (err) {
      respondError(res, 500, ERR_VERSIONS_STORE_ERROR, `project 台账读失败：${toMessage(err)}`);
      return;
    }
    const rows =
      typeof projectIdFilter === "string"
        ? entries.filter((entry) => entry.project_id === projectIdFilter)
        : entries;
    respondJson(res, 200, {
      ok: true,
      source: PROJECT_VERSIONS_SOURCE,
      observedAt: new Date().toISOString(),
      ownerGroup: ownerGroup ?? null,
      projectId: typeof projectIdFilter === "string" ? projectIdFilter : null,
      count: rows.length,
      projectVersions: rows,
    });
  }

  // ------------------------------------------------------------------
  // POST /api/project-versions
  // ------------------------------------------------------------------

  /**
   * **建版**（C-6 ①②）：`201` + 新行；形状判据（semver / 空串）与判重（同键 409）**全在 store 写口**，
   * 本层只做传输层形状 + 归属门闩 + 状态码映射 ⇒ 同一请求重复发不产生第二行。
   *
   * 入参：`{ ownerGroup? | owner_group?, projectId? | project_id?, version, date?, note? }`
   * + 查询参数 `?owner_group=` / `?project_id=`。归属与 `project_id` 各走**同族三源**解析。
   * 归属三源皆缺 ⇒ `null` = 匿名档（**不猜默认组**，另落 warn 留痕，同 Group 档口径）。
   * **无 `status` 入参**：建版恒 `open`（发版不经本口，C-4）⇒ 带该键直接 400，不静默忽略。
   */
  private async handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.ownerGate(res)) return;
    const body = await readJsonBody(req);
    if (!body.ok) {
      respondError(res, body.status, body.code, body.message);
      return;
    }
    const ownerGroupSource = readFieldSource(
      body.body,
      req,
      "ownerGroup",
      "owner_group",
      "owner_group",
    );
    if (ownerGroupSource === "invalid") {
      respondError(res, 400, ERR_VERSIONS_BAD_REQUEST, OWNER_GROUP_BAD_REQUEST);
      return;
    }
    const projectIdSource: FieldSource = readFieldSource(
      body.body,
      req,
      PROJECT_ID_BODY_KEYS[0],
      PROJECT_ID_BODY_KEYS[1],
      "project_id",
    );
    if (projectIdSource === "invalid") {
      respondError(res, 400, ERR_VERSIONS_BAD_REQUEST, PROJECT_ID_BAD_REQUEST);
      return;
    }
    if (projectIdSource === undefined || projectIdSource === null) {
      respondError(res, 400, ERR_VERSIONS_BAD_REQUEST, `缺少 project_id（必填字符串）：${PROJECT_ID_BAD_REQUEST}`);
      return;
    }
    const version = body.body["version"];
    if (typeof version !== "string") {
      respondError(res, 400, ERR_VERSIONS_BAD_REQUEST, "缺少 version（必填字符串，semver 形状）");
      return;
    }
    if ("status" in body.body) {
      respondError(
        res,
        400,
        ERR_VERSIONS_BAD_REQUEST,
        "project 版本不接受 status 入参：建版恒 open（released 只能由 Group 级发版动作同事务级联置入）",
      );
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
        "a2a-project-versions",
        `建 project 版未带 owner_group（project_id=${projectIdSource} · version=${version}）⇒ 落匿名档 NULL：配组环境下该行不可被按组的写口引用`,
        { projectId: projectIdSource, version },
      );
    }
    const input: ProjectVersionCreateInput = {
      ownerGroup: ownerGroupSource ?? null,
      projectId: projectIdSource,
      version,
      ...(date !== undefined ? { date } : {}),
      ...(note !== undefined ? { note } : {}),
    };
    let outcome: ProjectVersionWriteResult;
    try {
      outcome = projectVersionCreate(input);
    } catch (err) {
      bridgeLog.error(
        "a2a-project-versions",
        `建 project 版异常（project_id=${projectIdSource} · version=${version}）：${toMessage(err)}`,
      );
      respondError(res, 500, ERR_VERSIONS_STORE_ERROR, `建 project 版失败：${toMessage(err)}`);
      return;
    }
    if (!outcome.ok) {
      respondError(res, outcome.status, outcome.code, outcome.message);
      return;
    }
    respondJson(res, 201, { ok: true, projectVersion: outcome.record });
  }

  // ------------------------------------------------------------------
  // DELETE /api/project-versions/{project_id}/{version}?owner_group=
  // ------------------------------------------------------------------

  /**
   * **删版**（C-6 ③④）：判序 = 存在性 → `released` 冻结 → 归属引用，全过才真删；成功 ⇒ `204` 无体。
   *
   * 三个拒绝码各对应一条不可让的语义：
   * - `404` `orch_project_version_unknown` —— 幂等语义由判据保证（重复发第二次落 404，**不是** 500）；
   * - `409` `orch_project_version_released_locked` —— **发版事实不可撤销**，一经 `released` 即冻结（④）；
   * - `409` `orch_project_attribution_conflict` —— **一经被归属引用即不可改 / 不可删**（③）。
   *   该码在 C-13 里原本是归属写冲突码；闭集内**没有**专门的「被引用不可删」码，而「删掉一个已被
   *   承诺集引用的版本」与「改写它」是同一件事的两种写法 ⇒ 复用同码（回执登记为偏离项）。
   *
   * 「有归属」的判据用 `featureProjectStateCounts().total`（**单条 GROUP BY、无 N+1**）：
   * 计数经 `INNER JOIN features` 派生 ⇒ 归属行必伴一个存在的需求（本仓无删 Feature 的路径）。
   */
  private handleDelete(
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    version: string,
  ): void {
    if (!this.ownerGate(res)) return;
    const ownerGroup = readOwnerGroupParam(req) ?? null;
    let row: ProjectVersionRecord | null;
    try {
      row = projectVersionGet(ownerGroup, projectId, version);
    } catch (err) {
      bridgeLog.error(
        "a2a-project-versions",
        `删版判据读失败（project_id=${projectId} · version=${version}）：${toMessage(err)}`,
      );
      respondError(res, 500, ERR_VERSIONS_STORE_ERROR, `删版失败：${toMessage(err)}`);
      return;
    }
    if (row === null) {
      respondError(
        res,
        404,
        ERR_PROJECT_VERSION_UNKNOWN,
        `project 台账无此行（owner_group=${ownerGroup === null ? "NULL" : `"${ownerGroup}"`} · project_id=${projectId} · version=${version}）`,
      );
      return;
    }
    if (row.status === "released") {
      respondError(
        res,
        409,
        ERR_PROJECT_VERSION_RELEASED_LOCKED,
        `project 版本已 released，冻结不可删（owner_group=${ownerGroup === null ? "NULL" : `"${ownerGroup}"`} · project_id=${projectId} · version=${version}）：发版事实不可撤销，要动须抬到未 released 的新号`,
      );
      return;
    }
    let counts: ProjectVersionCardCounts;
    try {
      counts = featureProjectStateCounts(ownerGroup, projectId, version);
    } catch (err) {
      bridgeLog.error(
        "a2a-project-versions",
        `归属计数读失败（project_id=${projectId} · version=${version}）：${toMessage(err)}`,
      );
      respondError(res, 500, ERR_VERSIONS_STORE_ERROR, `删版失败：${toMessage(err)}`);
      return;
    }
    if (counts.total > 0) {
      respondError(
        res,
        409,
        ERR_ATTRIBUTION_CONFLICT,
        `project 版本名下有 ${counts.total} 条归属（open=${counts.open} completed=${counts.completed} cancelled=${counts.cancelled}），一经被归属引用即不可删（C-6 ③）：需先收掉这些归属`,
      );
      return;
    }
    let outcome: ProjectVersionWriteResult;
    try {
      outcome = projectVersionDelete(ownerGroup, projectId, version);
    } catch (err) {
      bridgeLog.error(
        "a2a-project-versions",
        `删版异常（project_id=${projectId} · version=${version}）：${toMessage(err)}`,
      );
      respondError(res, 500, ERR_VERSIONS_STORE_ERROR, `删版失败：${toMessage(err)}`);
      return;
    }
    if (!outcome.ok) {
      respondError(res, outcome.status, outcome.code, outcome.message);
      return;
    }
    sendNoContent(res);
  }

  /**
   * owner 门闩（**仅写路**）：follower ⇒ `503` `orch_versions_not_owner`。
   * 与 Group 档 / `runner.ts` 同判据同理由：同机双实例下不得两个写入面并存。
   */
  private ownerGate(res: ServerResponse): boolean {
    if (this.options.role() === "owner") return true;
    respondError(
      res,
      503,
      ERR_VERSIONS_NOT_OWNER,
      "本桥实例非 core 租约 owner（写入权在其它实例）：project 版本台账写口仅 owner 提供",
    );
    return false;
  }
}
