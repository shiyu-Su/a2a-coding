/**
 * 板写面守卫与入参解析（BD7 · BD8 扩两条 · BD9 再扩两条 · BD16 修「来源不可知」误判 · v0.9.2 M3 再扩一条 ·
 * v0.9.4 A1/A3 再扩一条 · BD4 再扩一条）—— **纯函数**（不依赖 http 类型，便于离线单测）。
 *
 * 放开的写路径共九条，方法**恒为 POST**： * - `POST /requirements`          —— 提需求（BD7）；
 * - `POST /features/:id/turn`     —— 触发宿主桥的一轮（BD8）；
 * - `POST /host/:org/stop`        —— 停桥（BD8，**与上两条同规格**：守卫头 / 同源校验）；
 * - `POST /features/:id/confirm`  —— 人工确认指令（BD9，投消息给 agent，**板不批准**）；
 * - `POST /features/:id/answer`   —— 澄清回答（BD9，仅当最新轮 `awaiting_answer` 可续推）；
 * - `POST /features/:id/schedule` —— 排期写（v0.9.2 M3，唯一放开的登记字段写，经 `feature-schedule.ts` 封装）；
 * - `POST /orgs`                  —— 组织写（v0.9.4 A 档 / BD1 建组织 + BD3 停用，`action` 字段分流；写板侧组织台账 `.data/orgs.json`；**不触桥、不写状态机、不写 machine 配置**）；
 * - `POST /orgs/{org}/members`    —— 成员写（v0.9.4 B 档 / BD4，**一条路由**靠 `action` 分「增 / 删」）：经 `group-admin.ts`
 *   以组身份调 O1 的受控写工具（配置面组写），**板绝不直写 orch/config.json**；
 * - `POST /versions`              —— 版本台账写（v0.9.4 N1，`action` 三值闭集 create/remove/setStatus 分流；
 *   写板侧版本台账 `.data/versions.json`；**不触桥、不写状态机**）。
 * 三件事收敛在这里：
 * - {@link parseWriteRoute}：方法门的放行白名单（含路径参数提取；其余路径的非 GET 仍 405，负向用例钉住）；
 * - {@link checkWriteAuth}：CSRF 防线（自定义头优先；无 JS 的表单退而求 Origin/Referer 同源，
 *   Origin「不可用」（缺失 / 空 / 字面 `null`）算**来源不可知**并退 Referer —— BD16；
 *   该兜底档能拿到 Referer 的前提 = 板页面 `Referrer-Policy: same-origin` —— BD17，见 `web/layout.ts`）；
 * - {@link parseRequirementForm}：urlencoded 表单 → createRequirement 入参（超限 / 解码失败 / `title` 为空
 *   ⇒ 结构化 400；v0.9.2 M6 起 `version` **不再必填**，留空 = 未排期）；
 * - {@link parseScheduleForm}：urlencoded 表单 → 排期写入参（M3；`version` **键必须显式存在**，
 *   空串 = 删除排期；缺键 = 编程错误抛出 {@link ScheduleFormProgrammingError}，不做缺键语义）；
 * - {@link validateOrgName} / {@link findOrgNameConflict} / {@link parseOrgForm}：组织名校验
 *   **单一纯函数**（字符集闭集）+ 三源重名闸（停用名豁免）+ `POST /orgs` 表单（v0.9.4 A2/A3，
 *   `action` 字段分「建 / 停用」，一条路由不扩白名单；D 档归一层复用同一校验函数）；
 * - {@link parseMemberForm}：`POST /orgs/{org}/members` 表单（v0.9.4 B 档 / BD4）——
 *   `action` **必须显式给出且落在闭集**（`add` / `remove`，不猜动作）+ 成员对 `{machineId, projectId}` 非空；
 * - {@link parseVersionActionForm}：`POST /versions` 表单（v0.9.4 N1）—— `action` 三值闭集
 *   （`create` / `remove` / `setStatus`，**未知 action fail-closed 拒**）+ `version` 非空 +
 *   `setStatus` 时 `status` 落在三态闭集。
 *
 * **组织名的校验点在请求期，不在启动期**（BD11 反转 BD10）：组织名由**用户在前台创建/指定**
 * （提需求表单 `group` 字段），板级 `config.json` 的 `group` 只是**可选默认组织**（BD12″ 起无 argv/env 通道）。
 * ⇒ 板**未配默认组织也照常起服务**（启动期零硬失败），只有「表单未填 ∧ 无板级默认」这一种组合
 * 才在 `POST /requirements` 上返回结构化 400 {@link GROUP_REQUIRED_CODE}（**不猜、不回落**）。
 */

import { VERSION_STATUSES, isVersionStatus, type VersionLedgerStatus } from "./versions-ledger.js";

/** 写面自定义请求头（API 调用方显式携带）；名字在此单点定义，README 同步。 */
export const WRITE_GUARD_HEADER = "x-board-write";

/** 表单不能携带自定义头（HTML 规范限制）⇒ 跨站表单先天发不出精确匹配的头部组合。 */
export const WRITE_GUARD_HEADER_VALUE = "1";

/** 请求体上限：防内存耗尽（提需求表单远小于此值）。 */
export const MAX_REQUIREMENT_BODY_BYTES = 262_144;

/** 本轨放开的写路径（方法恒为 POST）。 */
export const REQUIREMENTS_WRITE_PATH = "/requirements";

/** BD8 写路径模板（`{}` 段为路径参数）。 */
export const TURN_WRITE_PATH_TEMPLATE = "/features/{id}/turn";
export const HOST_STOP_WRITE_PATH_TEMPLATE = "/host/{org}/stop";

/** BD9 写路径模板（确认指令 / 澄清回答，均按需求定位）。 */
export const CONFIRM_WRITE_PATH_TEMPLATE = "/features/{id}/confirm";
export const ANSWER_WRITE_PATH_TEMPLATE = "/features/{id}/answer";

/** v0.9.2 M3 写路径模板（排期写 = 唯一放开的登记字段 `version` 写，按需求定位）。 */
export const SCHEDULE_WRITE_PATH_TEMPLATE = "/features/{id}/schedule";

/** v0.9.4 A1 写路径（组织台账 `.data/orgs.json` 的本地写：`action` 分「建（缺省）/ 停用」，精确路径、无路径参数）。 */
export const ORGS_WRITE_PATH = "/orgs";

/**
 * v0.9.4 B 档写路径模板（BD4）：**一条路由**靠表单 `action` 分「增 / 删」成员，
 * `{org}` 段 = 目标组织名（段卫生同 {@link paramSegment}，字符集闭集校验在 handler 经
 * {@link validateOrgName} 单一事实源完成）。⇒ `WRITE_ROUTES` 七→八。
 */
export const ORG_MEMBERS_WRITE_PATH_TEMPLATE = "/orgs/{org}/members";

/**
 * v0.9.4 N1 写路径（REQ-2026-09-27-05）：`POST /versions` —— 版本台账写口，
 * **一条路由**靠表单 `action` 三值闭集（`create` / `remove` / `setStatus`）分流；
 * 未知 action **fail-closed 拒**（不猜动作）。精确路径、无路径参数 ⇒ `WRITE_ROUTES` 八→九。
 */
export const VERSIONS_WRITE_PATH = "/versions";

/** 写路径清单（405 文案与 README 共用此单点）。 */
export const WRITE_ROUTES: readonly string[] = [
  "POST " + REQUIREMENTS_WRITE_PATH,
  `POST ${TURN_WRITE_PATH_TEMPLATE}`,
  `POST ${HOST_STOP_WRITE_PATH_TEMPLATE}`,
  `POST ${CONFIRM_WRITE_PATH_TEMPLATE}`,
  `POST ${ANSWER_WRITE_PATH_TEMPLATE}`,
  `POST ${SCHEDULE_WRITE_PATH_TEMPLATE}`,
  "POST " + ORGS_WRITE_PATH,
  `POST ${ORG_MEMBERS_WRITE_PATH_TEMPLATE}`,
  "POST " + VERSIONS_WRITE_PATH,
];

/** 已放开的写路由（携路径参数）。 */
export type WriteRoute =
  | { kind: "requirement" }
  | { kind: "turn"; featureId: string }
  | { kind: "host_stop"; org: string }
  | { kind: "confirm"; featureId: string }
  | { kind: "answer"; featureId: string }
  | { kind: "schedule"; featureId: string }
  | { kind: "orgs" }
  | { kind: "org_members"; org: string }
  | { kind: "versions" };

/** 解出单个路径参数段（含编码；拒绝空段与再含分隔符）。 */
function paramSegment(pathname: string, prefix: string, suffix: string): string | null {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const raw = pathname.slice(prefix.length, pathname.length - suffix.length);
  if (raw.length === 0 || raw.includes("/")) return null;
  try {
    const decoded = decodeURIComponent(raw);
    return decoded.trim() === "" ? null : decoded;
  } catch {
    return null;
  }
}

/**
 * 方法门 + 路由判定（**唯一白名单**）：命中 ⇒ 归一写路由，未命中 ⇒ `null`（落回读面 / 405）。
 * 精确匹配：`/requirements/` 与 `/requirements/x` 这类「近似路径」一律不放行。
 */
export function parseWriteRoute(method: string | undefined, pathname: string): WriteRoute | null {
  if (method !== "POST") return null;
  if (pathname === REQUIREMENTS_WRITE_PATH) return { kind: "requirement" };
  if (pathname === ORGS_WRITE_PATH) return { kind: "orgs" };
  if (pathname === VERSIONS_WRITE_PATH) return { kind: "versions" };
  // v0.9.4 B 档：`/orgs/{org}/members`（`{org}` 段卫生由 paramSegment 保证：非空、禁再含 `/`；
  // 字符集闭集在 handler 经 validateOrgName 判定 —— 路由层不立第二套规则）。
  const memberOrg = paramSegment(pathname, "/orgs/", "/members");
  if (memberOrg !== null) return { kind: "org_members", org: memberOrg };
  const featureId = paramSegment(pathname, "/features/", "/turn");
  if (featureId !== null) return { kind: "turn", featureId };
  const confirmId = paramSegment(pathname, "/features/", "/confirm");
  if (confirmId !== null) return { kind: "confirm", featureId: confirmId };
  const answerId = paramSegment(pathname, "/features/", "/answer");
  if (answerId !== null) return { kind: "answer", featureId: answerId };
  const scheduleId = paramSegment(pathname, "/features/", "/schedule");
  if (scheduleId !== null) return { kind: "schedule", featureId: scheduleId };
  const org = paramSegment(pathname, "/host/", "/stop");
  if (org !== null) return { kind: "host_stop", org };
  return null;
}

/** 方法门白名单判据（{@link parseWriteRoute} 的布尔投影；其余路径的非 GET 一律不写）。 */
export function isWriteRoute(method: string | undefined, pathname: string): boolean {
  return parseWriteRoute(method, pathname) !== null;
}

export type WriteAuthOk = { ok: true; via: "header" | "origin" | "referer" };
/**
 * 拒绝码两分（BD16）：`write_guard_origin` = **有名字且不同源**（明确跨站，CSRF 防线核心）；
 * `write_guard_origin_unknown` = **来源不可知**（Origin 缺失/空/字面 `null` 且 Referer 缺失或不同源）。
 * 二者都拒，但只有前者是"跨站"，后者需要给用户可操作的补救路径。
 * （BD16 前的 `write_guard_header` 不再产出：缺头 + 无来源同属"来源不可知"。）
 */
export type WriteAuthFail = {
  ok: false;
  code: "write_guard_origin" | "write_guard_origin_unknown";
  error: string;
};
export type WriteAuthResult = WriteAuthOk | WriteAuthFail;

/**
 * 「来源不可知」档的文案（可操作）：三档 —— 表单 / API 头 / 浏览器屏蔽 Origin+Referer。
 * `originRaw` 携带时被屏蔽的原值（如 `null`）以便排查。
 */
function unknownOriginError(originRaw: string | undefined, self: string | null): string {
  return (
    `无法确认请求来源（${originRaw === undefined ? "Origin 缺失" : `Origin = ${JSON.stringify(originRaw)} 不可用`}` +
    `，且无同源 Referer；本站 = ${self ?? "未知（缺 Host 头）"}）` +
    `⇒ 请在板上用表单提交；若在调用 API，请带 ${WRITE_GUARD_HEADER}: ${WRITE_GUARD_HEADER_VALUE} 头；` +
    "若浏览器屏蔽了 Origin/Referer，请把本站加入白名单"
  );
}

/** 归一 origin：scheme + 小写 host，**恒带显式端口**（缺省端口补全，避免 host:port vs host 误判）。 */
function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const port = u.port !== "" ? u.port : u.protocol === "https:" ? "443" : "80";
    const host = u.hostname.toLowerCase();
    return `${u.protocol}//${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
  } catch {
    return null;
  }
}

/** 从 Host 头 + 可选转发协议推导本请求 origin。 */
function requestOrigin(hostHeader: string | undefined, proto: string): string | null {
  if (hostHeader === undefined || hostHeader === "") return null;
  let hostname = hostHeader.toLowerCase();
  let port = proto === "https" ? "443" : "80";
  const idx = hostname.lastIndexOf(":");
  if (idx > 0) {
    const maybePort = hostname.slice(idx + 1);
    if (/^\d+$/.test(maybePort)) {
      hostname = hostname.slice(0, idx);
      port = maybePort;
    }
  }
  if (hostname === "") return null;
  const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return `${proto}://${host}:${port}`;
}

export interface WriteAuthInput {
  method: string | undefined;
  /** 已小写键的头部表（server 侧归一后传入） */
  headers: Record<string, string | undefined>;
  /** 请求 URL 的协议（loopback 板恒 http，除非 TLS —— 推导同源用） */
  proto: string;
}

/**
 * `Origin` 是否「不可用」（BD16）：缺失 / 空串 / 纯空白 / 字面 `null`（浏览器在隐私扩展、
 * sandboxed iframe、把 localhost 当第三方等情形发的是**字面字符串 `"null"`**）⇒ 属**来源不可知**，
 * 不是跨站，必须退到 Referer。**有名值解析不出（含 `://` 之类的畸形串）仍算有名 ⇒ 拒**，不放宽。
 */
function isOriginUnusable(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const v = raw.trim();
  return v === "" || v.toLowerCase() === "null";
}

/**
 * CSRF 防线（两档，任一成立即放行）：
 * ① `X-Board-Write: 1` 自定义头 —— 跨站表单无法携带自定义头，API 调用方走这一档；
 * ② `Origin`（**不可用时退 `Referer` 前缀**）与请求 Host **同源** —— 同站页面（本板自身）提交的表单走这一档。
 * 两档皆不成立 ⇒ 结构化拒绝（403），且**分两码**：有名 Origin 不同源 = `write_guard_origin`（明确跨站）；
 * Origin 与 Referer 皆不可用 = `write_guard_origin_unknown`（来源不可知，文案给可操作补救）。
 * **站内 Referer 必须可得**（BD17）：本板文档的 Referer 策略是 `same-origin`（`web/layout.ts`
 * `BOARD_REFERRER_POLICY`，响应头 + `<meta name=referrer>` 同值）—— 若改成 `no-referrer`，浏览器连
 * **同源表单提交都不带 Referer**，第二档兜底就被自己掐死了（v0.9.0 收口轨 11 修判定、轨 12 修信号源）。
 * Origin 有名时仍是主判据；`same-origin` 不放宽跨站（跨站拿不到同源 Referer，也带不出自定义头）。
 */
export function checkWriteAuth(input: WriteAuthInput): WriteAuthResult {
  if (input.headers[WRITE_GUARD_HEADER] === WRITE_GUARD_HEADER_VALUE) {
    return { ok: true, via: "header" };
  }
  const self = requestOrigin(input.headers.host, input.proto);
  const origin = input.headers.origin;
  if (!isOriginUnusable(origin)) {
    const got = normalizeOrigin(origin as string);
    if (got !== null && got === self) return { ok: true, via: "origin" };
    return {
      ok: false,
      code: "write_guard_origin",
      error: `Origin 与请求 Host 不同源（Origin = ${origin}，本站 = ${self ?? "未知（缺 Host 头）"}），已按 CSRF 拒绝`,
    };
  }
  const referer = input.headers.referer;
  if (self !== null && referer !== undefined && (referer === self || referer.startsWith(`${self}/`))) {
    return { ok: true, via: "referer" };
  }
  return {
    ok: false,
    code: "write_guard_origin_unknown",
    error: unknownOriginError(origin, self),
  };
}

/** POST 体 → createRequirement 入参（纯函数；超限/解码失败/必填为空都是结构化失败；v0.9.2 M6 起必填仅 `title`）。 */
export type RequirementFormOk = { ok: true; title: string; version: string; group: string; requirement?: string };
export type RequirementFormFail = { ok: false; status: 400 | 413; code: string; error: string };
export type RequirementFormResult = RequirementFormOk | RequirementFormFail;

/** 表单里的组织名字段（BD11 起 = 身份链 S1 的**来源**，不再是板级专属）。 */
export const REQUIREMENT_FORM_GROUP_FIELD = "group";

/** 「表单未填组织名 ∧ 板级默认组织未配置」的结构化错误码（400，请求期）。 */
export const GROUP_REQUIRED_CODE = "board_group_required";

/**
 * `defaultGroup` = 板级**可选默认组织**（config.json 的 `group`，未配置传 `null`）。
 * 生效序：**表单 `group` > 板级默认**；两者皆空 ⇒ {@link GROUP_REQUIRED_CODE}（400）——
 * 组织名决定 MCP 身份与宿主工作区，猜一个会把需求建到别的组织目录里去。
 */
export function parseRequirementForm(
  raw: string,
  contentLength?: number,
  defaultGroup?: string | null,
): RequirementFormResult {
  if (
    (contentLength !== undefined && contentLength > MAX_REQUIREMENT_BODY_BYTES) ||
    Buffer.byteLength(raw, "utf8") > MAX_REQUIREMENT_BODY_BYTES
  ) {
    return { ok: false, status: 413, code: "payload_too_large", error: "请求体超过板写面上限（256 KiB）" };
  }
  const f = new URLSearchParams(raw);
  const title = (f.get("title") ?? "").trim();
  // v0.9.2 M6：`version` 去必填 —— 留空 = 未排期（orch create 对 version 全链无校验，空串/缺键读面同值）。
  const version = (f.get("version") ?? "").trim();
  if (title === "") {
    return { ok: false, status: 400, code: "requirement_form_invalid", error: "必填字段为空：title（不得静默创建）" };
  }
  const formGroup = (f.get(REQUIREMENT_FORM_GROUP_FIELD) ?? "").trim();
  const group = formGroup !== "" ? formGroup : (defaultGroup ?? "").trim();
  if (group === "") {
    return {
      ok: false,
      status: 400,
      code: GROUP_REQUIRED_CODE,
      error:
        "组织名缺失：表单未填 group 且板级默认组织未配置（config.json 的 group）" +
        "⇒ 不猜、不回落任何兜底组名。组织由用户在板上首次填写创建（首次使用某组织名 = 在板上创建该组织）。",
    };
  }
  const requirement = f.get("requirement");
  return requirement !== null && requirement.trim() !== ""
    ? { ok: true, title, version, group, requirement }
    : { ok: true, title, version, group };
}

// ---------------------------------------------------------------------------
// v0.9.2 M3：排期写表单（POST /features/:id/schedule）
// ---------------------------------------------------------------------------

/** 排期表单的版本字段（HTML 表单恒携带该键；`required` 不硬拦 —— 空串 = 删除排期是合法语义）。 */
export const SCHEDULE_FORM_VERSION_FIELD = "version";

/** 排期表单「version 键缺失」= 编程错误（页面表单永远带该键；裸 API 调用省略键不是业务语义）。 */
export class ScheduleFormProgrammingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleFormProgrammingError";
  }
}

export interface ScheduleFormOk {
  ok: true;
  /** 已 `trim()` 的目标版本；空串 = 删除排期（回「未排期」）。 */
  version: string;
}
export interface ScheduleFormFail {
  ok: false;
  status: 413;
  code: "payload_too_large";
  error: string;
}
export type ScheduleFormResult = ScheduleFormOk | ScheduleFormFail;

/**
 * urlencoded 表单 → 排期写入参（纯函数，口径与 {@link parseRequirementForm} 同规格）：
 * - `version` **必须显式传**（键缺失 ⇒ 抛 {@link ScheduleFormProgrammingError}，不做缺键语义）；
 * - 服务端发送前一律 `trim()`（「空格自成一列」的坑）；**空串 = 删除排期** ⇒ 合法值，不拒；
 * - 超限（content-length 或实际字节数任一越界）⇒ 结构化 413。
 */
export function parseScheduleForm(raw: string, contentLength?: number): ScheduleFormResult {
  if (
    (contentLength !== undefined && contentLength > MAX_REQUIREMENT_BODY_BYTES) ||
    Buffer.byteLength(raw, "utf8") > MAX_REQUIREMENT_BODY_BYTES
  ) {
    return { ok: false, status: 413, code: "payload_too_large", error: "请求体超过板写面上限（256 KiB）" };
  }
  const f = new URLSearchParams(raw);
  if (!f.has(SCHEDULE_FORM_VERSION_FIELD)) {
    throw new ScheduleFormProgrammingError(
      `排期表单缺少 ${SCHEDULE_FORM_VERSION_FIELD} 键：排期写必须显式传 version（清空排期 = 空串），不做缺键语义`,
    );
  }
  return { ok: true, version: (f.get(SCHEDULE_FORM_VERSION_FIELD) ?? "").trim() };
}

// ---------------------------------------------------------------------------
// v0.9.4 A2：组织名校验**单一纯函数** + 三源重名闸（建组织与 D 档归一层共享此唯一事实源）
// ---------------------------------------------------------------------------

/** 组织名不合法的结构化错误码（与 `host-face.ORG_NAME_INVALID` 同码字面值 —— 板上错误族名见 views）。 */
export const ORG_NAME_INVALID_CODE = "board_org_name_invalid";

/** 建组织重名闸命中的错误码（409，handler 层产出）。 */
export const ORG_EXISTS_CODE = "board_org_exists";

/**
 * 组织名字符集**闭集**（A2 · R2 口径「字母 = Latin」）：中文（Han）/ Latin 字母 / 数字 / `-` `_` `.`。
 * 空格与 `#` `?` `%` `/` 以及**一切集外字符**（`\` `:` 全角字母等）都不在闭集内 ⇒ 天然拒绝；
 * 点段（`.` / `..` / 含 `..`）由 {@link validateOrgName} 单独钉（闭集字符可组成危险段）。
 */
const ORG_NAME_CHARS = /^[\p{Script=Han}A-Za-z0-9._-]+$/u;

export type OrgNameOk = { ok: true; name: string };
export type OrgNameFail = { ok: false; code: typeof ORG_NAME_INVALID_CODE; error: string };
export type OrgNameResult = OrgNameOk | OrgNameFail;

/**
 * 组织名校验（**单一纯函数，唯一事实源**）：`trim()` 后非空 ⇒ 非点段 ⇒ 不含 `..` ⇒ 字符集闭集。
 * 建组织（A 档）与 D 档归一层的 URL 段解码校验**必须复用本函数**，不得二处立规则；
 * 路径段卫生的既有判据（{@link paramSegment}：禁再含 `/`、decode 后非空）保持、在此之上叠加。
 */
export function validateOrgName(raw: string): OrgNameResult {
  const name = raw.trim();
  if (name === "") {
    return { ok: false, code: ORG_NAME_INVALID_CODE, error: "组织名为空：trim 后空白 ⇒ 必须显式给出（不得静默创建）" };
  }
  if (name === "." || name === "..") {
    return { ok: false, code: ORG_NAME_INVALID_CODE, error: `组织名不得是点段：${name}（路径遍历风险）` };
  }
  if (name.includes("..")) {
    return { ok: false, code: ORG_NAME_INVALID_CODE, error: `组织名不得含连续点段「..」：${name}（路径遍历风险）` };
  }
  if (!ORG_NAME_CHARS.test(name)) {
    return {
      ok: false,
      code: ORG_NAME_INVALID_CODE,
      error:
        `组织名含非法字符：${name} ⇒ 闭集 = 中文 / 字母（Latin）/ 数字 / "-" "_" "."，` +
        "禁空格与 # ? % /（也不得含 \\ : 等一切集外字符）",
    };
  }
  return { ok: true, name };
}

/** 重名闸的三个查重源（A2：盘枚举 ∪ 板台账 ∪ 需求 ownerGroup）。 */
export interface OrgNameUniverse {
  /** `<orgsDir>` 一级目录名（磁盘枚举）。 */
  disk: readonly string[];
  /** 板组织台账（`.data/orgs.json`）内的**在用**（未停用）组织名。 */
  ledger: readonly string[];
  /** 既有需求的 `ownerGroup`（trim 后非空集）。 */
  featureGroups: readonly string[];
  /**
   * 台账内**已停用**组织名（BD3 A3 过滤第二处）：命中 ⇒ 视为**可重建**（同名重建零迁移 —— 目录与工作区
   * 原样不动，台账把停用标记抹掉），三源一律不再判重。缺省 = 空集（BD1 口径逐字节不变）。
   */
  disabled?: readonly string[];
}

/** 重名命中的来源（文案按此点名，便于用户知道「和谁重了」）。 */
export type OrgNameConflictSource = "disk" | "ledger" | "featureGroup";

/** 三源重名闸（纯函数）：**停用名先豁免**，其余按 盘 → 台账 → 需求归属 序取**首个**命中源；无命中 ⇒ null。 */
export function findOrgNameConflict(name: string, universe: OrgNameUniverse): OrgNameConflictSource | null {
  if (universe.disabled !== undefined && universe.disabled.includes(name)) return null;
  if (universe.disk.includes(name)) return "disk";
  if (universe.ledger.includes(name)) return "ledger";
  if (universe.featureGroups.includes(name)) return "featureGroup";
  return null;
}

// ---------------------------------------------------------------------------
// v0.9.4 A2/A3：建组织与停用表单（POST /orgs 一条路由，`action` 字段分「建 / 停用」）
// ---------------------------------------------------------------------------

/** 建组织表单的组织名字段。 */
export const ORG_FORM_FIELD = "org";

/**
 * v0.9.4 A3：`POST /orgs` 的动作字段（**一条路由**分「建 / 停用」，与 B 档成员增删同款口径）——
 * 写路由白名单**不因此扩条**（建 + 停用共用 `POST /orgs` 一条）。
 */
export const ORG_ACTION_FIELD = "action";
export const ORG_ACTION_CREATE = "create";
export const ORG_ACTION_DISABLE = "disable";
export type OrgWriteAction = typeof ORG_ACTION_CREATE | typeof ORG_ACTION_DISABLE;

/** 动作值不在闭集（既非 create 也非 disable）的结构化错误码（400）—— 不猜动作。 */
export const ORG_ACTION_INVALID_CODE = "board_org_action_invalid";

export type OrgFormOk = { ok: true; name: string; action: OrgWriteAction };
export type OrgFormFail = { ok: false; status: 400 | 413; code: string; error: string };
export type OrgFormResult = OrgFormOk | OrgFormFail;

/**
 * urlencoded 表单 → {组织名, 动作}（口径同 {@link parseRequirementForm}：超限 413、校验不过 400）；
 * 字符集校验**只经单一纯函数** {@link validateOrgName}（缺键 = 空串 ⇒ 同走 400，不做缺键语义）；
 * `action` **缺省 = create**（BD1 的 `POST /orgs` 契约：只发 `org` 的表单与裸 API 调用照常建组织），
 * 但**给了值就必须落在闭集内** —— 认不出的动作不得当成建组织跑（防表单笔误静默建组织）。
 */
export function parseOrgForm(raw: string, contentLength?: number): OrgFormResult {
  if (
    (contentLength !== undefined && contentLength > MAX_REQUIREMENT_BODY_BYTES) ||
    Buffer.byteLength(raw, "utf8") > MAX_REQUIREMENT_BODY_BYTES
  ) {
    return { ok: false, status: 413, code: "payload_too_large", error: "请求体超过板写面上限（256 KiB）" };
  }
  const f = new URLSearchParams(raw);
  const name = validateOrgName(f.get(ORG_FORM_FIELD) ?? "");
  if (!name.ok) return { ok: false, status: 400, code: name.code, error: name.error };
  const rawAction = (f.get(ORG_ACTION_FIELD) ?? "").trim();
  if (rawAction === "") return { ok: true, name: name.name, action: ORG_ACTION_CREATE };
  if (rawAction === ORG_ACTION_CREATE || rawAction === ORG_ACTION_DISABLE) {
    return { ok: true, name: name.name, action: rawAction };
  }
  return {
    ok: false,
    status: 400,
    code: ORG_ACTION_INVALID_CODE,
    error: `组织写动作不合法：${rawAction} ⇒ 闭集 = ${ORG_ACTION_CREATE} / ${ORG_ACTION_DISABLE}（不猜动作）`,
  };
}

// ---------------------------------------------------------------------------
// v0.9.4 B 档（BD4）：成员写表单（POST /orgs/{org}/members，`action` 分「增 / 删」）
// ---------------------------------------------------------------------------

/** 成员表单的动作字段（与 {@link ORG_ACTION_FIELD} 同键名、**不同闭集** —— 两路口不共用值域）。 */
export const MEMBER_ACTION_FIELD = "action";
export const MEMBER_ACTION_ADD = "add";
export const MEMBER_ACTION_REMOVE = "remove";
export type MemberWriteAction = typeof MEMBER_ACTION_ADD | typeof MEMBER_ACTION_REMOVE;

/** 成员对的两个字段（= O1 `members[]` 项，与 orch `projectGroup.members` 同形）。 */
export const MEMBER_MACHINE_ID_FIELD = "machineId";
export const MEMBER_PROJECT_ID_FIELD = "projectId";

/** 动作缺失 / 越界的结构化错误码（400）—— 与建组织档「缺省 = create」**刻意不同**：成员写无缺省动作可言。 */
export const MEMBER_ACTION_INVALID_CODE = "board_member_action_invalid";

/** 成员对缺失（machineId / projectId 任一为空）的结构化错误码（400）。 */
export const MEMBER_PAIR_MISSING_CODE = "board_member_pair_missing";

export type MemberFormOk = { ok: true; action: MemberWriteAction; machineId: string; projectId: string };
export type MemberFormFail = { ok: false; status: 400 | 413; code: string; error: string };
export type MemberFormResult = MemberFormOk | MemberFormFail;

/**
 * urlencoded 表单 → {动作, 成员对}（口径同 {@link parseOrgForm}：超限 413、校验不过 400）：
 * - `action` **必须显式给出**且落在闭集（`add` / `remove`）—— 增删是两回事，**不猜、不缺省**；
 * - 成员对 `{machineId, projectId}` 发送前一律 `trim()`，任一为空 ⇒ 400
 *   {@link MEMBER_PAIR_MISSING_CODE}（板不校验 machineId 是否 ∈ orch 机器清单 —— 那是 O1 dry-run 的职责，
 *   在此立第二套判据必然与桥漂移）；
 * - 目标组织名**不在本函数**校验（来自 URL 段，handler 经 {@link validateOrgName} 单一事实源判定）。
 */
export function parseMemberForm(raw: string, contentLength?: number): MemberFormResult {
  if (
    (contentLength !== undefined && contentLength > MAX_REQUIREMENT_BODY_BYTES) ||
    Buffer.byteLength(raw, "utf8") > MAX_REQUIREMENT_BODY_BYTES
  ) {
    return { ok: false, status: 413, code: "payload_too_large", error: "请求体超过板写面上限（256 KiB）" };
  }
  const f = new URLSearchParams(raw);
  const rawAction = (f.get(MEMBER_ACTION_FIELD) ?? "").trim();
  if (rawAction !== MEMBER_ACTION_ADD && rawAction !== MEMBER_ACTION_REMOVE) {
    return {
      ok: false,
      status: 400,
      code: MEMBER_ACTION_INVALID_CODE,
      error:
        `成员写动作缺失或不合法：${rawAction === "" ? "（未给出 action）" : rawAction}` +
        ` ⇒ 闭集 = ${MEMBER_ACTION_ADD} / ${MEMBER_ACTION_REMOVE}（不猜动作、不设缺省）`,
    };
  }
  const machineId = (f.get(MEMBER_MACHINE_ID_FIELD) ?? "").trim();
  const projectId = (f.get(MEMBER_PROJECT_ID_FIELD) ?? "").trim();
  if (machineId === "" || projectId === "") {
    return {
      ok: false,
      status: 400,
      code: MEMBER_PAIR_MISSING_CODE,
      error: `成员对不完整：machineId=${machineId === "" ? "（空）" : machineId} · projectId=${projectId === "" ? "（空）" : projectId} ⇒ 两项均必填`,
    };
  }
  return { ok: true, action: rawAction, machineId, projectId };
}

// ---------------------------------------------------------------------------
// v0.9.4 N1：版本台账写表单（POST /versions，`action` 三值闭集 create/remove/setStatus）
// ---------------------------------------------------------------------------

/** 版本表单的动作字段（与 orgs / members 同键名、**不同闭集** —— 三路口各守各的值域）。 */
export const VERSION_ACTION_FIELD = "action";
export const VERSION_ACTION_CREATE = "create";
export const VERSION_ACTION_REMOVE = "remove";
export const VERSION_ACTION_SET_STATUS = "setStatus";
export type VersionWriteAction =
  | typeof VERSION_ACTION_CREATE
  | typeof VERSION_ACTION_REMOVE
  | typeof VERSION_ACTION_SET_STATUS;

/** 版本表单的版本号 / 目标状态字段。 */
export const VERSION_FORM_VERSION_FIELD = "version";
export const VERSION_FORM_STATUS_FIELD = "status";

/** 动作缺失 / 越界 ⇒ 结构化错误码（400）—— **fail-closed 拒**，不猜动作、不设缺省。 */
export const VERSION_ACTION_INVALID_CODE = "board_version_action_invalid";

/** 版本号为空 / `setStatus` 目标状态非闭集 ⇒ 结构化错误码（400）。 */
export const VERSION_FORM_INVALID_CODE = "board_version_form_invalid";

export type VersionFormOk = {
  ok: true;
  action: VersionWriteAction;
  /** 已 `trim()` 的版本号（非空）。 */
  version: string;
  /** 仅 `setStatus` 非 null（三态闭集之一）；其余动作恒 null。 */
  status: VersionLedgerStatus | null;
};
export type VersionFormFail = { ok: false; status: 400 | 413; code: string; error: string };
export type VersionFormResult = VersionFormOk | VersionFormFail;

/**
 * urlencoded 表单 → {动作, 版本号, 目标状态?}（口径同 {@link parseOrgForm}：超限 413、校验不过 400）：
 * - `action` **必须显式给出且落在三值闭集**（`create` / `remove` / `setStatus`）——
 *   未知 / 缺失一律 {@link VERSION_ACTION_INVALID_CODE}（**fail-closed 拒**，不猜）；
 * - `version` `trim()` 后非空（空 ⇒ {@link VERSION_FORM_INVALID_CODE}）；
 * - `setStatus` 时 `status` 必须落在三态闭集（复用 `versions-ledger.VERSION_STATUSES` 单一事实源）；
 * - semver 收口（`parseVersion`）在 handler 层对 `create` 施加 —— 本函数只管表单形状。
 */
export function parseVersionActionForm(raw: string, contentLength?: number): VersionFormResult {
  if (
    (contentLength !== undefined && contentLength > MAX_REQUIREMENT_BODY_BYTES) ||
    Buffer.byteLength(raw, "utf8") > MAX_REQUIREMENT_BODY_BYTES
  ) {
    return { ok: false, status: 413, code: "payload_too_large", error: "请求体超过板写面上限（256 KiB）" };
  }
  const f = new URLSearchParams(raw);
  const rawAction = (f.get(VERSION_ACTION_FIELD) ?? "").trim();
  if (
    rawAction !== VERSION_ACTION_CREATE &&
    rawAction !== VERSION_ACTION_REMOVE &&
    rawAction !== VERSION_ACTION_SET_STATUS
  ) {
    return {
      ok: false,
      status: 400,
      code: VERSION_ACTION_INVALID_CODE,
      error:
        `版本写动作缺失或不合法：${rawAction === "" ? "（未给出 action）" : rawAction}` +
        ` ⇒ 闭集 = ${VERSION_ACTION_CREATE} / ${VERSION_ACTION_REMOVE} / ${VERSION_ACTION_SET_STATUS}（不猜动作）`,
    };
  }
  const version = (f.get(VERSION_FORM_VERSION_FIELD) ?? "").trim();
  if (version === "") {
    return {
      ok: false,
      status: 400,
      code: VERSION_FORM_INVALID_CODE,
      error: "版本号缺失：version 必填且 trim 后非空（不得静默建/删空版本）",
    };
  }
  if (rawAction === VERSION_ACTION_SET_STATUS) {
    const rawStatus = (f.get(VERSION_FORM_STATUS_FIELD) ?? "").trim();
    if (!isVersionStatus(rawStatus)) {
      return {
        ok: false,
        status: 400,
        code: VERSION_FORM_INVALID_CODE,
        error:
          `目标状态缺失或不合法：${rawStatus === "" ? "（未给出 status）" : rawStatus}` +
          ` ⇒ 闭集 = ${VERSION_STATUSES.join(" / ")}`,
      };
    }
    return { ok: true, action: rawAction, version, status: rawStatus };
  }
  return { ok: true, action: rawAction, version, status: null };
}
