/**
 * ACP 权限门三档映射（REQ-v0.8.0-2026-09-19-01 · 节点 B4）。
 *
 * `session/request_permission`（服务端 → 客户端请求）→ 依桥启动参数 `--risk` 自动响应：
 * - **read**：只读语义 —— **拒绝一切权限请求**（写类必须拒，防越权）；
 * - **write**：读写可批 —— 命中 allow 选项则批准，否则回落 reject / cancelled；
 * - **full**：全批 —— 优先 `allow_always`，其次首个 allow。
 *
 * 未知 / 空选项 → `cancelled`（不猜测放行）。拒绝亦尽量选中服务端提供的 reject 选项
 * （形状 `{ outcome: { outcome: "selected", optionId } }`；无 reject 选项则 `{ outcome: { outcome: "cancelled" } }`）。
 *
 * 响应形状依 ACP 标准（P1 探针未触发权限请求，故以 ACP 规范形状实现）。
 * 零第三方依赖；不 import `orch/**` / `launcher/**`。
 *
 * **会话级 risk 路由（v0.10.2 · M-3，改造文档 §2.3 F-M2）**：权限处理器是进程级单注册，
 * 但 `session/request_permission` 的 params 带 `sessionId` ⇒ 本模块持 `SessionRiskRegistry`
 * （`sessionId → risk`）：命中 per-request override（`message.metadata.risk`，登记点 =
 * `AcpSessionRunner.execute`）⇒ 按会话生效；未命中 / 非法值 ⇒ **回落进程级 `--risk`**（逐字现状）。
 * risk 三档语义（read/write/full 判定矩阵）不因本节点改动 —— 变的只是「用哪一档」的取值来源。
 */

/** 风险档位（与线协议 RiskLevel 同口径）。 */
export type PermissionRisk = "read" | "write" | "full";

/** ACP 权限选项。 */
export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  /** ACP kind：`allow_once` / `allow_always` / `reject_once` / `reject_always` 等。 */
  kind?: string;
}

/** 权限决策（回写到 `{ outcome: <本对象> }`）。 */
export type PermissionDecision =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

/** 选项分类：allow / reject / unknown。 */
export function classifyPermissionOption(option: AcpPermissionOption): "allow" | "reject" | "unknown" {
  const kind = (option.kind ?? "").toLowerCase();
  const name = (option.name ?? "").toLowerCase();
  const haystack = `${kind} ${name}`;
  if (kind.includes("allow") || haystack.includes("allow") || haystack.includes("approve")) {
    return "allow";
  }
  if (
    kind.includes("reject") ||
    kind.includes("deny") ||
    haystack.includes("reject") ||
    haystack.includes("deny") ||
    haystack.includes("cancel")
  ) {
    return "reject";
  }
  return "unknown";
}

function isAllowAlways(option: AcpPermissionOption): boolean {
  return (option.kind ?? "").toLowerCase().includes("always");
}

/**
 * 依 risk 对一组选项做出决策（**纯函数**，便于单测）。
 * `read` 恒不批准；空 / 未知选项 → cancelled。
 */
export function decidePermission(
  risk: PermissionRisk,
  options: readonly AcpPermissionOption[],
): PermissionDecision {
  const allow = options.filter((o) => classifyPermissionOption(o) === "allow");
  const reject = options.filter((o) => classifyPermissionOption(o) === "reject");
  const firstReject = reject[0];

  // read：只读 -> 拒绝一切（防写类越权）；有 reject 选项则显式选中
  if (risk === "read") {
    return firstReject !== undefined
      ? { outcome: "selected", optionId: firstReject.optionId }
      : { outcome: "cancelled" };
  }

  if (allow.length === 0) {
    return firstReject !== undefined
      ? { outcome: "selected", optionId: firstReject.optionId }
      : { outcome: "cancelled" };
  }

  if (risk === "full") {
    const always = allow.find((o) => isAllowAlways(o));
    const chosen = always ?? allow[0];
    if (chosen !== undefined) return { outcome: "selected", optionId: chosen.optionId };
  }
  const chosen = allow[0];
  if (chosen !== undefined) return { outcome: "selected", optionId: chosen.optionId };
  return { outcome: "cancelled" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从 `session/request_permission` params 提取选项（容错：非法 → 空数组 ⇒ cancelled）。 */
export function extractOptions(params: unknown): AcpPermissionOption[] {
  if (!isRecord(params)) return [];
  const raw = params["options"];
  if (!Array.isArray(raw)) return [];
  const options: AcpPermissionOption[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const optionId = item["optionId"];
    if (typeof optionId !== "string" || optionId.length === 0) continue;
    options.push({
      optionId,
      ...(typeof item["name"] === "string" ? { name: item["name"] } : {}),
      ...(typeof item["kind"] === "string" ? { kind: item["kind"] } : {}),
    });
  }
  return options;
}

/**
 * 构造服务端请求处理器（注册到 `AcpClient.setRequestHandler`）：
 * 仅处理 `session/request_permission`，其余方法抛错（由客户端回 JSON-RPC error）。
 *
 * v0.10.2 · M-3：可选第三参 `sessionRisks` = 会话级路由表。命中该 sessionId 的登记值
 * ⇒ 用会话档；未注册 ⇒ 回落第一参的进程级 `risk`（日志逐字现状）。非法值不进表（归一化在
 * 登记点 `normalizeRisk`，逐键宽容口径同 M-2 `parseRoleIntent`）。不传本参 ⇒ 纯进程级，与旧版逐字一致。
 */
export function createPermissionHandler(
  risk: PermissionRisk,
  logger?: (message: string) => void,
  sessionRisks?: SessionRiskRegistry,
): (method: string, params: unknown) => unknown {
  return (method: string, params: unknown) => {
    if (method !== "session/request_permission") {
      throw new Error(`ACP 权限处理器不处理方法：${method}`);
    }
    let effective = risk;
    const sessionId = extractSessionId(params);
    if (sessionRisks !== undefined && sessionId !== undefined) {
      // 登记表只收合法档（归一化在登记点 normalizeRisk，v0.10.2 · M-3）；
      // 查得到 ⇒ 会话档，查不到 ⇒ 进程级回落。
      const override = normalizeRisk(sessionRisks.lookup(sessionId));
      if (override !== undefined) effective = override;
    }
    const decision = decidePermission(effective, extractOptions(params));
    logger?.(`[acp-permission] risk=${effective} → ${decision.outcome}${"optionId" in decision ? `(${decision.optionId})` : ""}`);
    return { outcome: decision };
  };
}

/** 从 `session/request_permission` params 提取 `sessionId`（ACP 线协议必带；非法 ⇒ undefined = 无会话档）。 */
function extractSessionId(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  const sessionId = params["sessionId"];
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

/**
 * risk 原值归一化（v0.10.2 · M-3）：仅 `read` / `write` / `full` 三值命中，其余（空串 / 非串 /
 * 未知档位）⇒ `undefined` = **未给 override**（回落进程级）。与 `parseRoleIntent` 的逐键宽容
 * 口径同形；闭集执法单一源在此，不在他处复制。
 */
export function normalizeRisk(value: string | undefined): PermissionRisk | undefined {
  return value === "read" || value === "write" || value === "full" ? value : undefined;
}

/** 会话 risk 登记表容量上限（桥进程生命周期 = 单 launcher 派发窗，量级远小于此；有界仅为防无界增长）。 */
export const MAX_SESSION_RISKS = 512;

/**
 * `sessionId → per-request risk` 会话级路由表（v0.10.2 · M-3）。
 * 写入点 = `AcpSessionRunner.execute`（会话建立后、prompt 前，仅当 `overrides.risk` 有值）；
 * 读取点 = {@link createPermissionHandler}（进程级单注册的处理器内）。
 * 同 sessionId 重复登记 ⇒ 覆盖（会话续接跨轮可能带新值）。插入序有界淘汰（超界丢最旧）。
 */
export class SessionRiskRegistry {
  private readonly bySessionId = new Map<string, string>();

  register(sessionId: string, risk: string): void {
    this.bySessionId.set(sessionId, risk);
    while (this.bySessionId.size > MAX_SESSION_RISKS) {
      const oldest = this.bySessionId.keys().next().value;
      if (oldest === undefined) break;
      this.bySessionId.delete(oldest);
    }
  }

  /** 该会话的 override 原值；未登记 ⇒ `undefined`（= 回落进程级）。 */
  lookup(sessionId: string): string | undefined {
    return this.bySessionId.get(sessionId);
  }

  size(): number {
    return this.bySessionId.size;
  }
}
