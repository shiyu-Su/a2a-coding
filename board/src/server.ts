/**
 * board HTTP 服务（BD1 骨架 + BD3 只读视图 + BD7 写面 + BD8 宿主面 + BD9 确认/回答入口 + v0.9.2 M3 排期写）—— **只绑 loopback**、零框架（`node:http`）。
 *
 * 路由：
 * - `GET /health`          —— 板自身健康（保留 BD1 行为）；
 * - `GET /`                —— **排期看板首页**（REQ-v0.9.2 增补 ④ N1：与 `/schedule` 同 kind 同渲染、逐字节同构；
 *   **REQ-2026-09-26-04 Q1**：页头「＋ 新增需求」按钮 + `<dialog id="new-req-dialog">` 提需求表单弹窗
 *   —— 表单 = `renderRequirementForm` 原样复用，提交经白名单内联脚本同源 fetch `POST /requirements`）；
 * - `GET /requirements`    —— **303 重定向回 `/`**（REQ-2026-09-26-04 Q2：需求列表页退役，旧地址深链兼容；
 *   与下 `POST /requirements` **同路径双义已终结** —— GET 恒重定向、不触桥，POST 仍建需求）；
 * - `GET /schedule`        —— **`/` 的别名**（历史深链兼容）：以下描述即首页看板内容
 *   （v0.9.2 M4/M5，只读）：数据 = 列表 `getFeatures()` 复用，
 *   板内存按 `version` 归组（M1 `version-order.ts` 数值序，非 `x.y.z` 字典序垫底）；列头 = 版本号 +
 *   卡片数；卡片 = title + 状态徽标 + stage/approval + taskCount（按状态分列不做）；
 *   **未排期卡**（单一判据 `trim() === ""`）不占版本列，集中本页末列「需求池」（卡上需求原文截断 120 字）；零写、零新桥接口；
 * - `GET /features/:id`    —— 需求详情 + 任务 + trace 三面 + 「触发一轮」+「阶段产出」（BD11；
 *   REQ-v0.9.2 按需求归约：该区由本需求 `decisions` 登记驱动，与旧「产出登记」合并为单区，版本目录清单作废）；
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
 * - `GET /orgs`            —— **组织视角页**（REQ-v0.9.2 N6，只读）：组织清单 = `<orgsDir>` 磁盘枚举
 *   ∪ 板托管台账 ∪ 板级默认 ∪ 需求归属 四源归并；逐组织以**组身份**只读 MCP 查 `a2a_projects`
 *   （并发 + 单组超时，失败/超时标「不可达」灰化不炸页）；需求按 `ownerGroup` 归组，
 *   null 归属归「（无归属）」伪分组如实呈现。零写、零缓存、零新增存储；
 * - `GET /agents`          —— **Agent View（机器与在飞）**（REQ-2026-09-26-02 B-T3，只读）：
 *   ① 机器表 = 桥 `/api/projects` 的 `runners` ∪ `machines` 归并（online/lastHeartbeatAt，无 runner 登记 ⇒ 未知）；
 *   ② 在飞任务区 = **逐 project 并发** `GET /api/tasks`（照 N6 模式：单项超时 `AGENT_QUERY_TIMEOUT_MS`、
 *   失败该项目灰化「不可达 ≠ 没有在飞」不炸页），按 `claimedAt` 升序、缺键沉底；
 *   ③ 页头 = **3300 页面退役后桥 identity/version 的唯一承载位**（`GET <mcpBaseUrl>/health` 的
 *   status/role/pid/startedAt/version，逐键容错、来源如实标注）；
 *   ④ 页脚口径行 = `AGENT_VIEW_CALIBRATION_NOTE`（闸内排队 orch 不可见、两个时钟不得相加）。
 *   零写、零缓存、零新增存储；
 * - `GET /host`            —— **宿主桥状态页**（本板进程托管的桥：五态 + 结构化错误 + 轮队列）；
 * - `POST /requirements`            —— 提需求（BD7 接线 · BD11 组织名进表单 · v0.9.2 M6 `version` 去必填，留空 = 未排期 ·
 *   **v0.9.2 增补 ⑤ N2**：`form.version` 命中 config `releasedVersions`（已发版锁版）⇒ **409 `board_version_released`**
 *   零出网 + 表单字段回填；空 version（未排期）不参与锁判）；
 *   **REQ-2026-09-26-04 Q2 起为提需求的唯一入口**（契约不变）：表单宿主 = 首页弹窗（`NEW_REQUIREMENT_DIALOG_SCRIPT` fetch 提交），
 *   无 JS / fetch 失效时弹窗内表单仍走原生整页 POST；成功 303 跳详情页的既有口径原样保留；
 * - `POST /features/:id/turn`       —— 触发一轮（BD8，起桥 + 发轮，**不等排队轮**；该需求已有在飞 /
 *   排队轮 ⇒ **409 `board_turn_busy`** 不重复入队 —— 收口轨 14 服务端防重，confirm / answer 同；
 *   需求已入**引擎终态** ⇒ **409 `board_feature_terminal`** 直接拒单不烧轮 —— 收口轨 16 ③，三入口同）；
 * - `POST /host/:org/stop`          —— 停桥（BD8，与上两条同规格受写面守卫）；
 * - `POST /features/:id/confirm`    —— 人工确认指令（BD9，**投消息给 agent**：由 agent 核对后自行执行 approve，板不批准）；
 * - `POST /features/:id/answer`     —— 澄清回答（BD9，仅当最新轮 `awaiting_answer` ⇒ 同 `contextId` 续推）；
 * - `POST /features/:id/schedule`   —— 排期写（v0.9.2 M3，唯一放开的登记字段 `version` 写）：表单 `version` **必须显式传**
 *   （空串 = 删除排期；服务端发送前 `trim()`），身份 = 该 Feature 的 `ownerGroup`（**null ⇒ 结构化 503，绝不回落板级默认组**），
 *   `to` = 先 `getFeature` 取当前态再经 `feature-schedule.ts` 封装走 advance「`to` = 当前态」特例；
 *   **已发版锁（v0.9.2 增补 ⑤ N3）**：现版本 ∉ 锁版 ∧ 目标 ∈ 锁版（入锁）或 现 ∈ 锁版 ∧ 目标 ≠ 现（出锁，含清空）
 *   ⇒ 409 `board_version_released` 零出网；同锁版无变化 ⇒ 幂等放行；
 *   **双条件状态闸（v0.9.3 B-T5）**：排期改动仅 `stage=需求分析 ∧ approval=未发起`（想法挪版）可写
 *   ⇒ 否则 409 `board_schedule_state_locked` 零出网（与已发版锁**叠加、互不替代**；同版重提两闸均豁免）；
 *   **改版自动善后（v0.9.3 B-T6）**：version 确实改动 ∧ decisions 含 `doc/{旧版}/` 登记 ⇒ 服务端受限 mv
 *   搬文档至 `doc/{新版}/` + 第二跳 advance 追加 decisions 新路径（仅源 A、仅登记路径、幂等；见 `docs-move.ts`）；
 *   读-写窗口态漂移被桥拒 ⇒ 如实弹错误浮层 + 表单值回填，**不自动重试**；
 * - `POST /shutdown`                —— **优雅停机（BD13″，仅 loopback 来源）**：200 仅代表「受理」；
 *   不经 CSRF 写面守卫（它是运维停机口，不是业务写面），来源门 = `socket.remoteAddress` 必须 loopback，
 *   非 loopback 一律 403 `loopback_only`（负向用例钉住）。
 *
 * **方法门**：读面仅 GET；写面只放开上面六条业务路径（白名单 = `write-guard.parseWriteRoute`）+
 * `/shutdown` 一条运维路径（本文件内处理），其余路径的非 GET 一律 405。写端点另受 CSRF 守卫（自定义头或同源 Origin/Referer，见 `write-guard.ts`）。
 * 板**不写状态机迁移**：approve / cancel 与「advance 到非当前态」的主链推进均无路径（确认与回答都只是给宿主 agent 的一轮消息，推进归 agent）；唯一放开的是 `version` 排期写（经 `feature-schedule.ts` 用 advance「`to` = 当前态」特例，M3 已接线 `POST /features/:id/schedule`）。
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
import { deriveTurnProgress, isTerminalFeatureState } from "./derive.js";
import {
  createRequirement,
  DEFAULT_MCP_BASE_URL,
  type CreateRequirementOptions,
  type CreateRequirementOutcome,
} from "./requirement.js";
import {
  scheduleFeature,
  type ScheduleAdvanceInput,
  type ScheduleFeatureOptions,
  type ScheduleOutcome,
  FeatureScheduleConfigError,
} from "./feature-schedule.js";
import {
  checkWriteAuth,
  parseRequirementForm,
  parseScheduleForm,
  parseWriteRoute,
  WRITE_ROUTES,
  MAX_REQUIREMENT_BODY_BYTES,
  ScheduleFormProgrammingError,
} from "./write-guard.js";
import { readVersion } from "./version.js";
import { isVersionLocked } from "./version-status.js";
import { normalizeVersion } from "./version-order.js";
import { defaultRepoRoot, readDoc, type DocsSource } from "./docs-read.js";
import { docsMoveRegistrations, executeDocsMove, planDocsMove, type DocsMoveResult } from "./docs-move.js";
import { defaultStaticRoot, findVendoredAsset, VENDORED_ASSETS, MERMAID_ASSET, mermaidAssetScriptTag, mermaidRenderScript, vendoredAssetExists } from "./docs-render.js";
import { renderDependencyGraphSection } from "./graph-view.js";
import {
  NO_OWNER_GROUP_LABEL,
  createOrgProjectsFetcher,
  groupFeaturesByOwner,
  listOrgDirs,
  mergeOrgNames,
  type OrgProjectsFetcher,
  type OrgProjectsOutcome,
} from "./orgs-view.js";
import type { AgentsPageInput, OrgsDirStatus, OrgsPageInput, OrgsRow } from "./web/views.js";
import { deriveScheduleGateOpen } from "./derive.js";
import {
  buildInflightModel,
  buildMachineRows,
  createAgentTasksFetcher,
  createBridgeIdentityFetcher,
  type AgentTasksFetcher,
  type AgentTasksOutcome,
  type BridgeIdentityFetcher,
} from "./agent-view.js";
import { timestampPrefix } from "./log.js";
import {
  BOARD_CSP,
  BOARD_REFERRER_POLICY,
  escapeHtml,
  renderPage,
  FEATURE_DETAIL_OVERLAY_SCRIPT,
  NEW_REQUIREMENT_DIALOG_SCRIPT,
  DRAG_SCHEDULE_SCRIPT,
  type ErrorOverlayField,
  type ErrorOverlayParams,
  type NavKey,
} from "./web/layout.js";
import {
  BRIDGE_UNREACHABLE_CODE,
  VIEW_NOTES,
  errorFamilyLabel,
  groupFeaturesByVersion,
  renderAcceptanceSection,
  renderAgentsPage,
  renderAnswerForm,
  renderConfirmForm,
  renderFeatureDetail,
  renderHostNotice,
  renderHostPage,
  renderNewRequirementDialog,
  renderNextStepGuide,
  renderOrgsPage,
  renderProjects,
  renderDocPage,
  renderSchedule,
  renderTasks,
  renderTasksPick,
  renderTurnForm,
  renderTurnOutcome,
  renderTurnProgress,
  selectRequirementPool,
  stopBridgeErrorOverlay,
  turnOutcomeErrorOverlay,
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
   * `scheduleFeature` 注入（测试离线自证，v0.9.2 M3）；缺省用 `feature-schedule.js` 的实现。
   * 排期写 = 板唯一放开的登记字段写，仍**只经该单一封装**触达 MCP advance 特例。
   */
  scheduleFeatureImpl?: (
    input: ScheduleAdvanceInput,
    options: ScheduleFeatureOptions,
  ) => Promise<ScheduleOutcome>;
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
  /**
   * **组织视角页的逐组项目查询器**（REQ-v0.9.2 N6）：只读 MCP 调用（`a2a_projects`，组身份 = 组织名）。
   * 缺省 = 按写面同基址（`mcpBaseUrl`）经 `mcp-client.ts` 真查；测试注入假桥。
   * `null` ⇒ 不查询，页面项目列如实显示「未查询」（不编造数据）。
   */
  orgProjectsFetcher?: OrgProjectsFetcher | null;
  /**
   * **Agent View 页的逐项目在飞任务查询器**（v0.9.3 B-T3）：只读桥单查 `GET /api/tasks?project=…`
   * （并发 + 单项超时，失败该项目灰化）。缺省 = 按板侧桥客户端同基址真查；测试注入假桥。
   * `null` ⇒ 不查询，全部项目按「不可达」灰化（如实降级，不编造「没有在飞」）。
   */
  agentTasksFetcher?: AgentTasksFetcher | null;
  /**
   * **Agent View 页头桥身份查询器**（v0.9.3 B-T3 · G3 收编）：只读 `GET <mcpBaseUrl>/health`
   * 取 role / pid / startedAt / version（3300 页面退役后的唯一承载位）。缺省 = 按写面同基址真查；
   * 测试注入假端点。`null` ⇒ 不查询，页头如实标「未查询」（不编造身份）。
   */
  bridgeIdentityFetcher?: BridgeIdentityFetcher | null;
  /**
   * **已发版版本清单**（REQ-v0.9.2 增补 ⑤ N1/N2）：= config `releasedVersions` 的注入通道。
   * 缺省 `[]`（未登记 ⇒ 无锁）。**锁判据唯一走 `version-status.isVersionLocked`**（trim 后精确串匹配）；
   * 启动期读一次，热改不生效（须重启）。
   */
  releasedVersions?: readonly string[];
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

/** 写面配置（**可选默认**组织名 + MCP 基址 + 两个 MCP 写封装）；生效序 = 表单组织名 > `defaultGroup`（仅提需求；排期**不回落**）。 */
interface Ctx extends PageCtx {
  write: {
    defaultGroup: string | null;
    mcpBaseUrl: string;
    createRequirement: NonNullable<CreateBoardServerOptions["createRequirementImpl"]>;
    scheduleFeature: NonNullable<CreateBoardServerOptions["scheduleFeatureImpl"]>;
  };
  /** BD8 宿主面（`null` ⇒ 未装配，写端点结构化 503、状态页如实显示）。 */
  host: BoardHostFace | null;
  /** BD13″ 优雅停机回调（`null` ⇒ 未接停机链，`POST /shutdown` 返回 501）。 */
  shutdown: (() => void) | null;
  /** BD11 读文档面根（源 A / 可选源 B）；BD14 增 vendored 静态资产根。 */
  docs: { repoRoot: string; orgsDir: string | null; staticRoot: string };
  /** N6 组织视角页的逐组项目查询器（`null` ⇒ 不查询，页面如实显示「未查询」）。 */
  orgProjects: OrgProjectsFetcher | null;
  /** B-T3 Agent View 页的逐项目在飞任务查询器（`null` ⇒ 不查询，项目全灰化）。 */
  agentTasks: AgentTasksFetcher | null;
  /** B-T3 Agent View 页头桥身份查询器（`null` ⇒ 不查询，页头如实标「未查询」）。 */
  bridgeIdentity: BridgeIdentityFetcher | null;
  /** 增补 ⑤ N2：已发版版本清单（config `releasedVersions` 注入；`[]` ⇒ 无锁）。锁判执法只走 `isVersionLocked`。 */
  releasedVersions: readonly string[];
}

interface Page {
  title: string;
  active: NavKey;
  bodyHtml: string;
  status?: number;
  /** 页头动作区（随标题渲染的字面量按钮；REQ-2026-09-26-04 首页「＋ 新增需求」）。 */
  headerActions?: string;
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
      headerActions: page.headerActions,
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
 * `fields`（REQ-v0.9.2 N1）：表单写路径失败时的回填字段回显；`active`：错误页导航高亮（缺省 features）。
 */
function errorPage(
  status: number,
  code: string,
  error: string,
  hint?: string,
  fields?: readonly ErrorOverlayField[],
  active: NavKey = "features",
): Page {
  return {
    title: "操作未成功",
    active,
    status,
    bodyHtml:
      `<h2>操作未成功（${status}）</h2>` +
      `<p class="hint">错误浮层已给出原因；关闭浮层后刷新或回到上方导航重试。</p>`,
    errorOverlay: { family: errorFamilyLabel(code), error, code, hint, fields },
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
  fields?: readonly ErrorOverlayField[],
  active: NavKey = "features",
): void {
  if (wantsJson(accept)) {
    respondJson(res, status, { ok: false, code, error });
    return;
  }
  sendPage(res, errorPage(status, code, error, hint, fields, active));
}

/**
 * 桥不可达整页（REQ-v0.9.2 N2）：改走 {@link errorPage} ⇒ 与其它结构化错误同一 BD2 浮层版式
 * （标题 = 族名「桥不可达」、正文 = 错误消息、mono = `bridge_unreachable`、「知道了」）。
 * 原「刷新重试」口径保留为 hint；`active` 随发起页，保证导航高亮不跳（首页/排期缺省「排期」）。
 */
function bridgeDownPage(hint: string, err: unknown, active: NavKey = "schedule"): Page {
  return errorPage(
    502,
    BRIDGE_UNREACHABLE_CODE,
    errText(err),
    `${hint} —— 板只读视图不缓存旧数据，恢复后刷新本页即可。`,
    undefined,
    active,
  );
}

/**
 * 首页表单旁的 orgsDir 三档结论（REQ-v0.9.2 N3 · 纯呈现）：
 * 未装配宿主面 / 装配了但根未配置或目录不可用（code 沿用 host-face 闭集）/ 就绪。
 */
function orgsStatusOf(host: BoardHostFace | null): OrgsDirStatus {
  if (host === null) return { tier: "not_configured" };
  const configured = host.configView().orgsDir;
  if (configured === null) return { tier: "not_configured" };
  const problem = host.orgsDirProblem();
  if (problem !== null) return { tier: "problem", code: problem.code, message: problem.message };
  return { tier: "ready", orgsDir: configured };
}

/**
 * 排期看板页（v0.9.2 M4 + M5 需求池；REQ-2026-09-26-04 Q1 起另承载「＋ 新增需求」弹窗）：
 * 数据 = `getFeatures()` 复用（零新桥接口），板内存按 version 归组；
 * 未排期卡不占版本列，集中末列「需求池」（判据单一 = `trim() === ""`）。
 * 弹窗 = 页头按钮 + dialog 骨架（表单复用 `renderRequirementForm`）+ 白名单内联脚本；
 * GET /requirements 列表页已退役（Q2：303 回本页）。
 */
async function pageSchedule(ctx: Ctx): Promise<Page> {
  const view = await ctx.client.getFeatures();
  return {
    title: "排期看板",
    active: "schedule",
    headerActions:
      '<button type="button" id="new-req-open" class="header-actions">＋ 新增需求</button>',
    bodyHtml:
      renderSchedule(
        groupFeaturesByVersion(view.features),
        selectRequirementPool(view.features),
        ctx.releasedVersions,
      ) +
      // 提需求弹窗骨架（表单原样复用；orgsDir 三档提示与锁版警示随表单呈现）
      renderNewRequirementDialog(ctx.write.defaultGroup, orgsStatusOf(ctx.host), ctx.releasedVersions),
    // REQ-v0.9.2 增补 ④：详情浮层脚本随本页（= schedule kind，`/` 与 `/schedule` 同一通路）注入，
    // 单点常量；其它 kind 无 dialog 骨架，脚本自身空转 ⇒ 不注入。卡片 <a> 回退不依赖它。
    // REQ-2026-09-26-04 Q1：新增需求弹窗脚本同页、同 extraScripts 通路注入（两枚各管各的 dialog）。
    // v0.9.3 B-T5：排期拖拽脚本同页、同通路（第三枚，常量分立不可共置；无 #schedule-board 的页面自然空转）。
    // v0.9.3 增补 ②：浮层换入的详情页依赖图/文档 mermaid 不经脚本执行（搬运节点不跑 `<script>`）⇒
    // 本页同挂 vendored 库 + 渲染脚本，浮层经 window.a2aRenderMermaid 钩子补渲（缺资产 ⇒ 不挂，源文本降级）。
    extraScripts:
      FEATURE_DETAIL_OVERLAY_SCRIPT +
      NEW_REQUIREMENT_DIALOG_SCRIPT +
      DRAG_SCHEDULE_SCRIPT +
      (vendoredAssetExists(ctx.docs.staticRoot, MERMAID_ASSET.file)
        ? mermaidAssetScriptTag() + mermaidRenderScript()
        : ""),
  };
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
  // REQ-v0.9.2 N7：轮次进度行 —— 排队位次取该桥队列可见面（在飞不查、查不到 ⇒ 不显示位次，
  // 队列面异常也不该把详情页带崩 ⇒ 兜成 null）。
  const queuePosition =
    busy !== null && busy.state === "queued" ? hostQueuePositionOf(ctx, busy.org, busy.turnId) : null;
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
  const turnProgress = renderTurnProgress(deriveTurnProgress(busy, queuePosition));
  const answerForm = awaiting === null ? "" : renderAnswerForm(f.featureId, awaiting.question);
  // T2 依赖图：mermaid 源经 application/json 数据通道注入（非可执行脚本、不入 n3 闭集）；
  // 渲染脚本只在区块存在且 vendored 资产在盘时挂（缺资产 ⇒ 源文本降级可见，不 404 静默）。
  const graph = renderDependencyGraphSection(detail.tasks);
  const extraScripts =
    graph.needsMermaid && vendoredAssetExists(ctx.docs.staticRoot, MERMAID_ASSET.file)
      ? mermaidAssetScriptTag() + mermaidRenderScript()
      : "";
  return {
    title: `需求 ${featureId.slice(0, 8)}`,
    active: "features",
    bodyHtml:
      renderFeatureDetail(detail, trace, traceError, ctx.now(), true, ctx.releasedVersions) +
      graph.html +
      "\n" +
      nextStep +
      renderAcceptanceSection(detail.acceptance) +
      turnProgress +
      hostForms +
      answerForm,
    extraScripts,
  };
}

/** 该桥队列里这条排队轮的位次（1 起）；队列面里没有它 / 取不到 ⇒ `null`（不臆造位次）。 */
function hostQueuePositionOf(ctx: Ctx, org: string, turnId: string): number | null {
  const face = ctx.host;
  if (face === null) return null;
  try {
    const index = face.queueView(org).waiting.findIndex((w) => w.turnId === turnId);
    return index < 0 ? null : index + 1;
  } catch {
    return null;
  }
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
      // REQ-v0.9.2 N2：503 降级档整页套 BD2 浮层版式（与写门 POST 的 errorPage 同码同文案；只加样式面，不动信息架构）。
      errorOverlay: {
        family: errorFamilyLabel(HOST_FACE_DISABLED_CODE),
        error: HOST_FACE_DISABLED_DISPLAY,
        code: HOST_FACE_DISABLED_CODE,
      },
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

async function pageTasks(ctx: PageCtx, url: URL, res: ServerResponse, accept: string | undefined): Promise<void> {
  const project = url.searchParams.get("project");
  if (project === null || project.length === 0) {
    let projects = null;
    let projectsError: string | null = null;
    try {
      projects = await ctx.client.getProjects();
    } catch (err) {
      projectsError = errText(err);
    }
    sendPage(res, { title: "任务视图", active: "tasks", bodyHtml: renderTasksPick(projects, projectsError) });
    return;
  }
  // REQ-v0.9.2 N4：`state`/`limit` 接进桥（客户端已具备并真发 query，bridge-client `getTasks`）——
  // 纯服务端接线。`limit` 非法 ⇒ 结构化 400（不静默吞）；`state` 不校验值域（桥侧过滤，如实回显）。
  const state = (url.searchParams.get("state") ?? "").trim();
  const limitRaw = (url.searchParams.get("limit") ?? "").trim();
  let limit: number | undefined;
  if (limitRaw !== "") {
    const parsed = /^([1-9]\d*)$/.exec(limitRaw);
    if (parsed === null || Number(parsed[1]) > MAX_TASKS_LIMIT) {
      respondError(
        res,
        accept,
        400,
        "invalid_limit",
        `limit 参数非法：${limitRaw.slice(0, 40)}（须为 1–${MAX_TASKS_LIMIT} 的整数）`,
        undefined,
        undefined,
        "tasks",
      );
      return;
    }
    limit = Number(parsed[1]);
  }
  const filter = { ...(state === "" ? {} : { state }), ...(limit === undefined ? {} : { limit }) };
  const view = await ctx.client.getTasks(project, filter);
  sendPage(res, { title: `任务 · ${project}`, active: "tasks", bodyHtml: renderTasks(view, filter) });
}

async function pageProjects(ctx: PageCtx): Promise<Page> {
  const view = await ctx.client.getProjects();
  return { title: "项目 / 机器", active: "projects", bodyHtml: renderProjects(view) };
}

/**
 * `GET /orgs` 组织视角页（REQ-v0.9.2 N6 · 只读）：
 * 组织清单 = 磁盘 `<orgsDir>` 一级目录 ∪ 板托管台账 ∪ 板级默认 ∪ 需求归属 四源归并（纯函数
 * `mergeOrgNames`）；逐组织经组身份只读查 `a2a_projects`（`Promise.allSettled` 并发 + 单组超时，
 * 失败/超时该组织标「不可达」灰化，**不炸页**）；需求按 `ownerGroup` 板内存归组，
 * null 归属归「（无归属）」伪分组如实呈现。零写、零缓存、零新增存储。
 */
async function pageOrgs(ctx: Ctx): Promise<Page> {
  const view = await ctx.client.getFeatures();
  const byOwner = groupFeaturesByOwner(view.features);
  const orgsStatus = orgsStatusOf(ctx.host);
  const orgsDir = ctx.docs.orgsDir;
  const dirProblem = orgsStatus.tier === "problem" ? { code: orgsStatus.code, message: orgsStatus.message } : null;
  const orgNames = mergeOrgNames({
    disk: listOrgDirs(orgsDir),
    // 台账源 = 宿主面托管记录（测试假宿主面可能未实现本方法 ⇒ 缺席按空源归并，不炸页）。
    ledger: ctx.host?.managedOrgs?.() ?? [],
    featureGroups: [...byOwner.keys()].filter((k) => k !== NO_OWNER_GROUP_LABEL),
    defaultGroup: ctx.write.defaultGroup,
  });
  type SettledQuery = PromiseSettledResult<OrgProjectsOutcome | null>;
  const settled = await Promise.allSettled(
    orgNames.map((org): Promise<OrgProjectsOutcome | null> =>
      ctx.orgProjects === null
        ? Promise.resolve(null)
        : ctx.orgProjects(org).catch((err: unknown): OrgProjectsOutcome => ({
            ok: false,
            code: "org_query_failed",
            error: err instanceof Error ? err.message : String(err),
          })),
    ),
  ) as SettledQuery[];
  const rows: OrgsRow[] = orgNames.map((org, i): OrgsRow => {
    const r: SettledQuery | undefined = settled[i];
    return {
      org,
      pseudo: false,
      projectsOutcome: r !== undefined && r.status === "fulfilled" ? r.value : null,
      features: byOwner.get(org) ?? [],
    };
  });
  const unowned = byOwner.get(NO_OWNER_GROUP_LABEL);
  if (unowned !== undefined && unowned.length > 0) {
    rows.push({ org: NO_OWNER_GROUP_LABEL, pseudo: true, projectsOutcome: null, features: unowned });
  }
  const input: OrgsPageInput = {
    rows,
    orgsDir,
    orgsDirProblem: dirProblem,
    ...(ctx.orgProjects === null ? { queryDisabledNote: "逐组项目查询器未装配 ⇒ 本页不查询任何组织的项目。" } : {}),
  };
  return { title: "组织视角", active: "orgs", bodyHtml: renderOrgsPage(input) };
}

/**
 * `GET /agents` Agent View 页（v0.9.3 B-T3 · 只读）：
 * 机器表 = `/api/projects` 的 `runners` ∪ `machines` 归并；在飞任务区 = **逐 project 并发**
 * `GET /api/tasks`（照 N6 模式：单项超时、失败该项目灰化「不可达 ≠ 没有在飞」，**不炸页**）；
 * 页头 = 3300 页面退役后桥 identity/version 的唯一承载位（`GET <mcpBaseUrl>/health`，取不到 ⇒ 灰化）。
 * 零写、零缓存、零新增存储。
 */
async function pageAgents(ctx: Ctx): Promise<Page> {
  const view = await ctx.client.getProjects();
  const projectIds = [...new Set(view.machines.flatMap((m) => m.projects.map((p) => p.projectId)))];
  const settled = await Promise.all(
    projectIds.map(async (projectId): Promise<AgentTasksOutcome> =>
      ctx.agentTasks === null
        ? { ok: false, code: "agent_tasks_not_queried", error: "在飞任务查询器未装配" }
        : ctx.agentTasks(projectId).catch((err: unknown): AgentTasksOutcome => ({
            ok: false,
            code: "tasks_query_failed",
            error: err instanceof Error ? err.message : String(err),
          })),
    ),
  );
  const tasks = new Map<string, AgentTasksOutcome>();
  projectIds.forEach((projectId, i) => {
    if (!tasks.has(projectId)) tasks.set(projectId, settled[i] as AgentTasksOutcome);
  });
  let identity: AgentsPageInput["identity"] = null;
  if (ctx.bridgeIdentity !== null) {
    try {
      identity = await ctx.bridgeIdentity();
    } catch (err) {
      identity = { ok: false, code: "health_query_failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
  const input: AgentsPageInput = {
    identity,
    identitySource: ctx.write.mcpBaseUrl,
    machineRows: buildMachineRows(view),
    inflight: buildInflightModel(view, tasks),
    observedAt: view.observedAt,
    ...(ctx.agentTasks === null
      ? { queryDisabledNote: "逐项目在飞任务查询器未装配 ⇒ 本页不查询任何项目的在飞任务（全部项目标为不可达）。" }
      : {}),
  };
  return { title: "Agent View", active: "agents", bodyHtml: renderAgentsPage(input) };
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
      scheduleFeature: options.scheduleFeatureImpl ?? scheduleFeature,
    },
    host: options.hostFace ?? null,
    shutdown: options.onShutdown ?? null,
    docs: {
      repoRoot: options.docs?.repoRoot ?? defaultRepoRoot(),
      orgsDir: options.docs?.orgsDir ?? null,
      staticRoot: options.staticRoot ?? defaultStaticRoot(),
    },
    orgProjects:
      options.orgProjectsFetcher === undefined
        ? createOrgProjectsFetcher({ baseUrl: options.mcpBaseUrl ?? DEFAULT_MCP_BASE_URL })
        : options.orgProjectsFetcher,
    agentTasks:
      options.agentTasksFetcher === undefined
        ? createAgentTasksFetcher(options.client ?? createBridgeClient(options.bridge ?? {}))
        : options.agentTasksFetcher,
    bridgeIdentity:
      options.bridgeIdentityFetcher === undefined
        ? createBridgeIdentityFetcher({ baseUrl: options.mcpBaseUrl ?? DEFAULT_MCP_BASE_URL })
        : options.bridgeIdentityFetcher,
    releasedVersions: options.releasedVersions ?? [],
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
/** `?limit=` 上界（REQ-v0.9.2 N4）：越界与格式错误同样落结构化 400，防超大值直传桥。 */
const MAX_TASKS_LIMIT = 500;
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

type PageRoute = { kind: "feature" | "feature-docs"; id: string } | { kind: Exclude<NavKey, "features"> } | null;

function matchPage(pathname: string): PageRoute {
  // REQ-v0.9.2 N1：`/` = 排期看板首页；`/schedule` 保留为别名（同 kind 同渲染，深链零红面）。
  if (pathname === "/" || pathname === "/schedule") return { kind: "schedule" };
  // REQ-2026-09-26-04 Q2：`/requirements` 列表页退役 ⇒ 不再注册读面路由（GET 重定向在 handle 先行处理）。
  if (pathname === "/tasks") return { kind: "tasks" };
  if (pathname === "/projects") return { kind: "projects" };
  if (pathname === "/orgs") return { kind: "orgs" };
  // REQ-2026-09-26-02 B-T3：Agent View（机器表 + 逐项目在飞任务 + 3300 收编的桥身份头）。
  if (pathname === "/agents") return { kind: "agents" };
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
  /** 方法门 = 读面白名单 ∪ 写面白名单（六条 POST，见 `write-guard.parseWriteRoute`）；其余非 GET 一律 405 */
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
    } else if (writeRoute.kind === "schedule") {
      await handleWriteSchedule(req, res, ctx, writeRoute.featureId);
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
  /**
   * REQ-2026-09-26-04 Q2：需求列表页退役 —— `GET /requirements` 303 回首页（排期看板，弹窗承载提需求）。
   * 先于路由匹配处理（该路径不再是读面路由）；重定向不触桥。板惯例用 303（R1 裁决：替代 301，留反悔余地）。
   */
  if (url.pathname === "/requirements") {
    if (req.method === "GET") {
      res.writeHead(303, { location: "/", "cache-control": "no-store" });
      res.end();
      return;
    }
    respondError(res, req.headers.accept, 405, "method_not_allowed", `GET /requirements 已改 303 回首页；其余方法不放开（收到 ${req.method ?? "?"} ${url.pathname}）`);
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
      await pageTasks(ctx, url, res, req.headers.accept);
    } else if (route.kind === "host") {
      sendPage(res, await pageHost(ctx, null));
    } else if (route.kind === "orgs") {
      sendPage(res, await pageOrgs(ctx));
    } else if (route.kind === "schedule") {
      sendPage(res, await pageSchedule(ctx));
    } else if (route.kind === "agents") {
      sendPage(res, await pageAgents(ctx));
    } else {
      sendPage(res, await pageProjects(ctx));
    }
  } catch (err) {
    sendPage(res, bridgeDownPage(`目标 = ${url.pathname}`, err, pageActiveOf(route)));
  }
}

/** 页面路由 → 导航高亮键（桥宕页随发起页高亮，REQ-v0.9.2 N2）。 */
function pageActiveOf(route: NonNullable<PageRoute>): NavKey {
  return route.kind === "feature" || route.kind === "feature-docs" ? "features" : route.kind;
}

// ---------------------------------------------------------------------------
// BD7 / BD8 / M3 写面（六条放开的 POST；CSRF 守卫与结构化错误口径同一规格）
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

/**
 * 提需求表单失败回填（REQ-v0.9.2 N1）：从已收取的 urlencoded 原始 body 提取非空提交值，
 * 供浮层回显。body 不可解析 / 字段全空 ⇒ 空数组（浮层与无回填时逐字节一致）。
 */
function requirementBackfillFields(body: string): ErrorOverlayField[] {
  const f = new URLSearchParams(body);
  const fields: ErrorOverlayField[] = [];
  for (const [key, label] of [
    ["group", "组织"],
    ["title", "标题"],
    ["version", "版本"],
    ["requirement", "需求描述"],
  ] as const) {
    const value = (f.get(key) ?? "").trim();
    if (value !== "") fields.push({ label, value });
  }
  return fields;
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
    respondError(res, headers.accept, form.status, form.code, form.error, undefined, requirementBackfillFields(body));
    return;
  }
  // ③ 已发版锁（REQ-v0.9.2 增补 ⑤ N2）：目标版本 ∈ config `releasedVersions` ⇒ 409 零出网。
  //    锁判据唯一走 `isVersionLocked`（trim 后精确串匹配，禁前缀）；空 version = 未排期 ⇒ 恒不锁、放行。
  if (isVersionLocked(form.version, ctx.releasedVersions)) {
    respondError(
      res,
      headers.accept,
      409,
      "board_version_released",
      `版本 ${form.version} 已发版 ⇒ 已发版版本不可排入新需求。请排入后续版本（本板只锁前台写口，登记/解锁改 config.json 的 releasedVersions 后重启生效）。`,
      undefined,
      requirementBackfillFields(body),
    );
    return;
  }
  // ④ 复用唯一写封装（不新写 MCP 调用）；组身份 = 表单组织名（缺省才回落板级默认）
  const outcome = await ctx.write.createRequirement(
    { title: form.title, version: form.version, requirement: form.requirement },
    { group: form.group, baseUrl: ctx.write.mcpBaseUrl },
  );
  if (!outcome.ok) {
    respondError(
      res,
      headers.accept,
      502,
      outcome.code,
      outcome.error,
      undefined,
      [
        { label: "组织", value: form.group },
        { label: "标题", value: form.title },
        { label: "版本", value: form.version },
        ...(form.requirement === undefined ? [] : [{ label: "需求描述", value: form.requirement }]),
      ],
    );
    return;
  }
  // ⑤ 回显：浏览器表单 ⇒ 303 跳详情页（PRG，刷新不重复建）；声明 accept: application/json ⇒ 201 JSON
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

/**
 * turn / confirm / answer 共用的应答出口：JSON 档出结构化载荷，HTML 档出结果页（**失败不伪装成 200**）。
 * 失败档（bridge_down / turn_failed / timeout / not_awaiting / busy / terminal / config_error）
 * 叠加 BD2 错误浮层（REQ-v0.9.2 N2 出口样式统一）；整页台账结构不动。
 *
 * **REQ-v0.9.2 N7**：HTML 档的**受理成功（排队）档**改 303 回需求详情页（PRG，同提需求 `POST /requirements`
 * 的先例）—— 该档本轮还没跑、结果页除「排队中」外无内容，详情页的轮次进度行才是它该有的落点，
 * 刷新也不重复烧一轮。**有内容回执的档（succeeded 摘要 / awaiting_answer 问题 / 各失败档）仍出整页**，
 * 否则 agent 的回答与失败根因会在跳转中丢失。JSON 档不受影响（载荷照常返回）。
 */
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
  if (outcome.disposition === "queued") {
    res.writeHead(303, {
      location: `/features/${encodeURIComponent(outcome.featureId)}`,
      "cache-control": "no-store",
    });
    res.end();
    return;
  }
  sendPage(res, {
    title: `${title} · ${outcome.featureId.slice(0, 8)}`,
    active: "features",
    status,
    bodyHtml: renderTurnOutcome(outcome),
    errorOverlay: turnOutcomeErrorOverlay(outcome) ?? undefined,
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
  sendPage(res, {
    ...page,
    status,
    errorOverlay: stopBridgeErrorOverlay(outcome) ?? undefined,
  });
}

// ---------------------------------------------------------------------------
// v0.9.2 M3 写面：POST /features/:id/schedule（排期写 —— 唯一放开的登记字段 `version` 写）
// ---------------------------------------------------------------------------

/** 排期写「归属组织缺失」的结构化错误码（503，请求期）—— 与提需求的 400 `board_group_required` 是两回事。 */
const SCHEDULE_OWNER_GROUP_MISSING_CODE = "board_schedule_owner_group_missing";

/** 锁版拒绝的回填：提交的目标版本 + 现版本（被锁的一侧要让用户看到「从哪被锁」；现为空 ⇒ 未排期）。 */
function scheduleLockBackfill(targetVersion: string, currentVersion: string | null): ErrorOverlayField[] {
  return [
    { label: "目标版本", value: targetVersion },
    { label: "现版本", value: normalizeVersion(currentVersion) === "" ? "（未排期）" : normalizeVersion(currentVersion) },
  ];
}

/**
 * 排期写一条需求（经 `feature-schedule.ts` 唯一封装，装配仅 {featureId, to, version} 三键）：
 * - 表单 `version` **必须显式传**（键缺失 ⇒ 编程错误，经全局兜底落 500，不做缺键语义）；
 *   空串 = 删除排期；服务端发送前一律 `trim()`；
 * - `to` = 先 `getFeature` 取当前态原样回填（advance「`to` = 当前态」登记字段特例，不迁移状态机）；
 * - **已发版锁（增补 ⑤ N3）**：`getFeature` 之后、出网之前做三分判（现版本 × 目标版本）——
 *   入锁（现 ∉ 锁版 ∧ 目标 ∈ 锁版）⇒ 409；出锁（现 ∈ 锁版 ∧ 目标 ≠ 现版本，含清空回池）⇒ 409；
 *   同锁版无变化 ⇒ 幂等放行；未排期 ↔ 未锁版间的一切变动照常（错误码同提需求面 `board_version_released`）；
 * - 身份 = 该 Feature 的 `ownerGroup`，**null ⇒ 结构化 503，绝不回落板级默认组**
 *   （排期改的是既有需求归属，拿板级组名出网会把写打到别的组织目录）；
 * - 读-写窗口内态漂移被桥拒（非法流转）⇒ 如实弹错误浮层 + N1 字段回填，**不自动重试**；
 * - **双条件状态闸（v0.9.3 B-T5）**：排期改动（新 version ≠ 现 version）仅
 *   `stage=需求分析 ∧ approval=未发起` 可写 ⇒ 409 `board_schedule_state_locked` 零出网；
 *   stage/approval 只作读判（getFeature），不进 HTTP 载荷与 `ScheduleAdvanceInput`；
 * - **改版自动善后（v0.9.3 B-T6）**：第一跳成功后，若 version 确实改动 ∧ decisions 含 `doc/{旧版}/`
 *   登记 ⇒ 受限 mv（`docs-move.ts`：仅源 A 树内、仅登记路径、目标已存在 = 跳 mv 仅登记、
 *   org 工作区路径不自动搬列入 manual）+ 第二跳 advance 追加 decisions 新路径；
 *   善后异常不回滚已成功的排期写，回执 `docMoves` 如实列出（JSON 出参；表单档 200 JSON 直显）；
 * - 成功 = PRG 303 回详情页；`Accept: application/json` ⇒ 200 JSON。
 */
async function handleWriteSchedule(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  featureId: string,
): Promise<void> {
  const headers = lowerHeaders(req);
  // ① CSRF 守卫先于一切（与既有五条同规格，含 body 读取都不做）
  const auth = checkWriteAuth({ method: req.method, headers, proto: "http" });
  if (!auth.ok) {
    respondError(res, headers.accept, 403, auth.code, auth.error);
    return;
  }
  // ② 入参解析（超限 413；version 键缺失 = 编程错误 ⇒ 不 catch，落全局兜底）
  let body: string;
  try {
    body = await readBodyCapped(req, MAX_REQUIREMENT_BODY_BYTES);
  } catch (err) {
    const code = errText(err) === "payload_too_large" ? "payload_too_large" : "body_read_failed";
    respondError(res, headers.accept, code === "payload_too_large" ? 413 : 400, code, errText(err));
    return;
  }
  const form = parseScheduleForm(body, Number(headers["content-length"] ?? NaN));
  if (!form.ok) {
    respondError(res, headers.accept, form.status, form.code, form.error);
    return;
  }
  const backfill = [{ label: "版本", value: form.version }];
  // ③ 当前态 + 归属 + 现版本：getFeature 失败 ⇒ 502 如实报（不猜态、不回落组名，交错误浮层）
  let to: string;
  let ownerGroup: string | null;
  let currentVersion: string | null;
  let stage: string | null;
  let approval: string | null;
  let decisions: string | null;
  try {
    const detail = await ctx.client.getFeature(featureId);
    to = detail.feature.state;
    ownerGroup = detail.feature.ownerGroup;
    currentVersion = detail.feature.version;
    stage = detail.feature.stage;
    approval = detail.feature.approval;
    decisions = detail.feature.decisions;
  } catch (err) {
    respondError(
      res,
      headers.accept,
      502,
      BRIDGE_UNREACHABLE_CODE,
      `需求数据读取失败，无法确定当前态与归属组织：${errText(err)}`,
      undefined,
      backfill,
    );
    return;
  }
  // ③a′ 同版判据（归一后**精确等串**，非前缀）：既是锁版幂等放行判据，也是双条件闸的豁免判据
  //     —— 同版重提 = 零变更写，不属「排期改动」，闸/锁都不拦（幂等语义原样保留）。
  const sameVersion = normalizeVersion(currentVersion) === normalizeVersion(form.version);
  if (ownerGroup === null || ownerGroup.trim() === "") {
    respondError(
      res,
      headers.accept,
      503,
      SCHEDULE_OWNER_GROUP_MISSING_CODE,
      `该需求无归属组织（ownerGroup 缺失）⇒ 拒绝排期写：不猜、绝不回落板级默认组（默认组只属于「提需求」链路）。` +
        "请先在引擎侧为该需求补齐 owner_group 后重试。",
      undefined,
      backfill,
    );
    return;
  }
  // ③b 已发版锁（REQ-v0.9.2 增补 ⑤ N3）：现版本（getFeature）× 目标版本（表单）三分判，零出网。
  //    同锁版无变化 ⇒ 幂等放行（不报错）；锁判据唯一走 `isVersionLocked`（trim 后精确匹配）；
  //    清空回池 = 目标归一后空串 ⇒ 若现 ∈ 锁版即"出锁"被拒。回填带上现版本值（用户看到从哪被锁）。
  const targetLocked = isVersionLocked(form.version, ctx.releasedVersions);
  const currentLocked = isVersionLocked(currentVersion, ctx.releasedVersions);
  // 入锁判据：`v0.9.1-probe` 相对锁版 `v0.9.1` 算「改到别的版」⇒ 出锁拒（同版判据见 ③a′ 精确等串）。
  if (!currentLocked && targetLocked) {
    respondError(
      res,
      headers.accept,
      409,
      "board_version_released",
      `版本 ${form.version} 已发版 ⇒ 该版本已发版，不可将需求排入（本板只锁前台写口，登记/解锁改 config.json 的 releasedVersions 后重启生效）。`,
      undefined,
      scheduleLockBackfill(form.version, currentVersion),
    );
    return;
  }
  if (currentLocked && !sameVersion) {
    respondError(
      res,
      headers.accept,
      409,
      "board_version_released",
      `该需求现排期版本 ${normalizeVersion(currentVersion)} 已发版 ⇒ 已发版版本的需求不可移出或取消排期（本板只锁前台写口，登记/解锁改 config.json 的 releasedVersions 后重启生效）。`,
      undefined,
      scheduleLockBackfill(form.version, currentVersion),
    );
    return;
  }
  // ③c 双条件状态闸（v0.9.3 B-T5 · 规范 §7 改版纪律）：排期改动仅
  //    `stage = 需求分析 ∧ approval = 未发起`（想法挪版档）可写 ⇒ 否则 409
  //    `board_schedule_state_locked` 零出网。stage/approval **只作读判**（来自 getFeature），
  //    不进 ScheduleAdvanceInput / HTTP 载荷（类型层封死，feature-schedule.ts）。
  //    与 ③b 已发版锁**叠加、互不替代**（两把锁各自独立 409，本版先判版本锁）；
  //    同版重提（sameVersion）= 零变更 ⇒ 闸豁免（口径同锁版幂等放行）。
  //    老桥登记字段缺失（null）⇒ fail-closed 拒写，不猜。
  if (!sameVersion && !deriveScheduleGateOpen(stage, approval)) {
    respondError(
      res,
      headers.accept,
      409,
      "board_schedule_state_locked",
      `需求已确认（stage = ${stage ?? "缺失"} · approval = ${approval ?? "缺失"}）⇒ 排期锁定：需求确认单经用户确认后（stage 迁「改造方案」/ approval 过门）该需求的排期即不可在本板改动，` +
        `仅「stage = 需求分析 ∧ approval = 未发起」的想法可改版/入池/出池（板前台执法，拖拽与表单同口）。` +
        `如确需挪版：方案变 ⇒ 由宿主走流程（主需求 cancel 后从 Step 0 新建）；**本板不提供解除入口**（approval 单向、无回边，锁不会因拖拽解除）。` +
        `宿主经 MCP 直写 \`version\` **不经过本闸**，由流程规范纪律句兜底。`,
      undefined,
      scheduleLockBackfill(form.version, currentVersion),
    );
    return;
  }
  // ④ 唯一封装出网（装配仅三键；桥拒原样透传，不自动重试）
  let outcome: ScheduleOutcome;
  try {
    outcome = await ctx.write.scheduleFeature(
      { featureId, to, version: form.version },
      { group: ownerGroup, baseUrl: ctx.write.mcpBaseUrl },
    );
  } catch (err) {
    // 封装的前置校验（空 featureId / 空 to / 缺 version 键 / 组名仅空白）= 编程错误口径，
    // 但其中「组名仅空白」可经真表单 + 老桥数据出现 ⇒ 归一为结构化 400，不裸 500。
    if (err instanceof ScheduleFormProgrammingError || err instanceof FeatureScheduleConfigError) {
      respondError(res, headers.accept, 400, "schedule_request_invalid", errText(err), undefined, backfill);
      return;
    }
    throw err;
  }
  if (!outcome.ok) {
    respondError(
      res,
      headers.accept,
      502,
      outcome.code,
      outcome.error + "（读-写窗口内状态可能已漂移；未自动重试，请刷新核对后再次提交）",
      undefined,
      backfill,
    );
    return;
  }
  // ④b 改版自动善后（v0.9.3 B-T6 · 受限 mv）：version 确实改动 ∧ decisions 含 doc/{旧版}/ 登记
  //    ⇒ 自动 mv 至 doc/{新版}/ + decisions 追加新路径（第二跳 advance，仅携带 version 回显 +
  //    decisions，仍不触 stage/approval）。守卫与幂等口径见 docs-move.ts：
  //    仅源 A 树内、仅登记路径、目标已存在 ⇒ 跳 mv 仅登记；org 工作区路径不自动搬、列入 manual。
  //    mv 为服务端文件动作，不经 HTTP 写路由面；第一跳已成功 ⇒ 善后异常不回滚排期写、不裸 5xx，
  //    moved/registerOnly/failed/manual 全部如实进回执（JSON 出参 / 表单档 JSON 直显）。
  let docMoves: (DocsMoveResult & { rejected: string[]; notes: string[] }) | null = null;
  if (!sameVersion) {
    const plan = planDocsMove(decisions, form.version, ctx.docs.repoRoot);
    if (plan.actions.length > 0 || plan.manual.length > 0 || plan.rejected.length > 0) {
      const executed = executeDocsMove(plan);
      docMoves = { ...executed, rejected: plan.rejected, notes: [] };
      const registrations = docsMoveRegistrations(executed);
      if (registrations.length > 0) {
        let appended: ScheduleOutcome;
        try {
          appended = await ctx.write.scheduleFeature(
            { featureId, to, version: form.version, decisions: registrations },
            { group: ownerGroup, baseUrl: ctx.write.mcpBaseUrl },
          );
        } catch (err) {
          appended = { ok: false, code: "schedule_request_invalid", error: errText(err) };
        }
        if (appended.ok) {
          docMoves.notes.push(`decisions 已追加 ${String(registrations.length)} 条搬移后路径`);
        } else {
          docMoves.failed.push(`decisions 追加未成功（${appended.code}：${appended.error}）⇒ 文档已搬至新目录，请宿主手工补登记`);
        }
      }
    }
  }
  // ⑤ 回显：JSON 档 200；表单档 PRG 303 回详情页（刷新不重复写）
  if (wantsJson(headers.accept)) {
    respondJson(res, 200, {
      ok: true,
      featureId: outcome.featureId,
      group: ownerGroup,
      state: outcome.state,
      version: outcome.version,
      ...(docMoves === null ? {} : { docMoves }),
    });
    return;
  }
  res.writeHead(303, { location: `/features/${encodeURIComponent(outcome.featureId)}`, "cache-control": "no-store" });
  res.end();
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
