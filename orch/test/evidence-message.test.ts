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

