/**
 * `orch/bridge/evidence-message.ts` 单元测试（v0.4.1 取证节点消息契约）。
 *
 * 为什么单独测这个模块：`registerEvidenceNode` 的落点在 `bridge/index.ts`，而 `index.ts`
 * 顶层**无条件**执行 `main()`（`index.ts:2289`）⇒ import 即起桥，**不可被单测导入**。
 * 故把「worker 实际消费的消息契约」抽成纯模块并在此锁定：
 * 角色标记 / 唯一 nonce / 自包含 / 只读 / 软校验口径 / 结构化输出格式 / 不含决策内容。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_ARTIFACT_NAME,
  EVIDENCE_EXCLUDED_STATES,
  EVIDENCE_WORKING_STATES,
  artifactSummaryText,
  buildEvidenceMessage,
  parseEvidenceResult,
  type EvidenceMessageInput,
} from "../bridge/evidence-message.js";
import { EVIDENCE_NODE_MARKER, isEvidenceNode, markEvidenceMessage } from "../bridge/scheduler.js";

function input(over: Partial<EvidenceMessageInput> = {}): EvidenceMessageInput {
  return {
    projectId: "orch",
    workspace: "G:/code/a2a-coding/orch",
    featureId: "f-1",
    plan: "In-Scope: 改 store.ts / scheduler.ts",
    nonce: "nonce-abc-123",
    sampleGapSec: 5,
    ...over,
  };
}

test("buildEvidenceMessage：自包含（nonce / project / workspace / In-Scope / 只读命令 / 软校验 / 输出格式）", () => {
  const msg = buildEvidenceMessage(input());

  // ① nonce（供排除自身）
  assert.ok(msg.includes("nonce-abc-123"), "必须含唯一 nonce");
  // ② project / workspace / In-Scope
  assert.ok(msg.includes("orch"));
  assert.ok(msg.includes("G:/code/a2a-coding/orch"));
  assert.ok(msg.includes("In-Scope: 改 store.ts / scheduler.ts"), "In-Scope 取自 Feature plan");
  // ③ 只读命令
  assert.ok(msg.includes("git -C G:/code/a2a-coding/orch status --porcelain"));
  assert.ok(msg.includes("git -C G:/code/a2a-coding/orch diff --stat"));
  assert.ok(msg.includes("门禁"));
  // ④ 软校验口径：对象字典 + 只认在飞态 + 必须排除挂起态 + 两次采样
  assert.ok(msg.includes("对象字典"), "tasks.json 是**对象字典**（不是数组）");
  for (const s of EVIDENCE_WORKING_STATES) assert.ok(msg.includes(s), `须认在飞态 ${s}`);
  for (const s of EVIDENCE_EXCLUDED_STATES) {
    assert.ok(msg.includes(s), `必须显式要求排除 ${s}（否则恒判「有在飞」）`);
  }
  assert.ok(msg.includes("两次"), "git 静默窗须两次采样");
  assert.ok(msg.includes("5"), "采样间隔来自入参");
  // ⑤ 结构化输出格式（D / R / 门禁 / stable / 完成度+理由）
  assert.ok(msg.includes(EVIDENCE_ARTIFACT_NAME), "artifact 名可用于 O4b 定位");
  assert.ok(msg.includes("stable"));
  assert.ok(msg.includes("已改集"));
  assert.ok(msg.includes("未改集"));
  assert.ok(msg.includes("gatesOk"));
  assert.ok(msg.includes("completion"));
  assert.ok(msg.includes("reason"));
});

test("buildEvidenceMessage：渲染出的 ```json 块必须是**可直接 parse 的合法 JSON**（v0.5.0 D4 §2.3/§2.4 强契约）", () => {
  const msg = buildEvidenceMessage(input());

  // ① 从渲染出的消息里抽出 ```json 围栏正文
  const fenceStart = msg.indexOf("```json");
  assert.ok(fenceStart >= 0, "模板必须给出 ```json 输出样例");
  const fenceEnd = msg.indexOf("```", fenceStart + "```json".length);
  assert.ok(fenceEnd > fenceStart, "```json 围栏必须闭合");
  const body = msg.slice(fenceStart + "```json".length, fenceEnd).trim();

  // ② 强契约：必须能 `JSON.parse` —— 旧模板的「true 或 false」「none | partial | full（或 0-100）」在此必然抛错
  const parsed = JSON.parse(body) as Record<string, unknown>;

  // ③ 字段名与类型逐项锁定（同时锁住 `EvidenceResult` 的必需四字段）
  assert.deepEqual(
    Object.keys(parsed),
    ["stable", "d", "r", "gatesOk", "completion", "reason"],
    "字段名不得改（数组顺序 = 样例顺序）",
  );
  assert.equal(typeof parsed["stable"], "boolean", "stable 必须是布尔**字面量**（不能是说明文字）");
  assert.equal(typeof parsed["gatesOk"], "boolean", "gatesOk 必须是布尔**字面量**");
  assert.ok(Array.isArray(parsed["d"]), "d 必须是数组");
  assert.ok(Array.isArray(parsed["r"]), "r 必须是数组");
  assert.equal(typeof parsed["completion"], "string");
  assert.equal(typeof parsed["reason"], "string");

  // ④ 负向锁：3 行非法样例的**说明性取值**不得再出现在块内
  assert.ok(!body.includes("或 false"), "块内不得再出现「true 或 false」二选一说明");
  assert.ok(!body.includes("或 true"), "块内不得再出现「true 或 false」二选一说明");
  assert.ok(!body.includes("none | partial"), "块内不得再出现「none | partial | full」说明");
  assert.ok(!body.includes("0-100"), "块内不得再出现「（或 0-100）」说明");

  // ⑤ 说明已移到**块外正文**（避免 worker 把说明照抄成「默认值」）
  const afterFence = msg.slice(fenceEnd + "```".length);
  assert.ok(afterFence.includes("`true` 或 `false`"), "true/false 二选一说明须在块外正文");
  assert.ok(
    afterFence.includes("`none` / `partial` / `full`"),
    "none/partial/full 口径须在块外正文",
  );

  // ⑥ 追加约束措辞（§2.3）：块后禁裸花括号 + 多文件逐行、禁 `{a,b,c}` 缩写
  assert.ok(
    msg.includes("JSON 块之后不得再出现 `{` 或 `}` 字符"),
    "须显式约束块后不得出现裸花括号",
  );
  assert.ok(msg.includes("{a,b,c}"), "须显式禁止 `{a,b,c}` 缩写");
  assert.ok(msg.includes("逐行"), "多文件须逐行列出");

  // ⑦ 与解析器同口径：整条渲染消息自身即可经 fence 主路径取出形状合法的结论
  assert.deepEqual(parseEvidenceResult(msg), {
    stable: parsed["stable"],
    gatesOk: parsed["gatesOk"],
    d: parsed["d"],
    r: parsed["r"],
  });
});

test("buildEvidenceMessage：只读约束 + 不含决策内容（引擎不替宿主拍板）", () => {
  const msg = buildEvidenceMessage(input());

  assert.ok(msg.includes("绝对不要修改任何文件"), "只读靠 prompt 自律（权限是项目级）");
  assert.ok(msg.includes("只读"));
  assert.ok(msg.includes("只报事实"), "只报事实、不给整改建议");
  // 不得含决策内容：不说"只做某片"、不说重做、不替 orch 决定重试
  assert.ok(!msg.includes("只做"), "不得含决策内容");
  assert.ok(!msg.includes("重新做"), "不得指示重做");
  assert.ok(!msg.includes("重试"), "取证节点不参与重试决策");
});

test("buildEvidenceMessage：workspace 未知时退化为 cwd 表述（git 不带 -C）", () => {
  const msg = buildEvidenceMessage(input({ workspace: null, plan: null }));

  assert.ok(msg.includes("cwd 即本项目 workspace"), "无同步 workspace 源时的退化口径");
  assert.ok(!msg.includes("git -C"), "未知 workspace 时不得拼 -C");
  assert.ok(msg.includes("git status --porcelain"));
  assert.ok(msg.includes("git diff --stat"));
  assert.ok(msg.includes("plan 为空"), "plan 为空时要求写明依据");
});

test("取证节点消息经 markEvidenceMessage 包裹 ⇒ 被 isEvidenceNode 识别（角色标记，§4.1.8）", () => {
  const body = buildEvidenceMessage(input());

  assert.equal(isEvidenceNode({ dispatchMessage: body, prompt: null }), false, "正文本身不带标记");
  const marked = markEvidenceMessage(body);
  assert.ok(marked.startsWith(EVIDENCE_NODE_MARKER), "标记在最前（持久化于消息内）");
  assert.equal(isEvidenceNode({ dispatchMessage: marked, prompt: null }), true);
  assert.equal(isEvidenceNode({ dispatchMessage: null, prompt: marked }), true);
});

// ---------------------------------------------------------------------------
// v0.4.1 O4b：取证结论解析（`resolveEvidence` 的纯函数核心）
// ---------------------------------------------------------------------------

const OK_JSON =
  '{"stable":true,"d":["a.ts"],"r":[],"gatesOk":true,"completion":"full","reason":"ok"}';
const OK_PARSED = { stable: true, d: ["a.ts"], r: [], gatesOk: true };

test("parseEvidenceResult：正常 JSON / ```json 围栏 / 夹带说明文字均可解析", () => {
  assert.deepEqual(parseEvidenceResult(OK_JSON), OK_PARSED);
  assert.deepEqual(parseEvidenceResult("```json\n" + OK_JSON + "\n```"), OK_PARSED, "围栏");
  assert.deepEqual(
    parseEvidenceResult(`我先跑了门禁，结论如下：\n${OK_JSON}\n（以上）`),
    OK_PARSED,
    "夹带说明文字",
  );
});

test("parseEvidenceResult：缺失 / 空 / 非 JSON / 形状不合 ⇒ null（fail-safe 交人）", () => {
  assert.equal(parseEvidenceResult(""), null, "缺 artifact ⇒ 无可解析内容 ⇒ null");
  assert.equal(parseEvidenceResult("   "), null);
  assert.equal(parseEvidenceResult("这次没有产出 artifact"), null);
  assert.equal(parseEvidenceResult('{"d":[],"r":[]}'), null, "缺 stable/gatesOk");
  assert.equal(
    parseEvidenceResult('{"stable":"true","d":[],"r":[],"gatesOk":true}'),
    null,
    "stable 必须是布尔（字符串不接收）",
  );
  assert.equal(
    parseEvidenceResult('{"stable":true,"d":"a.ts","r":[],"gatesOk":true}'),
    null,
    "d 必须是数组",
  );
  assert.equal(parseEvidenceResult("[1,2,3]"), null, "顶层必须是对象");
  // 宽容：数组里的非字符串元素被丢弃
  assert.deepEqual(parseEvidenceResult('{"stable":true,"d":[1,"a.ts"],"r":[],"gatesOk":false}'), {
    stable: true,
    d: ["a.ts"],
    r: [],
    gatesOk: false,
  });
});

test("artifactSummaryText：text/data/url 三类 part 拼接，raw 跳过（与 textFromArchivedArtifacts 同口径）", () => {
  const text = artifactSummaryText({
    parts: [
      { kind: "text", text: '{"stable":true' },
      { kind: "data", data: { x: 1 } },
      { kind: "url", url: "http://host/evidence" },
      { kind: "raw", bytes: 12345 },
    ],
  });
  assert.ok(text.includes('{"stable":true'));
  assert.ok(text.includes('{"x":1}'), "data part 序列化后并入");
  assert.ok(text.includes("http://host/evidence"));
  assert.ok(!text.includes("12345"), "raw 为二进制，跳过");
});

// ---------------------------------------------------------------------------
// v0.5.0 D4（REQ-v0.5.0-2026-09-16-03）：`parseEvidenceResult` 取串逻辑加固
//
// 三级取串 = ① 原始整串 → ② fence-aware 主路径（硬要求）→ ③ 升序候选兜底；
// 二级 / 三级共用形状校验（`stable`/`gatesOk` 布尔、`d`/`r` 数组），全败仍 `null`（宁交人）。
// ---------------------------------------------------------------------------

/**
 * 真实夹具（**字面量内联，严禁运行时读 `sessions.sqlite`** —— 改造文档 §2.4）。
 *
 * 来源：`orch/data/sessions.sqlite` 的 `tasks.text`，`task_id = 44e23343-0960-4da7-abd4-9dbbc03e4ccf`
 * （`project_id = machine`、`state = completed`、feature `40799f3a-…`、context `aee8077c-…`）。
 * 同一任务的唯一产物（`artifacts_json[0]`：`name = "response"`、只有一个 `text` part）与该
 * `text` **同为 3934 字符** ⇒ 它就是 `resolveEvidence` 候选 #2 的实际取串对象
 * （§1.1.6：候选 #1「命名 `evidence.json`」与候选 #3 在该任务上均为死路径）。
 *
 * **为什么必须测全文**：证据块（`## 4.`）**之前**的散文里含平衡花括号
 * `flow.agentConfig = {"agentCard":{"pushNotifications":true}}`（首 `{` 在 1466），块**之后**的散文
 * 亦含 `{tasks,sessions}`（末 `}` 在 3587）⇒ 旧「首 `{` → 末 `}`」切出的候选无法 `JSON.parse`。
 * ⚠️ 只测「块后脏花括号」会在兜底上**假绿** ⇒ 本用例锁定**全文 + 花括号指纹**。
 */
const REAL_EVIDENCE_TEXT = `## 取证报告（只读）· project=machine

**产出 artifact：\`evidence.json\`**（见下）· 未修改任何文件（无 edit/write/格式化/提交/checkout/stash/安装依赖）

### 0. In-Scope 的依据（Feature plan 为空）
\`orch/data/sessions.sqlite\` 的 \`features\` 表中 \`40799f3a-…\` 的 \`plan/decisions/contracts\` **均为 NULL** ⇒ 按指示改以「该 Feature 最近一次任务要求」为准：
- 节点 \`ec653530-d06b-4da0-8e25-1a3c8e87e09c\`（\`project_id=machine\`，\`dispatch_message\` 原文）：**REQ-03 收尾·回滚临时配置** —— ① 删除 \`machine/config/config.json\` 中 \`flow\` 的 \`agentConfig.timeouts\`（保留 \`agentCard\`、其它不动）② JSON 校验 ③ 经 \`machine/scripts/launcherctl.mjs\` 非阻塞重启 Launcher 并确认 \`/health\` = \`status:"ok"\` ④ 报告 ①–⑤。
- 该节点的既有终态：\`failed\` / \`failure_kind=infra\` / \`retry_count=0\` / \`exhausted=1\` / \`text="任务因包装器进程重启而中断（interrupted），未产出终态"\` / \`artifacts_json=[]\`。

### 1. 事实时间线（UTC；本地 = UTC+8）
| 时刻 | 事实 |
|---|---|
| 07:20:40.056Z | 节点 \`ec653530\` 派发到 machine（远端 task \`f1c2c55f\`） |
| **07:21:08Z** | **\`machine/config/config.json\` 被重写**（mtime，晚于派发 28s） |
| 07:21:37.499Z | **Launcher 新实例 pid \`7864\` 启动**（\`launcher.pid.startedAt\`）—— 该重启杀掉了承载本节点的 wrapper |
| 07:21:43.158Z | 节点 \`ec653530\` → \`failed\`(infra)，\`text\` 仅中断说明，无终态产出 |
| 07:21:43.223Z | 引擎登记取证节点 \`44e23343\`（= 我自己，远端 \`3c516419\`，含 nonce） |
| 07:22:28Z+ | 重启后 Launcher 启动自检 3 项目全通过 \`就绪（status=ok）\`；machine agent 于 07:22:48Z 上线 |

### 2. 只读命令结果
- \`git status --porcelain\` / \`diff --stat\`：**machine 单元零 tracked 改动**。脏文件全在 **\`orch/\`（v0.5.0 网页端只读工作台未提交改动：\`bridge/index.ts\`、\`config.ts\`、\`config/config.json.default\`、\`session/store.ts\`、\`types.ts\`、\`test/{config,scheduler,store,web}.test.ts\` + 新增 \`bridge/transports/web.ts\`、\`bridge/web/\`）+ 仓库根 \`opencode.json\`、\`flow/probe-sleep.cmd\`** —— 与本需求无关。
- \`machine/config/config.json\`：\`JSON.parse\` **OK**；\`flow.agentConfig = {"agentCard":{"pushNotifications":true}}\`；\`hasTimeouts=false\`；全 \`machine/config/*\` 无任何 \`timeouts\` 字样。文件 mtime = **07:21:08Z**（落在节点执行窗内）。
- \`GET http://127.0.0.1:3100/health\` → **200** \`{"ok":true,"protocolVersion":"1.0","status":"ok"}\`；\`GET /projects\` → \`machine\` online、\`flow\`/\`orch\` offline，\`flow.agentConfig\` **不含** \`timeouts\`；3100 正由 pid \`7864\` 持有。
- 门禁（In-Scope 所属项目 = **machine**，其 \`package.json\` 无 \`test\` 脚本）：\`npm run typecheck\` → **exit 0**；\`npm run lint\` → **exit 0**。**未跑 \`orch\` 的 \`npm test\`**：其脚本先 \`npm run build\`（会写 \`orch/dist\`），与本次只读约束冲突，且非本需求所属单元。

### 3. 软校验（stable）
- **(a) 在飞**：\`machine/.a2a/tasks.json\` 唯一 \`WORKING\` 条目 = \`3c516419\`，其 prompt 含 nonce \`2d0d8de8-…\` ⇒ **是我自己，已排除**；另 3 条为 \`TASK_STATE_INPUT_REQUIRED\`（2026-09-14）⇒ 按规则不计。**无在飞**。旁证：\`flow/.a2a/tasks.json = {}\`、\`orch/.a2a/tasks.json\` 仅 2 条 \`INPUT_REQUIRED\`。
- **(b) 静默窗**：间隔 5s 两次采样 \`status --porcelain\` 与 \`diff --stat\`，两次**完全一致**（文本相等、SHA1 同为 \`D7-85-4C-84…F9-57\`）。
- **(c) ⇒ \`stable = true\`**。

### 4. 登记 artifact：\`evidence.json\`
\`\`\`json
{
  "stable": true,
  "d": [
    "machine/config/config.json"
  ],
  "r": [
    "事项（要求 4）：任务回执未产出 —— ④ 项报告（flow 完整 JSON / JSON 校验结果 / GET /projects 回显 / launcherctl status 原文 / 偏离项）全无，artifacts_json=[]，节点 text 仅为中断说明",
    "事项（要求 3）：重启的「命令形态」不可判定 —— 仅能观测到「Launcher 已重启（pid 7864, 07:21:37.499Z）且 /health=ok」，无法从本工作区证明是经 machine/scripts/launcherctl.mjs 非阻塞发起的",
    "事项：Feature 40799f3a 未收口 —— state 仍为 executing（其唯一实现节点 ec653530=failed/infra/exhausted=1/retry=0，未产生重试或推进）"
  ],
  "gatesOk": true,
  "completion": "partial",
  "reason": "三项实质要求均已达成（回滚已落盘 07:21:08Z：flow 无 timeouts、JSON 可解析；Launcher 已于 07:21:37.499Z 重启且当前 /health=status:ok；machine 门禁 typecheck/lint exit 0），仅第 4 项「回执」未产出、Feature 未收口，故判 partial。"
}
\`\`\`

### 5. 附带事实（不构成建议）
- \`machine/agents/opencode.{orch,flow,machine}.json\`（15:21:54 / 15:22:10 / 15:22:44）与 \`.a2a/launcher.pid\`、\`.omo/run-continuation/*\`、各 \`.a2a/{tasks,sessions}.json\` 的近期 mtime 均系**重启后 Launcher/agent 运行时产物**，非本需求改动。
- \`orch/data/sessions.sqlite\` 中存在一条**陈旧本地行** \`e1e89c78\`（feature \`a4ffcced\` 已 \`failed\`，\`state=working\`、\`remote_task_id=null\`、created 06:54:58Z）—— 无远端任务，非在飞。
- 仓内遗留未跟踪文件：\`flow/probe-sleep.cmd\`（07:07:16Z，REQ-03 刺激源产物）、根 \`opencode.json\`。
- 未覆盖项：未读取/未校验机器侧其它项目配置以外的运行时账本内容；未对 \`orch\` 单元执行任何构建或测试。`;

/** 夹具指纹（取自 task 44e23343 原文实测）：防夹具被截断 / 改写而「假绿」 */
const REAL_EVIDENCE_HEAD_PROSE = 'flow.agentConfig = {"agentCard":{"pushNotifications":true}}';
const REAL_EVIDENCE_LEN = 3934;
const REAL_EVIDENCE_FIRST_BRACE = 1466;
const REAL_EVIDENCE_LAST_BRACE = 3587;

test("parseEvidenceResult：真实夹具**全文**（块前含平衡花括号散文）⇒ 解析成功且字段正确", () => {
  // ⓪ 夹具自证：确实是 3934 字符全文，且块前 / 块后散文各自贡献了一个花括号
  assert.equal(REAL_EVIDENCE_TEXT.length, REAL_EVIDENCE_LEN, "夹具必须是 task 44e23343 的全文");
  assert.ok(
    REAL_EVIDENCE_TEXT.includes(REAL_EVIDENCE_HEAD_PROSE),
    "夹具必须含块前散文里的平衡花括号（否则测不出缺陷）",
  );
  assert.equal(
    REAL_EVIDENCE_TEXT.indexOf("{"),
    REAL_EVIDENCE_FIRST_BRACE,
    "首个 `{` 落在证据块**之前**的散文里",
  );
  assert.equal(
    REAL_EVIDENCE_TEXT.lastIndexOf("}"),
    REAL_EVIDENCE_LAST_BRACE,
    "末个 `}` 落在证据块**之后**的散文里",
  );

  // ① 回归锁：旧实现切出的候选（首 `{` → 末 `}`）必须**解析不了** —— 证明夹具确实复现了缺陷
  assert.throws(
    () =>
      JSON.parse(REAL_EVIDENCE_TEXT.slice(REAL_EVIDENCE_FIRST_BRACE, REAL_EVIDENCE_LAST_BRACE + 1)),
    "旧「首 `{`→末 `}`」候选必须 parse 失败，否则本用例证明不了缺陷已复现",
  );

  // ② 主路径（fence-aware）：全文唯一 ```json 围栏的正文自身即可解析 ⇒ ② 必然先于 ③ 命中
  const fenceStart = REAL_EVIDENCE_TEXT.indexOf("```json");
  const fenceEnd = REAL_EVIDENCE_TEXT.indexOf("```", fenceStart + 3);
  assert.ok(fenceStart > 0 && fenceEnd > fenceStart, "夹具须含**闭合**的 ```json 围栏");
  const fenceBody = REAL_EVIDENCE_TEXT.slice(fenceStart + "```json".length, fenceEnd).trim();
  assert.notEqual(parseEvidenceResult(fenceBody), null, "围栏正文自身形状合法 ⇒ fence 主路径命中");

  // ③ 全文解析：旧实现返回 null（边界越界），新实现必须成功
  const parsed = parseEvidenceResult(REAL_EVIDENCE_TEXT);
  assert.ok(parsed !== null, "真实取证报告必须解析成功（旧实现返回 null）");
  assert.equal(parsed.stable, true);
  assert.equal(parsed.gatesOk, true);
  assert.deepEqual(parsed.d, ["machine/config/config.json"], "已改集");
  assert.equal(parsed.r.length, 3, "未改集：三条事项");
  assert.ok(parsed.r[0]?.startsWith("事项（要求 4）"), "回执未产出");
  assert.ok(parsed.r[1]?.includes("launcherctl.mjs"), "重启命令形态不可判定");
  assert.ok(parsed.r[2]?.includes("40799f3a") && parsed.r[2]?.includes("未收口"), "Feature 未收口");
  // 与围栏正文独立解析的结论一致（两条路径互证）
  assert.deepEqual(parsed, parseEvidenceResult(fenceBody));
});

test("parseEvidenceResult：未闭合围栏（有头无尾）⇒ 抽取为空 ⇒ 自动回退到升序兜底", () => {
  assert.deepEqual(
    parseEvidenceResult("```json\n" + OK_JSON),
    OK_PARSED,
    "有头无尾（带标签）必须回退成功",
  );
  assert.deepEqual(parseEvidenceResult("说明\n```\n" + OK_JSON), OK_PARSED, "有头无尾（无标签）");
  // 回退走升序扫描：前导还有一段平衡花括号散文时也要能命中
  assert.deepEqual(
    parseEvidenceResult('```json\n配置 = {"a":{"b":1}}\n结论：\n' + OK_JSON),
    OK_PARSED,
  );
});

test("parseEvidenceResult：JSON 在说明文字之前 / 前导平衡花括号 / 嵌套对象 ⇒ 升序兜底命中", () => {
  assert.deepEqual(parseEvidenceResult(OK_JSON + "\n\n以上为结论，未修改任何文件。"), OK_PARSED);

  // 前导是**形状不合**的平衡花括号 ⇒ 兜底须继续试下一候选（不得在此停住判 null）
  assert.deepEqual(
    parseEvidenceResult('配置 = {"agentCard":{"pushNotifications":true}}\n结论：\n' + OK_JSON),
    OK_PARSED,
  );

  // 嵌套对象：必须 `}` **升序**扫描才能命中外层配对（`lastIndexOf` 递减口径不成立）
  assert.deepEqual(
    parseEvidenceResult(
      '{"stable":true,"gatesOk":true,"d":[],"r":[],"meta":{"nested":{"deep":1}}}',
    ),
    { stable: true, gatesOk: true, d: [], r: [] },
  );
});

test("parseEvidenceResult：多围栏 / 多候选 ⇒ 取**首个形状合法**者", () => {
  const good = "```json\n" + OK_JSON + "\n```";

  // ① 前一个围栏是合法 JSON 但**形状不合** ⇒ 跳过，取下一个
  assert.deepEqual(parseEvidenceResult('```json\n{"hello":"world"}\n```\n' + good), OK_PARSED);

  // ② 前一个候选是合法 JSON 但形状不合（无围栏）⇒ 兜底继续试下一候选
  assert.deepEqual(parseEvidenceResult('{"stable":true}\n' + OK_JSON), OK_PARSED);

  // ③ 首个**形状合法**者胜（不是"最后一个"、也不是"最长的"）
  const firstValid = '```json\n{"stable":false,"gatesOk":false,"d":[],"r":[]}\n```';
  assert.deepEqual(parseEvidenceResult(firstValid + "\n" + good), {
    stable: false,
    gatesOk: false,
    d: [],
    r: [],
  });
});

test("parseEvidenceResult：`reason` 内含 `{` / `}` 仍可解析（字符串内花括号不干扰取串）", () => {
  const withBraces =
    '{"stable":true,"gatesOk":false,"d":["a.ts"],"r":[],"reason":"配置为 {\\"a\\":{\\"b\\":1}} 未闭合"}';
  const expected = { stable: true, gatesOk: false, d: ["a.ts"], r: [] };

  assert.deepEqual(parseEvidenceResult(withBraces), expected, "整串候选（①）");
  assert.deepEqual(
    parseEvidenceResult("结论：\n" + withBraces + "\n（完）"),
    expected,
    "兜底候选（③）",
  );
  assert.deepEqual(
    parseEvidenceResult("结论：\n```json\n" + withBraces + "\n```\n（完）"),
    expected,
    "主路径候选（②）",
  );
});

test("parseEvidenceResult：「```json 证据块 + 末尾 ```a2a-outcome 块」⇒ 取证据块（同源加固 §1.1.4）", () => {
  const outcomeBlock = '```a2a-outcome\n{"state":"input-required","question":"要不要重试？"}\n```';

  assert.deepEqual(
    parseEvidenceResult("先跑门禁：\n```json\n" + OK_JSON + "\n```\n\n" + outcomeBlock),
    OK_PARSED,
    "顺序：证据块在前（wrapper 把 worker 完整回复拼进同一候选串）",
  );
  assert.deepEqual(
    parseEvidenceResult(outcomeBlock + "\n\n```json\n" + OK_JSON + "\n```"),
    OK_PARSED,
    "顺序颠倒：a2a-outcome 块形状不合 ⇒ 跳过取证据块",
  );
});

test("parseEvidenceResult：围栏容忍 CRLF、接受无标签 ``` ", () => {
  assert.deepEqual(
    parseEvidenceResult("```json\r\n" + OK_JSON + "\r\n```"),
    OK_PARSED,
    "CRLF + 标签",
  );
  assert.deepEqual(
    parseEvidenceResult("报告：\r\n```\r\n" + OK_JSON + "\r\n```"),
    OK_PARSED,
    "CRLF + 无标签",
  );
  assert.deepEqual(
    parseEvidenceResult("报告：\n```\n" + OK_JSON + "\n```"),
    OK_PARSED,
    "LF + 无标签",
  );
});
