/**
 * 板只读视图（BD3）：需求列表 / 需求详情（含 trace 三面）/ 任务 / 项目·机器。
 *
 * 全部为**纯函数**（输入已归一的视图数据，输出正文 HTML 片段），规则一律取自
 * `derive.ts`，不散落在模板字符串里。所有动态值经 `escapeHtml`。
 */
import type {
  AcceptanceView,
  FeatureDetailView,
  FeatureListItem,
  FeatureTraceView,
  ProjectTasksView,
  ProjectsView,
} from "../bridge-client.js";
import {
  AGENT_VIEW_CALIBRATION_NOTE,
  B13_CALIBRATION_NOTES,
  INFLIGHT_CALIBRATION_NOTE,
  PARALLELISM_NOTE,
  deriveConfirmAffordance,
  deriveDisplayStage,
  deriveNextStepHint,
  deriveScheduleGateOpen,
  deriveTerminalFeatureAffordance,
  deriveTurnBusyAffordance,
  formatDurationBetween,
  traceWaitDisplay,
} from "../derive.js";
import type { ConfirmAffordance, NextStepInput, TurnProgressView } from "../derive.js";
import type { DocsSource } from "../docs-read.js";
import {
  MERMAID_ASSET,
  defaultStaticRoot,
  mermaidAssetScriptTag,
  mermaidRenderScript,
  renderMarkdown,
  vendoredAssetExists,
} from "../docs-render.js";
import type { OccupantTurnView } from "../host-turn.js";
import type { HostStatusEntry, StopBridgeOutcome, TriggerDisposition, TriggerTurnOutcome } from "../host-face.js";
import { NO_OWNER_GROUP_LABEL } from "../orgs-view.js";
import { orgSpaceLink } from "../org-space.js";
import type { GroupRow, OrgGroupsOutcome, OrgProjectsOutcome } from "../orgs-view.js";
import { CONFIG_WRITE_GROUP_TOOL, MEMBER_ADD_RESIDENCY_NOTE } from "../group-admin.js";
import type {
  AgentInflightModel,
  AgentInflightProject,
  AgentMachineRow,
  BridgeIdentityOutcome,
} from "../agent-view.js";
import { compareVersionOrder, isUnscheduled, normalizeVersion, sortPoolEntries } from "../version-order.js";
import { isVersionLocked } from "../version-status.js";
import { isConfirmedCard } from "../version-transition.js";
import { findVersionRecord, type VersionLedgerStatus, type VersionsLedger } from "../versions-ledger.js";
import { VERSION_ACTION_REMOVE } from "../write-guard.js";
import { emptyRow, escapeHtml } from "./layout.js";
import type { ErrorOverlayParams } from "./layout.js";

/** 引擎态中文（**仅展示层**，照 orch 网页面先例；未命中原样显示，不吞不猜）。 */
const FEATURE_STATE_LABELS: Readonly<Record<string, string>> = {
  waiting_approval: "待审批",
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
 * 任务视图状态过滤候选（REQ-v0.9.2 N4 · `renderTasksPick` 用）：值域 = 主链 6 态 + 异常 3 态 +
 * `blocked`（良性终态，§4 口径）。
 * （原「需求列表页过滤」共用常量随列表页退役收编于此，REQ-2026-09-26-04 Q3。）
 */
const TASK_FILTER_STATES = [
  "waiting_approval",
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
 * 详情页「阶段产出」区（REQ-v0.9.2 按需求归约：与旧「产出登记」合并为单区）：
 * 数据源 = 本需求 `decisions` 逐条 —— 含 `doc/…/*.md` 路径的条目即产出条目（**单链接、链接文字 = 剥去
 * `doc/{版本}/` 后的文件名**，复用 `GET /features/:id/docs` 守卫端点；版本取当前值，登记路径不进链接）；
 * 其余条目原样保留（登记即产出记录，不再两处重复）。
 * 无含 doc 路径的条目 ⇒ 「无（本需求未登记产出）」+ 口径一句；不回落版本目录清单（用户裁决）。
 * `currentVersion` 传入时（排期表单在本页渲染）区首追加 M6 改版失联警示行，不传 ⇒ 行为不变。
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
<p class="hint">数据 = 本需求 Feature Context 的 <code>decisions</code>（宿主 agent 经 <code>advance</code> 逐轮 append）：条目 = <code>decisions</code> 登记的文档文件名（剥去 <code>doc/{版本}/</code> 前缀作链接文字，登记路径不再展示），含 <code>doc/…&#47;*.md</code> 路径的条目即产出条目，打开经板读文档面守卫（版本白名单 / 根内收 / 仅 .md，版本取当前排期值）。链接不带 src ⇒ 服务端先查主仓、未命中自动回落组织工作区（实际来源在文档页头标注）。</p>
${warning}${body}`;
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
          : `<p class="hint warn"><code>board_orgs_dir_not_configured</code> 组织目录根（orgsDir）未装配：提需求本身不受影响，但触发一轮 / 起宿主桥将结构化 503，请配置 config.json 的 orgsDir 后重启板。</p>`;
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
 * **新增版本弹窗骨架**（v0.9.4 增补八 §9.3 · REQ-2026-09-28-02）：`/schedule` 页注入的
 * `<dialog id="new-version-dialog">`，与 {@link renderNewRequirementDialog} **同款结构**
 * （`dialog.fd` + 首枚「关闭」按钮 + `.fd-body` 内表单）；开/关与 fetch 提交由
 * `layout.NEW_REQUIREMENT_DIALOG_SCRIPT` 的 `wire()` 承载（闭集六元不扩、CSP 不动）。
 * 表单 = SSR 原生可提交（无 JS 回落整页 PRG）：`POST /versions` 隐藏字段 `action=create`
 * 分流 —— **服务端写口与闸零改动**；semver 收口（`x.y.z`）执法在服务端，字段仍可输入。
 * 复用 `dialog.fd` 样式类 ⇒ 4xx 错误卡叠加规则（`dialog.fd > .err-ov-card`）同款生效。
 * 骨架只嵌字面量（placeholder 文案，无用户数据）⇒ 无注入面。
 * **仅全局排期页渲染**：入口按钮 `#new-version-open` 只在全局页头（空间页无 ⇒ 弹窗不渲染）。
 */
export function renderNewVersionDialog(): string {
  return `<dialog class="fd" id="new-version-dialog">
<button type="button" id="new-version-close">关闭</button>
<div class="fd-body"><h2>新版本</h2>
<p class="hint">在版本台账（<code>.data/versions.json</code>）登记一个空版本 ⇒ 看板出现新列；初态 <code>notstart</code>，首张卡过确认门后自动转 <code>active</code>。</p>
<form method="post" action="/versions" class="w" data-submit="已提交，建版本中…" data-ov="1">
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
    : `<p class="hint">已发版版本（版本台账标记 <code>released</code> = 列头标 🔒 已发版）不可改入 / 移出（服务端 409 执法）；字段仍可输入，执法在服务端。</p>`;
  return `<h2>排期</h2>
<p class="hint">排期写 = 板唯一放开的登记字段写（经 <code>feature-schedule.ts</code> 走 advance「<code>to</code> = 当前态 ∧ 仅 <code>version</code>」特例，<b>不写状态机迁移</b>）；留空提交 = 删除排期（回需求池）。改版前先看「阶段产出」区的失联警示。</p>
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

export function renderFeatureDetail(
  detail: FeatureDetailView,
  trace: FeatureTraceView | null,
  traceError: string | null,
  nowMs: number,
  withScheduleForm: boolean = false,
  releasedVersions: readonly string[] = [],
): string {
  const f = detail.feature;
  const d = deriveDisplayStage(f.state, f.stage);
  const head = `<h2>${escapeHtml(f.title === "" ? f.featureId : f.title)} <span class="muted mono" title="${escapeHtml(f.featureId)}">${escapeHtml(f.featureId)}</span>${renderParentFeatureBadge(f.parentFeatureId)}</h2>
<table><tbody>
<tr><th>引擎态</th><td>${escapeHtml(label(FEATURE_STATE_LABELS, f.state))}</td><th>阶段（显示）</th><td>${escapeHtml(d.label)} <span class="muted">${d.basis === "derived" ? "派生" : "登记"}</span></td></tr>
<tr><th>阶段（登记）</th><td>${escapeHtml(f.stage ?? "—")}</td><th>版本</th><td>${escapeHtml(f.version === null || f.version === "" ? "—" : f.version)}</td></tr>
<tr><th>审批门（approval）</th><td>${escapeHtml(f.approval ?? "—")}</td><th>归属组</th><td>${escapeHtml(f.ownerGroup ?? "—")}</td></tr>
<tr><th>创建</th><td>${escapeHtml(stamp(f.createdAt))}</td><th>更新</th><td>${escapeHtml(stamp(f.updatedAt))}</td></tr>
</tbody></table>`;

  const taskRows = detail.tasks.map((t) => {
    return (
      "<tr>" +
      `<td class="mono">${escapeHtml(shortId(t.taskId))}</td>` +
      `<td>${escapeHtml(t.projectId)}</td>` +
      `<td>${escapeHtml(label(TASK_STATE_LABELS, t.state))}</td>` +
      `<td>${escapeHtml(t.lane)}</td>` +
      `<td>${escapeHtml(t.failureKind ?? "—")}</td>` +
      `<td>${t.retryCount === null ? "—" : t.retryCount}</td>` +
      `<td>${escapeHtml(t.dependencies === null ? "—" : t.dependencies.map(shortId).join(", "))}</td>` +
      `<td>${escapeHtml(stamp(t.createdAt))}</td>` +
      `<td>${escapeHtml(stamp(t.startedAt))}</td>` +
      `<td>${escapeHtml(stamp(t.finishedAt))}</td>` +
      `<td>${escapeHtml(formatDurationBetween(t.queuedAt, t.claimedAt))}</td>` +
      `<td>${escapeHtml(formatDurationBetween(t.startedAt, t.finishedAt))}</td>` +
      "</tr>"
    );
  });
  const tasks = `<h2>任务（${detail.tasks.length}）</h2>
<table><thead><tr><th>taskId</th><th>项目</th><th>状态</th><th>档</th><th>失败类</th><th>重派</th><th>依赖</th><th>创建</th><th>开始</th><th>结束</th><th>排队时长</th><th>执行时长</th></tr></thead>
<tbody>${taskRows.length === 0 ? emptyRow(12, "（无任务）") : taskRows.join("")}</tbody></table>`;
  let traceHtml: string;
  if (trace === null) {
    traceHtml = `<h2>进展三面（在等谁 / 位次 / 为什么没跑）</h2><p class="hint err">trace 读取失败：${escapeHtml(traceError ?? "未知错误")}（桥 trace 接口不可达时如实显示，不静默）</p>`;
  } else {
    const rows = trace.nodes.map((n) => {
      const w = traceWaitDisplay(n, nowMs);
      return (
        "<tr>" +
        `<td class="mono">${escapeHtml(shortId(n.taskId))}</td>` +
        `<td>${escapeHtml(n.projectId)}</td>` +
        `<td>${escapeHtml(label(TASK_STATE_LABELS, n.state))}</td>` +
        `<td>${escapeHtml(n.lane)}</td>` +
        `<td class="mono">${escapeHtml(w.waitReason)}</td>` +
        `<td>${escapeHtml(w.writeGate)}</td>` +
        `<td>${escapeHtml(w.readOccupants)}</td>` +
        `<td>${escapeHtml(w.position)}</td>` +
        `<td>${escapeHtml(w.waited)} <span class="muted">自 ${escapeHtml(w.waitedSince)}</span></td>` +
        `<td>${escapeHtml(w.blockedOn)}</td>` +
        "</tr>"
      );
    });
    traceHtml = `<h2>进展三面（在等谁 / 位次 / 为什么没跑）</h2>
<p class="hint">数据 = <code>GET /api/features/:id/trace</code> 原样复用；<code>waitReason</code> 为八值闭集，原样显示。</p>
<table><thead><tr><th>taskId</th><th>项目</th><th>状态</th><th>档</th><th>waitReason</th><th>写门（projectBusy）</th><th>读档占位（readOccupants）</th><th>位次</th><th>已等待（只取 waitedSince）</th><th>在等谁</th></tr></thead>
<tbody>${rows.length === 0 ? emptyRow(10, "（无非终态节点）") : rows.join("")}</tbody></table>`;
  }
  const stageOutputsSection = renderStageOutputs(f.featureId, f.decisions, f.version ?? null);
  // M6：排期表单上详情页（GET 面）；缺省不渲染 ⇒ 未接线的调用方保持旧行为。
  const scheduleForm = withScheduleForm ? renderScheduleForm(f.featureId, f.version, releasedVersions) : "";
  return `${head}\n${stageOutputsSection}\n${tasks}\n${traceHtml}\n${scheduleForm}`;
}

// ---------------------------------------------------------------------------
// 任务视图（复用 GET /api/tasks，project 必填）
// ---------------------------------------------------------------------------

export function renderTasksPick(projects: ProjectsView | null, pickError: string | null, org: string | null = null): string {
  // D 档/BD6：空间内（org 非 null）选单与表单落 `/org/<名>/tasks`（链接仍指全局深链口径）
  const tasksBase = org === null ? "/tasks" : orgSpaceLink(org, "tasks");
  const list =
    projects !== null
      ? projects.machines
          .flatMap((m) => m.projects.map((p) => p.projectId))
          .sort()
          .map((pid) => `<li><a class="fl" href="${escapeHtml(tasksBase)}?project=${encodeURIComponent(pid)}">${escapeHtml(pid)}</a></li>`)
          .join("")
      : "";
  const hint =
    pickError !== null
      ? `<p class="hint err">项目清单读取失败：${escapeHtml(pickError)}（不影响手工输入项目名查询）</p>`
      : "";
  const stateSelect = `<option value="">全部</option>${TASK_FILTER_STATES.map(
    (s) => `<option value="${escapeHtml(s)}">${escapeHtml(label(TASK_STATE_LABELS, s))}</option>`,
  ).join("")}`;
  return `<h2>任务视图</h2>
${hint}
<p class="hint">桥 <code>GET /api/tasks</code> 以 <code>project</code> 为必填参数 ⇒ 先选/输项目；<code>state</code>/<code>limit</code> 经桥服务端过滤（REQ-v0.9.2 N4）。</p>
<form method="get" action="${escapeHtml(tasksBase)}">
<label>projectId <input name="project" placeholder="项目 id"></label>
<label>状态 <select name="state">${stateSelect}</select></label>
<label>limit <input name="limit" type="number" min="1" step="1" placeholder="不限"></label>
<button type="submit">查询</button>
</form>
${list === "" ? "" : `<p class="hint">当前快照中的项目：</p><ul>${list}</ul>`}`;
}

export function renderTasks(view: ProjectTasksView, filter: { state?: string; limit?: number } = {}, org: string | null = null): string {
  const rows = view.tasks.map((t) => {
    return (
      "<tr>" +
      `<td class="mono">${escapeHtml(shortId(t.taskId))}</td>` +
      `<td class="mono">${escapeHtml(shortId(t.contextId ?? ""))}</td>` +
      `<td>${escapeHtml(label(TASK_STATE_LABELS, t.state))}</td>` +
      `<td>${t.stale ? '<span class="warn">stale</span>' : "—"}</td>` +
      `<td>${escapeHtml(stamp(t.updatedAt))}</td>` +
      `<td>${escapeHtml(t.prompt === null ? "—" : truncate(t.prompt, 80))}</td>` +
      "</tr>"
    );
  });
  const reach = view.reachable
    ? ""
    : `<p class="hint err">项目 ${escapeHtml(view.projectId)} 当前不可达${view.notice !== null ? `：${escapeHtml(view.notice)}` : ""}</p>`;
  const filterNote =
    filter.state === undefined && filter.limit === undefined
      ? ""
      : ` · 过滤：<span class="mono">${escapeHtml(
          [filter.state === undefined ? "" : `state=${filter.state}`, filter.limit === undefined ? "" : `limit=${filter.limit}`]
            .filter((s) => s !== "")
            .join(" · "),
        )}</span> <span class="muted">（桥服务端过滤）</span>`;
  return `<h2>任务 · 项目 <span class="mono">${escapeHtml(view.projectId)}</span></h2>
<p class="hint"><a class="fl" href="${escapeHtml(org === null ? "/tasks" : orgSpaceLink(org, "tasks"))}">换项目</a> · 共 ${view.tasks.length} 条${filterNote}</p>
${reach}
<table><thead><tr><th>taskId</th><th>contextId</th><th>状态</th><th>stale</th><th>更新</th><th>prompt 摘要</th></tr></thead>
<tbody>${rows.length === 0 ? emptyRow(6, "（无任务）") : rows.join("")}</tbody></table>
<p class="hint">${escapeHtml(INFLIGHT_CALIBRATION_NOTE)}</p>`;
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
   * `null` = 查询器未装配 ⇒ 标「未查询」；`ok=false` = 3300 宕机 / 配置坏 ⇒ 成员区**灰化**，
   * **本页其余照常渲染**（宕机不得阻断管理页）。与逐组 `a2a_projects`（运行态）**并存、不替代**。
   */
  groupsOutcome: OrgGroupsOutcome | null;
}

function renderOrgFeaturesTable(features: readonly FeatureListItem[]): string {
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
  return `<h3>需求（${String(features.length)}）</h3>
<table><thead><tr><th>需求</th><th>引擎态</th><th>阶段（显示）</th><th>版本</th><th>审批门</th><th>更新</th></tr></thead>
<tbody>${rows.length === 0 ? emptyRow(6, "（该组织暂无需求）") : rows.join("")}</tbody></table>`;
}

function renderOrgProjectsTable(outcome: OrgProjectsOutcome | null): string {
  if (outcome === null) {
    return `<h3>项目</h3><p class="hint muted"><b>未查询</b>：项目查询器未装配 ⇒ 本区不查询任何组织的项目（不编造「无项目」）。</p>`;
  }
  if (!outcome.ok) {
    return `<h3>项目</h3><p class="hint warn">不可达（<code>${escapeHtml(outcome.code)}</code>）：${escapeHtml(outcome.error)} —— 项目清单未知（灰化不炸页；刷新本页重查）。</p>`;
  }
  const rows = outcome.projects.map((p) => {
    return (
      "<tr" + (p.machineError !== null ? ' class="warn"' : "") + ">" +
      `<td>${escapeHtml(p.machineId)}</td>` +
      `<td><a class="fl" href="/tasks?project=${encodeURIComponent(p.projectId)}">${escapeHtml(p.projectId)}</a></td>` +
      `<td>${escapeHtml(p.agentKind ?? "—")}</td>` +
      `<td>${p.a2aPort === null ? "—" : String(p.a2aPort)}</td>` +
      `<td>${escapeHtml(p.status ?? "—")}</td>` +
      `<td>${escapeHtml(p.startedAt ?? "—")}</td>` +
      `<td>${escapeHtml(p.machineError ?? "—")}</td>` +
      "</tr>"
    );
  });
  return `<h3>项目（${String(outcome.projects.length)}）</h3>
<table><thead><tr><th>machineId</th><th>projectId</th><th>agentKind</th><th>a2aPort</th><th>status</th><th>startedAt</th><th>机器 error</th></tr></thead>
<tbody>${rows.length === 0 ? emptyRow(7, "（该组织快照中无项目）") : rows.join("")}</tbody></table>`;
}

/**
 * `POST /orgs` 建组织表单（v0.9.4 A5/BD2 · 纯 SSR，零新脚本常量）：
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
  return `<h3>建组织</h3>
<p class="hint">写板侧组织台账 <code>.data/orgs.json</code>（纯新建 · <b>不触桥、不写状态机、不写 machine 配置</b>）；名称闭集 = 中文 / 字母（Latin）/ 数字 / <code>-</code> <code>_</code> <code>.</code>，禁空格与 <code>#</code> <code>?</code> <code>%</code> <code>/</code>（服务端 <code>validateOrgName</code> 单一事实源）；与<b>磁盘一级目录 / 在用台账 / 需求归属</b>三源重名 ⇒ 409 拒绝（<b>已停用</b>名不判重，同名提交即复活）。</p>
<form method="post" action="/orgs" class="w" data-submit="已提交，建组织中…" data-ov="1">
<label>组织名 *<input name="org" required placeholder="如 flow-team"></label>
<button type="submit">建组织</button>
</form>`;
}

/**
 * `POST /orgs` 建组织**弹窗骨架**（v0.9.4 增补六 §9.5 · 纯 SSR，零新脚本常量）：
 * 门户页 `/` 页头「＋ 建组织」按钮（{@link renderOrgPortal} 宿主页的 `headerActions`，**无 JS 时服务端
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
 * 逐组织的**成员写表单**（v0.9.4 B 档 · BD4 · 纯 SSR，零新脚本常量）：增 / 删各一枚，
 * 都提交到**同一条**路由 `POST /orgs/{org}/members`，靠隐藏字段 <code>action</code> 分流
 * （与 A 档 `POST /orgs` 的 create/disable 同款口径）。落点是 **orch 的 `projectGroup` 段**
 * （经板第三个 MCP 写封装 `group-admin.ts` → O1 受控写工具），**不是板台账、不是 machine 配置**。
 * `machineId` 是否合法**不在板上判**（判据唯一在桥的 dry-run，二处立规则必漂移）。
 * **增补二 §9.1**：删成员的「末位不可删」由板写前闸业务化拒绝（`board_last_member_remove`）；
 * `data-ov="1"` ⇒ 两枚表单浮层报错不跳页（无 JS = 原生 PRG 不劣化）。
 */
function renderMemberForms(org: string): string {
  const action = escapeHtml(`/orgs/${encodeURIComponent(org)}/members`);
  const pairFields = `<label>machineId *<input name="machineId" required placeholder="如 win-a"></label>
<label>projectId *<input name="projectId" required placeholder="如 board"></label>`;
  return `<h3>成员（项目组台账）</h3>
<p class="hint">写 <b>orch <code>config.json</code> 的 <code>projectGroup</code> 段</b>（唯一通路 = 受控写工具 <code>${CONFIG_WRITE_GROUP_TOOL}</code>，<b>板不直写该文件、桥不可达也不降级本地直写</b>）；成员项 = <code>{machineId, projectId}</code> 对（可参考本页下方项目表）。写后<b>热生效</b>（无需重启桥）；<b>新增</b> project 若目标机尚未登记，仍须<b>人工重启该机 Launcher</b>。</p>
<form method="post" action="${action}" class="w" data-submit="已提交，加成员中…" data-ov="1">
<input type="hidden" name="action" value="add">
${pairFields}
<button type="submit">加成员</button>
</form>
<form method="post" action="${action}" class="w" data-submit="已提交，删成员中…" data-ov="1">
<input type="hidden" name="action" value="remove">
${pairFields}
<button type="submit">删成员</button>
</form>`;
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
 * 成员写成功卡（v0.9.4 B 档 · BD4）：表单档成功回执**有内容**（备份路径 + 驻留引导），
 * 故出整页而非 303（口径同 REQ-v0.9.2 N7「有内容回执的档仍出整页」）。
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
<p>组织 <code>${escapeHtml(input.org)}</code>：成员 <code>${escapeHtml(input.machineId)}/${escapeHtml(input.projectId)}</code> 已${verb}。<b>${input.changed ? "已写入" : "零写入（幂等：该成员本不在组内）"}</b>${input.retriedOnce ? " · 曾遇并发冲突，已自动重读重试一次" : ""}</p>
${rows}
<p class="hint">备份：<code>${escapeHtml(input.backedUpTo ?? "—（本次未产生写入，无备份文件）")}</code>（桥写前自动备份，板只展示不解析）</p>
${input.action === "add" ? `<p class="hint warn">${escapeHtml(MEMBER_ADD_RESIDENCY_NOTE)}</p>` : ""}`;
}

/**
 * 本组的**声明态成员清单**（v0.9.4 C 档/BD5 数据 + §9-c 承接位）：取自 3300 全组枚举
 * `GET <3300>/api/groups` 的只读投影（**声明面** = orch `config.json` 的 `projectGroup` 段，
 * 与运行态逐组 `a2a_projects` 语义不同、刻意并存不替代）。
 * 四档如实降级：查询器未装配 ⇒「未查询」；3300 宕机 / 配置坏 ⇒「组数据不可用」整块灰化
 * （**不阻断本页其余渲染**）；声明面无该组 ⇒「未声明」（盘 / 台账 / 需求归属源可先于 orch 组存在，不是错误）；
 * `warnings[]` 只作小字呈现，**不参与任何判定逻辑**。
 */
function renderOrgMemberSection(org: string, outcome: OrgGroupsOutcome | null): string {
  const head = `<h3>成员（声明态 · <code>GET /api/groups</code> 该组投影）</h3>`;
  if (outcome === null) {
    return `${head}<p class="hint muted">全组枚举查询器未装配 ⇒ 本区不呈现声明数据（不编造「无成员」）。</p>`;
  }
  if (!outcome.ok) {
    return `${head}<p class="hint warn muted"><b>组数据不可用</b>（<code>${escapeHtml(outcome.code)}</code>）：${escapeHtml(outcome.error)} —— 3300 聚合面查询失败 ⇒ 本区整块灰化，<b>本页其余部分照常渲染</b>（刷新本页重查）。</p>`;
  }
  const row = outcome.groups.find((g) => g.name === org);
  if (row === undefined) {
    return `${head}<p class="hint muted"><b>未声明</b>：orch 的 <code>projectGroup</code> 段尚无名为 <code>${escapeHtml(org)}</code> 的组 —— 盘目录 / 板台账 / 需求归属可以先于组存在，不是错误；下方「加成员」首次写入即建组带首成员（一次写入）。</p>`;
  }
  const rows = row.members.map((m) => {
    return (
      "<tr>" +
      `<td>${escapeHtml(m.machineId)}</td>` +
      `<td>${escapeHtml(m.projectId)}</td>` +
      "</tr>"
    );
  });
  const observed = outcome.observedAt === null ? "" : ` <span class="muted">（观测时刻 ${escapeHtml(outcome.observedAt)}）</span>`;
  const warnings =
    outcome.warnings.length === 0
      ? ""
      : `<p class="hint muted">配置瑕疵文案（桥 warn-once 快照，<b>仅供呈现、不参与任何判定</b>）：</p><ul class="hint muted">${outcome.warnings
          .map((w) => `<li>${escapeHtml(w)}</li>`)
          .join("")}</ul>`;
  return `${head}
${observed}
<p class="hint">该组声明成员 ${String(row.memberCount)} 项。</p>
<table><thead><tr><th>machineId</th><th>projectId</th></tr></thead>
<tbody>${rows.length === 0 ? emptyRow(2, "（无成员：该组已声明但成员清单为空）") : rows.join("")}</tbody></table>
${warnings}`;
}

/**
 * `GET /org/<名>/manage` **空间内管理页**（v0.9.4 §9-c · REQ-2026-09-27-06 N3）：
 * `/orgs` 组织管理页退役后，逐组织的管理职能落到该组织空间内（复用归一层上下文：
 * 组织不存在 404 / **已停用 410** 同 `org-space.resolveOrgSpaceRoute` 口径，本页只在「在用」组织上渲染）。
 * 页内四块（**全部复用既有写口，服务端零改动**）：
 * - **成员区**（声明态清单，取自 3300 全组枚举）+ 增 / 删表单 → `POST /orgs/{org}/members`（隐藏 `action`）；
 * - **停用操作** → `POST /orgs`（隐藏 `action=disable`，同写口分流；台账标记不物理删目录，恢复 = 同名重建）；
 * - **需求表** = 归一层已持有的该组需求投影（零新触桥面）；
 * - **项目表** = 逐组只读 `a2a_projects`（运行态，与声明态成员并存）。
 * **纯 SSR**：不挂任何可执行内联脚本（内联脚本闭集六元不动，纪律锚 N3-⑦/⑧）。
 */
export function renderOrgSpaceManagePage(input: OrgSpaceManageInput): string {
  return `<h2>管理 · ${escapeHtml(input.org)}</h2>
<p class="hint">本页 = <b>${escapeHtml(input.org)}</b> 组织空间内的管理面（§9-c：<code>/orgs</code> 页退役，管理职能随组织走）。写口全部复用既有端点（<code>POST /orgs/{org}/members</code> 成员增删 · <code>POST /orgs</code> 停用），服务端零改动。建组织在<b>组织门户 <code>/</code></b>。</p>
${renderOrgMemberSection(input.org, input.groupsOutcome)}
${renderMemberForms(input.org)}
<h3>停用本组织</h3>
<p class="hint">「停用」= 板台账标记 <b>+ 同步摘除该项目组在编排配置中的成员登记</b>（项目不再归属任何组织、可被其它组织接管；<b>不物理删目录、不隐式连带停桥</b>）：名下仍有活跃宿主桥 ⇒ <b>409 先停桥</b>（须先逐桥 stop）；成员登记摘除失败 ⇒ 停用整体失败（不留半态）。停用后本空间不再可达（410）、不可提新需求、不再起桥；恢复 = 到门户用<b>同名</b>再建一次（复活，零迁移）。</p>
${renderDisableOrgForm(input.org)}
${renderOrgFeaturesTable(input.features)}
${renderOrgProjectsTable(input.projectsOutcome)}`;
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
}

/**
 * 门户卡数据（纯函数）：给定组织清单 × 需求列表 ⇒ 逐组织计数。
 * 归属匹配 = `ownerGroup` trim 后精确相等（口径同 `orgs-view.featuresOfOrg`）；
 * 清单外的需求（无归属 / 盘遗留组织）不进任何卡，不丢弃判据也不反查扩清单。
 */
export function buildOrgPortalCards(
  orgs: readonly string[],
  features: readonly FeatureListItem[],
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
    return { org, scheduled: cell?.scheduled ?? 0, features: cell?.total ?? 0, tasks: cell?.tasks ?? null };
  });
}

/**
 * `GET /` 组织门户（§9-b · 用户实测后推翻 B 案的首页形态）：
 * 一行一组织的卡（复用看板 `.kanban` / `.kcol` 样式，无新 CSS 类）+ 计数摘要 +
 * 点卡头进空间 `/org/<名>/`；建组织 = **页头按钮 + 弹窗**（§9.5）：本视图渲染 `#new-org-inline`
 * 内联回退表单（无 JS 用）+ {@link renderCreateOrgDialog} 骨架（JS 用），按钮由宿主页 `headerActions` 给。
 * **零外源脚本**：本视图自身不挂可执行内联脚本；页头按钮的开/关由**已泛化**的
 * `NEW_REQUIREMENT_DIALOG_SCRIPT`（页面脚本闭集**六元**内既有常量，非新增第七枚）随宿主页注入承载。
 */
export function renderOrgPortal(cards: readonly OrgPortalCard[], orgsStatus?: OrgsDirStatus | null): string {
  const orgsLine =
    cards.length === 0
      ? `<p class="hint">（暂无组织：台账与需求归属两源皆空 —— 先用下方「建组织」建一个，或直接到<code>/schedule</code> 提未排期需求）</p>`
      : `<div class="kanban" id="org-portal">
${cards
  .map(
    (c) => `<div class="kcol">
<h3><a class="fl" href="${escapeHtml(orgSpaceLink(c.org))}">${escapeHtml(c.org)}</a></h3>
<p class="kmeta">排期中 ${String(c.scheduled)} · 需求 ${String(c.features)} · 任务 ${c.tasks === null ? "—" : String(c.tasks)}</p>
</div>`,
  )
  .join("\n")}
</div>`;
  const statusLine =
    orgsStatus === undefined || orgsStatus === null
      ? ""
      : orgsStatus.tier === "ready"
        ? `<p class="hint">组织目录根（orgsDir）<b>就绪</b>：<code>${escapeHtml(orgsStatus.orgsDir)}</code></p>`
        : orgsStatus.tier === "problem"
          ? `<p class="hint err"><code>${escapeHtml(orgsStatus.code)}</code> 组织目录根已配置但不可用：${escapeHtml(orgsStatus.message)}</p>`
          : `<p class="hint warn"><code>board_orgs_dir_not_configured</code> 组织目录根（orgsDir）未装配：门户照常展示，但<b>建组织 / 触发一轮 / 起宿主桥</b>将结构化 503，请配置 config.json 的 orgsDir 后重启板。</p>`;
  return `<h2>组织门户</h2>
<p class="hint">一页一入口：点组织名进<b>该组织的空间</b>（<code>/org/&lt;名&gt;/</code> 排期 / 需求 / 任务）；全局排期看板在 <code>/schedule</code>（提需求与拖拽排期都在那一页）。口径 = <b>台账未停用 ∪ 需求归属（ownerGroup）</b>（与顶栏切换器同一纯函数 <code>portalOrgNames</code>）—— 盘遗留目录与外机组不进门户。计数为需求列表 <code>getFeatures()</code> 板内存派生（排期中 = <code>version</code> 非空 · 需求 = 名下总数 · 任务 = 各需求 <code>taskCount</code> 之和，「—」= 列表未带任务数），无新桥接口、零缓存。</p>
${statusLine}
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
 * 需求列表 → 版本列（纯函数）：未排期（`trim() === ""` 单一判据，含 null）直接滤除；
 * 列序 = `version-order.ts` 比较器（semver 数值序、非 `x.y.z` 字典序垫底）；
 * 列内保持入参顺序（不做列内二次排序 —— 抖动排序键会让卡片跳位）。
 *
 * **并集（REQ-2026-09-27-05 §2.2 N2）**：列 = **台账条目 ∪ 需求卡派生** ——
 * 台账独有版本（尚无卡的「空列」= 新版本入口的落点）与卡独有版本（台账无登记的**历史脏列**）
 * **都保留显示**；同名去重并作一列（交集）。本函数**纯读、零写**（台账只贡献版本名、不携状态，
 * `notstart → active` 惰性转换在渲染前由 `server.ts` 的 `syncAutoVersionTransitions` 完成）⇒ 读面不突变。
 */
export function groupFeaturesByVersion(
  features: readonly FeatureListItem[],
  ledgerVersions: readonly string[] = [],
): ScheduleColumn[] {
  const byVersion = new Map<string, FeatureListItem[]>();
  for (const f of features) {
    if (isUnscheduled(f.version)) continue;
    const v = normalizeVersion(f.version);
    const bucket = byVersion.get(v);
    if (bucket === undefined) byVersion.set(v, [f]);
    else bucket.push(f);
  }
  for (const raw of ledgerVersions) {
    const v = normalizeVersion(raw);
    if (v === "" || byVersion.has(v)) continue; // 空串忽略；交集已在卡派生侧建桶
    byVersion.set(v, []); // 台账独有 ⇒ 空列占位（此版本已建、尚无卡）
  }
  return [...byVersion.entries()]
    .sort(([a], [b]) => compareVersionOrder(a, b))
    .map(([version, list]) => ({ version, features: list }));
}

/**
 * 看板的一张需求卡；`withRequirement` ⇒ 池卡追加需求原文（截断 120 字 + 转义，标题已链详情页）。
 * **v0.9.3 B-T5 拖拽闸**：`stage=需求分析 ∧ approval=未发起`（{@link deriveScheduleGateOpen}
 * 单一规则源，与服务端 409 同判据）⇒ `draggable="true"` + `data-feature`/`data-version`
 * （供 {@link DRAG_SCHEDULE_SCRIPT} 拖拽提交）；闸锁 ⇒ 置灰 + 紧凑标记「🔒 排期已锁」
 * （完整说明只在 409 错误卡呈现），**卡片仍可点击**（拖不动 ≠ 打不开）。detail 页/池卡同用本函数，闸口径一致。
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
  // 降噪（v0.9.3 增补 ①）：卡面只留紧凑锁定标记；完整说明（为何锁 / 板上解不了 / cancel 去处）
  // 只在拖拽/改版被拒的 409 错误卡呈现（server.ts `board_schedule_state_locked` 文案）。
  const lockedLine = open ? "" : `<span class="kbadge draglock">🔒 排期已锁</span>`;
  return `<div class="kcard${lockedClass}"${dragAttrs}>
<span class="kbadge">${escapeHtml(label(FEATURE_STATE_LABELS, f.state))}</span>
${renderParentFeatureBadge(f.parentFeatureId)}
${featureLink(f.featureId, f.title === "" ? f.featureId : f.title)} <span class="muted mono" title="${escapeHtml(f.featureId)}">${escapeHtml(shortId(f.featureId))}</span>
<p class="kmeta">阶段：${escapeHtml(d.label)}（${d.basis === "derived" ? "派生" : "登记"}） · 审批门：${escapeHtml(f.approval ?? "—")} · 任务数：${f.taskCount === null ? "—" : f.taskCount}</p>
${lockedLine}${reqLine}</div>`;
}

/**
 * 未排期需求 → 池序（纯函数）：判据单一 `trim(version) === ""`；
 * 排序不依赖 orch 列表序（改排期会前进 `updated_at`、列表序可变），池序见 `version-order.ts`。
 */
export function selectRequirementPool(features: readonly FeatureListItem[]): FeatureListItem[] {
  return sortPoolEntries(features.filter((f) => isUnscheduled(f.version)));
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
 */
export function renderVersionBadge(
  version: string,
  features: readonly FeatureListItem[],
  releasedVersions: readonly string[],
  ledger: VersionsLedger | null = null,
): string {
  const rec = ledger === null ? null : findVersionRecord(ledger, normalizeVersion(version));
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
 * 删除类操作不走脚本二次确认（内联脚本闭集六元不扩），由 `title` + `data-submit` 明确文案承担。
 */
function renderVersionDelete(
  version: string,
  features: readonly FeatureListItem[],
  ledger: VersionsLedger | null,
): string {
  const rec = ledger === null ? null : findVersionRecord(ledger, normalizeVersion(version));
  if (rec === null || rec.status === "released") return "";
  if (features.some((f) => isConfirmedCard(f.stage))) return "";
  return `<form method="post" action="/versions" class="inline vdel" data-submit="已提交，删除版本中…" data-ov="1" title="删除 ${escapeHtml(rec.version)}（仅未开始的版本可删；名下想法卡自动回需求池，已确认需求存在则服务端拒绝）">
<input type="hidden" name="action" value="${escapeHtml(VERSION_ACTION_REMOVE)}">
<input type="hidden" name="version" value="${escapeHtml(rec.version)}">
<button type="submit" aria-label="删除版本 ${escapeHtml(rec.version)}">×</button>
</form>`;
}

/**
 * `GET /schedule` 排期看板（纯函数）：版本列从左到右按 semver 数值序（M1 比较器），
 * 列头 = 版本号 + 状态徽标（N4 / N2：**台账三态** notstart=未开始 / active=进行中 / released=🔒；
 * 台账无该版回落**按卡片阶段派生**：有已确认卡=进行中 / 全想法卡或无卡=未开始 / 锁版=🔒，仅显示）+ 卡片数；
 * 未排期卡不占版本列，集中在末列「需求池」（池序 = 入参已排，见 {@link selectRequirementPool}）。
 * `columns` 由 {@link groupFeaturesByVersion} 给出（已含台账 ∪ 卡派生并集），`ledger` 供列头徽标取态。
 * **v0.9.4 增补十一 E1（§9.6）**：看板尾「新版本」拖拽**虚列已撤**（§2.6 形态作废）⇒ 创建版本
 * 的唯一入口 = 排期页页头「＋ 新版本」按钮 + `#new-version-dialog` 弹窗。
 * **v0.9.4 增补十一 E2（§9.6）**：删除入口由操作行的「删除版本」按钮**上框**为列头右上角
 * {@link renderVersionDelete} 的 ×（仅未开始版本出现）。
 * **v0.9.4 增补十一 E3（§9.6）**：列头**操作行整体撤除**（含「标记已发版」，其原属增补七 b 形态）
 * ⇒ 前台不再渲染任何 `setStatus` 入口；版本状态维护只留后台 `POST /versions` `setStatus` 直投
 * （数据纠错通道，**写口与迁移矩阵闸零改动**），真发版动作待「发版」按钮（另立需求 · 归 v0.9.5）。
 * **v0.9.4 增补十（§9.5）**：`released` 列**不再渲染任何操作入口**（去「重开」）⇒ 已发版列 UI =
 * 纯只读（仅 🔒 徽标）。
 */
export function renderSchedule(
  columns: readonly ScheduleColumn[],
  pool: readonly FeatureListItem[] = [],
  releasedVersions: readonly string[] = [],
  ledger: VersionsLedger | null = null,
): string {
  const cols = columns.map(
    (c) => `<div class="kcol" data-version="${escapeHtml(c.version)}">
<h3>${escapeHtml(c.version)}${renderVersionBadge(c.version, c.features, releasedVersions, ledger)} <span class="muted">(${String(c.features.length)})</span>${renderVersionDelete(c.version, c.features, ledger)}</h3>
${c.features.map((f) => renderScheduleCard(f)).join("\n")}
</div>`,
  );
  const poolCol = `<div class="kcol" data-version="">
<h3>需求池 <span class="muted">(${String(pool.length)})</span></h3>
${pool.length === 0 ? `<p class="hint">（无未排期需求）</p>` : pool.map((f) => renderScheduleCard(f, true)).join("\n")}
</div>`;
  const board = `<div class="kanban" id="schedule-board">${[...cols, poolCol].join("\n")}</div>`;
  const emptyNote =
    cols.length === 0
      ? `<p class="hint">（无已排期需求：全部需求 version 为空 ⇒ 都在需求池列）</p>`
      : "";
  // 详情浮层骨架（REQ-v0.9.2 增补 ④）：dialog 内容运行时由 FEATURE_DETAIL_OVERLAY_SCRIPT
  // 搬入详情页 <main> 节点，骨架恒空、不嵌任何用户数据；脚本随 renderPage 每页注入，
  // 无 dialog（其它页）或禁 JS 时不生效 ⇒ 卡片 <a> 即整页详情回退。
  return `<h2>排期看板</h2>
<p class="hint">数据 = 需求列表 <code>getFeatures()</code> 板内存按 <code>version</code> 归组（无新桥接口）；列从左到右 = semver 数值序（<code>v0.9.0 &lt; v0.10.0</code>），非 <code>x.y.z</code> 串字典序垫底；未排期（version 空）不进版本列，集中末列「需求池」（<code>createdAt</code> 降序）。状态作卡片徽标，不按状态分列；版本列头徽标（未开始 / 进行中 / 🔒 已发版）仅为显示提示，执法在服务端写口；台账未登记的版本按卡片阶段派生（名下有已确认卡=进行中，全是需求分析阶段的想法卡或无卡=未开始）；<b>删除版本</b> = 版本框头右上角的 <b>×</b>（<b>仅未开始的版本出现</b> = 名下没有任何已过需求确认门的卡；删除时其下<b>想法卡自动回需求池</b>，名下有已确认需求则服务端拒绝），提交到 <code>POST /versions</code>，被拒时浮层给出原因；<b>本版撤除「标记已发版」前台入口</b>（增补十一 E3）⇒ 版本列<b>不提供任何状态操作</b>：<b>已发版（🔒）列为纯只读</b>，进行中 / 未开始列同样无发版与重开按钮；版本状态维护走后台 <code>POST /versions</code> <code>setStatus</code> 直投（数据纠错通道，不经前台），真发版动作待「发版」按钮（另立需求 · 归 v0.9.5）；点卡片标题 = 浮层打开详情（禁 JS 时回退整页）。</p>
<p class="hint"><b>拖拽调整排期</b>（v0.9.3）：把卡片拖到目标版本列（或需求池列 = 清空排期）⇒ 提交排期写。仅「想法挪版」可拖（<code>stage=需求分析 ∧ approval=未发起</code>）；需求已确认的卡片置灰不可拖，服务端 409 执法（与已发版锁叠加）。改版时该需求已登记的 <code>doc/{旧版本}/</code> 产出文档会<b>自动搬迁</b>至 <code>doc/{新版本}/</code> 并追加登记（组织工作区文档不自动搬，回执列出交宿主手工）。</p>
${emptyNote}${board}
<dialog class="fd" id="feat-dialog">
<button type="button" id="feat-dialog-close">关闭</button>
<div class="fd-body"></div>
</dialog>`;
}

// ---------------------------------------------------------------------------
// 组织空间需求列表（v0.9.4 D 档 · BD6）—— 全局列表页（REQ-04 Q2 退役）不复活，
// 本视图只服务 `/org/<名>/features`；卡复用看板 kcard（renderScheduleCard），
// 点标题 = 全局深链 `/features/:id`（深链策略：不强制 303 回空间）
// ---------------------------------------------------------------------------

export function renderOrgSpaceFeaturesList(org: string, features: readonly FeatureListItem[]): string {
  const pool = sortPoolEntries(features);
  return `<h2>需求 · 组织空间 <span class="mono">${escapeHtml(org)}</span></h2>
<p class="hint">数据 = 需求列表 <code>getFeatures()</code> 按 <code>ownerGroup = ${escapeHtml(org)}</code> 板内存过滤（无新桥接口；trim 后精确匹配，null / 空白归属不进任何组织空间）。排序 = 未排期在前、其余 <code>createdAt</code> 降序（同需求池口径）；点标题 = 全局深链详情页。</p>
${pool.length === 0 ? `<p class="hint">（该组织名下暂无需求）</p>` : pool.map((f) => renderScheduleCard(f, true)).join("\n")}`;
}

// ---------------------------------------------------------------------------
// 触发一轮（BD8 · 宿主桥写控件；同源 POST，服务器端渲染）
// ---------------------------------------------------------------------------

/**
 * 需求详情页上的「触发一轮」表单：`POST /features/:id/turn`。
 * 表单只有一个提交按钮，无字段；澄清回答入口见 {@link renderAnswerForm}（BD9）。
 *
 * **收口轨 14 ②**：`busy`（该需求已有在飞 / 排队轮）⇒ 按钮渲染为 disabled + 原因
 * （规则源 = {@link deriveTurnBusyAffordance}；服务端另有 409 `board_turn_busy` 硬闸）。
 * **收口轨 17**：`featureState` 为引擎终态 ⇒ 同样 disabled + 原因，且**优先于**占用判据
 * （规则源 = {@link deriveTerminalFeatureAffordance}；服务端 409 `board_feature_terminal` 兜底直调）。
 */
export function renderTurnForm(
  featureId: string,
  busy: OccupantTurnView | null = null,
  featureState: string | null = null,
): string {
  const a =
    deriveTerminalFeatureAffordance(featureState) ??
    deriveTurnBusyAffordance(busy) ?? { enabled: true, note: "" };
  const button = a.enabled
    ? `<button type="submit">触发一轮</button>`
    : `<button type="submit" disabled aria-disabled="true">触发一轮</button>`;
  const reasonLine = a.enabled ? "" : `<p class="hint warn">${escapeHtml(a.note)}</p>`;
  return `<h2>宿主轮</h2>
<p class="hint">触发一轮 = 板按该需求的<b>归属组织</b>起（或复用）宿主桥，以<b>本需求 id 对应的 contextId</b> 发一轮提示词；板的推进只是「投消息给 agent」，<b>状态机仍由 agent 经 MCP 走</b>。同组织一时刻只跑一轮 ⇒ 被占用时本轮排队。</p>
${reasonLine}<form method="post" action="/features/${encodeURIComponent(featureId)}/turn" class="w" data-submit="已提交，本轮可能跑数分钟…">
${button}
</form>`;
}

/**
 * 需求详情页上的「人工确认」表单：`POST /features/:id/confirm`（BD9）。
 * **文案必须诚实**：按钮 = 给宿主 agent 的一轮<b>指令消息</b>，不是板上批准；
 * 放不放行由 agent 核对后判断（条件不满足它会拒绝放行并回报原因）。
 *
 * **BD18：按钮按 `approval` 条件化** —— 仅「待审批」可点；其余档位**禁用/灰态 + 一行原因**
 * （刻意不隐藏：看不到入口更迷惑）。规则源 = {@link deriveConfirmAffordance}。
 * **收口轨 14 ②：再叠加轮状态判据** —— 该需求已有在飞 / 排队轮时同样禁用（占用原因优先展示，
 * 因为它直接对应「点了会白点」）。端点语义不变（板不写状态机；禁用只是可用性层，
 * 服务端防重由 `board_turn_busy` 409 承担）。
 * **收口轨 17**：引擎终态判据**优先于**占用与 approval —— 终态需求两按钮一律 disabled + 原因
 * （规则源 = {@link deriveTerminalFeatureAffordance}，与引导行、服务端 409 同一判据）。
 */
export function renderConfirmForm(
  featureId: string,
  approval: string | null,
  busy: OccupantTurnView | null = null,
  featureState: string | null = null,
): string {
  const busyA = deriveTurnBusyAffordance(busy);
  const a: ConfirmAffordance =
    deriveTerminalFeatureAffordance(featureState) ?? busyA ?? deriveConfirmAffordance(approval);
  const button = a.enabled
    ? `<button type="submit">发送确认指令给 agent（由 agent 核对后决定是否放行）</button>`
    : `<button type="submit" disabled aria-disabled="true">发送确认指令给 agent（由 agent 核对后决定是否放行）</button>`;
  const stateLine = `<p class="hint${a.enabled ? "" : " warn"}">${escapeHtml(a.note)}</p>`;
  return `<h2>人工确认（给 agent 的指令）</h2>
${stateLine}
<p class="hint">点击 = 板把「用户已确认改造文档，请核对后执行放行（approve 语义）」作为<b>一轮消息投给该需求的宿主 agent</b>。<b>板不写引擎状态机，不存在「板上批准」</b>：agent 会先只读核对（改造文档是否落文件、审批门是否处于「待审批」），条件不满足（例如 approval 非「待审批」）时它<b>有权不放行</b>并在本轮结论里说明缺什么 —— 结果如实回显。同组织一时刻只跑一轮 ⇒ 被占用时排队。</p>
<form method="post" action="/features/${encodeURIComponent(featureId)}/confirm" class="w" data-submit="已提交，处理中…">
${button}
</form>`;
}

/**
 * 详情页「下一步」引导行（BD18 ②）：一行可操作提示，判序与文案规则见
 * {@link deriveNextStepHint}。放在正文按钮区之前，让用户先看到"该点哪个"。
 */
export function renderNextStepGuide(input: NextStepInput): string {
  return `<p class="hint nextstep">${escapeHtml(deriveNextStepHint(input))}</p>`;
}

/**
 * 详情页「下一步」引导区的**验收轨迹块**（REQ-v0.9.2 N8）：消费桥详情出参顶层 `acceptance`
 * （stages 段轨迹 + failures 账单 + stateCounts），计数与反推全归 orch，板侧只如实渲染。
 * `null` = 老桥 / 缺键 ⇒ 不渲染（详情页现行为）。
 *
 * 消费纪律：`state` 值域**非封闭**（存量库有退役值 analyzing/planning）⇒ 未命中标签表原样显示 + 灰化；
 * **末段** `leftAt === null` = 当前停留态（非缺字段）；同态重复段不合并。
 */
export function renderAcceptanceSection(acceptance: AcceptanceView | null | undefined): string {
  if (acceptance === null || acceptance === undefined) return "";
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
 * **不做自动刷新**（自动刷新不在页面脚本白名单闭集〔内联字面量常量 · N3 纪律钉〕内 + 与调度拍错拍）：文案直接写明刷新方式 = 重载本页。
 */
export function renderTurnProgress(view: TurnProgressView | null): string {
  if (view === null) return "";
  const where =
    view.state === "running"
      ? "在飞"
      : `排队中${view.position === null ? "" : ` · 队列第 ${String(view.position)} 位`}`;
  return `<p class="hint turn-progress">轮次进度：<b>第 ${String(view.round)} 轮 ${where}</b> · <span class="mono">${escapeHtml(view.turnId)}</span> · 刷新本页看最新（板不自动刷新）</p>`;
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
${q}<p class="hint">回答将<b>续接同一 contextId</b>（同一逻辑任务的澄清续推复用会话），提交后本轮结果如实回显。</p>
<form method="post" action="/features/${encodeURIComponent(featureId)}/answer" class="w" data-submit="已提交，回答续推中…">
<textarea name="answer" rows="4" cols="60" required placeholder="输入回答"></textarea>
<button type="submit">发送回答</button>
</form>`;
}

/**
 * 触发一轮的结果页正文（BD8）：**终态 + display 如实显示**。
 * `awaiting_answer` 由 BD4b 的 display 承载「需要你回答」（**不是失败**）；
 * `queued` 显示「排队中」并指向状态页（本节点不等排队轮的终态）。
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
  const summary =
    o.summary !== null ? `<h2>本轮产出（摘要）</h2><pre class="result">${escapeHtml(o.summary)}</pre>` : "";
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
  return `<h2>${escapeHtml(o.display === "" ? `触发一轮：${o.disposition}` : o.display)}</h2>
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
  const cfgLine = `<p class="hint">组织目录根 = <code>${escapeHtml(cfg.orgsDir ?? "（未配置 ⇒ 触发一轮将结构化 503）")}</code> · 默认组织 = <code>${escapeHtml(cfg.defaultOrg ?? "（未配置 ⇒ 组织名由提需求表单给出）")}</code> · 缺省 kind = <code>${escapeHtml(cfg.kind)}</code></p>`;
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
<p class="hint">当前进程未托管任何宿主桥 ⇒ 无状态可显示（本页面<b>不编造数据</b>）。到需求详情页「触发一轮」即会按组织起桥。</p>`;
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

// ---------------------------------------------------------------------------
// 口径脚注（每个数据页统一挂）
// ---------------------------------------------------------------------------

export const VIEW_NOTES: readonly string[] = [...B13_CALIBRATION_NOTES, PARALLELISM_NOTE];
