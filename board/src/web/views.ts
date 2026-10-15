/**
 * 板只读视图（BD3）：需求列表 / 需求详情（含执行明细单表）/ 任务 / 项目·机器。
 *
 * 全部为**纯函数**（输入已归一的视图数据，输出正文 HTML 片段），规则一律取自
 * `derive.ts`，不散落在模板字符串里。所有动态值经 `escapeHtml`。
 */
import type {
  AcceptanceView,
  EngineVersionsProjection,
  FeatureDetailView,
  FeatureListItem,
  FeatureTaskItem,
  FeatureTraceView,
  ProjectTasksView,
  ProjectVersionsField,
  ProjectsView,
  TraceNode,
} from "../bridge-client.js";
import { projectVersionsOf } from "../bridge-client.js";
import {
  AGENT_VIEW_CALIBRATION_NOTE,
  INFLIGHT_CALIBRATION_NOTE,
  LATEST_TURN_SUMMARY_MAX,
  TRACE_READ_NOTE,
  deriveActionAffordance,
  deriveCardColorTier,
  deriveDisplayStage,
  deriveNextStepHint,
  deriveScheduleGateOpen,
  formatDurationBetween,
  isTerminalFeatureState,
  traceWaitDisplay,
} from "../derive.js";
import type { ChainStateLine, DisplayStage, NextStepInput, TurnProgressView } from "../derive.js";
import type { DocsSource } from "../docs-read.js";
import type { Receipt } from "../receipt.js";
import {
  MERMAID_ASSET,
  defaultStaticRoot,
  mermaidAssetScriptTag,
  mermaidRenderScript,
  renderMarkdown,
  vendoredAssetExists,
} from "../docs-render.js";
import type { HostStatusEntry, StopBridgeOutcome, TriggerDisposition, TriggerTurnOutcome } from "../host-face.js";
import { NO_OWNER_GROUP_LABEL } from "../orgs-view.js";
import { orgSpaceLink } from "../org-space.js";
import type { GroupRow, OrgGroupsOutcome, OrgPoolOutcome, OrgProjectsOutcome } from "../orgs-view.js";
import { MEMBER_ADD_RESIDENCY_NOTE } from "../group-admin.js";
import { nodeStateOf, taskDigest, taskOrdinalMap, taskSummaryLines } from "../graph-view.js";
import type {
  AgentInflightModel,
  AgentInflightProject,
  AgentMachineRow,
  BridgeIdentityOutcome,
} from "../agent-view.js";
import { compareVersionOrder, isUnscheduled, normalizeVersion, sortFeatureCards, sortPoolEntries } from "../version-order.js";
import { isVersionLocked } from "../version-status.js";
import { isConfirmedCard } from "../version-transition.js";
import { findVersionRecord, isVersionStatus, type VersionLedgerStatus, type VersionOrgFilter, type VersionsLedger } from "../versions-ledger.js";
import { VERSION_ACTION_REMOVE } from "../write-guard.js";
import { emptyRow, escapeHtml } from "./layout.js";
import type { ErrorOverlayParams } from "./layout.js";

/** 引擎态中文（**仅展示层**，照 orch 网页面先例；未命中原样显示，不吞不猜）。 */
const FEATURE_STATE_LABELS: Readonly<Record<string, string>> = {
  waiting_approval: "待审批",
  version_planning: "定版中",
  decomposing: "拆任务中",
  executing: "执行中",
  integrating: "集成中",
  testing: "测试中",
  reviewing: "评审中",
  completed: "已完成",
  needs_input: "待澄清",
  failed: "失败",
  cancelled: "已取消",
};

const TASK_STATE_LABELS: Readonly<Record<string, string>> = {
  working: "执行中",
  completed: "已完成",
  failed: "失败",
  "input-required": "待澄清",
  blocked: "已阻塞",
};

/**
 * 任务视图状态过滤候选（REQ-v0.9.2 N4 · `renderTasksPick` 用）：值域 = 主链 **8** 态 + 异常 3 态 +
 * `blocked`（良性终态，§4 口径）。
 * （原「需求列表页过滤」共用常量随列表页退役收编于此，REQ-2026-09-26-04 Q3。）
 */
const TASK_FILTER_STATES = [
  "waiting_approval",
  "version_planning",
  "decomposing",
  "executing",
  "integrating",
  "testing",
  "reviewing",
  "completed",
  "needs_input",
  "failed",
  "cancelled",
  "blocked",
] as const;

/**
 * 只读页常驻刷新的周期单点（REQ-2026-10-11-03 件N1 · 改造文档 §2.1 换块契约）：毫秒整数，
 * **只经 SSR 属性下发**（每页第一枚锚上的周期属性），不进任何脚本字面量 ⇒ 脚本不内置周期。
 */
export const LIVE_INTERVALS: Readonly<{ schedule: number; tasks: number; feature: number }> = {
  schedule: 30000,
  tasks: 15000,
  feature: 15000,
};

/**
 * 页级「上次更新」控制条（件N1）：**恒在所有锚之外**，三页各调一次（单点函数）。
 * 服务端不写任何时刻 —— 占位 `--:--:--` 由脚本在「至少一枚锚成功换块」的那一拍改写；
 * `⟳` 钮缺省 `hidden` ⇒ 无 JS 环境不出死钮。周期不进本条（只挂每页第一枚锚）。
 */
export function renderLiveBar(intervalMs: number): string {
  return `<p class="hint live-bar" data-live-note>上次更新 <b class="live-clock mono">--:--:--</b><button type="button" class="fl live-now" data-live-now hidden>⟳ 立即更新</button></p>`;
}

function label(map: Readonly<Record<string, string>>, value: string | null): string {
  if (value === null || value === "") return "—";
  return Object.prototype.hasOwnProperty.call(map, value) ? `${map[value]}（${value}）` : value;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function stamp(iso: string | null): string {
  return iso ?? "—";
}

function featureLink(featureId: string, text?: string): string {
  return `<a class="fl" href="/features/${encodeURIComponent(featureId)}">${escapeHtml(text ?? shortId(featureId))}</a>`;
}

/**
 * 增补徽标 + 单跳父需求深链（v0.9.3 B1 读面标注）：`parentFeatureId` 非空才产出；
 * 只取一层不递归（父卡是否也是增补由父卡自身渲染决定，本函数不判断）。
 */
function renderParentFeatureBadge(parentFeatureId: string | null | undefined): string {
  if (parentFeatureId === null || parentFeatureId === undefined || parentFeatureId === "") return "";
  return `<span class="kbadge">增补 · 父需求 ${featureLink(parentFeatureId)}</span>`;
}

/**
 * 排期卡第 2 行的「关联需求 id」格（增补五 件A）：`.kbadge` 徽标形态退役、并入 id 行；
 * 转义口径原样沿用 {@link featureLink}（href 经 encodeURIComponent + 文本 escapeHtml），
 * 深链与单跳不递归语义均不变（父卡自身渲染时另行判断）。
 */
function renderParentFeatureIdCell(parentFeatureId: string | null | undefined): string {
  if (parentFeatureId === null || parentFeatureId === undefined || parentFeatureId === "") return "";
  return ` <span class="mono muted" title="${escapeHtml(parentFeatureId)}">${featureLink(parentFeatureId)}</span>`;
}

// ---------------------------------------------------------------------------
// 阶段产出（decisions 驱动 · 单区）/ 单文档页（BD11 · REQ-v0.9.1-2026-09-25-04；
// REQ-v0.9.2-2026-09-26-01 起区块按需求归约：版本目录 flat 清单作废）
// ---------------------------------------------------------------------------

/**
 * decisions 元素里的文档路径提取（b 案）：`doc/…/x.md` 或裸 `{version}/x.md` 形态，
 * 只取文件名段。**提取结果只作展示** —— 打开必走 docs-read 守卫（`/features/:id/docs`
 * 以 version 白名单 + 段卫生 + 根内收 + `.md` 闭集拒绝越界名），本正则不是打开依据。
 */
const DOC_PATH_RE = /(?:doc\/)?(?:([^/\\:%"'>\s]+)\/)?([^/\\:%"'>\s]+\.md)/;

/** decisions 条目里的登记文档路径：`doc/` 前缀 + 至多两段（`{version}/{file}.md` 或 `{file}.md`）。 */
const REGISTERED_DOC_PATH_RE = /doc\/((?:[^/\\:%"'>\s]+\/)?[^/\\:%"'>\s]+\.md)/;

/** 从任意 decisions 文本提取 `{version, file}`；无 `.md` 路径 ⇒ null。 */
export function extractDocPath(text: string): { version: string; file: string } | null {
  const m = DOC_PATH_RE.exec(text);
  if (m === null) return null;
  return { version: m[1] ?? "", file: m[2] ?? "" };
}

/**
 * 从 decisions 文本提取**本需求登记**的文档路径，仅认 `doc/…/*.md` 形态：
 * `doc/{version}/{file}.md` ⇒ 两段；`doc/{file}.md` ⇒ version 段为空（打开仍按当前版本定位）。
 * 裸 `{version}/x.md`（无 `doc/` 前缀）不算登记产出。
 */
export function extractRegisteredDocPath(text: string): { version: string; file: string } | null {
  const m = REGISTERED_DOC_PATH_RE.exec(text);
  const path = m?.[1];
  if (path === undefined) return null;
  const segs = path.split("/");
  const file = segs[segs.length - 1] ?? "";
  const version = segs.length >= 2 ? (segs[0] ?? "") : "";
  return { version, file };
}

/**
 * 单文档打开链接（src 缺省 = 源 A 主仓根）。**版本不进链接** —— 服务端从桥侧详情取，
 * 不接受调用方传版本（否则等于把白名单交给请求方）。
 */
function docHref(featureId: string, file: string, src: DocsSource | null): string {
  const qs = new URLSearchParams({ file });
  if (src !== null) qs.set("src", src);
  return `/features/${encodeURIComponent(featureId)}/docs?${qs.toString()}`;
}

/** 源标注（判据 2 的「来源标注」）：A = 主仓根，B = 组织工作区。 */
function docsSourceLabel(source: DocsSource): string {
  return source === "A" ? "主仓" : "组织工作区";
}

/**
 * decisions / note 载荷 → 逐条字符串数组（容错口径同 bridge-client：不抛错）。
 * JSON 数组（桥侧 decisions 落库形态）⇒ 逐元素字符串；非数组 / 解析失败 ⇒ 整段原文一条；空 ⇒ []。
 */
export function parseDecisionItems(decisions: string | null | undefined): string[] {
  if (decisions === null || decisions === undefined || decisions.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(decisions);
    if (Array.isArray(parsed)) {
      return parsed.map((x) => (typeof x === "string" ? x : JSON.stringify(x) ?? String(x)));
    }
  } catch {
    /* 非 JSON ⇒ 按整段原文显示 */
  }
  return [decisions];
}

/**
 * decisions 登记里的文档版本集合（保序去重）：只收 `extractRegisteredDocPath` 命中且 version 段非空的条目。
 * 改版失联警示的判据源（不校验白名单 —— 不合白名单的登记本来就打不开，警示口径与其一致）。
 */
export function registeredDecisionDocVersions(decisions: string | null | undefined): string[] {
  const seen = new Set<string>();
  for (const item of parseDecisionItems(decisions)) {
    const hit = extractRegisteredDocPath(item);
    if (hit !== null && hit.version !== "") seen.add(hit.version);
  }
  return [...seen];
}

/**
 * decisions 登记里的**产出文件清单**（保序去重，v0.9.5 C1 引导行的事实源之一）：
 * 只收 `extractRegisteredDocPath` 命中的条目并取**文件名段**（与「阶段产出」区同一提取口径）。
 */
export function registeredDecisionDocFiles(decisions: string | null | undefined): string[] {
  const seen = new Set<string>();
  for (const item of parseDecisionItems(decisions)) {
    const hit = extractRegisteredDocPath(item);
    if (hit !== null && hit.file !== "") seen.add(hit.file);
  }
  return [...seen];
}

/**
 * M6 改版失联警示行（纯文案警示 ⇒ 不新增页面脚本，白名单内联字面量常量闭集（N3 纪律钉）不动）：
 * 「阶段产出」里存在版本段 ≠ 当前版本的文档登记 ⇒ 该文档的读锚 `doc/{旧版本}/` 已随改版失联
 * （打开端点按当前版本定位，改版不搬文档 = 板零本地写 ⇒ 点开 404，失联为已知语义）。
 * 未登记文档、或登记版本与当前版本一致 ⇒ 空串（不渲染）。
 */
export function renderVersionSwitchWarningLine(
  decisions: string | null | undefined,
  currentVersion: string | null,
): string {
  const current = (currentVersion ?? "").trim();
  const stale = registeredDecisionDocVersions(decisions).filter((v) => v !== current);
  if (stale.length === 0) return "";
  return `<p class="hint warn">文档读锚将随版本切换：已登记的 <code>${escapeHtml(stale.join(" · "))}</code> 文档与当前版本（<code>${escapeHtml(current === "" ? "未排期" : current)}</code>）不一致 ⇒ 打开按当前版本定位，旧版本文档在板上打不开（板零本地写，不搬文档目录）。</p>`;
}

/**
 * 折叠层的一节（v0.9.5 C3）：原生 `<details>`（服务端渲染、**零脚本**，不碰页面脚本闭集锚）·
 * 默认收起 ⇒ summary 只给「这是什么 + 有多少」，正文（含口径长文）展开才见。
 * `content` 为空 ⇒ 整节不渲染（C2 空区块短路的落点）。
 */
function foldSection(summary: string, content: string): string {
  if (content === "") return "";
  return `<details class="fold"><summary>${escapeHtml(summary)}</summary><div class="fold-body">${content}</div></details>`;
}

/**
 * 详情页「阶段产出」区（REQ-v0.9.2 按需求归约：与旧「产出登记」合并为单区）：
 * 数据源 = 本需求 `decisions` 逐条 —— 含 `doc/…/*.md` 路径的条目即产出条目（**单链接、链接文字 = 剥去
 * `doc/{版本}/` 后的文件名**，复用 `GET /features/:id/docs` 守卫端点；版本取当前值，登记路径不进链接）；
 * 其余条目原样保留（登记即产出记录，不再两处重复）。
 * 无含 doc 路径的条目 ⇒ 「无（本需求未登记产出）」+ 口径一句；不回落版本目录清单（用户裁决）。
 * `currentVersion` 传入时（排期表单在本页渲染）区首追加 M6 改版失联警示行，不传 ⇒ 行为不变。
 * v0.9.5 C3：本区整体在折叠层内（{@link foldSection}）。
 */
function renderStageOutputs(
  featureId: string,
  decisions: string | null | undefined,
  currentVersion?: string | null,
): string {
  const items = parseDecisionItems(decisions);
  const docCount = items.filter((item) => extractRegisteredDocPath(item) !== null).length;
  const rows = items.map((item) => {
    const hit = extractRegisteredDocPath(item);
    if (hit === null) return `<li>${escapeHtml(item)}</li>`;
    return `<li><a class="fl" href="${escapeHtml(docHref(featureId, hit.file, null))}">${escapeHtml(hit.file)}</a></li>`;
  });
  const body =
    docCount === 0
      ? `<p class="hint">无（本需求未登记产出）—— 产出登记由宿主 / agent 经 <code>advance</code> 的 <code>decisions</code> 逐轮 append 承载，板不回落版本目录清单。</p>`
      : `<ul class="docs">${rows.join("")}</ul>`;
  const warning =
    currentVersion === undefined ? "" : renderVersionSwitchWarningLine(decisions, currentVersion);
  return `<h2>阶段产出</h2>
${warning}${body}`;
}

/**
 * 卡片外壳（REQ-2026-09-30-04 件5 · 原型 v2.3 样张④⑤）：卡头 = 标题 + 右对齐元信息（计数 / 读取时间 / 出口链接），
 * 正文由调用方给出。`titleHtml` 与 `metaHtml` **按已转义 HTML 处理**（可含 `<code>` 等固定标记，
 * 动态值请调用方自行 `escapeHtml`）。样式 = `layout.ts` 的 `.b-card` 基元（取色一律走 `--b-` token）。
 */
function cardShell(titleHtml: string, metaHtml: string, bodyHtml: string, extraClass = ""): string {
  const meta = metaHtml === "" ? "" : `<span class="b-card-meta">${metaHtml}</span>`;
  return `<div class="b-card${extraClass === "" ? "" : ` ${extraClass}`}">
<p class="b-card-h">${titleHtml}${meta}</p>
${bodyHtml}
</div>`;
}

/** 文档页双档（BD14）：render = markdown 子集渲染；raw = 现行 `<pre>` 原文视图。 */
export type DocPageMode = "render" | "raw";

/** 文档页渲染出口：正文 HTML + 页面级追加脚本（仅白名单字面量，不承载文档内容）。 */
export interface DocPageView {
  readonly bodyHtml: string;
  readonly extraScripts: string;
}

/**
 * 单文档页正文（BD14 渲染/原文双档，页头互链切换，渲染缺省）：
 * - `render`：`docs-render.renderMarkdown`（escape-first 子集）；```mermaid 围栏 ⇒ 占位 div +
 *   `<script type="application/json">` 安全注入，页面脚本读 textContent 渲染（源文本不拼 HTML）；
 *   vendored 资产缺文件 ⇒ 不挂脚本，mermaid 块保留源文本（降级可见，不 404 静默）；
 * - `raw`：现行 `<pre>` + escapeHtml 原文直出**原样保留**。
 * 超限内容 docs-read 只读到 256KiB 打 truncated ⇒ 两档均显截断提示。
 * `src` = 服务端实际命中的源（BD13 补源 B）⇒ 页头标注来源，不歧义。
 */
export function renderDocPage(
  featureId: string,
  file: string,
  src: DocsSource,
  content: string,
  truncated: boolean,
  mode: DocPageMode = "render",
  staticRoot: string = defaultStaticRoot(),
): DocPageView {
  const truncNote = truncated
    ? `<p class="hint warn">文档超过读取上限，以下为前段内容（已截断）。</p>`
    : "";
  const selfQs = (extra: Record<string, string>): string => {
    const qs = new URLSearchParams({ file, src, ...extra });
    return `/features/${encodeURIComponent(featureId)}/docs?${qs.toString()}`;
  };
  const other = mode === "raw" ? "render" : "raw";
  const otherLabel = mode === "raw" ? "渲染视图" : "原文视图";
  const toggle = `<a class="fl" href="${escapeHtml(selfQs({ mode: other }))}">${otherLabel}</a>`;
  const head = `<p class="hint"><a class="fl" href="/features/${encodeURIComponent(featureId)}">回到需求详情</a> · <span class="mono">${escapeHtml(file)}</span> · 来源：${escapeHtml(docsSourceLabel(src))} · 当前：<b>${mode === "raw" ? "原文" : "渲染"}</b> · ${toggle}</p>
<h2>${escapeHtml(file)}</h2>`;
  if (mode === "raw") {
    return { bodyHtml: `${head}\n${truncNote}\n<pre class="result">${escapeHtml(content)}</pre>`, extraScripts: "" };
  }
  const md = renderMarkdown(content);
  let extraScripts = "";
  if (md.hasMermaid) {
    extraScripts = vendoredAssetExists(staticRoot, MERMAID_ASSET.file)
      ? mermaidAssetScriptTag() + mermaidRenderScript()
      : `<p class="hint warn">mermaid 静态资产缺失（vendored 文件未就位，见 README），流程图按源文本显示。</p>`;
  }
  return { bodyHtml: `${head}\n${truncNote}\n${md.html}`, extraScripts };
}


// ---------------------------------------------------------------------------
// 提需求表单（BD7 · 板唯一写控件；同源 POST，服务器端渲染）
// ---------------------------------------------------------------------------

/**
 * `POST /requirements` 的同源表单（**提交体验靠 `layout.ts` 的内联提交守卫防连点**，
 * 无 JS 时仍可正常提交 —— CSRF 防线因此走「同源 Origin」档，
 * 自定义头 `X-Board-Write` 留给 API 调用方，见 `write-guard.ts`）。
 *
 * **组织名进表单（BD11）**：它是身份链 S1 的**来源**（= MCP URL 首段 = 组织目录名），由用户在板上
 * 创建/指定 —— 首次填写某组织名即在板上创建该组织。板级配置只是**可选默认**：配置了则占位提示、
 * 允许留空；未配置则该字段 `required`（服务端另在请求期硬校验，缺 ⇒ 400，**不猜不回落**）。
 *
 * **组织空间免选（BD8）**：传 `spaceOrg`（= 路径组织）⇒ 组织字段改**只读展示 + hidden 字段**，
 * hidden 的 `value` 照常发出（回落链「表单 > 板级默认 ⇒ 皆空 400」不可绕过）；表单 `action`
 * 带组织前缀 `/org/<名>/requirements`，无 JS 原生 POST 同路命中归一层，服务端 mismatch 409 照执法。
 */
/**
 * 提需求弹窗旁（`/schedule` 看板与空间页；§9-b 起门户 `/` 另有自己的一行）的**组织目录根（orgsDir）配置状态**（REQ-v0.9.2 N3 · 三档）：
 * - `not_configured` —— 本板进程未装配宿主面（config.json 无 orgsDir，无缺省值）；
 * - `problem` —— 配了但目录此刻不可用（code/message 沿用 `host-face.diagnoseOrgsDir` 闭集）；
 * - `ready` —— 就绪，`orgsDir` 为 configView 的绝对/原样路径。
 */
export type OrgsDirStatus =
  | { tier: "not_configured" }
  | { tier: "problem"; code: string; message: string }
  | { tier: "ready"; orgsDir: string };

export function renderRequirementForm(
  defaultGroup: string | null,
  orgsStatus?: OrgsDirStatus | null,
  releasedVersions: readonly string[] = [],
  spaceOrg: string | null = null,
): string {
  const space = spaceOrg !== null && spaceOrg.trim() !== "";
  const cfg = (defaultGroup ?? "").trim();
  const orgHintHtml = space
    ? `组织 = <b>${escapeHtml(spaceOrg as string)}</b>（组织空间路径决定，免选；服务端以路径为准，不一致 ⇒ 409 <code>board_org_mismatch</code>）`
    : escapeHtml(
        cfg === ""
          ? "组织名 *（必填：本板未配默认组织 · 首次填写即创建该组织）"
          : `组织名（留空 = 用板级默认 ${cfg}；填写其它名字 = 在板上创建该组织）`,
      );
  const orgField = space
    ? `<label>组织（免选 · 空间路径决定）<input type="hidden" name="group" value="${escapeHtml(spaceOrg as string)}"><span class="muted"> ${escapeHtml(spaceOrg as string)}</span></label>`
    : `<label>组织名 ${cfg === "" ? "*" : ""}<input name="group" ${cfg === "" ? "required " : ""}placeholder="如 flow-team"></label>`;
  const versionHint =
    releasedVersions.length === 0
      ? ""
      : `<p class="hint warn">已发版版本（版本台账标记 <code>released</code>）<b>排期锁定</b>：${releasedVersions.map((v) => `<code>${escapeHtml(v)}</code>`).join(" · ")} —— 已发版版本不可排入新需求（服务端 409 拒绝；在板上把版本标记 released / 重开为进行中即实时生效）。字段仍可输入，执法在服务端。</p>`;
  const orgsLine =
    orgsStatus === undefined || orgsStatus === null
      ? ""
      : orgsStatus.tier === "ready"
        ? `<p class="hint">组织目录根（orgsDir）<b>就绪</b>：<code>${escapeHtml(orgsStatus.orgsDir)}</code></p>`
        : orgsStatus.tier === "problem"
          ? `<p class="hint err"><code>${escapeHtml(orgsStatus.code)}</code> 组织目录根已配置但不可用：${escapeHtml(orgsStatus.message)}</p>`
          : `<p class="hint warn"><code>board_orgs_dir_not_configured</code> 组织目录根（orgsDir）未装配：提需求本身不受影响，但<b>详情页动作区</b>提交 / 起宿主桥将结构化 503，请配置 config.json 的 orgsDir 后重启板。</p>`;
  return `<h2>提需求</h2>
${orgsLine}
<p class="hint">建一条需求 = 以<b>${space ? "空间路径组织（免选）" : "表单所填组织名"}</b>${space ? "" : "（留空则板级默认）"}经唯一写封装（<code>requirement.ts</code>）在桥侧建 Feature，落初态 <code>waiting_approval</code>（登记 <code>stage=需求分析</code> · <code>approval=未发起</code>）。板<b>不写状态机</b>：审批 / 推进 / 取消一律归编排 agent。</p>
<form method="post" action="${space ? escapeHtml(orgSpaceLink(spaceOrg as string) + "requirements") : "/requirements"}" class="w" data-submit="已提交，建需求中…">
${orgField}
<label>标题 *<input name="title" required placeholder="需求的简短摘要"></label>
<label>版本<input name="version" placeholder="如 v0.9.2；留空 = 未排期（进需求池）"></label>
${versionHint}
<label>需求原文<textarea name="requirement" rows="3" placeholder="可选"></textarea></label>
<p class="hint">${orgHintHtml}</p>
<button type="submit">提交需求</button>
</form>`;
}

/**
 * **新增需求弹窗骨架**（REQ-2026-09-26-04 Q1）：排期页注入的 `<dialog id="new-req-dialog">`，
 * 表单区 = {@link renderRequirementForm} 原样复用（字段/校验/组织选择器不重建）；
 * 开/关与 fetch 提交由 `layout.NEW_REQUIREMENT_DIALOG_SCRIPT` 承载（白名单内联常量，按页注入）。
 * 复用 `dialog.fd` 样式类 ⇒ 4xx 错误卡叠加规则（`dialog.fd > .err-ov-card`）同款生效。
 * 骨架本身只嵌表单字面量（表单内只有 placeholder/hint 文案，无用户数据）⇒ 无注入面。
 */
export function renderNewRequirementDialog(
  defaultGroup: string | null,
  orgsStatus?: OrgsDirStatus | null,
  releasedVersions: readonly string[] = [],
  spaceOrg: string | null = null,
): string {
  return `<dialog class="fd" id="new-req-dialog">
<button type="button" id="new-req-close">关闭</button>
<div class="fd-body">${renderRequirementForm(defaultGroup, orgsStatus, releasedVersions, spaceOrg)}</div>
</dialog>`;
}

/**
 * **新增版本弹窗骨架**（v0.9.4 增补八 §9.3 · REQ-2026-09-28-02）：排期页注入的
 * `<dialog id="new-version-dialog">`，与 {@link renderNewRequirementDialog} **同款结构**
 * （`dialog.fd` + 首枚「关闭」按钮 + `.fd-body` 内表单）；开/关与 fetch 提交由
 * `layout.NEW_REQUIREMENT_DIALOG_SCRIPT` 的 `wire()` 承载（闭集枚数不扩、CSP 不动）。
 * 表单 = SSR 原生可提交（无 JS 回落整页 PRG）：隐藏字段 `action=create` 分流 ——
 * **服务端写口与闸零改动**；semver 收口（`x.y.z`）执法在服务端，字段仍可输入。
 * 复用 `dialog.fd` 样式类 ⇒ 4xx 错误卡叠加规则（`dialog.fd > .err-ov-card`）同款生效。
 * 骨架只嵌字面量（placeholder 文案 + 组织名，均已转义）⇒ 无注入面。
 *
 * **组织作用域（v0.9.6 B4 · 口径 4 / 9）**：本弹窗**只由组织空间排期页渲染**（`spaceOrg !== null`
 * 才渲；全局页那份随 B5a 页退役一并撤除），入参 `org` = 路径组织、**必传**。
 * 表单**零 org 字段** —— 台账唯一键 = `(org, version)`，归属由服务端从**请求路径**取（客户端不提交、
 * 也不可提交；正文那行「归属组织」只读展示 = 同 BD8 提需求免选形态的口径）。
 * `action` 带空间前缀 = `orgSpaceLink(org) + "versions"`（先例 {@link renderRequirementForm}
 * 的提需求表单）⇒ 归一层剥前缀命中同一条全局 `POST /versions`，成功 303 回**本空间排期页**（不再甩回全局）。
 */
export function renderNewVersionDialog(org: string): string {
  return `<dialog class="fd" id="new-version-dialog">
<button type="button" id="new-version-close">关闭</button>
<div class="fd-body"><h2>新版本</h2>
<p class="hint">在版本台账（<code>.data/versions.json</code>）登记一个空版本 ⇒ 看板出现新列；初态 <code>notstart</code>，首张卡过确认门后自动转 <code>active</code>。</p>
<p class="hint">归属组织 = <b>${escapeHtml(org)}</b>（当前空间，由服务端按路径注入；表单不含 org 字段，同版号在其它组织可各自登记）</p>
<form method="post" action="${escapeHtml(orgSpaceLink(org) + "versions")}" class="w" data-submit="已提交，建版本中…" data-ov="1">
<input type="hidden" name="action" value="create">
<label>版本号 *<input name="version" required placeholder="如 v0.10.0（x.y.z，可带 v 前缀）"></label>
<button type="submit">创建版本</button>
</form></div>
</dialog>`;
}

// ---------------------------------------------------------------------------
// 排期表单（v0.9.2 M3 写端点的 GET 面 · M6 上需求详情页）
// ---------------------------------------------------------------------------

/**
 * 需求详情页上的「排期」表单：`POST /features/:id/schedule`（GET 面 = 承载该表单的本页）。
 * 单端点三语义（M3 口径）：填版本 = 新增/修改排期，留空提交 = 删除排期（回未排期）；
 * `version` 键恒携带（`parseScheduleForm` 的缺键 = 编程错误前置由此保证）。
 */
export function renderScheduleForm(
  featureId: string,
  version: string | null,
  releasedVersions: readonly string[] = [],
): string {
  const current = (version ?? "").trim();
  const currentLocked = isVersionLocked(current, releasedVersions);
  const lockHint = currentLocked
    ? `<p class="hint warn">本需求现排期版本 <code>${escapeHtml(current)}</code> <b>已发版（🔒 锁定）</b>：不可移出、取消排期或改入其它版本（服务端 409 拒绝；同版本无变化提交放行）。在版本台账把该版重开为进行中即实时生效。</p>`
    : "";
  return `<h2>排期</h2>
${lockHint}
<form method="post" action="/features/${encodeURIComponent(featureId)}/schedule" class="w" data-submit="已提交，排期写入中…">
<label>版本<input name="version" value="${escapeHtml(current)}" placeholder="如 v0.9.2；留空 = 删除排期"></label>
<button type="submit">保存排期</button>
</form>`;
}

// ---------------------------------------------------------------------------
// 需求列表（视图 V1 · §2.2-9）—— REQ-2026-09-26-04 Q2/Q3 整页退役：
// `renderFeaturesList` / 过滤表单 / `selectOptions` 与（已删的）`parseFeaturesFilter` /
// `applyFeaturesFilter` / `featuresFilterActive` 随 GET /requirements 一并删除，无迁移、无兼容层
// （提需求改由排期页弹窗承载，见 {@link renderNewRequirementDialog}）。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 需求详情（单 Feature + 任务 + trace 三面）
// ---------------------------------------------------------------------------

/**
 * 详情页组装的**上层件**（v0.9.5 C1/C5/C6 · 由 `server.ts` 按宿主面数据渲染后下传）：
 * **REQ-2026-09-30-04 件2 改版**：三层骨架 → **主栏 + 侧栏**两栏（标题与阶段步条通栏在最上）；
 * **v0.10.3 N2c**：依赖图卡由侧栏上移主栏（管道制要宽度），侧栏收敛为四卡。
 * 主栏 = 引导卡（品牌浅底）→ 轮次进度 / 链状态行 → 动作区卡（与澄清框互斥）→ 最近一轮卡
 * → **依赖图卡** → 折叠层（需求原文 · 执行明细 · 验收轨迹，默认收起）；
 * 侧栏 = 元数据卡（compact 两列）→ 归属卡 → 阶段产出卡 → 排期卡。
 * 缺省 `{}` ⇒ 这些件不渲染（未接线调用方行为不变）。
 */
export interface FeatureDetailExtras {
  /** C1 引导行（字段表之后第一屏） */
  nextStepHtml?: string;
  /** C5 单动作区（补充框 + 状态感知按钮；终态 / 未装配 ⇒ 空串） */
  actionAreaHtml?: string;
  /** 待澄清回答框（BD9，仅存在 awaiting 轮时非空） */
  answerFormHtml?: string;
  /** C6 最近一轮留痕（state / 摘要 / 时间） */
  turnTraceHtml?: string;
  /** 轮次进度行（REQ-v0.9.2 N7） */
  turnProgressHtml?: string;
  /** 链状态行（v0.9.5 增补二 · D2：监视中 / 链已停 · 快照缺席 ⇒ 空串不渲染） */
  chainStateHtml?: string;
  /** 依赖图正文（graph-view 产出；无任务 ⇒ 空串，C2） */
  graphHtml?: string;
  /** 验收轨迹（`renderAcceptanceSection` 产出；单段零失败 ⇒ 空串，C2） */
  acceptanceHtml?: string;
}

/**
 * C4 需求原文正文（**只允许一层折叠**）：本函数只出 `<h2>` + `<pre class="result">` 全文，
 * 折叠层由外层 `foldSection("需求原文", …)` 唯一承担（展开一次即见全文，不再内套第二层）。
 * 空本金不渲（返回空串 ⇒ 外层 `foldSection` 自短路）；老桥 / 未填 ⇒ 同一路径。
 */
function renderRequirementOrigin(requirement: string | null | undefined): string {
  const text = (requirement ?? "").trim();
  if (text === "") return "";
  return `<h2>需求原文</h2>\n<pre class="result">${escapeHtml(text)}</pre>`;
}

/**
 * 详情页卡片外壳（件2 · 复用件5 的 `.b-card` 基元）：**正文自带 `<h2>`** 的块直接套卡
 * （卡头 = 首个 h2，样式见 `layout.ts` `.feat-card > h2:first-child`），不再叠第二层标题。
 * 空正文 ⇒ 空串（C2 空区块短路口径：空卡也是噪声）。
 */
function featCard(bodyHtml: string, extraClass = ""): string {
  if (bodyHtml.trim() === "") return "";
  return `<div class="b-card feat-card${extraClass === "" ? "" : ` ${extraClass}`}">\n${bodyHtml}\n</div>`;
}

/**
 * 阶段步条的六段（REQ-2026-09-30-04 件2 · v0.10.5 流程一致性由五段抬到六段）：
 * 词表 = 登记字段 `stage` 值域（六枚全启用），写入方分两路（**半派生**）——
 * `改造` / `回归` / `验收` 由**引擎随 `state` 派生写**，`需求分析` ↔ `改造方案` 与
 * `发版` 由**宿主显式写**（见 `derive.ts` 与 `doc/v0.10.5/流程一致性-改造文档.md` §2.2）。
 */
const STAGE_STEPS: readonly string[] = ["需求分析", "改造方案", "改造", "回归", "验收", "发版"];

/** 显示阶段 → 步条档位；`null` = 归档不上（未知 / 终态回落登记值 ⇒ 不高亮、不猜）。 */
interface StageStepPos {
  /** 当前段下标（0 起） */
  index: number;
  /** 已打勾的最后一段下标（-1 ⇒ 一段未成） */
  doneThrough: number;
  /** 段名与真实显示阶段不同时的补注（定版中 / 拆任务中挂「改造方案」段、待澄清挂「改造」段；v0.10.5 起「验收中」直挂「验收」段 ⇒ 不再需要补注） */
  qualifier: string | null;
}

function stageStepPos(d: DisplayStage): StageStepPos | null {
  switch (d.label) {
    case "需求分析":
      return { index: 0, doneThrough: -1, qualifier: null };
    case "改造方案":
      return { index: 1, doneThrough: 0, qualifier: null };
    case "定版中":
      // v0.10.5 主链新增两态（`version_planning`）同归「改造方案」段 —— 不新增第七段，靠补注显形
      return { index: 1, doneThrough: 0, qualifier: "定版中" };
    case "拆任务中":
      return { index: 1, doneThrough: 0, qualifier: "拆任务中" };
    case "改造中":
      return { index: 2, doneThrough: 1, qualifier: null };
    case "改造中 · 待澄清":
      return { index: 2, doneThrough: 1, qualifier: "待澄清" };
    case "回归中":
      return { index: 3, doneThrough: 2, qualifier: null };
    case "验收中":
      return { index: 4, doneThrough: 3, qualifier: null };
    case "已完成":
      return { index: 5, doneThrough: 4, qualifier: null };
    case "已发版":
      return { index: 5, doneThrough: 5, qualifier: null };
    default:
      return null;
  }
}

/**
 * 阶段步条（件2）：六段圆点 + 连线，完成段打勾、当前段实底；
 * 尾部一行保留「显示阶段（派生 / 登记）」—— 本条替代原元数据表的
 * 「阶段（显示）」+「阶段（登记）」双行，**派生 / 登记事实与 basis 标注一个不丢**。
 */
function renderStageStepBar(d: DisplayStage): string {
  const pos = stageStepPos(d);
  const basis = d.basis === "derived" ? "派生" : "登记";
  const cells: string[] = [];
  STAGE_STEPS.forEach((name, i) => {
    if (i > 0) {
      const passed = pos !== null && i <= pos.index;
      cells.push(`<span class="b-step-line${passed ? " done" : ""}"></span>`);
    }
    const done = pos !== null && i <= pos.doneThrough;
    const cur = pos !== null && i === pos.index && !done;
    const label = cur && pos !== null && pos.qualifier !== null ? `${name} · ${pos.qualifier}` : name;
    cells.push(
      `<span class="b-step${done ? " done" : ""}${cur ? " cur" : ""}"><i class="b-step-dot">${done ? "✓" : ""}</i><b class="b-step-name">${escapeHtml(label)}</b></span>`,
    );
  });
  const tail =
    pos === null
      ? `当前阶段 = <b>${escapeHtml(d.label)}</b> <span class="muted">（${basis} · 未归档到步条，如实显示）</span>`
      : `当前 = <b>${escapeHtml(d.label)}</b> <span class="muted">（${basis}）</span>`;
  return `<div class="b-steps">${cells.join("")}<span class="b-steps-cur">${tail}</span></div>`;
}

/** 侧栏元数据卡（件2）：compact 两列（名 / 值），**替代原 4×2 大表**；阶段行已上步条，此处不再重复。 */
function renderFeatureMetaCard(f: FeatureDetailView["feature"]): string {
  const rows: readonly [string, string][] = [
    ["引擎态", label(FEATURE_STATE_LABELS, f.state)],
    ["版本", f.version === null || f.version === "" ? "—" : f.version],
    ["审批门（approval）", f.approval ?? "—"],
    ["归属组", f.ownerGroup ?? "—"],
    ["创建", stamp(f.createdAt)],
    ["更新", stamp(f.updatedAt)],
  ];
  const body = rows
    .map(([k, v]) => `<div class="b-meta-row"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`)
    .join("");
  return `<h2>需求信息</h2>\n<dl class="b-meta">${body}</dl>`;
}

/**
 * 归属卡（② · REQ-2026-10-10-02）：这条需求在各 project 落哪个 Project Version。
 *
 * 数据源 = 详情出参顶层 `projects[]`（**与落点① 的 `projectVersions[]` 是两个数据源、两个切片**）：
 * 只读该两键，**不 join 状态、不加状态列**（归属一经引用其版号不可改，状态由版本面自己答）。
 *
 * 三态渲染（缺面 ≠ 空面）：
 * - `null` / `undefined` ⇒ **整卡不渲**（C2 空区块短路；调用方手搭的 detail 无该键也走此分支）；
 * - `[]` ⇒ 零行 + 中性文案（「未归属」是合法事实，不是降级）；
 * - 有行 ⇒ 逐行，**行数 == `projects.length`，行序 = 引擎原序（不排序** —— 排序会把归属集
 *   伪装成版本列车序，而引擎侧无序承诺）。
 *
 * 卡体 = `dl.b-meta` 两列（照 {@link renderFeatureMetaCard} 先例），左列取 `projectId`、右列取
 * `version`（键名逐字，不译写）；**不用 `<table>`**（侧栏 320px + 浮层内会挤破）。
 * **不按 org 切片**（数据源已是单需求维度，再切会在 `ownerGroup ≠ 页面 org` 时清零合法行）。
 */
export function renderFeatureOwnershipCard(projects: FeatureDetailView["projects"] | undefined): string {
  if (projects === null || projects === undefined) return "";
  const head = `<h2>归属（project 版本）</h2>`;
  if (projects.length === 0) {
    return `${head}\n<p class="hint muted">（暂无 project 归属记录）</p>`;
  }
  const body = projects
    .map((p) => `<div class="b-meta-row"><dt>${escapeHtml(p.projectId)}</dt><dd>${escapeHtml(p.version)}</dd></div>`)
    .join("");
  return `${head}\n<dl class="b-meta">${body}</dl>`;
}

/**
 * 执行明细单表的固定列序（v0.10.3 N3 · 改造文档 §2-4，**顺序即判据**）：
 * 「三面表」退役后其信息各归一列 —— waitReason / 位次 / 写门 / 读档占位 / 已等待 合成「为什么没跑」，
 * 创建·开始·结束三时刻**裁掉**（时刻原值走 `/tasks` 面追溯）。
 */
const EXECUTION_COLUMNS: readonly string[] = [
  "#",
  "taskId",
  "项目",
  "职责位",
  "状态",
  "要点",
  "为什么没跑",
  "失败类",
  "重派",
  "依赖",
  "排队时长",
  "执行时长",
] as const;

/**
 * 执行明细单表的行（v0.10.3 N3）：一行一任务，**按 `taskOrdinalMap` 升序**（与图上 chip 同一张编号表 ——
 * 键 = `createdAt` 登记时刻，不在本处第二处派生）；`taskId` 去重口径同 {@link taskOrdinalMap}（首见即留）。
 * trace 命中 ⇒ 填「为什么没跑」，终态 / 无 trace ⇒ `—`；在飞不做「至 now」推算（两时长函数照用）。
 */
function renderExecutionRows(
  tasks: readonly FeatureTaskItem[],
  trace: FeatureTraceView | null,
  nowMs: number,
): string[] {
  const ordinals = taskOrdinalMap(tasks);
  const byId = new Map<string, FeatureTaskItem>();
  for (const t of tasks) if (!byId.has(t.taskId)) byId.set(t.taskId, t);
  const traceByTask = new Map<string, TraceNode>();
  if (trace !== null) {
    for (const n of trace.nodes) if (!traceByTask.has(n.taskId)) traceByTask.set(n.taskId, n);
  }
  const ordered = [...byId.values()].sort((a, b) => {
    const oa = ordinals.get(a.taskId) ?? Number.POSITIVE_INFINITY;
    const ob = ordinals.get(b.taskId) ?? Number.POSITIVE_INFINITY;
    if (oa !== ob) return oa < ob ? -1 : 1;
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });
  return ordered.map((t) => {
    const traceNode = traceByTask.get(t.taskId) ?? null;
    const info = nodeStateOf(t, traceNode);
    const summary = taskSummaryLines(taskDigest(t.prompt));
    const wait = traceNode === null ? null : traceWaitDisplay(traceNode, nowMs);
    const waitText =
      wait === null
        ? "—"
        : `${wait.waitReason} · 第 ${wait.position} 位 · ${wait.writeGate} · ${wait.readOccupants} · 已等待 ${wait.waited}`;
    const deps = (t.dependencies ?? []).map((d) => {
      const o = ordinals.get(d);
      return o === undefined ? shortId(d) : `#${o}`;
    });
    const prompt = t.prompt ?? null;
    return (
      "<tr>" +
      `<td>${String(ordinals.get(t.taskId) ?? "—")}</td>` +
      `<td class="mono" title="${escapeHtml(t.taskId)}">${escapeHtml(shortId(t.taskId))}</td>` +
      `<td>${escapeHtml(t.projectId)}</td>` +
      `<td>${escapeHtml(t.taskType ?? "—")}</td>` +
      `<td><span class="dg-chip dg-${info.key}">${escapeHtml(info.label)}</span></td>` +
      (prompt === null
        ? "<td>—</td>"
        : `<td title="${escapeHtml(prompt)}">${summary === null ? "—" : summary.map(escapeHtml).join("<br/>")}</td>`) +
      (wait === null
        ? "<td>—</td>"
        : `<td title="${escapeHtml(`${waitText} · 自 ${wait.waitedSince} · 在等谁 ${wait.blockedOn}`)}">${escapeHtml(waitText)}</td>`) +
      `<td>${escapeHtml(t.failureKind ?? "—")}</td>` +
      `<td>${t.retryCount === null ? "—" : String(t.retryCount)}</td>` +
      `<td>${escapeHtml(deps.length === 0 ? "—" : deps.join("、"))}</td>` +
      `<td>${escapeHtml(formatDurationBetween(t.queuedAt, t.claimedAt))}</td>` +
      `<td>${escapeHtml(formatDurationBetween(t.startedAt, t.finishedAt))}</td>` +
      "</tr>"
    );
  });
}

export function renderFeatureDetail(
  detail: FeatureDetailView,
  trace: FeatureTraceView | null,
  traceError: string | null,
  nowMs: number,
  withScheduleForm: boolean = false,
  releasedVersions: readonly string[] = [],
  extras: FeatureDetailExtras = {},
): string {
  const f = detail.feature;
  const d = deriveDisplayStage(f.state, f.stage);
  // 件N1 锚 1/5 `steps`：详情页第一枚锚 ⇒ 页面周期属性挂它（`.b-steps` 本体逐字不动）。
  // 件D 第三档（REQ-2026-10-11-05 增补 N3）：头部「整页打开」链带 `target="_blank"` ⇒ 浮层导航分支
  // （`layout.ts` 的 `hasAttribute("target")` 放行）原样交回浏览器原生开新标签；链在 head 不在锚内
  // ⇒ 第八枚永不替换它。
  const head = `<h2>${escapeHtml(f.title === "" ? f.featureId : f.title)} <span class="muted mono" title="${escapeHtml(f.featureId)}">${escapeHtml(f.featureId)}</span>${renderParentFeatureBadge(f.parentFeatureId)} <a class="fd-fullpage" href="/features/${escapeHtml(f.featureId)}" target="_blank" rel="noopener">整页打开</a></h2>\n<div class="live-slot" data-live="steps" data-live-interval="${String(LIVE_INTERVALS.feature)}">${renderStageStepBar(d)}</div>`;

  // v0.10.3 N3：任务表与「进展三面」表**并为一张 12 列单表**（三面表退役）。
  // 行的事实源 = `detail.tasks` 全集，序 = `taskOrdinalMap` 升序（编号与图上 chip 同一张表，键 = `createdAt` 登记时刻）；
  // trace 只按 taskId 命中后填「为什么没跑」一列，终态 / 无 trace ⇒ `—`。
  const rows = renderExecutionRows(detail.tasks, trace, nowMs);
  const executionTable =
    rows.length === 0
      ? ""
      : `<h2>任务（${rows.length}）</h2>
<table><thead><tr>${EXECUTION_COLUMNS.map((c) => `<th>${c}</th>`).join("")}</tr></thead>
<tbody>${rows.join("")}</tbody></table>
<p class="hint">${escapeHtml(TRACE_READ_NOTE)}</p>`;
  const traceHint =
    trace === null
      ? `<p class="hint err">trace 读取失败：${escapeHtml(traceError ?? "未知错误")}（桥 trace 接口不可达时如实显示，不静默）</p>`
      : "";
  // C2 空区块短路①+②：任务 0 ∧ trace 空 ⇒ 整节不渲染；
  // **C2 执行注记（R1）：trace 读取失败不属短路范围** —— 读失败仍如实显示（不静默）。
  const executionBody = `${traceHint}${executionTable}`;
  // C2 空区块短路③：无任务 ⇒ 依赖图不渲染（graph-view 侧同判据；此处再兜一层，未接线调用方也不出空节）。
  // 件2 → v0.10.3 N2c：依赖图先移出「执行明细」折叠（独立卡），本节点再**从侧栏上移主栏**
  // （管道制要宽度）；外壳函数与 `feat-graph` 类名一律保留（「无任务 ⇒ 图卡不渲」的锚读的就是类名）。
  // 件N1 锚 4/5 `graph` / 锚 5/5 `exec`：恒在壳包住图卡与执行明细折叠（空正文 ⇒ 壳在场、内容空）。
  const graphCard = `<div class="live-slot" data-live="graph" data-live-lock>${featCard(extras.graphHtml ?? "", "feat-graph")}</div>`;
  const execution = `<div class="live-slot" data-live="exec">${
    executionBody === "" ? "" : foldSection("执行明细（任务 / 为什么没跑）", executionBody)
  }</div>`;
  const stageOutputsSection = renderStageOutputs(f.featureId, f.decisions, f.version ?? null);
  // M6：排期表单上详情页（GET 面）；缺省不渲染 ⇒ 未接线的调用方保持旧行为。
  const scheduleForm = withScheduleForm ? renderScheduleForm(f.featureId, f.version, releasedVersions) : "";
  // C5 终态墓碑：终态需求**不出动作区与回答框**（调用方误传也不渲染）—— 一行结论摘要 = 引导行 +
  // 最近一轮留痕，其余区块本就默认折叠。
  const terminal = isTerminalFeatureState(f.state);
  // ---- 件2 两栏装配 ------------------------------------------------------
  // 主栏自上而下 = 下一步引导卡（品牌浅底）→ 轮次进度 / 链状态行 → 动作区卡（与澄清框互斥，
  // 判据 = `awaitingAnswer`，见 7ee29786）→ 最近一轮卡 → **依赖图卡** → 折叠层（需求原文 / 执行明细 / 验收轨迹）。
  // 侧栏 = **四卡**：元数据 → 归属 → 阶段产出 → 排期（v0.10.3 N2c 起依赖图已移出侧栏）。
  // **DOM 序即契约**：轮次进度行与链状态行必须**早于**动作区与回答框 —— 件B 有界轮询按
  // 「`.turn-progress` 在回答表单之前」定位刷新面，停链表单同样须早于动作区锚点。
  // ⇒ 依赖图卡只能插在 `turnCard` **之后**（不得提到 `statusLines` 之前，否则顶掉件B 的刷新面定位）。
  const guide = featGuideCard(extras.nextStepHtml ?? "");
  // 件N1 锚 2/5 `turn-prog`：`statusLines` 拆两枚 —— 轮次进度行进恒在壳，链状态行**不进锚**
  // （含停链 `form`+`button`，属输入/动作面）；两行相对顺序不变（上注「DOM 序即契约」逐字保留）。
  const statusLines = `<div class="live-slot" data-live="turn-prog">${extras.turnProgressHtml ?? ""}</div>${extras.chainStateHtml ?? ""}`;
  const actionCard = featCard(terminal ? "" : `${extras.actionAreaHtml ?? ""}${extras.answerFormHtml ?? ""}`, "feat-action");
  // 件N1 锚 3/5 `turn`：最近一轮卡（`featCard` 空正文短路 ⇒ 壳恒在，0→N 首现那拍摘得到）。
  const turnCard = `<div class="live-slot" data-live="turn">${featCard(extras.turnTraceHtml ?? "", "feat-turn")}</div>`;
  const folds = `${foldSection("需求原文", renderRequirementOrigin(f.requirement))}${execution}${foldSection("验收轨迹", extras.acceptanceHtml ?? "")}`;
  const side = `${featCard(renderFeatureMetaCard(f), "feat-meta")}${featCard(renderFeatureOwnershipCard(detail.projects), "feat-ownership")}${featCard(stageOutputsSection, "feat-outputs")}${featCard(scheduleForm, "feat-schedule")}`;
  return `${head}
<div class="feat-cols">
<div class="feat-main">
${renderLiveBar(LIVE_INTERVALS.feature)}
${guide}
${statusLines}
${actionCard}
${turnCard}
${graphCard}
${folds}
</div>
<div class="feat-side">
${side}
</div>
</div>`;
}

/**
 * 下一步引导卡（件2）：品牌浅底承载引导行（`renderNextStepGuide` 产出的 `<p class="hint nextstep">`），
 * **不改引导行文案与 class**（件B / C1 的判据都在这一行上）。空 ⇒ 空串。
 */
function featGuideCard(nextStepHtml: string): string {
  if (nextStepHtml.trim() === "") return "";
  return `<div class="b-card feat-guide">\n${nextStepHtml}\n</div>`;
}

// ---------------------------------------------------------------------------
// 任务视图（复用 GET /api/tasks，project 必填）
// ---------------------------------------------------------------------------

/**
 * 任务态徽标配色档（REQ-2026-09-30-04 件5 · 原型 v2.3 样张④）：**只接管颜色档位**，
 * 文案仍由 {@link label} + {@link TASK_STATE_LABELS} 出（「执行中（working）」口径不变），
 * 未命中态 ⇒ `mute`（不猜语义）。
 */
const TASK_STATE_BADGE: Readonly<Record<string, string>> = {
  working: "run",
  completed: "ok",
  "input-required": "warn",
  blocked: "warn",
  failed: "danger",
};

function taskStateBadge(state: string): string {
  const tone = Object.prototype.hasOwnProperty.call(TASK_STATE_BADGE, state)
    ? (TASK_STATE_BADGE[state] as string)
    : "mute";
  return `<span class="b-badge ${tone}">${escapeHtml(label(TASK_STATE_LABELS, state))}</span>`;
}

/**
 * 结果表卡（件5）：{@link renderTasks}（查询档）与 {@link renderTasksPick}（默认带出档）
 * **共用同一张卡**，避免两处各存一份列定义。
 * 列 = taskId（含 stale 徽标）/ 状态徽标 / 更新 / contextId / prompt 摘要；
 * `metaHtml` = 卡头右侧的计数与过滤说明（调用方拼，含「换项目」出口）；
 * `unreachableHtml` = 项目不可达提示行（由调用方给出，缺 ⇒ 不渲）。
 */
function renderTasksResultCard(
  view: ProjectTasksView,
  metaHtml: string,
  unreachableHtml = "",
): string {
  const rows = view.tasks.map((t) => {
    const staleMark = t.stale ? ' <span class="b-badge warn">stale</span>' : "";
    return (
      "<tr>" +
      `<td class="mono">${escapeHtml(shortId(t.taskId))}${staleMark}</td>` +
      `<td>${taskStateBadge(t.state)}</td>` +
      `<td>${escapeHtml(stamp(t.updatedAt))}</td>` +
      `<td class="mono">${escapeHtml(shortId(t.contextId ?? "") || "—")}</td>` +
      `<td>${escapeHtml(t.prompt === null ? "—" : truncate(t.prompt, 80))}</td>` +
      "</tr>"
    );
  });
  return cardShell(
    "结果",
    metaHtml,
    `${unreachableHtml}
<table><thead><tr><th>taskId</th><th>状态</th><th>更新</th><th>contextId</th><th>prompt 摘要</th></tr></thead>
<tbody>${rows.length === 0 ? emptyRow(5, "（无任务）") : rows.join("")}</tbody></table>`,
  );
}

/** {@link renderTasksPick} 的默认带出档（件5）：调用方已取回的近 N 条快照 + 该次读取的 limit。 */
export interface TasksPreviewInput {
  view: ProjectTasksView;
  /** 本次默认带出的条数上限（服务端常量，如实回显用）。 */
  limit: number;
}

/**
 * 任务页的页面周期属性（件N1 判据 6：选单档与深链档**共用同一渲染路径** ⇒ 本页恰 1 处代码产出它）。
 * 前导空格是属性分隔符 ⇒ 调用方直接接在锚 key 属性之后。
 */
const TASKS_LIVE_INTERVAL_ATTR = ` data-live-interval="${String(LIVE_INTERVALS.tasks)}"`;

/**
 * 任务页选单档（`GET /tasks` / `GET /org/<名>/tasks` **不带 `project`** 时）。
 *
 * REQ-2026-09-30-04 件5（原型 v2.3 样张④）：裸查询表单 → **过滤卡**（项目 / 状态 / 条数 + 查询钮）
 * + **快捷项目 chips** + **默认带出结果卡**（`preview` = 调用方已取回的近 N 条快照，
 * 未传 ⇒ 不渲结果卡，行为同旧「先选项目」。
 * **表单零属性改动**（`method="get"` + `action` 逐字不变，排版靠 `.b-filter` 后代选择器）⇒ 读面表单锚不失效。
 */
export function renderTasksPick(
  projects: ProjectsView | null,
  pickError: string | null,
  org: string | null = null,
  membershipError: string | null = null,
  preview: TasksPreviewInput | null = null,
): string {
  // D 档/BD6：空间内（org 非 null）选单与表单落 `/org/<名>/tasks`（链接仍指全局深链口径）
  const tasksBase = org === null ? "/tasks" : orgSpaceLink(org, "tasks");
  const previewView = preview?.view ?? null;
  const previewProject = previewView?.projectId ?? "";
  const chips =
    projects !== null
      ? projects.machines
          .flatMap((m) => m.projects.map((p) => p.projectId))
          .sort()
          .map((pid) => {
            const on = previewProject !== "" && previewProject === pid ? ' class="on"' : "";
            return `<a${on} href="${escapeHtml(tasksBase)}?project=${encodeURIComponent(pid)}">${escapeHtml(pid)}</a>`;
          })
          .join("")
      : "";
  const hint =
    pickError !== null
      ? `<p class="hint err">项目清单读取失败：${escapeHtml(pickError)}（不影响手工输入项目名查询）</p>`
      : "";
  // v0.9.6 C2：空间档声明面不可判定（GET /api/groups 读失败）⇒ 清单已清空，如实标注、不外泄他组
  const membershipHint =
    membershipError !== null
      ? `<p class="hint err">项目清单不可判定：${escapeHtml(membershipError)}</p>`
      : "";
  const stateSelect = `<option value="">全部</option>${TASK_FILTER_STATES.map(
    (s) => `<option value="${escapeHtml(s)}">${escapeHtml(label(TASK_STATE_LABELS, s))}</option>`,
  ).join("")}`;
  // 件N1 锚 `tasks-result`（选单档 = 默认带出的结果卡）：恒在壳，未传 preview ⇒ 壳在场、内容空。
  const previewCard = `<div class="live-slot" data-live="tasks-result">${
    preview === null || previewView === null
      ? ""
      : renderTasksResultCard(
          previewView,
          `默认带出 <span class="mono">${escapeHtml(previewProject)}</span> 近 ${String(preview.limit)} 条（读回 ${String(previewView.tasks.length)} 条）· <a class="fl" href="${escapeHtml(tasksBase)}?project=${encodeURIComponent(previewProject)}">不带过滤重查</a>`,
          previewView.reachable
            ? ""
            : `<p class="hint err">项目 ${escapeHtml(previewProject)} 当前不可达${previewView.notice !== null ? `：${escapeHtml(previewView.notice)}` : ""}</p>`,
        )
  }</div>`;
  // 件N1 锚 2/2 `tasks-filter`：本档的第一枚锚 ⇒ 页面周期属性挂它（单点见上）。
  // （`.b-card.b-filter` 卡体与 `<form>` 标签逐字不动，只套恒在壳）。
  const filterAnchorOpen = `<div class="live-slot" data-live="tasks-filter"${TASKS_LIVE_INTERVAL_ATTR}>`;
  return `${renderLiveBar(LIVE_INTERVALS.tasks)}
<h2>任务视图</h2>
${hint}
${membershipHint}
${filterAnchorOpen}${cardShell(
  "过滤",
  "点下方项目 chip 或填条件后查询",
  `<form method="get" action="${escapeHtml(tasksBase)}">
<label>projectId <input name="project" placeholder="项目 id"${preview === null ? "" : ` value="${escapeHtml(previewProject)}"`}></label>
<label>状态 <select name="state">${stateSelect}</select></label>
<label>limit <input name="limit" type="number" min="1" step="1" placeholder="不限"></label>
<button type="submit">查询</button>
</form>
${chips === "" ? "" : `<div class="b-chips"><span class="b-chips-label">快捷项目</span>${chips}</div>`}`,
  "b-filter",
)}</div>
${previewCard}`;
}

export function renderTasks(
  view: ProjectTasksView,
  filter: { state?: string; limit?: number } = {},
  org: string | null = null,
  homeOrg: string | null = null,
): string {
  const reach = view.reachable
    ? ""
    : `<p class="hint err">项目 ${escapeHtml(view.projectId)} 当前不可达${view.notice !== null ? `：${escapeHtml(view.notice)}` : ""}</p>`;
  // v0.9.6 C3：全局深链页头的「所属组织」行（homeOrg=null ⇒ 声明面不可判定 ⇒ 不渲，不猜）
  const orgLine = homeOrg === null ? "" : `<p class="hint">所属组织：${escapeHtml(homeOrg)}</p>`;
  const filterNote =
    filter.state === undefined && filter.limit === undefined
      ? ""
      : ` · 过滤：<span class="mono">${escapeHtml(
          [filter.state === undefined ? "" : `state=${filter.state}`, filter.limit === undefined ? "" : `limit=${filter.limit}`]
            .filter((s) => s !== "")
            .join(" · "),
        )}</span> <span class="muted">（桥服务端过滤）</span>`;
  const meta = `共 ${String(view.tasks.length)} 条${filterNote} · <a class="fl" href="${escapeHtml(org === null ? "/tasks" : orgSpaceLink(org, "tasks"))}">换项目</a>`;
  // 件N1 锚 `tasks-result`（深链档本页唯一锚 ⇒ 页面周期属性挂它，单点见上）。
  const resultAnchorOpen = `<div class="live-slot" data-live="tasks-result"${TASKS_LIVE_INTERVAL_ATTR}>`;
  return `${renderLiveBar(LIVE_INTERVALS.tasks)}
<h2>任务 · 项目 <span class="mono">${escapeHtml(view.projectId)}</span></h2>
${orgLine}
${resultAnchorOpen}${renderTasksResultCard(view, meta, reach)}</div>`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ---------------------------------------------------------------------------
// 项目 / 机器视图（复用 GET /api/projects）
// ---------------------------------------------------------------------------

export function renderProjects(view: ProjectsView): string {
  const rows: string[] = [];
  for (const m of view.machines) {
    if (m.error !== null) {
      rows.push(
        `<tr class="warn"><td>${escapeHtml(m.machineId)}</td><td colspan="5">机器不可达：${escapeHtml(m.error)}</td></tr>`,
      );
    }
    for (const p of m.projects) {
      rows.push(
        "<tr>" +
          `<td>${escapeHtml(m.machineId)}</td>` +
          `<td><a class="fl" href="/tasks?project=${encodeURIComponent(p.projectId)}">${escapeHtml(p.projectId)}</a></td>` +
          `<td>${escapeHtml(p.agentKind ?? "—")}</td>` +
          `<td>${p.a2aPort === null ? "—" : p.a2aPort}</td>` +
          `<td>${escapeHtml(p.status ?? "—")}</td>` +
          `<td>${escapeHtml(p.startedAt ?? "—")}` +
          "</tr>",
      );
    }
  }
  const runners = view.runners
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.machineId)}</td><td>${r.online ? "在线" : "离线"}</td><td>${escapeHtml(r.lastHeartbeatAt ?? "—")}</td></tr>`,
    )
    .join("");
  const snapshot = `<p class="hint">${escapeHtml(view.note ?? "快照语义（非实时在线）")}${view.observedAt !== null ? ` · 观测时间 <span class="mono">${escapeHtml(view.observedAt)}</span>` : ""}</p>`;
  return `<h2>项目 / 机器</h2>
${snapshot}
<table><thead><tr><th>machineId</th><th>projectId</th><th>agentKind</th><th>a2aPort</th><th>status</th><th>startedAt</th></tr></thead>
<tbody>${rows.length === 0 ? emptyRow(6, "（无项目）") : rows.join("")}</tbody></table>
<h2>Runner 注册面</h2>
<table><thead><tr><th>machineId</th><th>online</th><th>lastHeartbeatAt</th></tr></thead>
<tbody>${runners === "" ? emptyRow(3, "（无 runner）") : runners}</tbody></table>
<p class="hint">${escapeHtml(INFLIGHT_CALIBRATION_NOTE)}</p>`;
}

// ---------------------------------------------------------------------------
// Agent View 页（REQ-2026-09-26-02 B-T3 · 只读）
// ---------------------------------------------------------------------------

/** 本页对外的三块输入（页头身份 / 机器表 / 在飞任务区），全部由 `agent-view.ts` 归一后喂入。 */
export interface AgentsPageInput {
  /** 桥 identity/version（G3 收编，3300 页面退役后的唯一承载位）；`null` = 查询器未装配。 */
  identity: BridgeIdentityOutcome | null;
  /** MCP 基址（页头如实标注身份来源端点用）。 */
  identitySource: string;
  machineRows: AgentMachineRow[];
  inflight: AgentInflightModel;
  /** 项目快照本身的观测时间（`/api/projects` 的 `observedAt`）；缺 ⇒ null。 */
  observedAt: string | null;
  /** 在飞查询器未装配时的说明（页级降级），null ⇒ 正常逐项目查询。 */
  queryDisabledNote?: string | null;
}

/** 页头桥身份行：四字段一行呈现；取不到 ⇒ 灰化并给结构化错误码（不炸页、不臆造）。 */
function renderBridgeIdentity(input: AgentsPageInput): string {
  const source = `<span class="muted">来源 = <code>${escapeHtml(input.identitySource)}/health</code></span>`;
  if (input.identity === null) {
    return `<p class="hint muted">桥身份未查询（查询器未装配）：role / pid / startedAt / version 未知 · ${source}</p>`;
  }
  if (!input.identity.ok) {
    return `<p class="hint warn">桥身份不可达（<code>${escapeHtml(input.identity.code)}</code>）：${escapeHtml(input.identity.error)} —— role / pid / startedAt / version 未知（灰化不炸页；刷新本页重查）· ${source}</p>`;
  }
  const i = input.identity.identity;
  const cells: ReadonlyArray<readonly [string, string]> = [
    ["role", i.role ?? "—"],
    ["pid", i.pid === null ? "—" : String(i.pid)],
    ["startedAt", i.startedAt ?? "—"],
    ["version", i.version ?? "—"],
  ];
  const statusCell = i.status === null ? "" : ` <span class="muted">（status <span class="mono">${escapeHtml(i.status)}</span>）</span>`;
  const body = cells
    .map(([k, v]) => `${escapeHtml(k)} = <b>${escapeHtml(v)}</b>`)
    .join(" · ");
  return `<p class="hint">编排桥身份${statusCell}：${body} · ${source}</p>`;
}

/** 机器表一行：runner 在线态 ∪ 项目快照（缺席侧如实「—」/ 0，不臆造）。 */
function renderMachineRow(r: AgentMachineRow): string {
  const online = r.online === null ? '<span class="muted">未知（无 runner 登记）</span>' : r.online ? "在线" : "离线";
  return (
    `<tr${r.machineError !== null || r.online === null ? ' class="muted"' : ""}>` +
    `<td>${escapeHtml(r.machineId)}</td>` +
    `<td>${online}</td>` +
    `<td>${escapeHtml(stamp(r.lastHeartbeatAt))}</td>` +
    `<td>${String(r.projectCount)}</td>` +
    `<td>${escapeHtml(r.machineError ?? "—")}</td>` +
    "</tr>"
  );
}

/** 在飞区的一个项目小节：ok = 在飞任务表（`claimedAt` 升序）；fail = 灰化 + 错误码。 */
function renderInflightSection(p: AgentInflightProject): string {
  const head = `<h3><a class="fl" href="/tasks?project=${encodeURIComponent(p.projectId)}">${escapeHtml(p.projectId)}</a> <span class="muted">@ ${escapeHtml(p.machineId)}${p.agentKind !== null ? ` · ${escapeHtml(p.agentKind)}` : ""}</span></h3>`;
  if (!p.outcome.ok) {
    return `${head}<p class="hint warn">在飞任务不可达（<code>${escapeHtml(p.outcome.code)}</code>）：${escapeHtml(p.outcome.error)} —— 该项目在飞数未知（灰化不炸页；≠「没有在飞」）。</p>`;
  }
  const rows = p.inflight.map((t) => {
    return (
      "<tr>" +
      `<td class="mono">${escapeHtml(shortId(t.taskId))}</td>` +
      `<td>${escapeHtml(label(TASK_STATE_LABELS, t.state))}</td>` +
      `<td>${escapeHtml(stamp(t.claimedAt))}</td>` +
      `<td>${escapeHtml(stamp(t.updatedAt))}</td>` +
      `<td>${t.stale ? '<span class="warn">stale</span>' : "—"}</td>` +
      `<td>${escapeHtml(t.contextId === null ? "—" : shortId(t.contextId))}</td>` +
      `<td>${escapeHtml(t.prompt === null ? "—" : truncate(t.prompt, 80))}</td>` +
      "</tr>"
    );
  });
  return `${head}
<p class="hint">在飞 ${String(p.inflight.length)} 条（终态之外即算在飞；按 <code>claimedAt</code> 升序 = 领取最早者在前）</p>
<table><thead><tr><th>taskId</th><th>状态</th><th>claimedAt</th><th>更新</th><th>stale</th><th>contextId</th><th>prompt 摘要</th></tr></thead>
<tbody>${rows.length === 0 ? emptyRow(7, "（无在飞任务）") : rows.join("")}</tbody></table>`;
}

/**
 * `GET /agents` Agent View 页（B-T3 · 纯函数）：页头 = 3300 收编的桥 identity/version 头；
 * 机器表 = `runners` ∪ `machines` 归并；在飞任务区 = 逐项目一节（有在飞或查询失败的项目才出节）；
 * 页脚 = 本页口径行（闸内排队与读席占用 orch 不可见）。单项目失败灰化，不炸页。
 */
export function renderAgentsPage(input: AgentsPageInput): string {
  const disabled =
    input.queryDisabledNote === undefined || input.queryDisabledNote === null
      ? ""
      : `<p class="hint warn">${escapeHtml(input.queryDisabledNote)}</p>`;
  const observed =
    input.observedAt === null
      ? ""
      : ` · 项目快照观测时间 <span class="mono">${escapeHtml(input.observedAt)}</span>`;
  const summaryRows = input.inflight.projects.map((p) => {
    const countCell = p.outcome.ok
      ? `<td>${String(p.inflight.length)}</td>`
      : '<td class="muted">未知</td>';
    return (
      `<tr${p.outcome.ok ? "" : ' class="muted"'}>` +
      `<td><a class="fl" href="/tasks?project=${encodeURIComponent(p.projectId)}">${escapeHtml(p.projectId)}</a></td>` +
      `<td>${escapeHtml(p.machineId)}</td>` +
      `<td>${escapeHtml(p.agentKind ?? "—")}</td>` +
      countCell +
      (p.outcome.ok ? "<td>可达</td>" : `<td class="muted">不可达 <span class="mono">${escapeHtml(p.outcome.code)}</span></td>`) +
      "</tr>"
    );
  });
  const sections = input.inflight.projects
    .filter((p) => !p.outcome.ok || p.inflight.length > 0)
    .map((p) => renderInflightSection(p))
    .join("\n");
  const grayNote =
    input.inflight.grayedCount === 0
      ? ""
      : `<p class="hint warn">在飞任务查询失败 ${String(input.inflight.grayedCount)} 个项目（灰化小节给出错误码；刷新本页重查）。</p>`;
  return `<h2>Agent View · 机器与在飞</h2>
${renderBridgeIdentity(input)}
<p class="hint">数据 = 项目快照 <code>/api/projects</code>（机器表 + 项目清单）+ <b>逐项目并发</b>拉 <code>/api/tasks</code>（单项超时即降级为「不可达」，不缓存、不落新存储）。快照语义（非实时在线）${observed}</p>
${disabled}
${grayNote}
<h3>机器（${String(input.machineRows.length)}）</h3>
<table><thead><tr><th>machineId</th><th>Runner 在线</th><th>末次心跳</th><th>项目数</th><th>机器 error</th></tr></thead>
<tbody>${input.machineRows.length === 0 ? emptyRow(5, "（无机器：项目快照里 machines[] 与 runners[] 皆空）") : input.machineRows.map((r) => renderMachineRow(r)).join("")}</tbody></table>
<h3>在飞任务（${String(input.inflight.inflightTotal)} 条 · ${String(input.inflight.projects.length)} 个项目）</h3>
<table><thead><tr><th>projectId</th><th>machineId</th><th>agentKind</th><th>在飞</th><th>任务查询</th></tr></thead>
<tbody>${summaryRows.length === 0 ? emptyRow(5, "（快照中无项目）") : summaryRows.join("")}</tbody></table>
${sections === "" ? `<p class="hint">（各项目当前均无在飞任务；查询失败的项目仍会出现在上表并给出错误码）</p>` : sections}
<p class="hint">${escapeHtml(AGENT_VIEW_CALIBRATION_NOTE)}</p>`;
}

// ---------------------------------------------------------------------------
// 组织空间管理页（v0.9.4 §9-c · REQ-2026-09-27-06 N3：`/orgs` 页退役后的承接位）
// ---------------------------------------------------------------------------

/**
 * `GET /org/<名>/manage` 的入参（**一页一组织**，故不再有「逐组织行」的表结构）。
 * 三块数据各自的缺席口径见 {@link renderOrgSpaceManagePage}。
 */
export interface OrgSpaceManageInput {
  org: string;
  /** 本组织的需求投影（归一层已持有，`ownerGroup` 精确匹配，零新触桥面）。 */
  features: readonly FeatureListItem[];
  /** 本组运行态项目（只读 `a2a_projects`）；`null` = 查询器未装配 ⇒ 如实标「未查询」。 */
  projectsOutcome: OrgProjectsOutcome | null;
  /**
   * 全组枚举结论（3300 只读 `GET <3300>/api/groups`，组结构**声明面** = 本组成员清单的事实源）。
   * `null` = 查询器未装配 ⇒ 池右栏与页头核对短条首档标「未查询」；`ok=false` = 3300 宕机 / 配置坏 ⇒
   * 二者**灰化**，**本页其余照常渲染**（宕机不得阻断管理页）。与逐组 `a2a_projects`（运行态）**并存、不替代**。
   */
  groupsOutcome: OrgGroupsOutcome | null;
  /**
   * **项目池**（v0.9.8 两栏拖拽 · REQ-2026-10-03-02）= 全量机器项目快照 − 全组（含本组）声明面成员对
   * （{@link computeProjectPool}）。`null` = 全量快照读面未装配 ⇒ 池区标「未查询」；
   * `ok=false` = 快照或声明面任一读失败 ⇒ 池区**整块灰化**（**不给拖拽载荷、不编造假池**），
   * 两栏容器不呈现（无行可拖 ⇒ 本档无成员写通路）。页面其余照常渲染。
   */
  poolOutcome?: OrgPoolOutcome | null;
  /**
   * **池左集规模**（v0.9.8 · REQ-2026-10-03-02 · B-3）= 差集被减之前的桥注册表全集投影行数
   * （`snapshot.rows.length`）。只服务空态两分支的字面（左集零行 ⇒「机器注册表暂无项目记录」）；
   * 省略 / `null` = 未随池装配 ⇒ 不据此编造「暂无记录」。不参与任何判定、不入差集。
   */
  poolSourceCount?: number | null;
  /**
   * 本组织 agent 配置卡的入参数据源（v0.9.8 · 按项目组配 agent）：组织两键 = 本次已读台账记录、
   * 全局两键 = `configView()`（**零新读面**）。`globalKind/globalModel` 为 null ⇒ 宿主面未装配
   * （如实显示「宿主面未装配」，不伪装成有全局值）；整个字段省略 ⇒ 按全未配置渲染（测试替身口径）。
   */
  hostAgent?: {
    orgKind: string | null;
    orgModel: string | null;
    globalKind: string | null;
    globalModel: string | null;
  };
  /**
   * **⑨ 需求表分页（REQ-2026-10-11-05 N11）**：三枚**一并缺席 = 全量渲染**（向后兼容既有调用点
   * 与既有测试锚 —— 未传时渲染结果与本节点改动前逐字一致，形态照 {@link OrgSpaceManageInput.versionProjection}
   * 的 optional「省略 ⇒ 不参评」先例）。写入侧 = `server.pageOrgSpaceManage`（**先排全量再切页**，
   * 排序复用 `version-order.comparePoolEntry`，**不新建第二比较器**）；视图只做「渲所给的那一页」。
   */
  /** 当前页（1 起）。server 侧已 fail-closed 归一（缺失 / 非有限 / `<1` / 起点越界 ⇒ 第 1 页）⇒ 视图不再回显原值。 */
  page?: number | null;
  /** 每页条数（缺省取单点常量 {@link ORG_FEATURES_PAGE_SIZE}）。 */
  pageSize?: number | null;
  /** 该组需求**全量**条数（切页之前的总数）—— 渲翻页链与「共 N 条」；不传 ⇒ 不渲链。 */
  total?: number | null;
  /**
   * **引擎版本台账投影（project 档）**核对源（v0.10.2 · REQ-2026-10-10-02 N2）：页头核对短条的
   * **第三档**，与项目卡「已发布的最新版本号」列**共用同一次** `GET /api/versions` 读取。
   * **省略 = 未注入 ⇒ 该源不参评**（该档不出现，也不参与「配置齐备」闸 —— 不注入即零行为变化）。
   * 三输入即三档判据的原料：`projection = null` ⇒ 本进程**从未读到过**投影；`failure` 非 `null`
   * ⇒ 本次读失败、值取最后一次投影（**stale**）；project 档 `absent` ⇒ 老引擎档。
   * `degradationText` = `absent` 两档的**降级文案单点**（`server.projectVersionDegradationText`
   * 的产出，含根因码）⇒ 视图不另写一套根因码。
   */
  versionProjection?: {
    projection: EngineVersionsProjection | null;
    failure: string | null;
    degradationText: string | null;
  };
}

/**
 * **⑨ 需求表每页条数的单点常量**（REQ-2026-10-11-05 N11 · 用户裁定 = 每页 10 条）：
 * 唯一定义处 —— `server.pageOrgSpaceManage` 的切片与本文件的翻页链都引它，**不得两处各写数字**。
 */
export const ORG_FEATURES_PAGE_SIZE = 10;

/**
 * **⑨ 翻页链**（REQ-2026-10-11-05 N11）：形态唯一合法解 = **链接式服务端分页**（`<a>` 携 query 参数 `page=N`）
 * —— 客户端脚本分页不可行：内联脚本字面量是**闭集八元**（`n3-regression-anchors` N3-⑦/⑪ 钉），
 * 新增一枚**可执行内联脚本**即破钉（扫描器按字面量计数，本注释不得书写该标签字面量）；
 * 也不得用 `<button>`+form 伪装翻页。
 * 只在 `total > 0` 且**页数 > 1** 时渲（`total = 0` ⇒ 不渲链、空态行原样保留；单页 ⇒ 不渲噪音链）。
 * **query 全站唯一生成点** = 本函数的 `hrefOf`（不得拼两遍）；页码取**归一后的整数**（`String(n)`），
 * **不回显用户输入** ⇒ 无反射型注入面。
 * 路径段编码由 {@link orgSpaceLink} 承担（`encodeURIComponent` 落在段上），query 在其后**不继承段编码**
 * ⇒ 页链打开后仍在本 org；首 / 末页时对应方向钮**不渲**（不渲灰壳）。
 */
function renderOrgFeaturesPager(org: string, page: number, pageSize: number, total: number): string {
  if (total <= 0) return "";
  const pageCount = Math.ceil(total / pageSize);
  if (pageCount <= 1) return "";
  const hrefOf = (n: number): string => `${escapeHtml(orgSpaceLink(org, "manage"))}?page=${String(n)}`;
  const cell = (n: number): string =>
    n === page ? `<b>${String(n)}</b>` : `<a class="fl" href="${hrefOf(n)}">${String(n)}</a>`;
  // 窗口 = 首页 / 末页 / 当前 ±2（升序直构，不排第二遍）；间隙以「…」纯文本占位，不是钮
  const window: number[] = [];
  for (let n = 1; n <= pageCount; n += 1) {
    if (n === 1 || n === pageCount || Math.abs(n - page) <= 2) window.push(n);
  }
  const cells: string[] = [];
  let prev = 0;
  for (const n of window) {
    if (prev !== 0 && n - prev > 1) cells.push(`<span class="muted">…</span>`);
    cells.push(cell(n));
    prev = n;
  }
  const prevLink = page > 1 ? `<a class="fl" href="${hrefOf(page - 1)}">← 上一页</a>` : "";
  const nextLink = page < pageCount ? `<a class="fl" href="${hrefOf(page + 1)}">下一页 →</a>` : "";
  return `<nav class="pager">${prevLink}${cells.join(" · ")}${nextLink}<span class="muted">共 ${String(total)} 条 · 第 ${String(page)}/${String(pageCount)} 页</span></nav>`;
}

function renderOrgFeaturesTable(
  org: string,
  features: readonly FeatureListItem[],
  page: number | null | undefined,
  pageSize: number | null | undefined,
  total: number | null | undefined,
): string {
  const rows = features.map((f) => {
    const d = deriveDisplayStage(f.state, f.stage);
    return (
      "<tr>" +
      `<td>${featureLink(f.featureId, f.title === "" ? f.featureId : f.title)}</td>` +
      `<td>${escapeHtml(label(FEATURE_STATE_LABELS, f.state))}</td>` +
      `<td>${escapeHtml(d.label)}</td>` +
      `<td>${escapeHtml(f.version === null || f.version === "" ? "—" : f.version)}</td>` +
      `<td>${escapeHtml(f.approval ?? "—")}</td>` +
      `<td>${escapeHtml(stamp(f.updatedAt))}</td>` +
      "</tr>"
    );
  });
  // 三枚全缺席 ⇒ 全量渲染 + 卡头文案与本节点改动前逐字一致（向后兼容判据）；
  // 带 total ⇒ 卡头报**全量**条数（不是本页行数），翻页链附在表尾。
  const paged = total !== null && total !== undefined;
  const count = paged ? String(total) : String(features.length);
  const pager =
    paged && page !== null && page !== undefined && pageSize !== null && pageSize !== undefined
      ? renderOrgFeaturesPager(org, page, pageSize, total)
      : "";
  return cardShell(
    "需求",
    `本组 ${count} 条`,
    `<table><thead><tr><th>需求</th><th>引擎态</th><th>阶段（显示）</th><th>版本</th><th>审批门</th><th>更新</th></tr></thead>
<tbody>${rows.length === 0 ? emptyRow(6, "（该组织暂无需求）") : rows.join("")}</tbody></table>${pager}`,
  );
}

/**
 * 组织项目卡（运行态 `a2a_projects`，一行 = 一 `(machineId, projectId)`）。
 *
 * 「已发布的最新版本号」列（v0.10.2 · REQ-2026-10-10-02 落点①）取数口径：
 * - 源 = **宿主本次渲染已取到的那份投影**（`versionProjection`，与页头核对短条共用同一次
 *   `GET /api/versions`）⇒ 本函数**不再打上游**；
 * - 值 = 按 `(org, projectId)` 从 project 档取 `status === "released"` 的 **semver 最大**
 *   （照门户摘要 {@link orgVersionSummaryOf} 的写法，用既有 `compareVersionOrder` / `normalizeVersion`，
 *   **不引入第二套比较器**）；`status = open` 的行**不进该列**；
 * - 无已发布版 / 投影为 `null` / project 档 `absent`·`empty` / 未注入 ⇒ 一律 `—`：**「无已发布」与
 *   「读不到」同显 `—`、不加提示、不加 `title`**（诚实通道唯一在页头核对短条，裁定④）；
 * - 联键 = `entry.projectId` trim 后精确相等 ∧ `entry.org === org`（他 org 的同版号不得染色）；
 * - 同 project 多机 ⇒ 同版号在**多行重复出现**，**不按 `projectId` 去重**（正常形态，不是缺陷）。
 * 三个早退分支（未查询 / 不可达）不带表 ⇒「空态 8 列」只作用于正常分支。
 */
function renderOrgProjectsTable(
  org: string,
  outcome: OrgProjectsOutcome | null,
  versionProjection?: OrgSpaceManageInput["versionProjection"],
): string {
  if (outcome === null) {
    return cardShell(
      "项目",
      "未查询",
      `<p class="hint muted"><b>未查询</b>：项目查询器未装配 ⇒ 本区不查询任何组织的项目（不编造「无项目」）。</p>`,
    );
  }
  if (!outcome.ok) {
    return cardShell(
      "项目",
      "不可达",
      `<p class="hint warn">不可达（<code>${escapeHtml(outcome.code)}</code>）：${escapeHtml(outcome.error)} —— 项目清单未知（灰化不炸页；刷新本页重查）。</p>`,
    );
  }
  const releasedVersionByProject = new Map<string, string>();
  if (versionProjection !== undefined) {
    const field: ProjectVersionsField = projectVersionsOf(versionProjection.projection);
    if (field.status === "live") {
      for (const entry of field.entries) {
        if (entry.org !== org || entry.status !== "released") continue;
        const projectId = entry.projectId.trim();
        const version = normalizeVersion(entry.version);
        if (projectId === "" || version === "") continue;
        const held = releasedVersionByProject.get(projectId);
        if (held === undefined || compareVersionOrder(version, held) > 0) {
          releasedVersionByProject.set(projectId, version);
        }
      }
    }
  }
  const rows = outcome.projects.map((p) => {
    return (
      "<tr" + (p.machineError !== null ? ' class="warn"' : "") + ">" +
      `<td>${escapeHtml(p.machineId)}</td>` +
      `<td><a class="fl" href="${escapeHtml(orgSpaceLink(org, "tasks"))}?project=${encodeURIComponent(p.projectId)}">${escapeHtml(p.projectId)}</a></td>` +
      `<td>${escapeHtml(dash(releasedVersionByProject.get(p.projectId.trim())))}</td>` +
      `<td>${escapeHtml(p.agentKind ?? "—")}</td>` +
      `<td>${p.a2aPort === null ? "—" : String(p.a2aPort)}</td>` +
      `<td>${escapeHtml(p.status ?? "—")}</td>` +
      `<td>${escapeHtml(p.startedAt ?? "—")}</td>` +
      `<td>${escapeHtml(p.machineError ?? "—")}</td>` +
      "</tr>"
    );
  });
  return cardShell(
    "项目",
    `运行态 ${String(outcome.projects.length)} 项`,
    `<table><thead><tr><th>machineId</th><th>projectId</th><th>已发布的最新版本号</th><th>agentKind</th><th>a2aPort</th><th>status</th><th>startedAt</th><th>机器 error</th></tr></thead>
<tbody>${rows.length === 0 ? emptyRow(8, "（该组织快照中无项目）") : rows.join("")}</tbody></table>`,
  );
}

/**
 * `POST /orgs` 建项目组表单（v0.9.4 A5/BD2 · 纯 SSR，零新脚本常量；可见文案 v0.9.7 增补改「项目组」，
 * 写口 / 字段名 / 校验闭集零改动）：
 * 同源提交（CSRF 防线 = 同源 Origin 档，与提需求表单同规格）；名字校验闭集的服务端
 * 单一事实源 = `write-guard.validateOrgName`，此处 hint 只做人读口径复述；
 * 写失败经既有 errorPage/错误浮层回填原输入（`orgBackfillFields`），成功 = 303 回 `/orgs`（PRG；
 * §9-c 起 `/orgs` 本身是「退役 ⇒ 303 回门户」的一跳，浏览器跟随两跳落回 `/`，**写口 `Location` 不改**）。
 * **A3（BD3）**：对**已停用**的同名组织，本表单即「同名重建 = 复活」（零迁移，三源查重豁免停用名）。
 * **§9-b 起唯一宿主 = 组织门户 `/`**；**§9-c 起 `/orgs` 页整页退役**（管理职能迁 `/org/<名>/manage`）。
 * **增补二 §9.1-②**：`data-ov="1"` ⇒ 提交守卫改 fetch 提交 + `.err-ov-card` 浮层报错（不跳错误页，
 * 成功 reload）；无 JS / 脚本失效 = 原生 PRG 整页回显，回退面不劣化、不扩内联脚本闭集。
 */
export function renderCreateOrgForm(): string {
  return `<h3>建项目组</h3>
<p class="hint">写板侧项目组台账 <code>.data/orgs.json</code>（纯新建 · <b>不触桥、不写状态机、不写 machine 配置</b>）；名称闭集 = 中文 / 字母（Latin）/ 数字 / <code>-</code> <code>_</code> <code>.</code>，禁空格与 <code>#</code> <code>?</code> <code>%</code> <code>/</code>（服务端 <code>validateOrgName</code> 单一事实源）；与<b>磁盘一级目录 / 在用台账 / 需求归属</b>三源重名 ⇒ 409 拒绝（<b>已停用</b>名不判重，同名提交即复活）。</p>
<form method="post" action="/orgs" class="w" data-submit="已提交，建组织中…" data-ov="1">
<label>项目组名 *<input name="org" required placeholder="如 flow-team"></label>
<button type="submit">建项目组</button>
</form>`;
}

/**
 * `POST /orgs` 建组织**弹窗骨架**（v0.9.4 增补六 §9.5 · 纯 SSR，零新脚本常量）：
 * 门户页 `/` 页头「＋ 建项目组」按钮（{@link renderOrgPortal} 宿主页的 `headerActions`，**无 JS 时服务端
 * 即以 `hidden` 隐藏**）点击后由 `layout.NEW_REQUIREMENT_DIALOG_SCRIPT`（已泛化为**两枚 dialog 共用**
 * 开/关逻辑）`showModal()` 打开本骨架；表单区 = {@link renderCreateOrgForm} 原样复用
 * （字段 / 校验 / `action="POST /orgs"` **零变化**）。
 * **无 JS 回退**（渐进增强）：门户正文仍保留内联表单 `#new-org-inline`，脚本可用时把它隐藏；
 * 本 dialog 关闭态不渲染 ⇒ 无 JS 用户照常走内联表单原生 POST。
 * 复用 `dialog.fd` 样式类 ⇒ 4xx 错误卡叠加规则（`dialog.fd > .err-ov-card`）同款生效。
 */
export function renderCreateOrgDialog(): string {
  return `<dialog class="fd" id="new-org-dialog">
<button type="button" id="new-org-close">关闭</button>
<div class="fd-body">${renderCreateOrgForm()}</div>
</dialog>`;
}

/**
 * 逐组织的「停用」操作表单（v0.9.4 A3 · BD3 · 纯 SSR，零新脚本常量）：提交到**同一条** `POST /orgs`，
 * 靠隐藏字段 <code>action=disable</code> 分流（写路由白名单不扩条）。删除语义 = <b>台账标记停用</b>，
 * <b>不物理删目录、不隐式连带停桥</b>：名下仍有活跃宿主桥时服务端 409 拒绝并引导「先逐桥 stop 再删」。
 * 恢复 = 用同名再走一次建组织（复活，零迁移）。`org` 值经 `escapeHtml`（盘 / 需求归属源可能含任意字符）。
 * **增补二 §9.1-②**：`data-ov="1"` ⇒ 浮层报错不跳页（同建组织表单）。
 * **增补五 §9.4-②**：`data-ov-redirect="/"` ⇒ 停用成功后 `ovSubmit` 跳组织门户 `/`，
 * 而非 reload 当前空间页（该组织刚被停用，刷新必落 410）；与服务端 303 落点同口径。
 */
function renderDisableOrgForm(org: string): string {
  return `<form method="post" action="/orgs" class="inline" data-submit="已提交，停用中…" data-ov="1" data-ov-redirect="/">
<input type="hidden" name="action" value="disable">
<input type="hidden" name="org" value="${escapeHtml(org)}">
<button type="submit">停用</button>
</form>`;
}

/**
 * 停用卡（REQ-2026-09-30-04 件5 · 原型 v2.3 样张⑤）：{@link renderDisableOrgForm} 的卡化宿主 ——
 * **表单标记逐字不动**（写面表单锚 / `data-ov` 浮层档 / `data-ov-redirect` 全保留），
 * 长口径折叠已随增补四 件B（REQ-2026-10-02-04）移除；「名下仍有活跃桥 ⇒ 409 先停桥」落成卡内警示条。
 */
function renderDisableOrgCard(org: string): string {
  return cardShell(
    "停用本组织",
    `<span class="mono">POST /orgs</span> · action=disable`,
    `<p class="b-note danger">名下仍有活跃宿主桥 ⇒ <b>409 先停桥</b>（须先逐桥 stop）；成员登记摘除失败 ⇒ 停用整体失败（不留半态）。</p>
${renderDisableOrgForm(org)}`,
  );
}

/**
 * 两栏拖拽池的行卡（v0.9.8 · REQ-2026-10-03-02）。
 * **`draggable` 由服务端渲染判据控制**（执法在服务端与桥 O1，脚本只是体验层）：
 * - 池行恒 `draggable="true"` —— 加入若撞别组，由 409 `board_member_group_conflict` 浮层兜底；
 * - 本组**末位成员行不给 `draggable`**（同写前闸 `board_last_member_remove` 判据）⇒ 拖不动即拖不了。
 * `data-machine` / `data-project` 只作拖拽载荷来源（`dataTransfer text/plain`），不承载样式判定。
 * **池行的唯一时间提示位（B-4 · REQ-2026-10-03-02）**：`lastReportedAt` 非空时在行内**服务端渲染**
 * 「最后上报于 …（非实时探测）」—— 注册表投影的语义 = 最后一次随 Runner 注册全量替换写入的时刻，
 * **不是实时探测**，故**不采信也不渲染** `status` / `online`（会冒充在线）。缺值 ⇒ 不渲（不臆造时刻）；
 * 右栏成员行不带该位 ⇒ 行字面逐字不变。
 */
function memberDragRow(
  machineId: string,
  projectId: string,
  draggable: boolean,
  lastReportedAt: string | null = null,
): string {
  const stamp =
    typeof lastReportedAt === "string" && lastReportedAt !== ""
      ? ` <span class="muted">最后上报于 ${escapeHtml(lastReportedAt)}（非实时探测）</span>`
      : "";
  const inner = `<span class="mono">${escapeHtml(machineId)}</span> / <span class="mono">${escapeHtml(projectId)}</span>${stamp}`;
  if (!draggable) return `<div class="mrow">${inner}</div>`;
  return `<div class="mrow" draggable="true" data-machine="${escapeHtml(machineId)}" data-project="${escapeHtml(projectId)}">${inner}</div>`;
}

/**
 * 项目池卡的手动刷新表单（v0.10.4 · REQ-2026-10-11-06 · **零脚本 D 档**）：一枚原生 GET 表单，
 * 提交即整页重载 ⇒ 服务端重跑管理页那四路并行读取，不做任何局部刷新、不接 live 轮询。
 * **不带 `data-ov` / `data-submit` / `data-live`**：GET 无覆盖层报错语义，也不属 live 槽。
 * 类名用新的 `m-refresh`，**不复用 `.live-now` 或 `.b-card a.fl`** —— 那两个选择器是第八枚
 * `PAGE_LIVE_SCRIPT` 的委托选择器，蹭上即把零脚本档悄悄接回脚本面。
 */
function renderPoolRefreshForm(org: string): string {
  return `<form method="get" action="${escapeHtml(orgSpaceLink(org, "manage"))}" class="m-refresh">
<button type="submit">⟳ 刷新项目池</button>
</form>`;
}

/**
 * **两栏拖拽区**（v0.9.8 · REQ-2026-10-03-02 · SSR 直出，拖拽仅作增强）：
 * 左「项目池」= 全量机器项目 − **全组（含本组）声明面**（{@link poolProjects} 的集合差，
 * 故别组成员在池里**完全不显示** —— 显示层过滤，不是写入闸门）；右「本组项目」= 声明面 members
 * （两栏同取 3300 全组枚举的该组投影，不另立事实源）。
 * 降级多档先例：快照未装配 ⇒「未查询」；读失败 / 声明面不可达 ⇒「不可用」整块灰化
 * （**不给拖拽载荷** ⇒ 不给假池编造归属）；两种降级下**本页不提供成员写通路**（⑦ 退役手填表单，
 * 拖拽是唯一写面 ⇒ 降级档只能刷新重查，写入结论以服务端投影与 409 为准）。
 * **退役卡的承接位（v0.10.2 · REQ-2026-10-10-03 N2）**：逐组「成员清单」卡撤销后，「未声明」档由本卡
 * **三出口**同渲同一枚 note —— 「未查询」/「不可用」/ 右栏空态 ⇒ 诚实通道不因删卡失承载。
 * `#member-pool` + `data-org` = {@link MEMBER_DRAG_SCRIPT} 的入口锚与提交目标（页隔离锚点，N3-⑦/⑧）。
 * `sourceCount` = **左集规模**（差集被减之前的桥注册表全集投影行数），只服务空态两分支的字面（B-3）：
 * 左集本身零行 ⇒「机器注册表暂无项目记录」；左集有行但全被减 ⇒「已全部归属某个项目组」。二者不串台。
 * `null`（未随池装配）⇒ 无从判左集，按后者如实回退，**不编造**「暂无记录」。
 */
function renderMemberPoolColumns(
  org: string,
  pool: OrgPoolOutcome | null,
  groupsOutcome: OrgGroupsOutcome | null,
  sourceCount: number | null = null,
): string {
  const title = `加 / 删项目（两栏拖拽）`;
  const refresh = renderPoolRefreshForm(org);
  const declared = groupsOutcome !== null && groupsOutcome.ok;
  const ownRow = declared ? groupsOutcome.groups.find((g) => g.name === org) : undefined;
  const undeclared = declared && ownRow === undefined;
  const undeclaredNote = `<p class="hint muted"><b>未声明</b>：orch 的 <code>projectGroup</code> 段尚无名为 <code>${escapeHtml(org)}</code> 的组（盘目录 / 板台账 / 需求归属可先于组存在，不是错误）—— 首次写入即建组带首成员（左栏拖入，一次写入）。</p>`;
  if (pool === null) {
    return cardShell(
      title,
      "未查询",
      `${refresh}<p class="hint muted"><b>未查询</b>：全量机器项目快照未装配 ⇒ 本区不呈现池与本组清单（不编造「无项目」）；成员写本档无拖拽面 ⇒ 刷新本页重查，写入结论以服务端投影与 409 为准。</p>${undeclared ? undeclaredNote : ""}`,
    );
  }
  if (!pool.ok) {
    return cardShell(
      title,
      "不可用",
      `${refresh}<p class="hint warn muted"><b>池数据不可用</b>（<code>${escapeHtml(pool.code)}</code>）：${escapeHtml(pool.error)} —— 项目归属未知 ⇒ 本区整块灰化、<b>不给拖拽</b>（刷新本页重查；成员写本档无拖拽面 ⇒ 写入结论以服务端投影与 409 为准）。</p>${undeclared ? undeclaredNote : ""}`,
    );
  }
  const own = ownRow?.members ?? [];
  const canRemove = own.length > 1;
  const poolBody =
    pool.rows.length === 0
      ? sourceCount === 0
        ? `<p class="hint muted">（机器注册表暂无项目记录）</p>`
        : `<p class="hint muted">（池为空：桥注册表全集投影中的机器项目已全部归属某个项目组）</p>`
      : pool.rows.map((r) => memberDragRow(r.machineId, r.projectId, true, r.lastReportedAt)).join("\n");
  const ownBody = !declared
    ? `<p class="hint muted">（声明面不可用 ⇒ 本组清单未知，不编造「无项目」）</p>`
    : undeclared
      ? undeclaredNote
      : own.length === 0
        ? `<p class="hint muted">（本组暂无项目：该组已在 orch 声明、成员清单为空 —— 左栏拖入即加入本组）</p>`
        : own.map((r) => memberDragRow(r.machineId, r.projectId, canRemove)).join("\n");
  const ownMeta = own.length === 1 ? `${String(own.length)} 项 · 末位不可移出` : `${String(own.length)} 项`;
  return cardShell(
    title,
    `池 ${String(pool.rows.length)} 项 · 本组 ${ownMeta}${pool.observedAt === null ? "" : ` · 观测时刻 ${escapeHtml(pool.observedAt)}`}`,
    `${refresh}<div class="m-pool" id="member-pool" data-org="${escapeHtml(org)}">
<div class="mcol" data-side="pool">
<p class="mcol-h">项目池 <span class="mcol-sub">拖到右栏 = 加入本组</span></p>
${poolBody}
</div>
<div class="mcol" data-side="own">
<p class="mcol-h">本组项目 <span class="mcol-sub">拖到左栏 = 移出本组</span></p>
${ownBody}
</div>
</div>`,
  );
}

/** {@link renderMemberWriteCard} 的入参（成员写成功回执，表单档整页顶部卡片）。 */
export interface MemberWriteCardInput {
  org: string;
  action: "add" | "remove";
  machineId: string;
  projectId: string;
  /** false = 幂等零写入（删本不在组内的成员），此时无备份文件。 */
  changed: boolean;
  /** 操作后该组声明态成员；桥未回列 ⇒ null（不臆造清单）。 */
  members: readonly { machineId: string; projectId: string }[] | null;
  /** 本次实际写入前的备份路径（**仅展示，板不解析**）。 */
  backedUpTo: string | null;
  /** 是否消费了并发冲突那唯一一次自动重读重试。 */
  retriedOnce: boolean;
}

/**
 * 成员写成功卡（v0.9.4 B 档 · BD4 · REQ-2026-09-30-04 件5 卡化）：表单档成功回执**有内容**
 * （备份路径 + 驻留引导），故出整页而非 303（口径同 REQ-v0.9.2 N7「有内容回执的档仍出整页」）。
 * 版式 = 页标题 + 一张回执卡（卡头带动作与写/零写结论），备份路径与驻留引导落成卡内条行。
 */
export function renderMemberWriteCard(input: MemberWriteCardInput): string {
  const verb = input.action === "add" ? "加入" : "移出";
  const rows =
    input.members === null
      ? '<p class="hint muted">（桥未回列操作后的成员清单 ⇒ 不臆造；刷新本页重查）</p>'
      : `<p class="hint">该组现有成员 ${String(input.members.length)} 项：` +
        (input.members.length === 0
          ? "<i>（空组）</i>"
          : input.members
              .map((m) => `<code>${escapeHtml(m.machineId)}/${escapeHtml(m.projectId)}</code>`)
              .join(" · ")) +
        "</p>";
  return `<h2>成员写成功</h2>
${cardShell(
  `组织 <code>${escapeHtml(input.org)}</code>`,
  `<span class="b-badge ok">${escapeHtml(input.machineId)}/${escapeHtml(input.projectId)} 已${verb}</span>`,
  `<p><b>${input.changed ? "已写入" : "零写入（幂等：该成员本不在组内）"}</b>${input.retriedOnce ? " · 曾遇并发冲突，已自动重读重试一次" : ""}</p>
${rows}
<p class="hint">备份：<code>${escapeHtml(input.backedUpTo ?? "—（本次未产生写入，无备份文件）")}</code>（桥写前自动备份，板只展示不解析）</p>
${input.action === "add" ? `<p class="b-note">${escapeHtml(MEMBER_ADD_RESIDENCY_NOTE)}</p>` : ""}`,
)}`;
}

/**
 * 核对源**档位词的单点常量**（⑧a：原「配置核对卡」内联字面量抬出为唯一一处 ——
 * 短条与任何后续读面不得各写一套档位词）。
 */
const CONFIG_CHECK_TIER_LABELS = {
  unassembled: "未装配",
  unreadable: "读不到",
  stale: "本次读不到",
  readable: "可读",
} as const;
type ConfigCheckTier = keyof typeof CONFIG_CHECK_TIER_LABELS;

/**
 * **页头核对短条**（REQ-2026-09-30-04 件5 · 原型 v2.3 样张⑤ 起为「配置核对卡」；
 * REQ-2026-10-11-05 ⑧a 卡面降级为**页头一条短条** —— **判定逻辑与原卡逐字相同，只换包装**）：
 * 本页**已读到的只读投影**逐源给一档核对结论 —— **① 声明面** 3300 `GET /api/groups` · **② 运行态** 逐组
 * `a2a_projects` · **③ 引擎版本台账投影（project 档）**（`GET /api/versions`，未注入 ⇒ 不参评），
 * 外加桥 `warnings[]` 的**缺文件 / 配置瑕疵警示条**。
 * **零新触面**：不查盘、不新增只读端点 —— 核对的是本页各读面那次读取的健康度，
 * 因此「上次核对时间」= 声明面那次读取的 `observedAt`（缺 ⇒ 不谎报时间）。
 * 全部**已注入**源可读 ∧ 无 warn ⇒ 结论「配置齐备 · 上次核对时间 …」。
 *
 * **第三源的三态闭集**（互斥 + 穷尽，改造文档 §2.1 落点④）—— **判据序 ①→②→③ 不可颠倒**（判序即语义）：
   1. `projection === null` ⇒ **本进程从未读到过**（「读不到」+ 根因码
      `project_versions_group_projection_unreadable`，经降级文案单点带出）；
   2. `projection !== null` ∧ `failure !== null` ⇒ **stale** = 本次读失败、值取 `engineVersionsLastGood`
      （「本次读不到 · 值取最后一次投影」+ `failure` 根因）；
   3. `projection !== null` ∧ `failure === null` ∧ project 档 `absent` ⇒ **老引擎档**（「读不到」+
      `project_versions_field_missing` / `project_versions_field_invalid`）；
   余下（`live` / `empty`）⇒ **「可读」** —— `empty` 是**合法事实**「未登记，本版本起生效」，
   **不得报读不到**。
 * 颠倒 ①/② 的后果：`versionProjectionOf` 读失败时返回的正是最后一次投影，**从未读到**（投影为
 * `null`）同时满足 ② ⇒ 颠倒会渲出**两条根因**。本源也是「投影读不到」的**唯一诚实通道**
 * （项目卡新列刻意不带 stale 提示，裁定④）。**根因码视图不另写一套** —— 三枚全部经
 * `degradationText`（`server.projectVersionDegradationText` 单点）/ `ProjectVersionsField.code` 带出。
 */
function renderOrgConfigHealthBar(
  groupsOutcome: OrgGroupsOutcome | null,
  projectsOutcome: OrgProjectsOutcome | null,
  versionProjection?: OrgSpaceManageInput["versionProjection"],
): string {
  const tierWord = (t: ConfigCheckTier): string => escapeHtml(CONFIG_CHECK_TIER_LABELS[t]);
  /** 已注入两源的档位（原 `sourceRow` 的三分支 —— 档位取值与说明文案逐字照搬）。 */
  const sourceTier = (
    outcome: { ok: boolean; code?: string; error?: string } | null,
  ): { tier: ConfigCheckTier; noteHtml: string | null } => {
    if (outcome === null) {
      return { tier: "unassembled", noteHtml: "本区不查询（不编造「齐备」也不编造「缺失」）" };
    }
    if (!outcome.ok) {
      return {
        tier: "unreadable",
        noteHtml: `<code>${escapeHtml(outcome.code ?? "unknown")}</code> ${escapeHtml(outcome.error ?? "")}`,
      };
    }
    return { tier: "readable", noteHtml: null };
  };
  /**
   * 第三源（版本台账投影 project 档）：`readable` = 是否计入「全部源可读」闸。
   * **不造「未装配」档** —— 投影读取器恒在（`ctx.engineVersions`），未注入时本源整条不出现。
   */
  const versionTier = (
    v: NonNullable<OrgSpaceManageInput["versionProjection"]>,
  ): { tier: ConfigCheckTier; noteHtml: string | null; readable: boolean } => {
    if (v.projection === null) {
      return {
        tier: "unreadable",
        noteHtml: escapeHtml(v.degradationText ?? "（未取到降级文案 ⇒ 根因码无从展示，请查投影读取面）"),
        readable: false,
      };
    }
    if (v.failure !== null) {
      return {
        tier: "stale",
        noteHtml: escapeHtml(`值取最后一次投影 · ${v.failure}`),
        readable: false,
      };
    }
    const field: ProjectVersionsField = projectVersionsOf(v.projection);
    if (field.status === "absent") {
      return {
        tier: "unreadable",
        noteHtml: escapeHtml(v.degradationText ?? `${field.code} · ${field.error}`),
        readable: false,
      };
    }
    return { tier: "readable", noteHtml: null, readable: true };
  };
  const groupsLabel = "声明面成员（3300 <code>GET /api/groups</code>）";
  const projectsLabel = "运行态项目（逐组 <code>a2a_projects</code>）";
  const versionLabel = "引擎版本台账投影（project 档 · <code>GET /api/versions</code>）";
  const groupsTier = sourceTier(groupsOutcome);
  const projectsTier = sourceTier(projectsOutcome);
  const versionSource = versionProjection === undefined ? null : versionTier(versionProjection);
  const warnings = groupsOutcome !== null && groupsOutcome.ok ? groupsOutcome.warnings : [];
  const bothAssembled = groupsOutcome !== null && projectsOutcome !== null;
  const allReadable =
    groupsOutcome !== null &&
    projectsOutcome !== null &&
    groupsOutcome.ok &&
    projectsOutcome.ok &&
    // 未注入 ⇒ 不参评（true：第三源缺席时不得挡「配置齐备」）
    (versionSource === null || versionSource.readable);
  const checkedAt =
    groupsOutcome !== null && groupsOutcome.ok ? groupsOutcome.observedAt : null;
  const src = (labelHtml: string, t: ConfigCheckTier): string => `${labelHtml} <b>${tierWord(t)}</b>`;
  const parts = [src(groupsLabel, groupsTier.tier), src(projectsLabel, projectsTier.tier)];
  if (versionSource !== null) parts.push(src(versionLabel, versionSource.tier));
  /** 不可读源的说明（原「说明」列内容照搬，换 `<ul>` 承载；可读源不重复啰嗦）。 */
  const notes: { labelHtml: string; noteHtml: string }[] = [];
  if (groupsTier.noteHtml !== null) notes.push({ labelHtml: groupsLabel, noteHtml: groupsTier.noteHtml });
  if (projectsTier.noteHtml !== null) notes.push({ labelHtml: projectsLabel, noteHtml: projectsTier.noteHtml });
  if (versionSource !== null && versionSource.noteHtml !== null) {
    notes.push({ labelHtml: versionLabel, noteHtml: versionSource.noteHtml });
  }
  const absentPart = bothAssembled ? "" : ` · ${escapeHtml("部分源未查询")}`;
  const verdictPart =
    allReadable && warnings.length === 0
      ? ` · 配置齐备 · 上次核对时间 ${escapeHtml(checkedAt ?? "（桥未回观测时刻）")}`
      : "";
  const noteList =
    notes.length === 0
      ? ""
      : `\n<ul class="hint muted">${notes
          .map((n) => `<li>${n.labelHtml}：${n.noteHtml}</li>`)
          .join("")}</ul>`;
  const warnBar =
    warnings.length === 0
      ? ""
      : `\n<p class="b-note"><b>配置瑕疵 ${String(warnings.length)} 条</b>（桥 warn-once 快照，如<b>缺文件 / 缺成员</b>类；<b>仅供呈现、不参与任何判定</b>）：</p><ul class="hint muted">${warnings
          .map((w) => `<li>${escapeHtml(w)}</li>`)
          .join("")}</ul>`;
  return `<p class="hint">核对源健康度：${parts.join(" · ")}${absentPart}${verdictPart}</p>${noteList}${warnBar}`;
}

/**
 * agentKind 输入框的**建议清单**（REQ-2026-10-04-01 增补 · `<datalist>` 唯一数据源）：
 * **板侧自持、非闭集**（写面不校验值域，清单外的值仍可手填），序 = 字母序（用户裁定①，
 * 故不得改成后端声明序）；与规范源 `PROTOCOL.md` 锚点 `<!-- agent-kinds: … -->` 的集合一致性
 * 由回归断言锁定（`test/piece5-space-cards.test.mjs`）。
 * 不放 `write-guard.ts`（那是写面校验，显示层常量放此处会被误读成值域执法）。
 */
export const ORG_HOST_AGENT_KIND_SUGGESTIONS = ["claude", "codex", "opencode", "qoder-cn"];

/**
 * **本组织 agent 配置卡**（v0.9.8 · 按项目组配 agent · 纯 SSR，零新脚本常量）：
 * 两枚文本框（agentKind / agentModel）**预填该组织当前值**，提交到同一条 `POST /orgs`
 * 靠隐藏 `action=setHostAgent` 分流（写路由白名单不扩条）；**整体覆盖两键**（不做增量 PATCH，
 * 留空 = 置 null 恢复全局默认）。回显行 = 每项生效值 + 来源标注（本组织 / 全局默认 / 后端缺省），
 * 缓解「只配 kind ⇒ 全局 model 对该组织静默失效」（改造文档 §6 遗留，不改成对回落）。
 * hint 三条固定口径见改造文档 §3（取值热生效等新建桥 / kind 写错 502 指引 / 种子 AGENTS.md 遗留）。
 * agentKind 一枚带 {@link ORG_HOST_AGENT_KIND_SUGGESTIONS} 的 `<datalist>` 建议下拉（REQ-2026-10-04-01
 * 增补）：**仍是可手填的文本框**，无 JS / 不支持 datalist 时原生退化为纯文本框。
 */
function renderOrgHostAgentCard(
  org: string,
  cfg: { orgKind: string | null; orgModel: string | null; globalKind: string | null; globalModel: string | null },
): string {
  // 生效值与回落序逐字对齐 `orgBridgeConfig`（R1 命名空间规则：组织配了 kind 未配 model ⇒ 不沿用全局 model）
  const kindSource = cfg.orgKind !== null ? "本组织" : "全局默认";
  const effKind = cfg.orgKind ?? cfg.globalKind ?? "（宿主面未装配）";
  const modelSource =
    cfg.orgModel !== null ? "本组织" : cfg.orgKind !== null ? "后端缺省" : cfg.globalModel !== null ? "全局默认" : "后端缺省";
  const effModel =
    cfg.orgModel ?? (cfg.orgKind === null && cfg.globalModel !== null ? cfg.globalModel : "（后端缺省）");
  const globalLine =
    `全局默认：kind = <code>${escapeHtml(cfg.globalKind ?? "（宿主面未装配）")}</code> · ` +
    `model = <code>${escapeHtml(cfg.globalModel ?? "（未配置 ⇒ 后端缺省）")}</code>`;
  return cardShell(
    "本组织 agent 配置",
    `<span class="mono">POST /orgs</span> · action=setHostAgent`,
    `<p class="hint">生效值回显：kind = <code>${escapeHtml(effKind)}</code>（来源：${kindSource}）· model = <code>${escapeHtml(effModel)}</code>（来源：${modelSource}）· ${globalLine}。未配置的键回落全局；<b>组织改过 kind 而未配 model ⇒ 不沿用全局 model</b>（全局 model 按全局 kind 命名空间配置，跨适配器必错），由该 kind 适配器的后端缺省接管。</p>
<form method="post" action="/orgs" class="w" data-submit="已提交，保存配置中…" data-ov="1">
<input type="hidden" name="action" value="setHostAgent">
<input type="hidden" name="org" value="${escapeHtml(org)}">
<label>agentKind（后端适配器）<input name="agentKind" value="${escapeHtml(cfg.orgKind ?? "")}" list="org-host-agent-kind-list" placeholder="留空 = 回落全局默认"></label>
<datalist id="org-host-agent-kind-list">${ORG_HOST_AGENT_KIND_SUGGESTIONS.map((kind) => `<option value="${escapeHtml(kind)}"></option>`).join("")}</datalist>
<label>agentModel（后端模型）<input name="agentModel" value="${escapeHtml(cfg.orgModel ?? "")}" placeholder="留空 = 回落全局默认 / 后端缺省"></label>
<button type="submit">保存 agent 配置</button>
</form>
<ul class="hint muted">
<li>改后对<b>已在线的该组织桥无效</b>：取值热、生效等新建桥 —— 须停桥后下一轮才用新值（与 config.json「仅对新建桥生效」同口径）。</li>
<li><b>kind 写错</b> ⇒ 该组织下一轮起桥报 502 <code>spawn_failed</code>（页面显示为「宿主桥已断」）；板不预校验值域，<b>停桥改回即可</b>。下拉为<b>板侧维护的建议清单</b>（非闭集）：清单外的值仍可手填；后端新增适配器时需同步本清单。</li>
<li>建组织种子 <code>AGENTS.md</code> 内的后端标识仍为<b>全局值</b>，不随本配置更新（已知遗留，登记于改造文档 §6）。</li>
</ul>`,
  );
}

/**
 * `GET /org/<名>/manage` **空间内管理页**（v0.9.4 §9-c · REQ-2026-09-27-06 N3）：
 * `/orgs` 组织管理页退役后，逐组织的管理职能落到该组织空间内（复用归一层上下文：
 * 组织不存在 404 / **已停用 410** 同 `org-space.resolveOrgSpaceRoute` 口径，本页只在「在用」组织上渲染）。
 * 页内七块（REQ-2026-09-30-04 件5 卡化，**全部复用既有写口，服务端零改动**），渲出序 =
 * **页头核对短条**（⑧a · REQ-2026-10-11-05 N9：紧接 `<h2>`，**先于项目卡**；卡面降级为一条
 *   `<p class="hint">`，本页**已注入**源的读取健康度 + warnings；第三源 = 引擎版本台账投影 project 档，随
 *   {@link OrgSpaceManageInput.versionProjection} 注入才参评）；
 * **项目卡** = 逐组只读 `a2a_projects`（运行态）；项目深链落**空间任务页**
 *   `/org/<名>/tasks?project=…`（v0.9.6 C3：manage 页内 org 已知，不再指全局 `/tasks`）；
 * **两栏拖拽池** {@link renderMemberPoolColumns}（左池 / 右本组，v0.9.8 · REQ-2026-10-03-02）
 *   → 成员写**只此一条拖拽通路** → `POST /orgs/{org}/members`（隐藏 `action`；⑦ 起两枚手填表单与其
 *   折叠宿主已退役，无 JS / 无拖拽面 ⇒ 该档无页内写通路，登记于改造文档 §6）；**本组织 agent 配置卡**；**停用卡** → `POST /orgs`
 *   （隐藏 `action=disable`，同写口分流；台账标记不物理删目录，恢复 = 同名重建）；**需求卡** = 归一层已持有的该组需求投影（零新触桥面）。
 * **v0.10.2 · REQ-2026-10-10-03 N2**：逐组「成员清单」卡（3300 全组枚举的该组投影）撤销 ⇒ 声明面那一次
 * 读取的健康度仍由页头核对短条首档承载，「未声明」档由 {@link renderMemberPoolColumns} 的三出口承接；
 * 本页是全站**唯一**注入第七枚内联脚本 {@link MEMBER_DRAG_SCRIPT} 的页（`Page.extraScripts` 页隔离）。
 */
export function renderOrgSpaceManagePage(input: OrgSpaceManageInput): string {
  return `<h2>管理 · ${escapeHtml(input.org)}</h2>
${renderOrgConfigHealthBar(input.groupsOutcome, input.projectsOutcome, input.versionProjection)}
${renderOrgProjectsTable(input.org, input.projectsOutcome, input.versionProjection)}
${renderMemberPoolColumns(input.org, input.poolOutcome ?? null, input.groupsOutcome, input.poolSourceCount ?? null)}
${renderOrgHostAgentCard(input.org, input.hostAgent ?? { orgKind: null, orgModel: null, globalKind: null, globalModel: null })}
${renderDisableOrgCard(input.org)}
${renderOrgFeaturesTable(
    input.org,
    input.features,
    input.page ?? null,
    input.pageSize ?? ORG_FEATURES_PAGE_SIZE,
    input.total ?? null,
  )}`;
}

// ---------------------------------------------------------------------------
// 组织门户（v0.9.4 §9-b · 首页形态 B→A · 纯 SSR 零脚本）
// ---------------------------------------------------------------------------

/** 门户的一张组织卡（计数摘要 = `getFeatures()` 既有数据派生，**零新触桥面**）。 */
export interface OrgPortalCard {
  org: string;
  /** 排期中 = 该组织名下 `version` 非空的需求数（判据与需求池互补，单一事实源 {@link isUnscheduled}）。 */
  scheduled: number;
  /** 需求 = 该组织名下需求总数。 */
  features: number;
  /** 任务 = 该组织名下各需求 `taskCount` 之和；有需求但无一携带 taskCount ⇒ `null`（不臆造 0）。 */
  tasks: number | null;
  /** B6 版本摘要：已发版 = 该组织 released 记录里 semver 最大者（无 ⇒ null，显示「—」）。 */
  lastReleased: string | null;
  /** B6 版本摘要：进行中含卡派生档，semver 升序（首个 = 显示档，`active.length > 1` ⇒ 折叠「另 N」；无 ⇒ []，显示「—」）。 */
  active: string[];
  /** B6 版本摘要：`active` 中台账未登记、由卡片阶段派生的版号（渲 `*` + title 说明；判据同 {@link deriveVersionBadgeStatus}）。 */
  activeDerived: string[];
  /** B6 版本摘要：折叠计数 = `max(0, active.length - 1)`（首个之外的余项）。 */
  extraActive: number;
}

/**
 * 门户卡的**组织版本摘要**（B6 · 与 {@link buildOrgPortalCards} 同族：显示派生，**不执法**、零写 ——
 * 门户是纯读面（**不跑任何自动写**），未点亮台账的派生档因此带 `*` 出现）。
 * - 「已发版」= 该组织 `released` 记录按 {@link compareVersionOrder} 取 **semver 最大**（**不用登记序** ——
 *   登记序会把后登记的小版本误当最新）；
 * - 「进行中」= 台账 `active` ∪ 卡派生 active（口径同列头徽标回落：台账无该 `(org, version)` 条目 ∧
 *   名下有已确认卡〔{@link isConfirmedCard}〕⇒ 派生，判据同 {@link deriveVersionBadgeStatus}）；
 *   升序后首个 = 显示档，其余折叠「另 N」；
 * - `ledger = null`（无台账面）⇒ 全部 active 视为派生（逐版带 `*`）。
 */
export function orgVersionSummaryOf(
  ledger: VersionsLedger | null,
  features: readonly FeatureListItem[],
  org: string,
): { lastReleased: string | null; active: string[]; activeDerived: string[]; extraActive: number } {
  const released: string[] = [];
  const active: string[] = [];
  const derived = new Set<string>();
  if (ledger !== null) {
    for (const rec of ledger.versions) {
      if (rec.org !== org) continue;
      const v = normalizeVersion(rec.version);
      if (v === "") continue;
      if (rec.status === "released" && !released.includes(v)) released.push(v);
      else if (rec.status === "active" && !active.includes(v)) active.push(v);
    }
  }
  const hasLedgerRecord = (v: string): boolean =>
    ledger !== null && ledger.versions.some((r) => r.org === org && normalizeVersion(r.version) === v);
  for (const f of features) {
    if ((f.ownerGroup ?? "").trim() !== org) continue;
    const v = normalizeVersion(f.version);
    if (v === "" || !isConfirmedCard(f.stage) || hasLedgerRecord(v) || active.includes(v)) continue;
    active.push(v);
    derived.add(v);
  }
  released.sort(compareVersionOrder);
  active.sort(compareVersionOrder);
  return {
    lastReleased: released.length === 0 ? null : (released[released.length - 1] ?? null),
    active,
    activeDerived: active.filter((v) => derived.has(v)),
    extraActive: Math.max(0, active.length - 1),
  };
}

/**
 * 门户卡数据（纯函数）：给定组织清单 × 需求列表 × 版本台账 ⇒ 逐组织计数 + 版本摘要。
 * 归属匹配 = `ownerGroup` trim 后精确相等（口径同 `orgs-view.featuresOfOrg`）；
 * 清单外的需求（无归属 / 盘遗留组织）不进任何卡，不丢弃判据也不反查扩清单。
 * **B6**：`ledger`（`.data/versions.json` 现值，`null` = 无台账面）只贡献摘要行的显示派生，**零写**。
 */
export function buildOrgPortalCards(
  orgs: readonly string[],
  features: readonly FeatureListItem[],
  ledger: VersionsLedger | null = null,
): OrgPortalCard[] {
  const tally = new Map<string, { scheduled: number; total: number; tasks: number | null }>();
  for (const f of features) {
    const owner = (f.ownerGroup ?? "").trim();
    if (owner === "") continue;
    let cell = tally.get(owner);
    if (cell === undefined) {
      cell = { scheduled: 0, total: 0, tasks: null };
      tally.set(owner, cell);
    }
    cell.total += 1;
    if (!isUnscheduled(f.version)) cell.scheduled += 1;
    if (f.taskCount !== null) cell.tasks = (cell.tasks ?? 0) + f.taskCount;
  }
  return orgs.map((org) => {
    const cell = tally.get(org);
    const s = orgVersionSummaryOf(ledger, features, org);
    return {
      org,
      scheduled: cell?.scheduled ?? 0,
      features: cell?.total ?? 0,
      tasks: cell?.tasks ?? null,
      ...s,
    };
  });
}

/**
 * `GET /` 组织门户（§9-b · 用户实测后推翻 B 案的首页形态）：
 * 一行一组织的卡（复用看板 `.kanban` / `.kcol` 样式，无新 CSS 类）+ 计数摘要 +
 * **版本摘要行**（B6：已发版 / 进行中，卡派生档带 `*` + title）+
 * 点卡头进空间 `/org/<名>/`；建项目组 = **页头按钮 + 弹窗**（§9.5）：本视图渲染 `#new-org-inline`
 * 内联回退表单（无 JS 用）+ {@link renderCreateOrgDialog} 骨架（JS 用），按钮由宿主页 `headerActions` 给。
 * **件B（REQ-2026-10-02-01 增补）**：正文不再有 `<h2>` 标题（页头 page-head `<h1>` 已承载，去重）。
 * **增补三（REQ-2026-10-02-03）**：一句话摘要行与「ⓘ 门户口径说明」折叠体撤除 —— 正文只剩故障状态行 + 组织卡区 + 建项目组。
 * **零外源脚本**：本视图自身不挂可执行内联脚本；页头按钮的开/关由**已泛化**的
 * `NEW_REQUIREMENT_DIALOG_SCRIPT`（页面脚本闭集**七元**内既有常量，非本轮新增的第七枚）随宿主页注入承载。
 */
export function renderOrgPortal(cards: readonly OrgPortalCard[], orgsStatus?: OrgsDirStatus | null): string {
  const orgsLine =
    cards.length === 0
      ? `<p class="hint">（暂无项目组：台账与需求归属两源皆空 —— 先用下方「建项目组」建一个，或直接到<code>/schedule</code> 提未排期需求）</p>`
      : `<div class="kanban" id="org-portal">
${cards
  .map(
    (c) => `<div class="kcol">
<h3><a class="fl" href="${escapeHtml(orgSpaceLink(c.org))}">${escapeHtml(c.org)}</a></h3>
<p class="kmeta">排期中 ${String(c.scheduled)} · 需求 ${String(c.features)} · 任务 ${c.tasks === null ? "—" : String(c.tasks)}</p>
<p class="kmeta"${c.activeDerived.length > 0 ? ` title="带 * = 台账未登记该版，由卡片阶段派生（名下有已确认卡 ⇒ 进行中；门户为纯读面，不做台账自动点亮）"` : ""}>已发版 ${escapeHtml(c.lastReleased ?? "—")} · 进行中 ${c.active.length === 0 ? "—" : `${escapeHtml((c.active[0] ?? "") + (c.activeDerived.includes(c.active[0] ?? "") ? "*" : ""))}${c.extraActive > 0 ? ` (另 ${String(c.extraActive)})` : ""}`}</p>
</div>`,
  )
  .join("\n")}
</div>`;
  // 增补三（REQ-2026-10-02-03）：ready 档不再展示（原承载它的折叠体已一并撤除）；
  // problem / not_configured 保持原地默认可见 —— 用户 2026-10-02 裁决：故障出现时用户必须看到。
  const statusFaultLine =
    orgsStatus === undefined || orgsStatus === null || orgsStatus.tier === "ready"
      ? ""
      : orgsStatus.tier === "problem"
        ? `<p class="hint err"><code>${escapeHtml(orgsStatus.code)}</code> 项目组目录根已配置但不可用：${escapeHtml(orgsStatus.message)}</p>`
        : `<p class="hint warn"><code>board_orgs_dir_not_configured</code> 项目组目录根（orgsDir）未装配：门户照常展示，但<b>建项目组 / 详情页动作区提交 / 起宿主桥</b>将结构化 503，请配置 config.json 的 orgsDir 后重启板。</p>`;
  return `${statusFaultLine}
${orgsLine}
<div id="new-org-inline">${renderCreateOrgForm()}</div>
${renderCreateOrgDialog()}`;
}

// ---------------------------------------------------------------------------
// 排期看板页（v0.9.2 M4 · 只读；数据 = 列表 `getFeatures()` 复用，零新桥接口）
// ---------------------------------------------------------------------------

/** 看板的一个版本列（列头 + 该版本下的需求卡；未排期不进列，归需求池 M5）。 */
export interface ScheduleColumn {
  /** 已归一（trim）的版本串，列内恒定。 */
  version: string;
  features: FeatureListItem[];
}

/**
 * 引擎版本台账投影 → 版号清单（纯读，v0.10.0 尾段 N1 · 版本列换源）：
 * 事实源 = **引擎版本台账**（板本地台账自 B4 起降为读缓存）⇒ 版本列的台账侧版号取此处。
 * - `projection === null`（从未读到过投影）⇒ **空清单**（不当作「引擎零版本」，降级档由调用方接读缓存）；
 * - `org` 切片档同 {@link ledgerVersionNames}：`undefined` = 不限组织，字符串 = 精确匹配该组织；
 * - 跨组织同名折叠为一、保持登记序、空版号忽略（视图侧再 `normalizeVersion` 归一，此处不重复裁）。
 * **只取版号、不取状态** —— 状态仍由 `renderSchedule` 的徽标读面按台账条目取（本函数不扩口径）。
 */
export function projectionVersionNames(
  projection: EngineVersionsProjection | null,
  org?: VersionOrgFilter,
): string[] {
  const names: string[] = [];
  if (projection === null) return names;
  for (const entry of projection.entries) {
    if (org !== undefined && entry.org !== org) continue;
    const v = normalizeVersion(entry.version);
    if (v === "" || names.includes(v)) continue;
    names.push(v);
  }
  return names;
}

/**
 * 引擎版本台账投影 → 台账形状（**全量三态**，v0.10.0 尾段 N2 · 门户摘要 / 启动日志换源）：
 * 事实源 = 引擎版本台账 ⇒ 纯读面（版本摘要行 / 已发版清单）也改由投影喂入，板本地台账只在
 * **从未读到过投影**时充当降级读缓存（口径同 N1 的版本列）。
 * - 与 server 侧 {@link versionProjectionLedgerOf}（**锁档**：只取 `released`）分立的理由是消费面不同 ——
 *   本函数供 `orgVersionSummaryOf` / {@link releasedVersionLabels}，二者**自身按 status 过滤**，
 *   故必须保留 `active` / `notstart` 条目，否则「台账登记的进行中版本」会退化成卡派生（带 `*`）；
 * - `status` 非闭集（含 `null` ⇒ 老桥缺键）⇒ 落 `notstart`：**既不当已发版、也不当进行中**，
 *   仅占「台账已登记该 `(org, version)`」一位（口径与本地台账的 notstart 条目一致）；
 * - 时刻字段以本次投影的 `capturedAt` 如实标注（投影不带逐条 createdAt）；`note` 不出投影面 ⇒ `null`。
 * 纯读、零写。
 */
export function projectionLedgerOf(projection: EngineVersionsProjection): VersionsLedger {
  return {
    version: 0,
    versions: projection.entries.map((entry) => ({
      org: entry.org,
      version: entry.version,
      status: isVersionStatus(entry.status) ? entry.status : "notstart",
      createdAt: projection.capturedAt,
      updatedAt: projection.capturedAt,
      note: null,
    })),
  };
}

/**
 * 需求列表 → 版本列（纯函数）：未排期（`trim() === ""` 单一判据，含 null）直接滤除；
 * 列序 = `version-order.ts` 比较器**升序**（semver 数值序、非 `x.y.z` 字典序垫底）；
 * 看板呈现侧按此降序展示（件3：需求池最左 + 版本由大到小，见 {@link renderSchedule}），
 * 本函数不动（版本台账等其它读面仍是升序口径）；
 * 列内保持入参顺序（不做列内二次排序 —— 抖动排序键会让卡片跳位）。
 * **v0.10.4 限定（REQ-2026-10-12-02）**：上句只约束**本函数** —— 本函数仍不排；**呈现侧**
 * （{@link renderSchedule}）自 v0.10.4 增补起按状态档（`compareFeatureCard`）另排一把，
 * **不得据此句判「板内列内永不排序」**。
 *
 * **并集（REQ-2026-09-27-05 §2.2 N2 · v0.10.0 尾段 N1 换源）**：列 = **卡派生 ∪ 台账侧版号** ——
 * 台账侧独有版本（尚无卡的「空列」= 新版本入口的落点）与卡独有版本（台账无登记的**历史脏列**）
 * **都保留显示**；同名去重并作一列（交集）。台账侧版号自 v0.10.0 起分两路入参：
 * `engineVersions` = **引擎版本台账清单**（事实源，见 {@link projectionVersionNames}）、
 * `ledgerVersions` = 板本地台账（**仅在拿不到投影时**由调用方作降级读缓存喂入，正常档传空数组）——
 * 两路都是「版号清单」，本函数按同一并集规则消费，不区分来源。
 * **绝不「只渲染引擎清单」**：引擎无条目 ∧ 卡有 `version` ⇒ 该卡仍须成列（否则卡在整个版本面失去清单读面）。
 * 本函数**纯读、零写**（台账只贡献版本名、不携状态；不突变入参）⇒ 读面不突变。
 * **v0.9.6 B3**：两个版号数组均由调用方按组织切片喂入（`projectionVersionNames(projection, org)` /
 * `ledgerVersionNames(ledger, org)`）—— 本函数不认组织，他组织的同版号是否成列取决于调用方给的名字集。
 */
export function groupFeaturesByVersion(
  features: readonly FeatureListItem[],
  ledgerVersions: readonly string[] = [],
  engineVersions: readonly string[] = [],
): ScheduleColumn[] {
  const byVersion = new Map<string, FeatureListItem[]>();
  for (const f of features) {
    if (isUnscheduled(f.version)) continue;
    const v = normalizeVersion(f.version);
    const bucket = byVersion.get(v);
    if (bucket === undefined) byVersion.set(v, [f]);
    else bucket.push(f);
  }
  for (const raw of [...engineVersions, ...ledgerVersions]) {
    const v = normalizeVersion(raw);
    if (v === "" || byVersion.has(v)) continue; // 空串忽略；交集已在卡派生侧建桶
    byVersion.set(v, []); // 台账独有 ⇒ 空列占位（此版本已建、尚无卡）
  }
  return [...byVersion.entries()]
    .sort(([a], [b]) => compareVersionOrder(a, b))
    .map(([version, list]) => ({ version, features: list }));
}

/**
 * 看板的一张需求卡（REQ-2026-10-02-05 增补五 件A · **固定四行序**）：
 * 第1行 `.khd` = 标题链（≤2 行截断）；第2行 `.kmeta` = id 行（mono 短 id，增补时追加「关联需求 id」
 * 同格并列 · 单跳深链保留）；第3行 `.kbadge-line` = 状态徽标（闸锁时同带紧凑「🔒 排期已锁」）；
 * 第4行 `.kmeta` = 一行 11px 元信息（阶段 · 任务数）。**审批门摘出卡面** —— 其值已由状态徽标承载
 * （`待审批` ⇔ `waiting_approval`），登记字段原样在详情页；阶段档摘出「派生 / 登记」后缀（同因）。
 * `withRequirement` ⇒ 池卡追加需求原文（截断 120 字 + 转义，标题已链详情页）。
 * **v0.9.3 B-T5 拖拽闸**：`stage=需求分析 ∧ approval=未发起`（{@link deriveScheduleGateOpen}
 * 单一规则源，与服务端 409 同判据）⇒ `draggable="true"` + `data-feature`/`data-version`
 * （供 {@link DRAG_SCHEDULE_SCRIPT} 拖拽提交）；闸锁 ⇒ 置灰 + 紧凑标记「🔒 排期已锁」
 * （完整说明只在 409 错误卡呈现），**卡片仍可点击**（拖不动 ≠ 打不开）。detail 页/池卡同用本函数，闸口径一致。
 * **行为类不重命名**：`.kcard` / `.kcard[draggable="true"]` / `.draglocked` / `.kbadge` / `.kmeta`
 * 逐字保留（拖拽双条件闸与详情浮层委托的判据锚）。
 * **增补五 件B（REQ-2026-10-02-05）按状态着色**：卡根追加状态色档类 `kst-${档}`
 * （{@link deriveCardColorTier} 单一规则源，七元闭集）—— 纯显示层，
 * 不新增/修改任何行为判据属性（`draggable` / `data-feature` / `data-version` / `draglocked` 原样）。
 */
export function renderScheduleCard(f: FeatureListItem, withRequirement = false): string {
  const d = deriveDisplayStage(f.state, f.stage);
  const reqLine =
    withRequirement && f.requirement !== null && f.requirement !== ""
      ? `<p class="kmeta">需求：${escapeHtml(truncate(f.requirement, 120))}</p>`
      : "";
  const open = deriveScheduleGateOpen(f.stage, f.approval);
  const versionAttr = escapeHtml(normalizeVersion(f.version));
  const dragAttrs = open
    ? ` draggable="true" data-feature="${escapeHtml(f.featureId)}" data-version="${versionAttr}"`
    : "";
  const lockedClass = open ? "" : " draglocked";
  const tierClass = ` kst-${deriveCardColorTier(f.state)}`;
  // 降噪（v0.9.3 增补 ①）：卡面只留紧凑锁定标记；完整说明（为何锁 / 板上解不了 / cancel 去处）
  // 只在拖拽/改版被拒的 409 错误卡呈现（server.ts `board_schedule_state_locked` 文案）。
  const lockedLine = open ? "" : `<span class="kbadge draglock">🔒 排期已锁</span>`;
  const idLine = `<span class="mono muted" title="${escapeHtml(f.featureId)}">${escapeHtml(shortId(f.featureId))}</span>${renderParentFeatureIdCell(f.parentFeatureId)}`;
  return `<div class="kcard${lockedClass}${tierClass}"${dragAttrs}>
<div class="khd">${featureLink(f.featureId, f.title === "" ? f.featureId : f.title)}</div>
<p class="kmeta">${idLine}</p>
<p class="kbadge-line">${lockedLine}<span class="kbadge">${escapeHtml(label(FEATURE_STATE_LABELS, f.state))}</span></p>
<p class="kmeta">阶段：${escapeHtml(d.label)} · 任务数：${f.taskCount === null ? "—" : f.taskCount}</p>
${reqLine}</div>`;
}

/**
 * 未排期需求 → 池序（纯函数）：判据两条 `trim(version) === ""` ∧ 非引擎终态
 * （`completed` / `failed` / `cancelled` 不进池；未排期且终态的卡在板面无清单读面 ——
 * 组织空间需求清单读面已随 v0.9.6 组织作用域收敛退役，历史读面 = 经引擎
 * `a2a_feature_status` / `a2a_feature_trace` 查阅，不得因需求池不显示而默认算完成；
 * `state` 为 null / 未知态按非终态放行）；显示过滤不改事实源，不得用作任何计数闸数据源。
 * 排序不依赖 orch 列表序（改排期会前进 `updated_at`、列表序可变），池序见 `version-order.ts`。
 */
export function selectRequirementPool(features: readonly FeatureListItem[]): FeatureListItem[] {
  return sortPoolEntries(
    features.filter((f) => isUnscheduled(f.version) && !isTerminalFeatureState(f.state)),
  );
}

/**
 * 台账三态 → 列头徽标投影（REQ-2026-09-27-05 §2.2 N2 · 单一映射点）：
 * `notstart`=未开始 / `active`=进行中 / `released`=🔒 已发版。样式与既有派生徽标分立可辨
 * （灰 / 蓝 / 棕），`note` 作 tooltip。
 */
const LEDGER_BADGE: Readonly<Record<VersionLedgerStatus, { text: string; variant: string; note: string }>> = {
  notstart: { text: "未开始", variant: "notstart", note: "版本台账状态：未开始。" },
  active: { text: "进行中", variant: "wip", note: "版本台账状态：进行中。" },
  released: { text: "🔒 已发版", variant: "locked", note: "版本台账状态：已发版。" },
};

/** 派生徽标（台账无该版）· 锁版命中：与台账 released 同一显示，tooltip 说明锁来源。 */
const DERIVED_RELEASED_BADGE = {
  text: "🔒 已发版",
  variant: "locked",
  note: "该版已登记为已发版 ⇒ 排期锁定（不可排入 / 改入 / 改出）。",
} as const;

/**
 * 派生徽标（台账无该版）· 按卡片阶段判定（§9.4 增补九）：口径与台账三态的显示投影一致，
 * 差别只在 tooltip 说明「本枚由卡片阶段派生、非台账态」。
 */
const DERIVED_STAGE_BADGE: Readonly<Record<"active" | "notstart", { text: string; variant: string; note: string }>> = {
  active: {
    text: "进行中",
    variant: "wip",
    note: "台账未登记该版，徽标由卡片阶段派生：名下存在已确认卡（stage ≠ 需求分析）⇒ 进行中。",
  },
  notstart: {
    text: "未开始",
    variant: "notstart",
    note: "台账未登记该版，徽标由卡片阶段派生：名下全是想法卡（stage = 需求分析）或无卡 ⇒ 未开始。",
  },
};

/**
 * 台账**无该版**（由卡片 `version` 派生的列）时的徽标态（§9.4 增补九）：
 * 判据与迁移矩阵「`notstart → active` 触发 = 首卡过 Step 0 确认门」同源 ——
 * 名下**存在已确认卡**（`stage ≠ 需求分析`）⇒ `active`；全是想法卡 / 名下无卡 ⇒ `notstart`。
 * 锁版（已发版集命中）优先，由调用方判定。
 */
export function deriveVersionBadgeStatus(features: readonly FeatureListItem[]): "active" | "notstart" {
  return features.some((f) => isConfirmedCard(f.stage)) ? "active" : "notstart";
}

/**
 * 列头版本状态徽标（REQ-v0.9.2 增补 ⑤ N4 · **仅显示，不执法**）：
 * - **N2 起**（REQ-2026-09-27-05 §2.2）：版本在**台账**中 ⇒ 按台账三态渲染
 *   （`notstart`=未开始 / `active`=进行中 / `released`=🔒 已发版）—— 台账状态优先于卡片派生；
 * - 台账无该版（历史脏列 / 老桥）⇒ 回落**按卡片阶段派生**（§9.4 增补九）：锁版命中「🔒 已发版」优先，
 *   其余「有已确认卡 ⇒ 进行中 / 全想法卡或无卡 ⇒ 未开始」（**读面不突变**）；
 * - 「未排期」不进版本列，无需处理。（v0.9.3 增补 ③ Timeline 退役后仅排期看板使用本枚。）
 * **v0.9.6 B3**：台账唯一键 = `(org, version)` ⇒ 取条目按 `org` 精确档（`undefined` = 不限组织，
 * 全局页的跨组织并集）；切片值由调用方给定，本函数不猜组织。
 */
export function renderVersionBadge(
  version: string,
  features: readonly FeatureListItem[],
  releasedVersions: readonly string[],
  ledger: VersionsLedger | null = null,
  org?: VersionOrgFilter,
): string {
  const rec = ledger === null ? null : findVersionRecord(ledger, normalizeVersion(version), org);
  const b =
    rec !== null
      ? LEDGER_BADGE[rec.status]
      : isVersionLocked(version, releasedVersions)
        ? DERIVED_RELEASED_BADGE
        : DERIVED_STAGE_BADGE[deriveVersionBadgeStatus(features)];
  return ` <span class="kbadge vbadge ${b.variant}" title="${escapeHtml(b.note)}">${escapeHtml(b.text)}</span>`;
}

/**
 * 版本框头**删除入口 ×**（v0.9.4 增补十一 E2 · 父改造文档 §9.6；**替代**增补七 b 的
 * 「操作行里的删除版本按钮」· 纯 SSR，零新脚本常量）：提交到既有的那一条
 * `POST /versions`（隐藏字段 `action=remove`），`data-ov="1"` 沿用「fetch 提交 +
 * `.err-ov-card` 浮层报错」口径（无 JS = 原生 PRG 整页回显）。
 *
 * 可见性 = **仅未开始的版本**：判据与「首卡过确认门才转 active」同源 ——
 * 名下**没有任何已过 Step 0 确认门的卡**（`isConfirmedCard(stage)` 全假）。
 * 由此前台 × 的出现与服务端可删闸（released + 有已确认卡 ⇒ 拒）一一对应，不出必 409 的死按钮。
 *
 * 台账无该版（历史脏列 = 只由卡片派生）⇒ 不出 ×（台账里没有可删的条目）；
 * `released` 条目 ⇒ 不出 ×（已发版为终态、服务端不可删，同增补十的纯只读口径）。
 * 删除类操作不走脚本二次确认（内联脚本闭集枚数不扩），由 `title` + `data-submit` 明确文案承担。
 * **v0.9.6 B3**：条目按 `(org, version)` 取（`org` 省略 = 不限组织）—— 他组织的同版号条目不得
 * 决定本列的 × 出现，也不得被本列的 × 删掉。
 * **v0.9.6 B4**：`org` 非空（空间档）⇒ 表单 `action` 同带空间前缀（口径 4 的同一条通路）——
 * 服务端只从**路径**认组织（表单零 org 字段），前缀缺失会让删除落回「不限组织」取首个命中，
 * 从而可能删掉**他组织**的同版号条目；全局档（`org` 省略）action 仍 `/versions` 逐字节不变。
 */
function renderVersionDelete(
  version: string,
  features: readonly FeatureListItem[],
  ledger: VersionsLedger | null,
  org?: VersionOrgFilter,
): string {
  const rec = ledger === null ? null : findVersionRecord(ledger, normalizeVersion(version), org);
  if (rec === null || rec.status === "released") return "";
  if (features.some((f) => isConfirmedCard(f.stage))) return "";
  const action = typeof org === "string" && org !== "" ? orgSpaceLink(org) + "versions" : "/versions";
  return `<form method="post" action="${escapeHtml(action)}" class="inline vdel" data-submit="已提交，删除版本中…" data-ov="1" title="删除 ${escapeHtml(rec.version)}（仅未开始的版本可删；名下想法卡自动回需求池，已确认需求存在则服务端拒绝）">
<input type="hidden" name="action" value="${escapeHtml(VERSION_ACTION_REMOVE)}">
<input type="hidden" name="version" value="${escapeHtml(rec.version)}">
<button type="submit" aria-label="删除版本 ${escapeHtml(rec.version)}">×</button>
</form>`;
}

/**
 * `GET /schedule` 排期看板（纯函数）：**列序 = 需求池最左，其右版本列由大到小**
 * （件3 · 呈现侧降序 —— 对 {@link groupFeaturesByVersion} 的升序入参做 `compareVersionOrder` 反向
 * 排序，**不改该纯函数**，版本台账等其它页仍是升序口径）。列头（**sticky**，见 `layout.ts`
 * `.kcol &gt; h3`）= 版本号 + 状态徽标（N4 / N2：**台账三态** notstart=未开始 / active=进行中 / released=🔒；
 * 台账无该版回落**按卡片阶段派生**：有已确认卡=进行中 / 全想法卡或无卡=未开始 / 锁版=🔒，仅显示）+ 卡片计数；
 * 未排期卡不占版本列，集中首列「需求池」（池序 = 入参已排，见 {@link selectRequirementPool}）。
 * **增补三 件B（REQ-2026-10-02-03）**：件3 的顶部 `<details>` 长说明（数据口径 / 拖拽纪律）已整块撤除 ——
 * 本页为纯看板，口径由列头徽标与删除 × 的 `title` 就地承载。
 * `columns` 由 {@link groupFeaturesByVersion} 给出（已含台账 ∪ 卡派生并集），`ledger` 供列头徽标取态。
 * **v0.9.6 B3**：`org` = 本面的组织切片档（调用方给定）—— 列头徽标与删除 × 的台账取条目按
 * `(org, version)`；`undefined` = 不限组织（全局页并集，B5a 退役前保持既有形态）。
 * **v0.9.4 增补十一 E1（§9.6）**：看板尾「新版本」拖拽**虚列已撤**（§2.6 形态作废）⇒ 创建版本
 * 的唯一入口 = 排期页页头「＋ 新版本」按钮 + `#new-version-dialog` 弹窗。
 * **v0.9.4 增补十一 E2（§9.6）**：删除入口由操作行的「删除版本」按钮**上框**为列头右上角
 * {@link renderVersionDelete} 的 ×（仅未开始版本出现）。
 * **v0.9.4 增补十一 E3（§9.6）**：列头**操作行整体撤除**（含「标记已发版」，其原属增补七 b 形态）
 * ⇒ 前台不再渲染任何 `setStatus` 入口；版本状态维护只留后台 `POST /versions` `setStatus` 直投
 * （数据纠错通道，**写口与迁移矩阵闸零改动**），真发版动作待「发版」按钮（另立需求 · 归 v0.9.5）。
 * **v0.9.4 增补十（§9.5）**：`released` 列**不再渲染任何操作入口**（去「重开」）⇒ 已发版列 UI =
 * 纯只读（仅 🔒 徽标）。
 * **v0.10.4 增补（REQ-2026-10-12-02）列内序**：列内序 = `version-order.compareFeatureCard` 单点
 * （六档状态序 + 同档 `createdAt` 降序 + `featureId` 兜底；本面经 {@link sortFeatureCards} 消费该比较器）。
 * 30s 换块拍上状态一变即**跨档跳位**，是**裁定后的正常形态**（回指需求确认单），**不得据跳位判回归**。
 */
export function renderSchedule(
  columns: readonly ScheduleColumn[],
  pool: readonly FeatureListItem[] = [],
  releasedVersions: readonly string[] = [],
  ledger: VersionsLedger | null = null,
  org?: VersionOrgFilter,
): string {
  const cols = [...columns]
    .sort((a, b) => compareVersionOrder(b.version, a.version))
    .map(
      (c) => `<div class="kcol" data-version="${escapeHtml(c.version)}">
<h3>${escapeHtml(c.version)}${renderVersionBadge(c.version, c.features, releasedVersions, ledger, org)} <span class="muted">(${String(c.features.length)})</span>${renderVersionDelete(c.version, c.features, ledger, org)}</h3>
${sortFeatureCards(c.features).map((f) => renderScheduleCard(f)).join("\n")}
</div>`,
    );
  const poolCol = `<div class="kcol" data-version="">
<h3>需求池 <span class="muted">(${String(pool.length)})</span></h3>
${pool.length === 0 ? `<p class="hint">（无未排期的在途需求 · 终态卡不进需求池）</p>` : pool.map((f) => renderScheduleCard(f, true)).join("\n")}
</div>`;
  // 件N1：排期页锚 = 看板容器**自身**（不套壳 —— 拖拽脚本 `colOf` 以该元素为上溯边界，
  // 容器节点不可替换）；页面周期属性挂这一枚（本锚即该页第一枚）。
  const board = `<div class="kanban" id="schedule-board" data-live="sched-board" data-live-interval="${String(LIVE_INTERVALS.schedule)}">${[poolCol, ...cols].join("\n")}</div>`;
  const emptyNote =
    cols.length === 0
      ? `<p class="hint">（无已排期需求：未排期的在途需求都在需求池列）</p>`
      : "";
  // 详情浮层骨架（REQ-v0.9.2 增补 ④）：dialog 内容运行时由 FEATURE_DETAIL_OVERLAY_SCRIPT
  // 搬入详情页 <main> 节点，骨架恒空、不嵌任何用户数据；脚本随 renderPage 每页注入，
  // 无 dialog（其它页）或禁 JS 时不生效 ⇒ 卡片 <a> 即整页详情回退。
  return `${emptyNote}${renderLiveBar(LIVE_INTERVALS.schedule)}${board}
<dialog class="fd" id="feat-dialog">
<button type="button" id="feat-dialog-close">关闭</button>
<div class="fd-body"></div>
</dialog>`;
}

// ---------------------------------------------------------------------------
// 动作区（v0.9.5 C5 · 档位化意图按钮；同源 POST，服务器端渲染）
// ---------------------------------------------------------------------------

/**
 * 详情页**单动作区**（v0.9.5 C5 · 合并原「触发一轮」与「人工确认」两个表单）。
 *
 * **档位化口径（定向推翻 BD18 / 收口轨 14 ② / 收口轨 17 的「禁用不隐藏」旧写法）**：按钮文案与
 * 提交去向由 {@link deriveActionAffordance} 按「用户此刻想做什么」给唯一档位 ——
 * agent 闲置 = 「让 agent 继续」· 有待裁待答 = 「提交给 agent」· `approval` = 待审批 =
 * 「确认改造文档 → 放行执行」（**唯一**出现确认档的地方）；**终态 / 宿主面未装配 ⇒ 整个动作区不渲染**
 * （不再摆三个 573 字灰态按钮让人猜哪个能点）。轮占用仍渲染但 disabled + 原因（点了会白点，入口须可见）。
 * **写路由与语义零改动**：`form action` 仍一对一指 `/features/:id/turn` 与 `/features/:id/confirm`；
 * 服务端 409 硬闸（`board_turn_busy` / `board_feature_terminal`）全保留 —— 本区只控**显示**。
 */
export function renderActionArea(featureId: string, input: NextStepInput): string {
  const a = deriveActionAffordance(input);
  if (a === null) return "";
  const target =
    a.kind === "confirm"
      ? `/features/${encodeURIComponent(featureId)}/confirm`
      : `/features/${encodeURIComponent(featureId)}/turn`;
  const submitNote = a.kind === "confirm" ? "已提交，处理中…" : "已提交，本轮可能跑数分钟…";
  // 补充框只随 turn 档走（confirm 档是固定指令模板通道，不掺自由文本）。
  const supplementField =
    a.kind === "confirm"
      ? ""
      : `<label class="hint">补充（可选 · 随本轮一起发给 agent；留空 = 只说「继续」）<textarea name="supplement" rows="3" placeholder="例：需求里那点理解不对，应该是…"></textarea></label>`;
  const cls = a.quiet ? ' class="quiet"' : "";
  const button = a.enabled
    ? `<button type="submit"${cls}>${escapeHtml(a.label)}</button>`
    : `<button type="submit"${cls} disabled aria-disabled="true">${escapeHtml(a.label)}</button>`;
  const reasonLine = a.enabled ? "" : `<p class="hint warn">${escapeHtml(a.note)}</p>`;
  return `<h2>动作</h2>
${reasonLine}<form method="post" action="${target}" class="w" data-submit="${escapeHtml(submitNote)}">
${supplementField}
${button}
</form>`;
}

/**
 * 详情页「下一步」引导行（BD18 ② · v0.9.5 C1 升级）：一行可操作提示（卡在哪 / 等谁 / 做什么），
 * 判序与文案规则见 {@link deriveNextStepHint}；**上移到字段表之后的第一屏**。
 * 终态需求的这一行即「墓碑」结论摘要（{@link renderFeatureDetail} 对终态不渲染动作区）。
 */
export function renderNextStepGuide(input: NextStepInput): string {
  return `<p class="hint nextstep">${escapeHtml(deriveNextStepHint(input))}</p>`;
}

// ---------------------------------------------------------------------------
// 轮结果留痕（v0.9.5 C6 · 最近一轮的 state / 摘要 / 时间）
// ---------------------------------------------------------------------------

/** 轮态中文（`TurnState` 七值闭集；未命中 ⇒ 原样显示，不吞不猜）。 */
const TURN_STATE_LABELS: Readonly<Record<string, string>> = {
  queued: "排队中",
  running: "进行中",
  awaiting_answer: "等你回答",
  succeeded: "有结论",
  failed: "失败",
  canceled: "已取消",
  timeout: "超时",
};

/** 最近一轮的留痕入参（`BoardHostFace.latestTurnOf` 归一后的最小面）。 */
export interface TurnTraceInput {
  turnId: string;
  state: string;
  summary: string | null;
  /** 该轮最近一次时刻（ISO 原文）；`null` ⇒ 不显示时间。 */
  at: string | null;
  /** 结构化错误码（非失败轮 ⇒ `null`）。 */
  errorCode: string | null;
  /**
   * 本轮尾部【回执】块的结构化结果（v0.9.6 N4 · 契约见 `receipt.ts`）。
   * 缺字段 / null（历史轮、agent 漏遵）⇒ **走现状渲染**（容错退回，不劣于今天）。
   */
  receipt?: Receipt | null;
}

/** 待用户逐条标号（与 `receipt.ts` 的圈号分隔同一族，超出十项回落项目符）。 */
const RECEIPT_TODO_MARKS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"] as const;

/**
 * 结构化回执卡（v0.9.6 N4 · 改造文档 §2-4）：要点 / 待用户 / 下一步三行 +
 * 一条**静态**产出指引（「阶段产出」区默认收起 ⇒ 措辞必须含「展开」）+「完整摘要」折叠。
 * **零脚本**：折叠用原生 `<details>`（内容 = 现状那枚 400 字 `pre.result`），不碰 N3 的内联脚本闭集。
 */
function renderReceiptCard(receipt: NonNullable<Receipt>, summary: string | null): string {
  const head = receipt.head.length > 0 ? receipt.head.map((s) => escapeHtml(s)).join("<br>") : "—";
  const todo =
    receipt.todo.length > 0
      ? receipt.todo
          .map((s, i) => `${RECEIPT_TODO_MARKS[i] ?? "·"} ${escapeHtml(s)}`)
          .join("<br>")
      : "无";
  const next = receipt.next !== "" ? escapeHtml(receipt.next) : "—";
  const fold = renderTurnSummaryFold(summary, "完整摘要");
  return `<div class="receipt-card">
<p class="hint receipt-row"><b>要点</b> · ${head}</p>
<p class="hint receipt-row"><b>待用户</b> · ${todo}</p>
<p class="hint receipt-row"><b>下一步</b> · ${next}</p>
<p class="hint receipt-docs">📄 文档产出见『阶段产出』区，展开查看</p>
</div>
${fold}`;
}

/**
 * 摘要折叠层（现状形态）。`summaryLabel = null` ⇒ 折叠入口 = 截断预览（C6 现状）；
 * 给定字符串 ⇒ 入口用该文案（回执卡在场时摘要已退居次要，标题改「完整摘要」）。
 */
function renderTurnSummaryFold(summary: string | null, summaryLabel: string | null): string {
  if (summary === null || summary === "") return "";
  const preview = summaryLabel === null ? truncate(summary, LATEST_TURN_SUMMARY_MAX) : summaryLabel;
  return `<details class="fold turn-summary"><summary>${escapeHtml(preview)}</summary><pre class="result">${escapeHtml(summary)}</pre></details>`;
}

/**
 * 详情页「最近一轮」留痕行（C6）：预审段与 executing 段都显示 —— 用户看得懂「上一轮跑到哪、
 * 说了什么」。`null` = 该需求从未起过轮 / 宿主面未装配 ⇒ 不渲染（缺席不是错误，不带崩页面）。
 *
 * v0.9.6 N4：本轮带回执 ⇒ 「最近一轮」下方渲结构化回执卡（重点不再落在 400 字截断区）；
 * 无回执（历史轮 / agent 漏遵）⇒ 渲染与 C6 现状**逐字节一致**。
 */
export function renderTurnTrace(turn: TurnTraceInput | null): string {
  if (turn === null) return "";
  const receipt = turn.receipt ?? null;
  const summary =
    receipt !== null
      ? renderReceiptCard(receipt, turn.summary)
      : renderTurnSummaryFold(turn.summary, null);
  const errBit =
    turn.errorCode === null || turn.errorCode === ""
      ? ""
      : ` · <span class="mono">${escapeHtml(turn.errorCode)}</span>`;
  return `<h2>最近一轮</h2>
<p class="hint turn-trace"><b>${escapeHtml(label(TURN_STATE_LABELS, turn.state))}</b> · <span class="mono">${escapeHtml(shortId(turn.turnId))}</span> · ${escapeHtml(stamp(turn.at))}${errBit}</p>
${summary}`;
}

/**
 * 详情页「下一步」引导区的**验收轨迹块**（REQ-v0.9.2 N8）：消费桥详情出参顶层 `acceptance`
 * （stages 段轨迹 + failures 账单 + stateCounts），计数与反推全归 orch，板侧只如实渲染。
 * `null` = 老桥 / 缺键 ⇒ 不渲染（详情页现行为）。
 *
 * 消费纪律：`state` 值域**非封闭**（存量库有退役值 analyzing/planning）⇒ 未命中标签表原样显示 + 灰化；
 * **末段** `leftAt === null` = 当前停留态（非缺字段）；同态重复段不合并。
 *
 * **v0.9.5 C2 空区块短路④**：`stages` 至多一段（= 从未迁出过态）∧ 失败账单 0 条 ⇒ 整节不渲染
 * —— 「waiting_approval 一张卡 + 失败 0 条」这种轨迹没有任何信息量。
 */
export function renderAcceptanceSection(acceptance: AcceptanceView | null | undefined): string {
  if (acceptance === null || acceptance === undefined) return "";
  if (acceptance.stages.length <= 1 && acceptance.failures.length === 0) return "";
  const stageRows = acceptance.stages.map((s, i) => {
    const known = Object.prototype.hasOwnProperty.call(FEATURE_STATE_LABELS, s.state);
    const stateCell = known
      ? escapeHtml(label(FEATURE_STATE_LABELS, s.state))
      : `<span class="muted">${escapeHtml(s.state === "" ? "—" : s.state)}</span>`;
    const last = i === acceptance.stages.length - 1;
    const leftCell = s.leftAt !== null ? escapeHtml(stamp(s.leftAt)) : last ? '<span class="warn">当前停留</span>' : "—";
    return `<tr><td>${stateCell}</td><td>${escapeHtml(stamp(s.enteredAt))}</td><td>${leftCell}</td></tr>`;
  });
  const stageTable = `<table><thead><tr><th>主链态（轨迹段）</th><th>进入</th><th>离开</th></tr></thead>
<tbody>${stageRows.length === 0 ? emptyRow(3, "（无段轨迹）") : stageRows.join("")}</tbody></table>`;
  const counts = Object.entries(acceptance.stateCounts)
    .map(([k, n]) => `${escapeHtml(label(TASK_STATE_LABELS, k))} × ${String(n)}`)
    .join(" · ");
  const failureRows = acceptance.failures.map((fl) => {
    return (
      "<tr>" +
      `<td class="mono">${fl.eventId === null ? "—" : String(fl.eventId)}</td>` +
      `<td>${escapeHtml(stamp(fl.at))}</td>` +
      `<td class="mono">${escapeHtml(acceptancePayloadSummary(fl.payload))}</td>` +
      "</tr>"
    );
  });
  const failuresBlock =
    acceptance.failures.length === 0
      ? `<p class="hint">失败账单：<b>0 条</b></p>`
      : `<p class="hint">失败账单：<b>${String(acceptance.failures.length)} 条</b>（orch 零去重原样列出）</p>
<table><thead><tr><th>eventId</th><th>时间</th><th>payload 摘要</th></tr></thead>
<tbody>${failureRows.join("")}</tbody></table>`;
  return `<h2>验收轨迹（acceptance）</h2>
<p class="hint">数据 = 桥详情出参顶层 <code>acceptance</code> 块（orch 聚合，板不重算、不按 state 反推）；态值域非封闭，未知/退役态原样显示。${counts === "" ? "" : ` 节点态计数：${counts}`}</p>
${stageTable}
${failuresBlock}`;
}

/**
 * 失败账单 payload 摘要：`payload` 是事件原文 JSON 字符串（可 null），**内层键不作契约** ——
 * 能 parse 成对象则按「实际有的键」浅层概括（数组记长度、标量记值），坏 JSON / 非对象 ⇒ 原文截断显示。
 */
function acceptancePayloadSummary(payload: string | null): string {
  if (payload === null || payload === "") return "—";
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const parts = Object.entries(parsed as Record<string, unknown>).map(([k, v]) =>
        Array.isArray(v) ? `${k}×${String(v.length)}` : `${k}=${String(v)}`,
      );
      if (parts.length > 0) return parts.join(" · ");
      return "（空对象）";
    }
  } catch {
    // 防御式：payload 非合法 JSON 属容错面，原文如实显示，不崩不吞
  }
  return truncate(payload, 120);
}

/**
 * 详情页「轮次进度」行（REQ-v0.9.2 N7）：该需求有在飞 / 排队的轮时显示「第 N 轮 · 在飞 / 排队中（位次）」，
 * 无 ⇒ 空串（不渲染）。触发一轮受理成功后 303 回本页，这一行就是它该有的落点。
 *
 * **自动更新的三档准确口径（REQ-2026-10-11-05 增补 N3 第三档；①② 承 REQ-2026-10-11-03 件D，
 * 取代 REQ-2026-09-29-02 件D 的口径）**：
 * ① **浮层动作区** = 件B 的**有界**轮询（周期与上界 = `layout.ts` `FEATURE_DETAIL_OVERLAY_SCRIPT`
 * 内的 `POLL_INTERVAL_MS` × `POLL_MAX_TICKS`，本轮收口即停）—— 在浮层里提交一轮后进度就地累加；
 * ② **本页只读锚** = 第八枚「页级就地刷新」脚本（`layout.ts` `PAGE_LIVE_SCRIPT`）按
 * `LIVE_INTERVALS.feature` 常驻，逐 `[data-live]` 锚只换其子节点 —— **锚级就地换块，不是整页重载**。
 * ③ **浮层打开即跟刷**（件D 第三档）：`open()` 取到详情后**成功档即起轮**，与「是否在浮层里提交过」
 * 无关 —— 但**仅仍忙才轮**（`stillBusy(main)` 为假 ⇒ 不起轮，**已收口的详情零请求**）；换页走浮层侧
 * `swapPage`，其语义 = **整份 `<main>` 全换**（不是 ② 那种锚级换块），故浮层内的表单 / 输入区**不保留**
 * 未提交内容 —— 为此有**拍级 held 闸**：用户正在填 / 已填未提交 ⇒ 本拍不换页，只排下一拍。
 * **含输入 / 表单的区域**（澄清框、动作区表单、池卡等）不在锚内 ⇒ 仍须重载本页才见最新。
 * 旧口径「整页静态、唯一自动面 = 浮层动作区」已退役（它描述的正是件D 之前的形态）；
 * 收尾提示按上述口径写清，周期数值**只经 `liveIntervalMs` 传入**，不在本函数内二次硬编码。
 */
export function renderTurnProgress(view: TurnProgressView | null, liveIntervalMs: number = LIVE_INTERVALS.feature): string {
  if (view === null) return "";
  const where =
    view.state === "running"
      ? "在飞"
      : `排队中${view.position === null ? "" : ` · 队列第 ${String(view.position)} 位`}`;
  return `<p class="hint turn-progress">轮次进度：<b>第 ${String(view.round)} 轮 ${where}</b> · <span class="mono">${escapeHtml(view.turnId)}</span> · 浮层内提交后动作区自动刷新进度至本轮收口；本页只读区每 ${String(liveIntervalMs / 1000)}s 自动更新；含输入的区域不自动更新</p>`;
}

/**
 * 详情页「链状态」一行（v0.9.5 增补二 · D2）：自动接力 / 心跳监视的内存态如实回显，紧跟轮次进度。
 * - `监视中（等 N 个子任务）`：链未被停、正由板侧监视（N = 挂起台账 pending 条数；读不到 ⇒ 不说个数，0 ⇒ 按 DAG 监视）；
 * - `链已停（原因 · 来源）`：来源 = 用户（停链口）⇒ **人工动作不解冻**（一点即停、不再复活）；
 *   来源 = 自动（撞 occupant / 退让超上限）⇒ 补充或回答即解冻。
 * 入参 `null`（快照缺席 / 取值失败）⇒ 空串：整行不渲染、不报错。
 *
 * **REQ-2026-09-30-04（停链入口上板）**：第二参数 `featureId` **可选** —— 仅 `monitoring` ∧ `featureId`
 * 在场时，行后挂一枚**空表单**（`POST /features/:id/stop-chain`，id 走路径、零 body 字段）作为插话逃生门；
 * 未传 ⇒ 维持纯文案（与 `deriveActionAffordance` 的监视中短路同为 fail-open，未接线的调用方零改动）。
 * 纯 `<form method="post">` 过 CSRF 的 Origin/Referer 档 ⇒ **零脚本、零扩写面白名单**；
 * `data-submit` 复用 v0.9.5 提交即时反馈口（`SUBMIT_GUARD_SCRIPT`）。
 * 表单是 `<p>` 的**兄弟节点**（HTML 不允许 `form` 嵌在 `p` 内，嵌了会被解析器拆开）。
 *
 * **REQ-2026-09-30-05 增补（监视档感知 awaiting）**：第三参数 `awaitingAnswer` **可选** ——
 * `monitoring` ∧ `awaitingAnswer === true` ⇒ 档位标签换成「等你回答」（链仍在监视，`waiting` 计数
 * 子串与 stopHint 逐字不动），消除「等你回答」引导行与「监视中」链状态行同页并存的矛盾；
 * 缺省（不传 / false）⇒ 输出与既往逐字一致（与 `featureId` 第二参同一条可选参纪律）。
 */
export function renderChainStateLine(view: ChainStateLine | null, featureId?: string, awaitingAnswer?: boolean): string {
  if (view === null) return "";
  if (view.state === "monitoring") {
    const label = awaitingAnswer === true ? "等你回答" : "监视中";
    const waiting =
      view.pendingCount === null ? "" : view.pendingCount === 0 ? "（无待回子任务 · 按 DAG 监视）" : `（等 ${String(view.pendingCount)} 个子任务）`;
    const id = (featureId ?? "").trim();
    // 指路文案与表单**同进同出**：无表单时不得说「点停链」（-03 口径 = 文案只指向页面上真实存在的入口），
    // 由此未传 featureId 的调用点输出与旧形态逐字一致。
    const stopHint = id === "" ? "" : " · 要插话请点「停链」，停链后动作区回来";
    const stopForm =
      id === ""
        ? ""
        : `<form method="post" action="/features/${encodeURIComponent(id)}/stop-chain" class="inline" data-submit="已停链，正在返回本页…"><button type="submit" title="停掉自动接力 / 心跳监视，动作区随即回来（内存标志，重启板进程即恢复）">停链</button></form>`;
    return `<p class="hint chain-state">链状态：<b>${label}</b>${waiting}${stopHint}</p>${stopForm}`;
  }
  const source =
    view.source === "user"
      ? "来源：用户（停链口）· 人工动作不解冻"
      : view.source === "auto"
        ? "来源：自动 · 补充 / 回答可解冻"
        : "来源：未知";
  return `<p class="hint chain-state">链状态：<b>链已停</b>（${escapeHtml(view.reason ?? "原因未记录")} · ${source}）</p>`;
}

/**
 * 需求详情页上的「澄清回答」表单：`POST /features/:id/answer`（BD9）。
 * **仅在存在 `awaiting_answer` 轮时渲染**（调用方判据 = {@link BoardHostFace.awaitingTurnOf}）；
 * 回答将以同一 `contextId` 续接该需求的宿主会话（澄清续推口径）。
 */
export function renderAnswerForm(featureId: string, question: string | null): string {
  const q = question === null || question.trim() === ""
    ? ""
    : `<pre class="result">${escapeHtml(question)}</pre>`;
  return `<h2>回答待澄清的问题</h2>
${q}<p class="hint">在这里回答，<b>或直接给新指示</b>（改方向、取消等均可）—— 提交将<b>续接同一 contextId</b>（同一逻辑任务的澄清续推复用会话），非答案内容原会话 agent 也能接住；提交后本轮结果如实回显。</p>
<form method="post" action="/features/${encodeURIComponent(featureId)}/answer" class="w" data-submit="已提交，回答续推中…">
<textarea name="answer" rows="4" cols="60" required placeholder="输入回答"></textarea>
<button type="submit">发送回答</button>
</form>`;
}

/**
 * 触发一轮的结果页正文（BD8）：**终态 + display 如实显示**。
 * `awaiting_answer` 由 BD4b 的 display 承载「需要你回答」（**不是失败**）；
 * `queued` 显示「排队中」并指向状态页（本节点不等排队轮的终态）。
 * v0.9.6 N4：带回执 ⇒ 「本轮回执」卡替下平铺摘要（摘要退入「完整摘要」折叠）；无回执 ⇒ 现状渲染。
 */
export function renderTurnOutcome(o: TriggerTurnOutcome): string {
  const bad = isFailureDisposition(o.disposition);
  const hintClass = bad ? "hint err" : "hint";
  const rows = [
    ["组织", o.org],
    ["需求", o.featureId],
    ["轮次", o.turnId ?? "—"],
    ["contextId", o.contextId ?? "—"],
    ["第几轮", o.round === null ? "—" : `第 ${String(o.round)} 轮`],
    ["轮态", o.state ?? "—"],
    ["结局", o.disposition],
    ["桥 pid:port", o.bridge === null ? "—" : `${String(o.bridge.pid)}:${String(o.bridge.port)}（${o.bridge.kind}）`],
  ]
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td class="mono">${escapeHtml(v)}</td></tr>`)
    .join("");
  const receipt = o.receipt ?? null;
  const summary =
    receipt !== null
      ? `<h2>本轮回执</h2>\n${renderReceiptCard(receipt, o.summary)}`
      : o.summary !== null
        ? `<h2>本轮产出（摘要）</h2><pre class="result">${escapeHtml(o.summary)}</pre>`
        : "";
  const question =
    o.question !== null
      ? `<h2>要你回答的问题</h2><pre class="result">${escapeHtml(o.question)}</pre>`
      : "";
  const error =
    o.error !== null
      ? `<p class="hint err">错误码 <code>${escapeHtml(o.error.code)}</code>：${escapeHtml(o.error.message)}</p>`
      : "";
  const note =
    o.disposition === "awaiting_answer"
      ? `<p class="hint">「需要你回答」= 后端按 A2A 的 <code>input-required</code> 收口，<b>不是失败</b>；回答入口 = 需求详情页下方的「回答待澄清的问题」表单（同 contextId 续推）。本轮记录已落板侧台账。</p>`
      : o.disposition === "not_awaiting"
        ? `<p class="hint">回答入口只服务<b>当前待澄清的一轮</b>：该需求现在没有 <code>awaiting_answer</code> 的轮 ⇒ 本次回答<b>未投递</b>（结构化 409），板不会把答案投进一个不在澄清中的会话。</p>`
        : o.disposition === "busy"
          ? `<p class="hint">该需求已有<b>在飞或排队</b>的一轮 ⇒ 本次提交<b>未入队</b>（结构化 409 <code>board_turn_busy</code>，防连点重复烧一轮）；等上一轮结束后可到<a class="fl" href="/host">宿主桥状态</a>页确认队列。</p>`
          : o.disposition === "terminal"
            ? `<p class="hint">该需求已进入<b>引擎终态</b>（completed / failed / cancelled）⇒ 本次提交<b>未投递</b>（结构化 409 <code>board_feature_terminal</code>，防 API 直调为已结束的需求白烧一轮）；如需继续请重新提需求。</p>`
            : o.disposition === "queued"
          ? `<p class="hint">本轮<b>排队中</b>（同组织一时刻只跑一轮）⇒ 本响应未等它的终态；到<a class="fl" href="/host">宿主桥状态</a>页刷新可看队列。本轮记录已落板侧台账。</p>`
          : `<p class="hint">本轮终态与摘要已落板侧台账，板<b>不写引擎状态机</b>（审批 / 推进 / 取消归编排 agent）。</p>`;
  const back = `<p class="hint"><a class="fl" href="/features/${encodeURIComponent(o.featureId)}">回到需求详情</a> · <a class="fl" href="/host">宿主桥状态</a></p>`;
  return `<h2>${escapeHtml(o.display === "" ? `本轮结果：${o.disposition}` : o.display)}</h2>
<p class="${hintClass}">结局 = <code>${escapeHtml(o.disposition)}</code>${o.queued ? " · 未开跑（排队）" : ""}</p>
${error}
${question}
${summary}
<table><tbody>${rows}</tbody></table>
${note}
${back}`;
}

/** 结局是否属「失败档」（与 {@link renderTurnOutcome} 的 `bad` 判据同一闭集）。 */
function isFailureDisposition(d: TriggerDisposition): boolean {
  return (
    d === "bridge_down" ||
    d === "turn_failed" ||
    d === "timeout" ||
    d === "not_awaiting" ||
    d === "busy" ||
    d === "terminal" ||
    d === "config_error"
  );
}

/**
 * 轮结果失败档的 BD2 浮层参数（REQ-v0.9.2 N2）：标题 = 错误码中文族名、正文 = error 消息、
 * mono 小字 = code、「知道了」由渲染层给出。成功 / `awaiting_answer` / `queued` 等非失败档 ⇒ `null`
 * （不弹——它们不是错误）。整页信息架构不变（renderTurnOutcome 原样保留），浮层只是统一样式面。
 */
export function turnOutcomeErrorOverlay(o: TriggerTurnOutcome): ErrorOverlayParams | null {
  if (!isFailureDisposition(o.disposition)) return null;
  const code = o.error?.code ?? `turn_${o.disposition}`;
  return {
    family: errorFamilyLabel(code),
    error: o.error?.message ?? (o.display === "" ? `本轮未成功（${o.disposition}）` : o.display),
    code,
    hint: "整页仍保留本轮台账明细；关闭浮层后可回宿主桥状态页重试。",
  };
}

/** 停桥结果失败档的 BD2 浮层参数（同判据：`ok:false` ⇒ 浮层；成功 ⇒ null）。 */
export function stopBridgeErrorOverlay(o: StopBridgeOutcome): ErrorOverlayParams | null {
  if (o.ok) return null;
  const code = o.error?.code ?? "host_stop_failed";
  return {
    family: errorFamilyLabel(code),
    error: o.error?.message ?? (o.display === "" ? "停桥未成功" : o.display),
    code,
    hint: "状态页已如实回显；关闭浮层后可重试或查桥日志。",
  };
}

/** 桥不可达整页的错误码（BD2 浮层版式统一 · REQ-v0.9.2 N2）。 */
export const BRIDGE_UNREACHABLE_CODE = "bridge_unreachable";

/** 停桥结果横幅（同页显示；失败如实带错误码，不伪装成「已停」）。 */
export function renderHostNotice(o: StopBridgeOutcome): string {
  return o.ok
    ? `已停桥：${o.org} · ${o.display}`
    : `停桥未成功（${o.error?.code ?? "unknown"}）：${o.error?.message ?? o.display}`;
}

// ---------------------------------------------------------------------------
// 宿主桥状态页（BD8 · 故障可见是本页重点）
// ---------------------------------------------------------------------------

/** 宿主桥五态中文（**仅展示层**；未命中原样显示，不吞不猜）。 */
const HOST_STATE_LABELS: Readonly<Record<string, string>> = {
  running: "在线",
  starting: "启动中",
  unreachable: "进程在但连不上",
  exited: "进程已消失",
  failed: "起不来",
};

function hostStateCell(state: string): string {
  const label = Object.prototype.hasOwnProperty.call(HOST_STATE_LABELS, state)
    ? `${HOST_STATE_LABELS[state]}（${state}）`
    : state;
  const cls = state === "running" || state === "starting" ? "" : ' class="warn"';
  return `<td${cls}>${escapeHtml(label)}</td>`;
}

function dash(v: string | number | null | undefined): string {
  return v === null || v === undefined || v === "" ? "—" : String(v);
}

export interface HostPageInput {
  entries: HostStatusEntry[];
  config: { orgsDir: string | null; defaultOrg: string | null; kind: string };
  /** 最近一次写面动作的回显（触发结果 / 停桥结果），无 ⇒ null。 */
  notice: string | null;
  /**
   * 组织目录根的不可用结论（BD14）：非空 ⇒ 本页顶部出**根因**条，
   * 不得只留一句「未托管任何宿主桥」让人去猜是桥坏还是目录没建。
   */
  orgsDirProblem?: { code: string; message: string } | null;
}

/**
 * `GET /host`：逐组织一行桥状态（五态 + 结构化 error + pid/port/kind/起停时刻）
 * 外加该组织的轮队列。**故障可见是本页重点** —— 断链组织必须落 `.warn` 行 +
 * 「宿主桥已断」文案 + 原始错误码，**不得静默、不得假数据**。
 */
export function renderHostPage(input: HostPageInput): string {
  const cfg = input.config;
  const cfgLine = `<p class="hint">组织目录根 = <code>${escapeHtml(cfg.orgsDir ?? "（未配置 ⇒ 详情页动作区提交将结构化 503）")}</code> · 默认组织 = <code>${escapeHtml(cfg.defaultOrg ?? "（未配置 ⇒ 组织名由提需求表单给出）")}</code> · 缺省 kind = <code>${escapeHtml(cfg.kind)}</code></p>`;
  const problem = input.orgsDirProblem ?? null;
  const problemLine =
    problem === null
      ? ""
      : `<p class="hint err"><code>${escapeHtml(problem.code)}</code> ${escapeHtml(problem.message)}</p>`;
  const notice =
    input.notice === null ? "" : `<p class="hint">${escapeHtml(input.notice)}</p>`;
  if (input.entries.length === 0) {
    return `<h2>宿主桥</h2>
${cfgLine}
${problemLine}
${notice}
<p class="hint">当前进程未托管任何宿主桥 ⇒ 无状态可显示（本页面<b>不编造数据</b>）。到需求详情页<b>动作区</b>点一次按钮即会按组织起桥。</p>`;
  }
  const rows = input.entries.map((e) => {
    const s = e.status;
    const down = s.state === "unreachable" || s.state === "exited" || s.state === "failed";
    const errCell =
      s.error === null
        ? "—"
        : `<span class="err">${escapeHtml(s.error.code)}</span> ${escapeHtml(s.error.message)}`;
    const waiting = e.queue.waiting
      .map((w) => `${escapeHtml(w.requirementId)} <span class="muted">${escapeHtml(w.turnId)}</span>`)
      .join("、");
    const runningTurn =
      e.queue.running === null
        ? "—"
        : `在飞：<code>${escapeHtml(e.queue.running.requirementId)}</code> <span class="muted">${escapeHtml(e.queue.running.turnId)}</span>`;
    const idle = s.idleMs === null ? "—" : `${String(Math.floor(s.idleMs / 1000))}s`;
    const stopForm = `<form method="post" action="/host/${encodeURIComponent(s.org)}/stop" data-submit="已提交，停桥中…"><button type="submit">停桥</button></form>`;
    return (
      `<tr${down ? ' class="warn"' : ""}>` +
      `<td>${escapeHtml(s.org)}</td>` +
      hostStateCell(s.state) +
      `<td>${escapeHtml(s.display)}</td>` +
      `<td class="mono">${dash(s.pid)}</td>` +
      `<td class="mono">${dash(s.port)}</td>` +
      `<td>${escapeHtml(s.kind)}</td>` +
      `<td>${dash(s.inFlightRounds)} / 阈值 ${escapeHtml(s.idleStopMs === 0 ? "常驻" : `${String(Math.round(s.idleStopMs / 1000))}s`)}</td>` +
      `<td>${escapeHtml(stamp(s.startedAt))} / ${escapeHtml(stamp(s.lastActivityAt))} / ${escapeHtml(idle)}</td>` +
      `<td>${runningTurn}${waiting === "" ? "" : `<br>排队（${String(e.queue.waiting.length)}）：${waiting}`}</td>` +
      `<td>${errCell}</td>` +
      `<td>${stopForm}</td>` +
      "</tr>"
    );
  });
  return `<h2>宿主桥</h2>
${cfgLine}
${problemLine}
${notice}
<p class="hint">状态取 BD4a 的五态闭集（<code>running / starting / unreachable / exited / failed</code>）· 队列取 BD4b 的闸位视图（<b>容量恒 1</b>：同组织一时刻只跑一轮）· 后端 CLI 一律 <b>SIGTERM 后超时树杀</b>（桥 + 后端两级）。</p>
<table><thead><tr><th>组织</th><th>状态</th><th>显示文案</th><th>pid</th><th>port</th><th>kind</th><th>在飞轮 / 回收</th><th>起 / 末次活动 / 空闲</th><th>轮队列</th><th>结构化错误</th><th>动作</th></tr></thead>
<tbody>${rows.join("")}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// 错误码 → 中文族名（REQ-v0.9.1-2026-09-25-03 · 表单档错误浮层的标题）
// ---------------------------------------------------------------------------

/** 动态码前缀（jsonrpc_<n> / http_<n>）→ 族名；精确表未命中才查前缀。 */
const ERROR_FAMILY_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["jsonrpc_", "桥调用错误"],
  ["http_", "桥调用错误"],
];

const ERROR_FAMILY_LABELS: Readonly<Record<string, string>> = {
  write_guard_origin: "CSRF 来源校验拒绝",
  write_guard_origin_unknown: "CSRF 来源不可判定",
  requirement_form_invalid: "表单字段校验失败",
  board_group_required: "表单字段校验失败",
  payload_too_large: "请求体超限",
  body_read_failed: "请求体读取失败",
  bridge_unreachable: "桥不可达",
  host_turn_rejected: "本轮未受理",
  host_stop_failed: "停桥未成功",
  host_not_managed: "本板未托管该组织",
  turn_failed: "本轮执行失败",
  timeout: "本轮超时",
  bridge_down: "宿主桥不可达",
  config_error: "宿主面配置错误",
  board_orgs_dir_not_configured: "宿主面未配置组织根",
  board_orgs_dir_missing: "组织目录根不可用",
  board_org_not_resolved: "归属组织无法确定",
  board_org_name_invalid: "组织名不合法",
  board_org_exists: "组织已存在",
  board_org_action_invalid: "组织写动作不合法",
  board_org_disabled: "组织已停用",
  board_org_host_agent_not_found: "组织不在台账",
  board_org_host_agent_invalid: "agent 配置表单校验失败",
  board_org_space_not_found: "组织空间不存在",
  board_org_space_gone: "组织空间已关闭（组织停用）",
  board_org_mismatch: "组织空间归属不一致",
  board_org_has_active_bridge: "组织名下仍有宿主桥",
  board_member_action_invalid: "成员写动作不合法",
  board_member_pair_missing: "成员项不完整",
  board_last_member_remove: "组织仅剩一项目",
  config_write_dry_run_rejected: "桥拒写（配置校验未过）",
  config_write_unknown_machine: "机器不在桥配置",
  config_write_group_not_found: "目标组不存在",
  config_write_duplicate_member: "成员重复",
  config_write_concurrent_modification: "配置并发冲突",
  config_write_io_failed: "桥写盘失败",
  board_turn_request_invalid: "本轮入参不合法",
  board_no_awaiting_turn: "无可回答的澄清轮",
  board_turn_busy: "本轮已在进行",
  board_feature_terminal: "需求已终态",
  board_version_released: "版本已发版锁定",
  board_version_action_invalid: "版本写动作不合法",
  board_version_form_invalid: "版本写字段校验失败",
  board_version_exists: "版本已存在",
  board_version_not_found: "版本不在台账",
  board_version_remove_released: "已发版版本不可删",
  board_version_remove_confirmed_cards: "该版本下还有已确认需求",
  board_version_remove_pool_back_failed: "想法卡回需求池失败",
  org_workspace_missing: "组织工作区缺失",
  bridge_unavailable: "宿主桥不可达",
  bridge_exited: "宿主桥已退出",
  bridge_start_timeout: "宿主桥启动超时",
  spawn_failed: "宿主桥起不来",
  launch_plan_failed: "宿主桥启动计划失败",
  response_invalid: "桥调用错误",
  protocol_error: "桥调用错误",
  jsonrpc_error: "桥调用错误",
  transport_error: "桥调用错误",
  no_fetch: "桥调用错误",
  unknown: "桥调用错误",
  host_face_disabled: "宿主面未装配",
  answer_empty: "参数校验失败",
  board_schedule_owner_group_missing: "归属组织缺失",
  board_schedule_state_locked: "排期状态锁定",
  schedule_request_invalid: "排期写入参错误",
  bad_url: "请求不合法",
  not_found: "未知路径",
  method_not_allowed: "方法不允许",
  internal_error: "系统异常",
};

/** 错误码 → 中文族名；**无命中回退原文 code**（不吞不猜）。 */
export function errorFamilyLabel(code: string): string {
  for (const [prefix, family] of ERROR_FAMILY_PREFIXES) {
    if (code.startsWith(prefix)) return family;
  }
  for (const [key, family] of Object.entries(ERROR_FAMILY_LABELS)) {
    if (key === code) return family;
  }
  return code;
}
