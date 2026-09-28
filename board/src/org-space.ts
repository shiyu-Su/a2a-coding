/**
 * 组织空间**归一层**（v0.9.4 D 档 · BD6 · REQ-2026-09-26-01，改造文档 §2.5）—— **纯函数**。
 *
 * `/org/<组织名>/…` 前缀在**路由入口**被识别、剥离并校验，其后按剥离出的剩余路径
 * 走既有通路 ⇒ **写路由保持全局唯一集合不变**（{@link write-guard.WRITE_ROUTES} 不加
 * 前缀变体，405 文案与三枚白名单脚本的 fetch 拼接零改动）；组织上下文经返回值注入 handler
 * （写请求的表单侧组织上下文 = BD8 免选形态：只读展示 + hidden 字段值必发，见 `web/views.renderRequirementForm`）。
 *
 * 判据口径：
 * - 组织名段 = **解码-校验复用 BD1 单一纯函数** {@link write-guard.validateOrgName}
 *   （段卫生循 {@link write-guard.paramSegment} 先例：单段、禁再含 `/`、decode 后非空）；
 *   非法段与不存在组织**同档 404**（不给枚举合法段名留信号面）；
 * - **存在** = 组织名 ∈ 四源归并 universe（盘 ∪ 台账（在用）∪ 需求归属 ∪ 板级默认，
 *   复用 {@link orgs-view.mergeOrgNames}；§9-c 起 `pageOrgs` 退役，本层是四源口径的唯一持有者）；
 * - **已停用** = 台账 `disabledAt ≠ null`（唯一判据 {@link orgs-ledger.isOrgDisabled}）⇒ 410；
 *   停用标记本身即存在凭据（磁盘目录不物理删 ⇒ universe 未必含停用名，停用档先判）。
 */
import { enabledOrgNames, isOrgDisabled, type OrgsLedger } from "./orgs-ledger.js";
import { mergeOrgNames } from "./orgs-view.js";
import { parseWriteRoute, validateOrgName } from "./write-guard.js";

/** 组织空间 URL 前缀（含尾斜杠；`/org` 不带斜杠 ≠ 空间路径）。 */
export const ORG_SPACE_PREFIX = "/org/";

/** D 档读面路由族（改造文档 §2.5 三枚 + §9-c 管理页一枚）；`/org/<名>/features/:id` 属深链透传，不在此族内。 */
export type OrgSpaceView = "schedule" | "features" | "tasks" | "manage";

/** 归一失败档（HTTP 状态与结构化码由调用方按此分流）。 */
export type OrgSpaceFailure = "invalid_name" | "not_found" | "gone";

export const ORG_SPACE_NOT_FOUND_CODE = "board_org_space_not_found";
export const ORG_SPACE_GONE_CODE = "board_org_space_gone";

/** {@link resolveOrgSpaceRoute} 的判据输入（存在性源与停用台账分列，均可注入）。 */
export interface OrgSpaceUniverse {
  /** 四源归并的组织名清单（**在用的都进**；停用名不进 ledger 源）。 */
  orgNames: readonly string[];
  /** 板组织台账（「已停用」判据的唯一事实源）。 */
  ledger: OrgsLedger;
}

/** 路由入口判定（resolve 的判别联合；`unknown` = 非 `/org/` 前缀路径，调用方走既有通路）。 */
export type OrgSpaceRoute =
  | { kind: "unknown" }
  | { kind: "failure"; failure: OrgSpaceFailure; orgRaw: string }
  | { kind: "view"; org: string; view: OrgSpaceView }
  | { kind: "feature_detail"; org: string; featureId: string }
  | { kind: "write"; org: string; remainder: string }
  | { kind: "other"; org: string };

/** 四源存在性 universe 装配（停用名并入盘/需求源时由 ledger 档兜住，停用档先判）。 */
export function orgSpaceUniverseOf(sources: {
  disk: readonly string[];
  ledger: OrgsLedger;
  featureGroups: readonly string[];
  defaultGroup: string | null;
}): OrgSpaceUniverse {
  return {
    orgNames: mergeOrgNames({
      disk: sources.disk,
      ledger: enabledOrgNames(sources.ledger),
      featureGroups: sources.featureGroups,
      defaultGroup: sources.defaultGroup,
    }),
    ledger: sources.ledger,
  };
}

/**
 * 前缀剥离 + 段解码校验 + 剩余路径归类（**不做存在性判定**，universe 归 {@link resolveOrgSpaceRoute}）。
 * `remainder` 以 `/` 开头或为空串（`/org/<名>` 与 `/org/<名>/` 同义 = 空间首页）。
 */
export function parseOrgSpacePath(pathname: string): { org: string; remainder: string } | { orgRaw: string; invalid: true } | null {
  if (!pathname.startsWith(ORG_SPACE_PREFIX)) return null;
  const rest = pathname.slice(ORG_SPACE_PREFIX.length);
  if (rest === "") return { orgRaw: "", invalid: true as const };
  const slash = rest.indexOf("/");
  const rawSeg = slash < 0 ? rest : rest.slice(0, slash);
  const remainder = slash < 0 ? "" : rest.slice(slash);
  if (rawSeg === "" || rawSeg.includes("/")) return { orgRaw: rawSeg, invalid: true as const };
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawSeg);
  } catch {
    return { orgRaw: rawSeg, invalid: true as const };
  }
  const name = validateOrgName(decoded);
  if (!name.ok) return { orgRaw: rawSeg, invalid: true as const };
  return { org: name.name, remainder };
}

/** 剩余路径归类（classifyRemainder 的中间判据，不含 org）。 */
type RemainderClass =
  | { view: OrgSpaceView }
  | { featureId: string }
  | { write: string }
  | { other: true };

/** 剩余路径 → 读面族 / 深链 / 写归一（纯映射；`/features/:id` 全局唯一，不强制 303）。 */
function classifyRemainder(remainder: string, method: string | undefined): RemainderClass {
  if (remainder === "" || remainder === "/" || remainder === "/schedule") return { view: "schedule" };
  if (remainder === "/features") return { view: "features" };
  if (remainder === "/tasks") return { view: "tasks" };
  // §9-c：/orgs 管理页退役 ⇒ 成员管理与停用操作落空间内 manage 页（写 action 仍走全局端点）
  if (remainder === "/manage") return { view: "manage" };
  if (remainder.startsWith("/features/") && !remainder.slice("/features/".length).includes("/")) {
    const rawId = decodeURIComponentSafeLocal(remainder.slice("/features/".length));
    if (rawId !== null) return { featureId: rawId };
  }
  // 写面归一：POST 且剥掉前缀后的剩余恰为全局写路径（WRITE_ROUTES 不扩前缀变体）
  if (method === "POST" && parseWriteRoute("POST", remainder) !== null) return { write: remainder };
  return { other: true };
}

function decodeURIComponentSafeLocal(value: string): string | null {
  if (value === "" || value.includes("/")) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.trim() === "" || decoded.includes("/") ? null : decoded;
  } catch {
    return null;
  }
}

/**
 * 路由入口的完整判定（parse + 存在性 + 停用档）：
 * - 非法段 / 组织不存在 ⇒ `not_found`（404，同档不区分）；
 * - 台账已停用 ⇒ `gone`（410，先于存在性 —— 停用标记即存在凭据）；
 * - 读面族 / 深链 / 写前缀形态 ⇒ 携归一结果。
 * 非 `/org/` 前缀 ⇒ `unknown`（调用方走既有通路，零改动）。
 */
export function resolveOrgSpaceRoute(pathname: string, universe: OrgSpaceUniverse, method?: string): OrgSpaceRoute {
  const parsed = parseOrgSpacePath(pathname);
  if (parsed === null) return { kind: "unknown" };
  if ("invalid" in parsed) return { kind: "failure", failure: "invalid_name", orgRaw: parsed.orgRaw };
  const { org, remainder } = parsed;
  if (isOrgDisabled(universe.ledger, org)) {
    return { kind: "failure", failure: "gone", orgRaw: org };
  }
  if (!universe.orgNames.includes(org)) {
    return { kind: "failure", failure: "not_found", orgRaw: org };
  }
  const classified = classifyRemainder(remainder, method ?? "GET");
  if ("view" in classified) return { kind: "view", org, view: classified.view };
  if ("featureId" in classified) return { kind: "feature_detail", org, featureId: classified.featureId };
  if ("write" in classified) return { kind: "write", org, remainder: classified.write };
  return { kind: "other", org };
}

/** 空间内链接的单点拼装（URL 段一律 encodeURIComponent，口径同既有 featureLink）。 */
export function orgSpaceLink(org: string, view: OrgSpaceView | "" = ""): string {
  return ORG_SPACE_PREFIX + encodeURIComponent(org) + (view === "" ? "/" : "/" + view);
}
