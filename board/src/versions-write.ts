/**
 * 板 → 引擎**版本台账写口**（v0.10.0 B2 · REQ-v0.10.0-2026-09-24-01 · 改造文档 §2.1(2) / §2.3(2)/(3)）。
 *
 * 版本状态的事实源已在**引擎（orch）**：建 / 删 / 设状态三处写面一律**向引擎发意图**，
 * 板**不判闸**（不复核 semver 形状 / 重复 / released / 名下卡 / 迁移矩阵），把引擎的**错误码
 * 原样展示**（未知码不 fail-closed），引擎不可达 ⇒ **硬失败**（`502 bridge_unreachable`），
 * **不做本地下沉兜底写**（不既写本地台账又读引擎）。
 *
 * ## 端点（与 `bridge/transports/http.ts` 的 `/api/versions*` 委托同端口 = 板 `mcpBaseUrl`，缺省 8787）
 *
 * | 方法 | 路径 | 载荷 |
 * |---|---|---|
 * | `POST` | `/api/versions` | body `{ownerGroup, version}`（camelCase，与 create 端点约定一致） |
 * | `DELETE` | `/api/versions/{version}?owner_group=` | 归属走查询参数（版号含 `.` 不拼多段路径） |
 * | `PATCH` | `/api/versions/{version}/status` | body `{ownerGroup, status}` |
 *
 * 信封 = 引擎统一形状：成功 `{ok:true, …}`；失败 `{ok:false, error:{code,message}}`
 * （§2.1(2)）。**`PATCH …/status`（O2c）为跨节点依赖**：本模块按改造文档契约调用，端点未就绪时
 * 引擎回 404，板照常把该响应**原样展示**（不 fail-closed、不本地兜底）。
 *
 * ## 解析与网络分离
 *
 * {@link parseVersionWriteResponse} / {@link describeVersionWriteError} 为**纯函数**（离线自测），
 * `create` / `remove` / `setStatus` 只负责 fetch + 委派解析。业务错误（引擎 4xx/5xx）**不抛**，
 * 一律归一为 {@link VersionWriteFailure}；仅运行环境无 fetch 实现这一编程/环境缺口也算不可达。
 */

/** 引擎写面缺省基址（= 编排桥 MCP/可写面端口，与 `feature-schedule.ts` 同源）。 */
export const DEFAULT_ENGINE_BASE_URL = "http://127.0.0.1:8787";

/**
 * 引擎不可达（传输层失败 / 无 fetch）的统一错误码。与板全站 `bridge_unreachable`
 * （`web/views.ts` 的 {@link import("./web/views.js").BRIDGE_UNREACHABLE_CODE}）逐字相同；
 * 本模块自带一份常量以避免网络模块回指视图层。
 */
export const ENGINE_UNREACHABLE_CODE = "bridge_unreachable";

export interface VersionsWriteOptions {
  /** 引擎基址，缺省 {@link DEFAULT_ENGINE_BASE_URL}。 */
  baseUrl?: string;
  /** fetch 实现（测试注入用）；缺省 `globalThis.fetch`。 */
  fetchImpl?: typeof fetch;
  /** 单次请求超时（ms），缺省 10_000。 */
  timeoutMs?: number;
}

/** 建 / 删版的共用入参：`ownerGroup` = `null` ⇒ 引擎匿名档（NULL），`version` 必填。 */
export interface VersionWriteInput {
  ownerGroup: string | null;
  version: string;
}

/** 设状态入参：`status` 为三态串（值域由调用方保证；引擎侧另有校验）。 */
export interface VersionStatusWriteInput extends VersionWriteInput {
  status: string;
}

export interface VersionWriteSuccess {
  ok: true;
  /** 引擎 HTTP 状态（成功档，仅留痕；板回显状态码由 handler 决定）。 */
  httpStatus: number;
  /** 引擎回显的版号（缺省回填入参；`remove` 204 无体 ⇒ 调用方用入参）。 */
  version: string | null;
  /** 引擎回显的状态（`remove` 无体 / 无该键 ⇒ `null`）。 */
  status: string | null;
}

export interface VersionWriteFailure {
  ok: false;
  /** 引擎 HTTP 状态；传输层失败 ⇒ `502`。 */
  httpStatus: number;
  /** 引擎错误码（`orch_*` / `not_found` …）或 {@link ENGINE_UNREACHABLE_CODE}。 */
  code: string;
  /** 引擎原始错误文案（未知码场景由 {@link describeVersionWriteError} 原样透出）。 */
  message: string;
}

export type VersionWriteOutcome = VersionWriteSuccess | VersionWriteFailure;

export interface VersionsWriteClient {
  create(input: VersionWriteInput): Promise<VersionWriteOutcome>;
  remove(input: VersionWriteInput): Promise<VersionWriteOutcome>;
  setStatus(input: VersionStatusWriteInput): Promise<VersionWriteOutcome>;
}

// ---------------------------------------------------------------------------
// 纯函数（无 I/O；单测目标）
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * 引擎 `orch_*` 错误码的**显示映射表**（§2.3(3)「orch_* 四码走板错误显示映射表」）。
 * **只做展示层转写**：命中 ⇒ 业务化中文；未命中（含 `not_found` / 未来新码）⇒ **原样展示**
 * 引擎文案（`engineMessage`），**绝不 fail-closed、绝不吞成通用错误**。
 */
const ENGINE_CODE_TEXT: Readonly<Record<string, string>> = {
  orch_version_exists: "该版本已存在（同一组织内版号唯一）⇒ 引擎拒绝重复创建。",
  orch_version_unknown: "该版本不在引擎版本台账中（可能已被删除或从未登记）。",
  orch_version_released_locked: "该版本已发版（released）⇒ 引擎拒绝删除（发版事实不可撤销）。",
  orch_version_open_cards: "该版本名下仍有未收口需求（completed / cancelled 之外的卡）⇒ 引擎拒绝删除，请先收口。",
  orch_version_not_converged: "该版本名下需求未全部收尾（或全为 cancelled、无交付）⇒ 引擎发版闸拒绝标记 released。",
  orch_version_invalid_shape: "版本号不是 x.y.z 形式（引擎侧 semver 形状校验）。",
  orch_version_status_invalid: "目标状态不合法（引擎侧三态值域校验）。",
  orch_versions_not_owner: "本桥实例非 core 租约 owner（版本台账写口仅 owner 提供）⇒ 引擎拒绝写入。",
  orch_versions_store_error: "引擎版本台账写失败（引擎侧存储错误）。",
};

/**
 * 引擎错误码 → 展示文案（纯函数）：已知码给业务化中文，其余**原样透出引擎文案**。
 * 空文案也不是 fail-closed —— 兜底回显错误码本身。
 */
export function describeVersionWriteError(code: string, engineMessage: string): string {
  const mapped = ENGINE_CODE_TEXT[code];
  if (mapped !== undefined) return mapped;
  const raw = engineMessage.trim();
  return raw !== "" ? raw : code;
}

/**
 * 解析引擎写响应（**纯函数**）：`2xx` ⇒ 成功（读回 `version.version` / `version.status`，
 * 缺键容错 `null`）；非 `2xx` ⇒ 失败（读统一信封；`error` 为对象取 `code`/`message`，
 * 为字符串则整串当 `code` 兼 `message`；非 JSON / 空体 ⇒ `response_invalid` 附 HTTP 码）。
 * **绝不抛**、**绝不 fail-closed** —— 任何形状都归一为一个可展示的结果。
 */
export function parseVersionWriteResponse(httpStatus: number, bodyText: string): VersionWriteOutcome {
  const text = bodyText.trim();
  if (httpStatus >= 200 && httpStatus < 300) {
    if (text === "") return { ok: true, httpStatus, version: null, status: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return {
        ok: false,
        httpStatus,
        code: "response_invalid",
        message: `引擎返回 2xx 但响应不是合法 JSON：${text.slice(0, 200)}`,
      };
    }
    if (isRecord(parsed) && parsed.ok === true) {
      const rec = isRecord(parsed.version) ? parsed.version : null;
      return {
        ok: true,
        httpStatus,
        version: rec === null ? null : str(rec.version),
        status: rec === null ? null : str(rec.status),
      };
    }
    return {
      ok: false,
      httpStatus,
      code: "response_invalid",
      message: `引擎返回 2xx 但信封缺 ok:true（原文：${text.slice(0, 200)}）`,
    };
  }
  return parseVersionWriteFailure(httpStatus, text);
}

function parseVersionWriteFailure(httpStatus: number, text: string): VersionWriteFailure {
  if (text !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = undefined;
    }
    if (isRecord(parsed)) {
      const err = parsed["error"];
      if (isRecord(err)) {
        const code = str(err["code"]) ?? str(parsed["code"]) ?? "unknown";
        const message = str(err["message"]) ?? code;
        return { ok: false, httpStatus, code, message };
      }
      if (typeof err === "string" && err.trim() !== "") {
        const code = str(parsed["code"]) ?? err.trim();
        return { ok: false, httpStatus, code, message: err.trim() };
      }
      const code = str(parsed["code"]);
      if (code !== null) {
        return { ok: false, httpStatus, code, message: str(parsed["message"]) ?? code };
      }
    }
  }
  const snippet = text === "" ? "" : `：${text.slice(0, 200)}`;
  return {
    ok: false,
    httpStatus,
    code: "response_invalid",
    message: `引擎返回 HTTP ${httpStatus}${snippet}`,
  };
}

// ---------------------------------------------------------------------------
// 网络层
// ---------------------------------------------------------------------------

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** 归属查询参数：`null` / 空串 ⇒ 不带参（引擎匿名档 = NULL）；否则带上（trim 后）。 */
function ownerGroupQuery(ownerGroup: string | null): string {
  const org = ownerGroup === null ? "" : ownerGroup.trim();
  return org === "" ? "" : `?owner_group=${encodeURIComponent(org)}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function request(
  options: VersionsWriteOptions,
  method: "POST" | "DELETE" | "PATCH",
  path: string,
  body: string | undefined,
): Promise<VersionWriteOutcome> {
  const base = normalizeBaseUrl(options.baseUrl ?? DEFAULT_ENGINE_BASE_URL);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      httpStatus: 502,
      code: ENGINE_UNREACHABLE_CODE,
      message: "运行环境无 fetch 实现 ⇒ 无法触达引擎版本写端点",
    };
  }
  let res: Response;
  try {
    res = await fetchImpl(`${base}${path}`, {
      method,
      headers: body === undefined
        ? { accept: "application/json" }
        : { accept: "application/json", "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (err) {
    return {
      ok: false,
      httpStatus: 502,
      code: ENGINE_UNREACHABLE_CODE,
      message: `引擎不可达（${method} ${path}）：${errText(err)}`,
    };
  }
  const text = await res.text().catch(() => "");
  return parseVersionWriteResponse(res.status, text);
}

/**
 * 建引擎版本写客户端。三个方法各发一次 HTTP（无重试、无本地兜底）：板把意图交给引擎，
 * 引擎的错误码由 {@link describeVersionWriteError} 决定展示文案（handler 层）。
 */
export function createVersionsWriteClient(options: VersionsWriteOptions = {}): VersionsWriteClient {
  const options0: VersionsWriteOptions = { ...options, baseUrl: options.baseUrl ?? DEFAULT_ENGINE_BASE_URL };
  return {
    create(input: VersionWriteInput): Promise<VersionWriteOutcome> {
      return request(
        options0,
        "POST",
        "/api/versions",
        JSON.stringify({ ownerGroup: input.ownerGroup, version: input.version }),
      );
    },
    remove(input: VersionWriteInput): Promise<VersionWriteOutcome> {
      return request(
        options0,
        "DELETE",
        `/api/versions/${encodeURIComponent(input.version)}${ownerGroupQuery(input.ownerGroup)}`,
        undefined,
      );
    },
    setStatus(input: VersionStatusWriteInput): Promise<VersionWriteOutcome> {
      return request(
        options0,
        "PATCH",
        `/api/versions/${encodeURIComponent(input.version)}/status`,
        JSON.stringify({ ownerGroup: input.ownerGroup, status: input.status }),
      );
    },
  };
}
