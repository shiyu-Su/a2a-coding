/**
 * board HTTP 服务（BD1 骨架 + BD3 只读视图 + BD7 写面 + BD8 宿主面 + BD9 确认/回答入口）—— **只绑 loopback**、零框架（`node:http`）。
 *
 * 路由：
 * - `GET /health`          —— 板自身健康（保留 BD1 行为）；
 * - `GET /`                —— 需求列表（桥 `/api/features`）+ 提需求表单；
 * - `GET /features/:id`    —— 需求详情 + 任务 + trace 三面 + 「触发一轮」+「阶段产出」/「产出登记」（BD11）；
 * - `GET /features/:id/docs?file=<name>[&src=A|B][&mode=render|raw]` —— **单文档内容**（BD11 读文档面）：
 *   `text/plain` 原文直出，
 *   浏览器 `Accept: text/html` ⇒ 整页；**BD14 双档**：缺省 `render`（markdown 子集渲染 + mermaid 占位），
 *   `mode=raw` ⇒ 现行 `<pre>` 原文视图原样保留；版本 / 归属取自桥侧详情（不接受调用方传版本），
 *   守卫全在 `docs-read.ts`（四件套），失败 404 / 400 **不泄根路径**；
 *   **BD13 补源 B**：`src` 未指定（缺省源 A）且源 A 未命中 ⇒ 自动回落源 B（回落同样逐守卫过一遍，
 *   命中即停；两源同名 ⇒ 源 A 优先，实际来源经响应头 `X-Docs-Source` 与页面标注透出，不歧义）；
 * - `GET /static/<名>`      —— **vendored 静态资产**（BD14，mermaid.min.js）：文件名 = 白名单闭集
 *   （`docs-render.VENDORED_ASSETS`），白名单外 / 缺文件 ⇒ 404，不做目录遍历；同源脚本加载经
 *   CSP `script-src 'self'` 放行（板 CSP 首次放宽，理由见 layout.ts 注释）；
 * - `GET /tasks[?project=]`—— 任务视图（桥 `/api/tasks`，project 必填；缺省为选单页）；
 * - `GET /projects`        —— 项目 / 机器视图（桥 `/api/projects`）；
 * - `GET /host`            —— **宿主桥状态页**（本板进程托管的桥：五态 + 结构化错误 + 轮队列）；
 * - `POST /requirements`            —— 提需求（BD7 接线 · BD11 组织名进表单）；
 * - `POST /features/:id/turn`       —— 触发一轮（BD8，起桥 + 发轮，**不等排队轮**；该需求已有在飞 /
 *   排队轮 ⇒ **409 `board_turn_busy`** 不重复入队 —— 收口轨 14 服务端防重，confirm / answer 同；
 *   需求已入**引擎终态** ⇒ **409 `board_feature_terminal`** 直接拒单不烧轮 —— 收口轨 16 ③，三入口同）；
 * - `POST /host/:org/stop`          —— 停桥（BD8，与上两条同规格受写面守卫）；
 * - `POST /features/:id/confirm`    —— 人工确认指令（BD9，**投消息给 agent**：由 agent 核对后自行执行 approve，板不批准）；
 * - `POST /features/:id/answer`     —— 澄清回答（BD9，仅当最新轮 `awaiting_answer` ⇒ 同 `contextId` 续推）；
 * - `POST /shutdown`                —— **优雅停机（BD13″，仅 loopback 来源）**：200 仅代表「受理」；
 *   不经 CSRF 写面守卫（它是运维停机口，不是业务写面），来源门 = `socket.remoteAddress` 必须 loopback，
 *   非 loopback 一律 403 `loopback_only`（负向用例钉住）。
 *
 * **方法门**：读面仅 GET；写面只放开上面五条业务路径（白名单 = `write-guard.parseWriteRoute`）+
 * `/shutdown` 一条运维路径（本文件内处理），其余路径的非 GET 一律 405。写端点另受 CSRF 守卫（自定义头或同源 Origin/Referer，见 `write-guard.ts`）。
 * 板**不写状态机**：无 approve / advance / cancel 任何路径（确认与回答都只是给宿主 agent 的一轮消息，推进归 agent）。
 *
 * **组织名（BD11）**：由**提需求表单**给出（= MCP URL 首段 = 组织目录名，身份链 S1）；配置文件
 * `config.json` 的 `group` 只是**可选默认**（表单未填才生效，BD12″ 起无 argv/env 通道）。两者皆空 ⇒
 * **请求期**结构化 400 `board_group_required`（**启动期不报错、不猜、不回落兜底组名**）。
 *
 * 读面对桥只发起 GET（经 `bridge-client`）；不推事件游标、不写配置。**BD11 起读面另有一条本地读路径**
 * （`/features/:id/docs` → `docs-read.ts`，纯读、守卫四件套、失败不泄根）。
 * 桥不可达 ⇒ 页面如实显示读取失败（502），**不得静默**。
 * 宿主桥故障（起不来 / 连不上 / 中途消失）⇒ 状态页与触发响应一律显示「宿主桥已断」+ 结构化错误码。
 *
 * **错误呈现（REQ-v0.9.1-2026-09-25-03 弹窗化）**：结构化错误出口按 `wantsJson` 分流 ——
 * `Accept: application/json` ⇒ JSON 形状 `{ok:false,code,error}` 逐字节不变；表单档（浏览器提交）⇒
 * 同状态码渲染整页 + 错误浮层（`errorPage`：族名标题中文映射 + error 正文 + mono 错误码 +「知道了」）。
 * `/shutdown`（运维口，板 UI 无表单）与既有 HTML 出口（宿主轮结果页 / 停桥提示 / 桥宕整页）不在分流范围。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import {
  createBridgeClient,
  type BridgeClient,
  type BridgeClientOptions,
} from "./bridge-client.js";
import { dispositionHttpStatus, terminalTurnRejection, type BoardHostFace, type TriggerTurnOutcome } from "./host-face.js";
import { isTerminalFeatureState } from "./derive.js";
import {
  createRequirement,
  DEFAULT_MCP_BASE_URL,
  type CreateRequirementOptions,
  type CreateRequirementOutcome,
} from "./requirement.js";
import {
  checkWriteAuth,
  parseRequirementForm,
  parseWriteRoute,
  WRITE_ROUTES,
  MAX_REQUIREMENT_BODY_BYTES,
} from "./write-guard.js";
import { readVersion } from "./version.js";
import { defaultRepoRoot, listDocs, readDoc, type DocsSource } from "./docs-read.js";
import { defaultStaticRoot, findVendoredAsset, VENDORED_ASSETS } from "./docs-render.js";
import type { FeatureDocsView } from "./web/views.js";
import { timestampPrefix } from "./log.js";
import { BOARD_CSP, BOARD_REFERRER_POLICY, escapeHtml, renderPage, type ErrorOverlayParams, type NavKey } from "./web/layout.js";
import {
  VIEW_NOTES,
  errorFamilyLabel,
  renderAnswerForm,
  renderConfirmForm,
  renderFeaturesList,
  renderFeatureDetail,
  renderHostNotice,
  renderHostPage,
  renderNextStepGuide,
  renderProjects,
  renderDocPage,
  renderRequirementForm,
  renderTasks,
  renderTasksPick,
  renderTurnForm,
  renderTurnOutcome,
} from "./web/views.js";

export interface BoardServerHandle {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface CreateBoardServerOptions {
  host: string;
  port: number;
  /** 桥客户端注入（测试用）；缺省按 `bridge` 选项建只读客户端 */
  client?: BridgeClient;
  /** 缺省客户端的桥基址等参数 */
  bridge?: BridgeClientOptions;
  /** 渲染时刻源（测试可固定，用于「已等待」单时钟计算） */
  now?: () => number;
  /**
   * **板级默认组织**（可选默认，BD11 起降级）：仅在**提需求表单未填组织名**时生效。
   * `undefined` / `null` / 空白 = 未配置 ⇒ **不是错误**，板照常起、写面照常可用；
   * 此时表单的组织名成为必填（缺失 ⇒ 请求期结构化 400 `board_group_required`，**不猜不回落**）。
   * 它同时是宿主面「桥侧无 `ownerGroup`」时的回退组织名（S1 身份链）。
   */
  defaultGroup?: string | null;
  /** 写面 MCP 端点基址，缺省 {@link DEFAULT_MCP_BASE_URL} */
  mcpBaseUrl?: string;
  /** `createRequirement` 注入（测试离线自证）；缺省用 `requirement.js` 的实现 */
  createRequirementImpl?: (
    input: Parameters<typeof createRequirement>[0],
    options: CreateRequirementOptions,
  ) => Promise<CreateRequirementOutcome>;
  /**
   * **宿主面**（BD8）：触发一轮 / 桥状态 / 停桥的唯一入口，缺省 `null` ⇒ 宿主面不可用
   * （`GET /host` 如实显示「未装配」，写端点结构化 503 `host_face_disabled`，**不假数据**）。
   * 名字与 `host`（绑定地址）区分 —— 绑定地址仍是 `host: string`。
   */
  hostFace?: BoardHostFace | null;
  /**
   * **优雅停机回调**（BD13″）：`POST /shutdown` 命中 loopback 来源时，先回 200（= 仅「受理」），
   * 再经 `setImmediate` 调用本回调（响应不被停机路径的 close 截断）。未注入 ⇒ 返回 501
   * `shutdown_unsupported`（服务未接停机链，不假装受理）。
   */
  onShutdown?: () => void;
  /**
   * **读文档面根**（BD11 · REQ-v0.9.1-2026-09-25-04）：`repoRoot` = 主仓根（源 A），
   * `orgsDir` = 组织目录根（源 B，`<orgsDir>/<org>/doc/`；未配置 ⇒ `null` ⇒ 只剩源 A）。
   * 缺省 = 按模块位置推导的板根上一级 + 无 orgsDir（目录不存在时按空清单降级，不报错）。
   */
  docs?: { repoRoot: string; orgsDir: string | null };
  /**
   * **vendored 静态资产目录**（BD14）：`GET /static/<名>` 的文件名闭集见 `docs-render.VENDORED_ASSETS`。
   * 缺省 = 模块旁 `src/web/static/`（仅服务白名单文件，不做目录遍历）。
   */
  staticRoot?: string;
}

/** 仅接受 loopback（127.0.0.1 / ::1 / localhost）；否则抛错，拒绝绑定非本机地址 */
export function assertLoopbackHost(host: string): void {
  const ok = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!ok) {
    throw new Error(`board 服务只允许绑定 loopback，拒绝非本机地址：${host}`);
  }
}

/**
 * **来源**地址是否 loopback（BD13″ `/shutdown` 的来源门；照 orch `http.ts#isLoopbackHostOrAddress`
 * 同语义、异实现）：覆盖 `::1` / `127.x` / IPv4-mapped IPv6（`::ffff:127.x`，双栈监听下对端常见形态）。
 */
export function isLoopbackAddress(value: string): boolean {
  const v = value.toLowerCase();
  return (
    v === "localhost" ||
    v === "::1" ||
    v === "[::1]" ||
    v.startsWith("127.") ||
    v === "::ffff:127.0.0.1" ||
    v.startsWith("::ffff:127.")
  );
}

/**
 * `/shutdown` 的判定（纯函数，来源门的唯一事实源）：
 * 返回 `"accept"` ⇒ 放行（调用方回 200 并触发停机链）；否则返回要原样回的结构化响应。
 * 板恒绑 loopback，非 loopback 对端无法在真机出现 ⇒ 该负向分支由本函数钉住（而非靠连真 socket）。
 */
export function decideShutdown(input: {
  method: string | undefined;
  remoteAddress: string;
  chainWired: boolean;
}): "accept" | { status: number; body: { ok: false; code: string; error: string } } {
  if (input.method !== "POST") {
    return { status: 405, body: { ok: false, code: "method_not_allowed", error: "POST /shutdown 只接受 POST" } };
  }
  if (!isLoopbackAddress(input.remoteAddress)) {
    return { status: 403, body: { ok: false, code: "loopback_only", error: "仅 loopback 来源可触发优雅停机" } };
  }
  if (!input.chainWired) {
    return {
      status: 501,
      body: { ok: false, code: "shutdown_unsupported", error: "本服务未接停机链（onShutdown 未注入），不假装受理" },
    };
  }
  return "accept";
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function respondHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": BOARD_CSP,
    // BD17：与页面内 `<meta name=referrer>` 同值 —— 同源表单必须带得上 Referer（写面守卫的第二档兜底）。
    "referrer-policy": BOARD_REFERRER_POLICY,
  });
  res.end(html);
}

/**
 * 单文档内容出口（BD11）：`text/plain; charset=utf-8` + `no-store`（头口径同 {@link respondJson}）。
 * 原文直出（不做 markdown 渲染 = B4），CSP 不适用（非 HTML）；`escapeHtml` 由视图层负责整页包装。
 */
function respondText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

interface PageCtx {
  client: BridgeClient;
  now: () => number;
}

/** 写面配置（**可选默认**组织名 + MCP 基址 + 唯一写封装）；生效序 = 表单组织名 > `defaultGroup`。 */
interface Ctx extends PageCtx {
  write: {
    defaultGroup: string | null;
    mcpBaseUrl: string;
    createRequirement: NonNullable<CreateBoardServerOptions["createRequirementImpl"]>;
  };
  /** BD8 宿主面（`null` ⇒ 未装配，写端点结构化 503、状态页如实显示）。 */
  host: BoardHostFace | null;
  /** BD13″ 优雅停机回调（`null` ⇒ 未接停机链，`POST /shutdown` 返回 501）。 */
  shutdown: (() => void) | null;
  /** BD11 读文档面根（源 A / 可选源 B）；BD14 增 vendored 静态资产根。 */
  docs: { repoRoot: string; orgsDir: string | null; staticRoot: string };
}

interface Page {
  title: string;
  active: NavKey;
  bodyHtml: string;
  status?: number;
  /** 表单档错误浮层（errorPage 专用；renderPage 内逐字段转义）。 */
  errorOverlay?: ErrorOverlayParams;
  /** BD14：页面级追加脚本（仅白名单字面量，如 mermaid 资产引用 + 渲染脚本；不承载文档内容）。 */
  extraScripts?: string;
}

function sendPage(res: ServerResponse, page: Page): void {
  respondHtml(
    res,
    page.status ?? 200,
    renderPage({
      title: page.title,
      active: page.active,
      bodyHtml: page.bodyHtml + (page.extraScripts ?? ""),
      notes: VIEW_NOTES,
      errorOverlay: page.errorOverlay,
    }),
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function wantsJson(accept: string | undefined): boolean {
  return (accept ?? "").includes("application/json");
}

/**
 * 表单档错误页（REQ-v0.9.1-2026-09-25-03）：整页 = 正常页 + errorOverlay 浮层（族名标题 / error 正文 / mono code）。
 * 只服务 **!wantsJson** 分流；JSON 档仍走 {@link respondJson}，形状逐字节不变。
 */
function errorPage(status: number, code: string, error: string, hint?: string): Page {
  return {
    title: "操作未成功",
    active: "features",
    status,
    bodyHtml:
      `<h2>操作未成功（${status}）</h2>` +
      `<p class="hint">错误浮层已给出原因；关闭浮层后刷新或回到上方导航重试。</p>`,
    errorOverlay: { family: errorFamilyLabel(code), error, code, hint },
  };
}

/** 结构化错误的统一应答出口：JSON 档逐字节不变，表单档（!wantsJson）改走 {@link errorPage}。 */
function respondError(
  res: ServerResponse,
  accept: string | undefined,
  status: number,
  code: string,
  error: string,
  hint?: string,
): void {
  if (wantsJson(accept)) {
    respondJson(res, status, { ok: false, code, error });
    return;
  }
  sendPage(res, errorPage(status, code, error, hint));
}

function bridgeDownPage(hint: string, err: unknown): Page {
  return {
    title: "桥不可达",
    active: "features",
    status: 502,
    bodyHtml:
      `<h2>桥数据读取失败（502）</h2>` +
      `<p class="hint err">${escapeHtml(errText(err))}</p>` +
      `<p class="hint">${escapeHtml(hint)} —— 板只读视图不缓存旧数据，恢复后刷新本页即可。</p>`,
  };
}

async function pageFeatures(ctx: Ctx): Promise<Page> {
  const view = await ctx.client.getFeatures();
  return {
    title: "需求列表",
    active: "features",
    bodyHtml: renderRequirementForm(ctx.write.defaultGroup) + renderFeaturesList(view),
  };
}

/**
 * 「阶段产出」清单（BD11 a 案）：双源合并列 `doc/{version}/`。
 * version 缺失 / 不合白名单 ⇒ docs-read 返回空清单 ⇒ 区块如实显示「无」（不报错，B3）；
 * 盘查不动等异常 ⇒ 只出可见错误文案（不静默、不泄根）。
 */
function loadDocsView(ctx: Ctx, version: string | null, org: string | null): FeatureDocsView {
  try {
    return {
      entries: listDocs(
        { repoRoot: ctx.docs.repoRoot, orgsDir: ctx.docs.orgsDir, org },
        version ?? "",
      ),
      error: null,
    };
  } catch (err) {
    return { entries: [], error: errText(err) };
  }
}

async function pageFeatureDetail(ctx: Ctx, featureId: string): Promise<Page> {
  const detail = await ctx.client.getFeature(featureId);
  let trace = null;
  let traceError: string | null = null;
  try {
    trace = await ctx.client.getFeatureTrace(featureId);
  } catch (err) {
    traceError = errText(err);
  }
  // BD9：宿主面装配了才显示轮触发与确认入口；回答框**仅在存在 `awaiting_answer` 轮时出现**。
  // BD18：确认按钮按 approval 条件化（禁用/灰态 + 原因），并给整页一行「下一步」引导。
  // 收口轨 14 ②：再叠加轮状态判据 —— 该需求已有在飞 / 排队轮 ⇒ 「触发一轮 / 发送确认指令」禁用 + 原因。
  const f = detail.feature;
  // 收口轨 16 ①：引擎终态优先 —— 终态需求不渲染回答表单（台账里的陈旧 awaiting 残留不再作数），
  // 引导行也走 deriveNextStepHint 的终态文案（两处共用 isTerminalFeatureState 同一判据）。
  // 收口轨 17：同一终态事实下传两个写表单 ⇒「触发一轮 / 发送确认指令」渲染为 disabled + 原因。
  const terminal = isTerminalFeatureState(f.state);
  const awaiting = ctx.host === null || terminal ? null : ctx.host.awaitingTurnOf(f.featureId);
  const busy = ctx.host === null ? null : ctx.host.busyTurnOf(f.featureId);
  const hostForms =
    ctx.host === null
      ? ""
      : renderTurnForm(f.featureId, busy, f.state) + renderConfirmForm(f.featureId, f.approval, busy, f.state);
  const nextStep = renderNextStepGuide({
    hostFaceAssembled: ctx.host !== null,
    awaitingAnswer: awaiting !== null,
    approval: f.approval,
    state: f.state,
  });
  const answerForm = awaiting === null ? "" : renderAnswerForm(f.featureId, awaiting.question);
  const docs = loadDocsView(ctx, f.version, f.ownerGroup);
  return {
    title: `需求 ${featureId.slice(0, 8)}`,
    active: "features",
    bodyHtml: renderFeatureDetail(detail, trace, traceError, ctx.now(), docs) + nextStep + hostForms + answerForm,
  };
}

/**
 * `GET /features/:id/docs?file=<name>[&src=A|B]`（BD11 a 案 HTTP 面）：
 * 版本与归属组织从桥侧详情取（**不接受调用方传 version** ⇒ 无从绕开白名单），
 * 落盘读取全权交 docs-read 的四件套守卫。读面恒 GET、不过 CSRF（既有口径）。
 *
 * 两档呈现（同 `wantsJson` 分流先例）：`Accept: text/html`（浏览器点开）⇒ 整页；
 * 其余 ⇒ `text/plain; charset=utf-8`（原文，头口径同 `respondJson`）。失败一律纯文本 404 / 400
 * （docs-read 的文案不携带根路径 = B3「不泄根」）。
 *
 * **BD14 渲染/原文双档**（仅 html 档内再分流）：`mode=render`（缺省）⇒ markdown 子集渲染 +
 * mermaid 占位；`mode=raw` ⇒ 现行 `<pre>` 原文视图**原样保留**；`text/plain` 档不受 mode 影响。
 *
 * **BD13 补源 B（b 案·服务端回落）**：`src` 显式指定 ⇒ 只查该源（现状不变）；`src` 缺省 ⇒ 先查源 A，
 * `not_found` 时回落源 B —— 回落是**换参重走 readDoc**，四件套守卫逐源各自过一遍（只加通路不开口子）。
 * 实际来源经响应头 `X-Docs-Source: A|B` 透出，html 档另在页头标注 —— 两源同名时源 A 优先、不歧义。
 */
async function handleFeatureDoc(
  ctx: Ctx,
  res: ServerResponse,
  req: IncomingMessage,
  featureId: string,
  params: URLSearchParams,
): Promise<void> {
  const file = params.get("file") ?? "";
  const srcParam = params.get("src");
  const srcExplicit = srcParam === "A" || srcParam === "B";
  let version: string | null;
  let org: string | null;
  try {
    const detail = await ctx.client.getFeature(featureId);
    version = detail.feature.version;
    org = detail.feature.ownerGroup;
  } catch (err) {
    respondText(res, 502, `需求数据读取失败，无法定位文档：${errText(err)}`);
    return;
  }
  const dirs = { repoRoot: ctx.docs.repoRoot, orgsDir: ctx.docs.orgsDir, org };
  const read = (source: DocsSource) => readDoc(dirs, source, version ?? "", file);
  let src: DocsSource = srcExplicit ? (srcParam as DocsSource) : "A";
  let result = read(src);
  if (!srcExplicit && !result.ok && result.code === "docs_read_not_found") {
    const fallback = read("B");
    if (fallback.ok) {
      src = "B";
      result = fallback;
    }
  }
  res.setHeader("X-Docs-Source", src);
  if (!result.ok) {
    respondText(res, result.code === "docs_read_not_found" ? 404 : 400, result.error);
    return;
  }
  if ((req.headers.accept ?? "").includes("text/html")) {
    const mode = params.get("mode") === "raw" ? "raw" : "render";
    const view = renderDocPage(featureId, file, src, result.content, result.truncated, mode, ctx.docs.staticRoot);
    sendPage(res, {
      title: `文档 ${file}`,
      active: "features",
      bodyHtml: view.bodyHtml,
      extraScripts: view.extraScripts,
    });
    return;
  }
  respondText(res, 200, result.truncated ? `${result.content}\n\n…（超过读取上限，已截断）` : result.content);
}

/** 宿主桥状态页（BD8）：本板进程的桥事实 + 轮队列；**不触桥**（宿主面故障与编排桥故障分开显示）。 */
async function pageHost(ctx: Ctx, notice: string | null): Promise<Page> {
  if (ctx.host === null) {
    return {
      title: "宿主桥",
      active: "host",
      bodyHtml: renderHostPage({
        entries: [],
        config: { orgsDir: null, defaultOrg: null, kind: "（宿主面未装配）" },
        notice: HOST_FACE_DISABLED_DISPLAY,
      }),
    };
  }
  const entries = await ctx.host.statusView();
  return {
    title: "宿主桥",
    active: "host",
    // BD14：组织目录根坏了是**根因**，要在还没有任何桥的时候就能看见（否则本页只会一片「无桥可显示」）。
    bodyHtml: renderHostPage({
      entries,
      config: ctx.host.configView(),
      notice,
      orgsDirProblem: ctx.host.orgsDirProblem(),
    }),
  };
}

async function pageTasks(ctx: PageCtx, url: URL): Promise<Page> {
  const project = url.searchParams.get("project");
  if (project === null || project.length === 0) {
    let projects = null;
    let projectsError: string | null = null;
    try {
      projects = await ctx.client.getProjects();
    } catch (err) {
      projectsError = errText(err);
    }
    return { title: "任务视图", active: "tasks", bodyHtml: renderTasksPick(projects, projectsError) };
  }
  const view = await ctx.client.getTasks(project);
  return { title: `任务 · ${project}`, active: "tasks", bodyHtml: renderTasks(view) };
}

async function pageProjects(ctx: PageCtx): Promise<Page> {
  const view = await ctx.client.getProjects();
  return { title: "项目 / 机器", active: "projects", bodyHtml: renderProjects(view) };
}

export function createBoardServer(options: CreateBoardServerOptions): Promise<BoardServerHandle> {
  assertLoopbackHost(options.host);
  const ctx: Ctx = {
    client: options.client ?? createBridgeClient(options.bridge ?? {}),
    now: options.now ?? Date.now,
    write: {
      defaultGroup: options.defaultGroup ?? null,
      mcpBaseUrl: options.mcpBaseUrl ?? DEFAULT_MCP_BASE_URL,
      createRequirement: options.createRequirementImpl ?? createRequirement,
    },
    host: options.hostFace ?? null,
    shutdown: options.onShutdown ?? null,
    docs: {
      repoRoot: options.docs?.repoRoot ?? defaultRepoRoot(),
      orgsDir: options.docs?.orgsDir ?? null,
      staticRoot: options.staticRoot ?? defaultStaticRoot(),
    },
  };
  const server: Server = createServer((req, res) => {
    void handle(req, res, server, ctx).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      respondError(res, req.headers.accept, 500, "internal_error", errText(err));
    });
  });
  return new Promise<BoardServerHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const addr = server.address();
      const boundPort = addr !== null && typeof addr === "object" ? addr.port : options.port;
      resolve({
        host: options.host,
        port: boundPort,
        close: () => closeServer(server),
      });
    });
  });
}

const TRACE_SUFFIX = "/trace";
/** 单文档子路径（BD11）：`GET /features/:id/docs?file=<name>`。 */
const DOCS_SUFFIX = "/docs";

/** `/static/` 名字段解码（异常编码 ⇒ null，不抛）。 */
function decodeURIComponentSafe(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** `/static/` 段卫生（BD14）：单段、无分隔符 / 点段 / 冒号 / 百分号（白名单精确匹配前的第一道）。 */
function isSafeStaticName(name: string): boolean {
  return (
    name !== "" &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes(":") &&
    !name.includes("%") &&
    !name.includes("..")
  );
}

/** 宿主面未装配（板进程未接 BD4a / BD4b）时的统一码与文案。 */
const HOST_FACE_DISABLED_CODE = "host_face_disabled";
const HOST_FACE_DISABLED_DISPLAY =
  "宿主面未装配：本板进程未接上「组织目录根」（config.json 的 orgsDir 未配置，无缺省值）⇒ 不起桥、不触发一轮";

type PageRoute = { kind: "feature" | "feature-docs"; id: string } | { kind: NavKey } | null;

function matchPage(pathname: string): PageRoute {
  if (pathname === "/") return { kind: "features" };
  if (pathname === "/tasks") return { kind: "tasks" };
  if (pathname === "/projects") return { kind: "projects" };
  if (pathname === "/host") return { kind: "host" };
  if (pathname.startsWith("/features/")) {
    const raw = pathname.slice("/features/".length);
    const isDocs = raw.endsWith(DOCS_SUFFIX);
    const idPart = isDocs ? raw.slice(0, -DOCS_SUFFIX.length) : raw;
    if (idPart.length > 0 && !idPart.includes("/") && !idPart.endsWith(TRACE_SUFFIX)) {
      try {
        const id = decodeURIComponent(idPart);
        return isDocs ? { kind: "feature-docs", id } : { kind: "feature", id };
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  server: Server,
  ctx: Ctx,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://board.invalid");
  } catch {
    respondError(res, req.headers.accept, 400, "bad_url", "无法解析请求 URL");
    return;
  }
  if (url.pathname === "/health" && req.method === "GET") {
    const addr = server.address();
    const port = addr !== null && typeof addr === "object" ? addr.port : 0;
    respondJson(res, 200, { status: "ok", version: readVersion(), port });
    return;
  }
  /**
   * BD13″ 优雅停机（运维路径，先于业务写面方法门）：仅 POST、仅 loopback 来源；
   * 200 = 受理（≠ 已停），停机经回调在响应发出后触发（`setImmediate`，不截断响应）。
   */
  if (url.pathname === "/shutdown") {
    const remote = req.socket.remoteAddress ?? "";
    const decision = decideShutdown({ method: req.method, remoteAddress: remote, chainWired: ctx.shutdown !== null });
    if (decision !== "accept") {
      if (decision.body.code === "loopback_only") {
        process.stderr.write(`${timestampPrefix("shutdown")}/shutdown 拒绝非 loopback 来源：${remote === "" ? "?" : remote}\n`);
      }
      respondJson(res, decision.status, decision.body);
      return;
    }
    respondJson(res, 200, { ok: true, message: "shutting_down" });
    const onShutdown = ctx.shutdown;
    setImmediate(() => {
      onShutdown?.();
    });
    return;
  }
  /** 方法门 = 读面白名单 ∪ 写面白名单（三条 POST，见 `write-guard.parseWriteRoute`）；其余非 GET 一律 405 */
  const writeRoute = parseWriteRoute(req.method, url.pathname);
  if (writeRoute !== null) {
    if (writeRoute.kind === "requirement") {
      await handleWriteRequirement(req, res, ctx);
    } else if (writeRoute.kind === "turn") {
      await handleWriteTurn(req, res, ctx, writeRoute.featureId, "trigger");
    } else if (writeRoute.kind === "confirm") {
      await handleWriteTurn(req, res, ctx, writeRoute.featureId, "confirm");
    } else if (writeRoute.kind === "answer") {
      await handleWriteAnswer(req, res, ctx, writeRoute.featureId);
    } else {
      await handleWriteHostStop(req, res, ctx, writeRoute.org);
    }
    return;
  }
  const route = matchPage(url.pathname);
  /**
   * BD14 `/static/<名>`：vendored 资产端点（读面，恒 GET）。文件名 = `VENDORED_ASSETS` 白名单闭集
   * （`findVendoredAsset` 精确匹配，路径段卫生在拼接前完成）；缺文件 ⇒ 404，不列目录。
   * 响应带同源 CSP（页面以 `<script src>` 加载须 `script-src 'self'` 放行，见 layout.ts 放宽说明）。
   */
  if (url.pathname.startsWith("/static/")) {
    if (req.method !== "GET") {
      respondError(res, req.headers.accept, 405, "method_not_allowed", "/static 仅支持 GET");
      return;
    }
    const name = decodeURIComponentSafe(url.pathname.slice("/static/".length));
    const found = name !== null && isSafeStaticName(name) ? findVendoredAsset(ctx.docs.staticRoot, name) : null;
    if (found === null) {
      respondError(res, req.headers.accept, 404, "not_found", "静态资产不在白名单");
      return;
    }
    let buf: Buffer;
    try {
      buf = readFileSync(found.absPath);
    } catch {
      respondError(res, req.headers.accept, 404, "not_found", "静态资产文件缺失（见 README vendored 资产节）");
      return;
    }
    res.writeHead(200, {
      "content-type": found.asset.contentType,
      "cache-control": "no-store",
      "content-security-policy": BOARD_CSP,
    });
    res.end(buf);
    return;
  }
  if (route === null) {
    respondError(res, req.headers.accept, 404, "not_found", `未知路径 ${url.pathname}`);
    return;
  }
  if (req.method !== "GET") {
    respondError(
      res,
      req.headers.accept,
      405,
      "method_not_allowed",
      `除已放开的写路径外仅支持 GET（写面 = ${WRITE_ROUTES.join(" · ")}；收到 ${req.method ?? "?"} ${url.pathname}）`,
    );
    return;
  }
  try {
    if (route.kind === "feature") {
      sendPage(res, await pageFeatureDetail(ctx, route.id));
    } else if (route.kind === "feature-docs") {
      await handleFeatureDoc(ctx, res, req, route.id, url.searchParams);
    } else if (route.kind === "tasks") {
      sendPage(res, await pageTasks(ctx, url));
    } else if (route.kind === "host") {
      sendPage(res, await pageHost(ctx, null));
    } else {
      const page =
        route.kind === "features"
          ? await pageFeatures(ctx)
          : await pageProjects(ctx);
      sendPage(res, page);
    }
  } catch (err) {
    sendPage(res, bridgeDownPage(`目标 = ${url.pathname}`, err));
  }
}

// ---------------------------------------------------------------------------
// BD7 / BD8 写面（三条放开的 POST；CSRF 守卫与结构化错误口径同一规格）
// ---------------------------------------------------------------------------

function lowerHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

/** 带硬上限地读请求体（超限即断连并报 413，不无界缓冲）。 */
function readBodyCapped(req: IncomingMessage, max: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error("payload_too_large"), { code: "payload_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleWriteRequirement(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const headers = lowerHeaders(req);
  // ① CSRF 守卫先于一切（未认证请求不消耗 body 读取、也不泄露板配置）
  const auth = checkWriteAuth({ method: req.method, headers, proto: "http" });
  if (!auth.ok) {
    respondError(res, headers.accept, 403, auth.code, auth.error);
    return;
  }
  // ② 入参校验（空 title/version ⇒ 400；组织名见 `parseRequirementForm`：**表单 > 板级默认**，
  //    两者皆空 ⇒ 400 `board_group_required` —— BD11 起校验点在请求期，板级默认未配置不是错误）
  let body: string;
  try {
    body = await readBodyCapped(req, MAX_REQUIREMENT_BODY_BYTES);
  } catch (err) {
    const code = errText(err) === "payload_too_large" ? "payload_too_large" : "body_read_failed";
    respondError(res, headers.accept, code === "payload_too_large" ? 413 : 400, code, errText(err));
    return;
  }
  const form = parseRequirementForm(body, Number(headers["content-length"] ?? NaN), ctx.write.defaultGroup);
  if (!form.ok) {
    respondError(res, headers.accept, form.status, form.code, form.error);
    return;
  }
  // ③ 复用唯一写封装（不新写 MCP 调用）；组身份 = 表单组织名（缺省才回落板级默认）
  const outcome = await ctx.write.createRequirement(
    { title: form.title, version: form.version, requirement: form.requirement },
    { group: form.group, baseUrl: ctx.write.mcpBaseUrl },
  );
  if (!outcome.ok) {
    respondError(res, headers.accept, 502, outcome.code, outcome.error);
    return;
  }
  // ④ 回显：浏览器表单 ⇒ 303 跳详情页（PRG，刷新不重复建）；声明 accept: application/json ⇒ 201 JSON
  const accept = headers.accept ?? "";
  if (accept.includes("application/json")) {
    respondJson(res, 201, {
      ok: true,
      featureId: outcome.featureId,
      /** 本条需求实际使用的组织名（表单优先，未填时回落板级默认）—— 归属可核对。 */
      group: form.group,
      state: outcome.state,
      stage: outcome.stage,
      version: outcome.version,
      approval: outcome.approval,
    });
    return;
  }
  res.writeHead(303, { location: `/features/${encodeURIComponent(outcome.featureId)}`, "cache-control": "no-store" });
  res.end();
}

// ---------------------------------------------------------------------------
// BD8 写面 ①：POST /features/:id/turn（触发一轮 —— 起桥 + 发轮，**不等排队轮**）
// ---------------------------------------------------------------------------

/**
 * 宿主面写端点的公共前置（**BD7 / BD8 / BD9 同规格**）：CSRF 守卫先于一切 ⇒ 排空请求体 ⇒ 宿主面装配检查。
 * 返回宿主面句柄与已排空的请求体；返回 `null` ⇒ 已应答（403 / 413 / 503），调用方直接 return。
 */
async function hostWriteGate(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
): Promise<{ face: BoardHostFace; body: string } | null> {
  const headers = lowerHeaders(req);
  const auth = checkWriteAuth({ method: req.method, headers, proto: "http" });
  if (!auth.ok) {
    respondError(res, headers.accept, 403, auth.code, auth.error);
    return null;
  }
  try {
    const body = await readBodyCapped(req, MAX_REQUIREMENT_BODY_BYTES);
    if (ctx.host === null) {
      respondError(res, headers.accept, 503, HOST_FACE_DISABLED_CODE, HOST_FACE_DISABLED_DISPLAY);
      return null;
    }
    return { face: ctx.host, body };
  } catch (err) {
    const code = errText(err) === "payload_too_large" ? "payload_too_large" : "body_read_failed";
    respondError(res, headers.accept, code === "payload_too_large" ? 413 : 400, code, errText(err));
    return null;
  }
}

/** turn / confirm / answer 共用的应答出口：JSON 档出结构化载荷，HTML 档出结果页（**失败不伪装成 200**）。 */
function respondTurnOutcome(
  res: ServerResponse,
  accept: string | undefined,
  title: string,
  outcome: TriggerTurnOutcome,
): void {
  const status = dispositionHttpStatus(outcome.disposition);
  if (wantsJson(accept)) {
    respondJson(res, status, outcome);
    return;
  }
  sendPage(res, {
    title: `${title} · ${outcome.featureId.slice(0, 8)}`,
    active: "features",
    status,
    bodyHtml: renderTurnOutcome(outcome),
  });
}

/**
 * BD8 触发一轮 与 BD9 人工确认（同一触发通道，仅提示词不同）共用一个 handler。
 * `kind = "confirm"` ⇒ 板投「用户已确认改造文档，请核对后执行放行」的一轮消息给宿主 agent
 * （**板不写状态机**：agent 核对不通过会不放行并回报原因，结果如实回显）。
 */
async function handleWriteTurn(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  featureId: string,
  kind: "trigger" | "confirm",
): Promise<void> {
  const headers = lowerHeaders(req);
  const gate = await hostWriteGate(req, res, ctx);
  if (gate === null) return;
  // 归属组织取桥侧 `ownerGroup`（身份链 S1）；读面失败 ⇒ 交宿主面回退**板级**组织名，
  // 两者皆无时宿主面返回结构化 503 —— 编排桥不可读不该让触发凭空猜一个组织。
  let org: string | null = null;
  let version: string | null = null;
  let engineState: string | null = null;
  try {
    const detail = await ctx.client.getFeature(featureId);
    org = detail.feature.ownerGroup;
    version = detail.feature.version;
    engineState = detail.feature.state;
  } catch {
    org = null;
  }
  // 收口轨 16 ③ 服务端兜底：已终态的需求 ⇒ 409 `board_feature_terminal`，不起桥不发轮
  // （防绕过页面直调 API 白烧一轮；编排桥读面失败 ⇒ 判不了，按既有链路放行，不新增误挡）。
  if (engineState !== null && isTerminalFeatureState(engineState)) {
    respondTurnOutcome(
      res,
      headers.accept,
      kind === "confirm" ? "确认指令" : "触发一轮",
      terminalTurnRejection(featureId, engineState),
    );
    return;
  }
  const outcome = kind === "confirm"
    ? await gate.face.confirmTurn({ featureId, org, version })
    : await gate.face.triggerTurn({ featureId, org, version });
  respondTurnOutcome(res, headers.accept, kind === "confirm" ? "确认指令" : "触发一轮", outcome);
}

// ---------------------------------------------------------------------------
// BD9 写面 ②：POST /features/:id/answer（澄清回答；仅当最新轮 `awaiting_answer` ⇒ 同 contextId 续推）
// ---------------------------------------------------------------------------

async function handleWriteAnswer(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  featureId: string,
): Promise<void> {
  const headers = lowerHeaders(req);
  const gate = await hostWriteGate(req, res, ctx);
  if (gate === null) return;
  const answer = (new URLSearchParams(gate.body).get("answer") ?? "").trim();
  if (answer === "") {
    respondError(
      res,
      headers.accept,
      400,
      "answer_empty",
      "回答内容为空（不得静默提交；澄清回答必须有内容）",
    );
    return;
  }
  // 收口轨 16 ③ 服务端兜底：终态需求 ⇒ 409 `board_feature_terminal`（与 turn / confirm 同一判据；
  // 桥读面失败 ⇒ 判不了，放行到宿主面既有链路，不新增误挡）。
  let engineState: string | null = null;
  try {
    engineState = (await ctx.client.getFeature(featureId)).feature.state;
  } catch {
    engineState = null;
  }
  if (engineState !== null && isTerminalFeatureState(engineState)) {
    respondTurnOutcome(res, headers.accept, "澄清回答", terminalTurnRejection(featureId, engineState));
    return;
  }
  const outcome = await gate.face.answerRequirement({ featureId, answer });
  respondTurnOutcome(res, headers.accept, "澄清回答", outcome);
}

// ---------------------------------------------------------------------------
// BD8 写面 ②：POST /host/:org/stop（停桥；停后立即重探活并渲染状态页）
// ---------------------------------------------------------------------------

async function handleWriteHostStop(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  org: string,
): Promise<void> {
  const headers = lowerHeaders(req);
  const gate = await hostWriteGate(req, res, ctx);
  if (gate === null) return;
  const outcome = await gate.face.stopBridge(org);
  const status = outcome.ok ? 200 : 502;
  if (wantsJson(headers.accept)) {
    respondJson(res, status, outcome);
    return;
  }
  const page = await pageHost(ctx, renderHostNotice(outcome));
  sendPage(res, { ...page, status });
}

/**
 * 关卡（BD13″ 停机链）：先 `closeIdleConnections()` + `server.close()` 等在飞收尾；
 * keep-alive/长连接会让 close 回调迟迟不来 ⇒ 宽限后 `closeAllConnections()` 强断兜底
 * （照 orch `http.ts#HTTP_CLOSE_GRACE_MS` = 5s 同语义、异实现）。**回调恒在宽限时 settle**，
 * 停机链不会因单条连接挂死。
 *
 * **BD19**：这根兜底定时器**必须 `unref()`**（先前漏了）—— 它只是「连接挂死」时的保险，
 * 不该反过来把已经排空的事件循环再钉 5s：真机上「已停止（耗时 5007ms）」就是它造成的
 * （停机链要等 `close()`，而 `close()` 之所以慢是 keep-alive 连接 —— 那些连接本身就是活跃句柄，
 * 定时器 unref 后照常在 5s fire；循环若已空则进程直接自然退出，走不到强断）。
 */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.closeIdleConnections();
    server.close(done);
    setTimeout(() => {
      server.closeAllConnections();
      setTimeout(done, 250).unref();
    }, HTTP_CLOSE_GRACE_MS).unref();
  });
}

/** 停机时强断残留连接的宽限（与 orch 桥同值）；导出供 index.ts 停机日志口径引用。 */
export const HTTP_CLOSE_GRACE_MS = 5_000;
