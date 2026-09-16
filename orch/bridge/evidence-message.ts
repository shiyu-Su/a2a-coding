/**
 * 取证节点消息模板（v0.4.1 §2.5「取证节点」）。
 *
 * 定位：`registerEvidenceNode` 的真实落点在 `bridge/index.ts`，而 `index.ts` 顶层**无条件**
 * 执行 `main()`（`index.ts:2289`）⇒ **不可被单测导入**（import 即起桥）。故把这段
 * 「worker 实际消费的契约」抽成本模块，使其可被纯函数级断言：
 * 角色标记 / 唯一 nonce / 自包含 / 只读 / 软校验口径 / 结构化输出格式。
 *
 * 与调度器的分工：本模块只产出**正文**；角色标记由 `scheduler.ts` 的
 * `markEvidenceMessage()` 包裹（`isEvidenceNode()` 据此识别），二者刻意不合并
 * —— 识别逻辑属调度器，消息内容属本模块。
 */

import type { EvidenceResult } from "./scheduler.js";

/** `buildEvidenceMessage` 入参 */
export interface EvidenceMessageInput {
  /** 目标项目（与失败节点同 project） */
  projectId: string;
  /**
   * 绝对 workspace 路径；**未知时传 `null`**。
   *
   * 桥侧**没有同步的 workspace 源**（`workspace` 只出现在异步 `GET /projects` 的
   * `ProjectStatus` 里，登记回调是同步的），而取证节点本身就跑在该 project 的 workspace 下
   * ⇒ 退化表述为「你的 cwd 即 workspace」。O4b 的 `/projects` 快照落地后可改传真值。
   */
  workspace: string | null;
  /** 归属 Feature（仅用于留痕） */
  featureId: string;
  /** 本需求 In-Scope 清单（取自 `FeatureRecord.plan`；可空） */
  plan: string | null;
  /** 唯一 nonce：取证节点据此在 `.a2a/tasks.json` 中**排除自身** */
  nonce: string;
  /** git 静默窗两次采样的间隔（秒） */
  sampleGapSec: number;
}

/** `tasks.json` 中视为「在飞」的状态串（与 wrapper 侧常量对齐；此处按字面引用） */
export const EVIDENCE_WORKING_STATES = ["TASK_STATE_WORKING", "TASK_STATE_SUBMITTED"] as const;

/** `tasks.json` 中**必须排除**的状态串：挂起态条目不会被清理，误算会导致恒判「有在飞」 */
export const EVIDENCE_EXCLUDED_STATES = ["TASK_STATE_INPUT_REQUIRED"] as const;

/** 结构化输出 artifact 建议名（下游 O4b 解析据此定位） */
export const EVIDENCE_ARTIFACT_NAME = "evidence.json";

/** 结构化输出的字段清单（与 §2.5 的 D / R / 门禁 / stable / 完成度+理由 一一对应） */
export const EVIDENCE_OUTPUT_FIELDS = [
  "stable",
  "d",
  "r",
  "gatesOk",
  "completion",
  "reason",
] as const;

/** 渲染 git 静默窗的两次采样命令（workspace 已知时带 `-C`，否则依赖 cwd） */
function gitCmd(workspace: string | null, args: string): string {
  return workspace === null ? `git ${args}` : `git -C ${workspace} ${args}`;
}

/**
 * 解析取证节点回报的结构化结论（§2.5；§2.3 ④ 的输入）。
 *
 * 容忍：```json 围栏、前后夹带说明文字、`data` part 被序列化后的整串。
 * **形状不合 / 解析失败一律返回 `null`** ⇒ 调度器按「无证据」交人（fail-safe：
 * 宁可让人拍板，也不拿一份半解析的证据去自动重试）。
 */
export function parseEvidenceResult(text: string): EvidenceResult | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const candidates: string[] = [trimmed];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const o = parsed as Record<string, unknown>;
    const stable = o["stable"];
    const gatesOk = o["gatesOk"];
    const d = o["d"];
    const r = o["r"];
    if (typeof stable !== "boolean" || typeof gatesOk !== "boolean") continue;
    if (!Array.isArray(d) || !Array.isArray(r)) continue;
    return {
      stable,
      gatesOk,
      d: d.filter((x): x is string => typeof x === "string"),
      r: r.filter((x): x is string => typeof x === "string"),
    };
  }
  return null;
}

/** 单个归档产物摘要的文本（text/data/url 三类 part 拼接；`raw` 跳过二进制） */
export function artifactSummaryText(artifact: {
  parts: ReadonlyArray<{ kind?: unknown } & Record<string, unknown>>;
}): string {
  const chunks: string[] = [];
  for (const part of artifact.parts) {
    if (part["kind"] === "text" && typeof part["text"] === "string") chunks.push(part["text"]);
    else if (part["kind"] === "data") chunks.push(renderUnknown(part["data"]));
    else if (part["kind"] === "url" && typeof part["url"] === "string") chunks.push(part["url"]);
  }
  return chunks.join("\n");
}

/** 渲染 unknown（data part 可能是对象） */
function renderUnknown(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * 构建取证节点消息正文（**不含**角色标记；调用方须用 `markEvidenceMessage` 包裹）。
 *
 * 三条硬约束（对应 §2.5）：
 * 1. **只读** —— 明确禁止任何写操作（权限是项目级、无法由 orch 强制，故只能 prompt 自律；
 *    这是已登记的已知缺口）；
 * 2. **自包含** —— nonce / project / workspace / In-Scope / 命令 / 软校验口径 / 输出格式全在消息内，
 *    新 `contextId` 不继承旧上下文也能独立完成；
 * 3. **只报事实、不做决策** —— 只要求它采集并回报 `stable`/`d`/`r`/门禁，「是否重试/是否交人」
 *    由 orch 判定（引擎不替宿主拍板）。
 */
export function buildEvidenceMessage(input: EvidenceMessageInput): string {
  const workspaceLine =
    input.workspace === null
      ? "你的 **cwd 即本项目 workspace**（桥侧无同步 workspace 源；若你能读到项目配置，以实际路径为准）"
      : input.workspace;
  const planBlock =
    input.plan === null || input.plan.trim().length === 0
      ? "（Feature 的 plan 为空 —— 请以「本需求最近一次任务要求」为准，并在报告里写明你的依据）"
      : input.plan;

  return [
    "你的唯一任务：对本项目当前工作区做一次**只读取证**，回答「上一次因超时被打断的任务，究竟做到哪儿了」。",
    "**绝对不要修改任何文件**：不要 edit / write / 格式化 / 提交 / checkout / stash / 安装依赖。",
    "越权修改会污染证据、并让后续判断失真。你只需要读、跑只读命令、然后报告。",
    "",
    "## 0. 排除你自己（唯一 nonce）",
    `本次取证任务的 nonce：\`${input.nonce}\``,
    "读取 `.a2a/tasks.json` 判断「是否还有在飞任务」时，凡是命中该 nonce 的条目**就是你自己**，必须排除；",
    "否则你会把自己算成「有在飞任务」而恒判不稳定。",
    "",
    "## 1. 环境（自包含；新会话，不要依赖任何旧上下文）",
    `- project: ${input.projectId}`,
    `- workspace: ${workspaceLine}`,
    `- feature: ${input.featureId}`,
    "- 本需求 In-Scope 清单（来自 Feature plan）：",
    planBlock,
    "",
    "## 2. 只读命令（在 workspace 下执行）",
    `- \`${gitCmd(input.workspace, "status --porcelain")}\``,
    `- \`${gitCmd(input.workspace, "diff --stat")}\``,
    "- 门禁：按上面 In-Scope 所属项目的 `package.json` 脚本执行（通常 `npm run typecheck` / `npm test` 同款命令）；",
    "  若无法确定门禁命令，请写明「未能确定门禁」而不是跳过。",
    "",
    "## 3. 软校验（必须做，用于判断工作区是否「稳定」）",
    "a) 读 `.a2a/tasks.json`（它是**对象字典**）：",
    `   只把状态为 ${EVIDENCE_WORKING_STATES.join(" / ")} 的条目算作「在飞」；`,
    `   **必须排除 ${EVIDENCE_EXCLUDED_STATES.join(" / ")}**（挂起态条目不会被清理，算进去会恒判「有在飞」）；`,
    "   并用第 0 节的 nonce 排除你自己。",
    `b) git 静默窗：间隔约 ${input.sampleGapSec} 秒**采样两次**上述两条 git 命令，两次输出**完全一致**才算「静默」。`,
    "c) `stable = (a 无在飞) AND (b 静默)` —— 任一项不满足即为 false。",
    "   **宁可报 false，也不要猜 true**；判 false 时请写清是哪一项不满足。",
    "",
    `## 4. 输出（登记为 artifact，建议名 \`${EVIDENCE_ARTIFACT_NAME}\`）`,
    "严格用下面这个形状（字段名不要改）：",
    "",
    "```json",
    "{",
    '  "stable": true 或 false,',
    '  "d": ["已改集：本需求范围内、确实改过的文件"],',
    '  "r": ["未改集：本需求要求但尚未完成的文件或事项"],',
    '  "gatesOk": true 或 false,',
    '  "completion": "none | partial | full（或 0-100）",',
    '  "reason": "一句话说明判断依据"',
    "}",
    "```",
    "",
    "- `d` 与 `r` 都要给**具体文件路径**，不要只写「部分完成」；",
    "- 若 `stable=false`，仍要给出你在不稳定状态下已看到的 d / r，并说明「为什么判不稳定」；",
    "- 不要给整改建议、不要替 orch 决定下一步该做什么 —— 只报事实。",
  ].join("\n");
}
