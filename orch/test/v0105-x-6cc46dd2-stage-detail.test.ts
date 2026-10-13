/**
 * v0.10.5 增补 `6cc46dd2` · **N1 + N2** —— 《改造文档》档名标记能力（`DESIGN_DOC_MARKER` +
 * 由 `confirmationDocRegistered` 泛化而来的 `docRegistered`）与**本阶段明细的派生单源**
 * （`FeatureStageDetail` / 两枚文案表 / `deriveStageDetail`）的测试锚。
 *
 * 被锚定的行为（`bridge/feature-tools.ts`）：
 * - `DESIGN_DOC_MARKER` = `"-改造文档.md"` —— 取命名规范 `{topic}-改造文档.md`（`需求流程.md` §4）
 *   的**固定尾段**，**前导连字符不可省**：省了裸文件名 `改造文档.md`（§4 明令禁止的无 topic 前缀
 *   形态）也构成命中；
 * - `docRegistered(persisted, pending, marker)` 保住**并集口径**（已落库 ∪ 本单同写）——
 *   「已落库半边为空」不得打死「本单同写」这一半，反之亦然。
 *
 * 本文件按 DAG 节点分段落钉：**G1 = N1**（上面这段，只锚标记判据本身）；**G2–G6 + G8 = N2**
 * （明细类型 / 文案表 / `deriveStageDetail` 纯函数）；**G7（advance 段）/ G9 / G10 = N3**
 * （`advance` 四条成功出口的在场性 / 写后重读 / 不读节点态）；**G7（`create` / `approve` 段）
 * + G9（approve 写后重读）= N4**；**G7（`feature_status` 单查段）+ G11（`cancel` 负锚 ·
 * 列表分支负锚 · 与 `advance` 出口的同源面）= N5**。门① 的行为未变，其凭据 = 既有
 * `test/v0105-x-bbc7ea28-gate1-decision-doc.test.ts` 一行不改且全绿（调用点固定传
 * `CONFIRMATION_DOC_MARKER`）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 * 隔离：G1–G8 纯判据、零 store；N3 / N4 / N5 段（G7 / G9 / G10 / G11）走 `SESSION_DB=:memory:`，
 * 每条夹具各自 `close()` ⇒ 零派发、零出站（不 import `bridge/index.ts`，故不需 `MACHINES_CONFIG`）。
 */
process.env["SESSION_DB"] = ":memory:"; // N3 段的夹具用 store，须在首次触碰 store 之前

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DESIGN_DOC_MARKER,
  PENDING_HOST_SIDE_ITEMS,
  PENDING_USER_CREDENTIAL_ITEMS,
  STAGE_DETAIL_ACTIONS,
  WAITING_APPROVAL_ACTIONS,
  deriveStageDetail,
  docRegistered,
  handleFeatureAdvance,
  handleFeatureApprove,
  handleFeatureCancel,
  handleFeatureCreate,
  handleFeatureStatus,
  type FeatureAdvanceExit,
  type FeatureApproveSuccess,
  type FeatureCreateSuccess,
  type FeatureStatusSingleSuccess,
  type FeatureToolFailure,
} from "../bridge/feature-tools.js";
import {
  close,
  createFeature,
  createTask,
  getFeature,
  projectVersionCreate,
  updateFeatureContext,
  updateTaskState,
  versionLedgerCreate,
} from "../session/store.js";
import type { FeatureRecord, FeatureStage, FeatureState } from "../types.js";

/** 合法档名（`{topic}-改造文档.md`，带前导连字符的固定尾段） */
const DOC_OK = '["doc/v0.10.5/夹具-改造文档.md"]';

// ===========================================================================
// 字面锚：常量不得漂移（去掉前导连字符即放宽成「裸名也命中」）
// ===========================================================================

test("G1 档名子串字面锚：DESIGN_DOC_MARKER = -改造文档.md（前导连字符在位）", () => {
  assert.equal(DESIGN_DOC_MARKER, "-改造文档.md");
});

// ===========================================================================
// G1 正锚：带 topic 前缀（`-改造文档.md`）命中 —— 已落库 / 本单同写各一遍（并集两半）
// ===========================================================================

test("G1 已落库半边命中 ⇒ true（pending 为空不影响）", () => {
  assert.equal(docRegistered(DOC_OK, undefined, DESIGN_DOC_MARKER), true);
  assert.equal(docRegistered(DOC_OK, "", DESIGN_DOC_MARKER), true);
});

test("G1 本单同写半边命中 ⇒ true（persisted 为空不影响 —— 并集口径不可省）", () => {
  assert.equal(docRegistered(null, DOC_OK, DESIGN_DOC_MARKER), true);
  assert.equal(docRegistered("", DOC_OK, DESIGN_DOC_MARKER), true);
});

test("G1 多份产出物并陈时仍命中（decisions 是数组串，不是单档名）", () => {
  const mixed = '["doc/v0.10.5/夹具-需求确认单.md","doc/v0.10.5/夹具-改造文档.md"]';
  assert.equal(docRegistered(mixed, undefined, DESIGN_DOC_MARKER), true);
});

// ===========================================================================
// G1 负锚：宽松形态不误放
// ===========================================================================

test("G1 裸文件名 改造文档.md（§4 明令禁止的无 topic 前缀形态）⇒ 不命中", () => {
  const bare = '["doc/v0.10.5/改造文档.md"]';
  assert.equal(docRegistered(bare, undefined, DESIGN_DOC_MARKER), false);
  assert.equal(docRegistered(null, bare, DESIGN_DOC_MARKER), false);
});

test("G1 非连字符分隔（下划线 / 空格）⇒ 不命中", () => {
  const loose = ['["doc/v0.10.5/夹具_改造文档.md"]', '["doc/v0.10.5/夹具 改造文档.md"]'];
  for (const doc of loose) {
    assert.equal(docRegistered(doc, undefined, DESIGN_DOC_MARKER), false, doc);
  }
});

test("G1 两侧皆空（null / undefined / 空串）⇒ 不命中（不把空值当命中）", () => {
  assert.equal(docRegistered(null, undefined, DESIGN_DOC_MARKER), false);
  assert.equal(docRegistered("", "", DESIGN_DOC_MARKER), false);
});

// ===========================================================================
// G1 泛化不改动《需求确认单》那一半：同一判据换 marker 参，两族档名互不误认
// ===========================================================================

test("G1 只登记《需求确认单》的串 ⇒ 对改造文档标记不命中（两族标记分立）", () => {
  const onlyConfirmation = '["doc/v0.10.5/夹具-需求确认单.md"]';
  assert.equal(docRegistered(onlyConfirmation, undefined, DESIGN_DOC_MARKER), false);
});

// ===========================================================================
// N2 —— 明细类型 + 文案表 + `deriveStageDetail` 纯函数（**派生单源，不接线**）
//
// 本段锚的是 `bridge/feature-tools.ts` 的**纯派生层**；各成功出口（`advance` 四出口 /
// `create` / `approve` / `feature_status` 单查）的**在场性锚**归 N3/N4/N5（G7 / G9–G11）。
// ===========================================================================

/** 最小 FeatureRecord（五维可覆盖，其余字段与本派生无关 —— 正是 G8 的「无关维」） */
function rec(over: Partial<FeatureRecord> = {}): FeatureRecord {
  return {
    featureId: "feat-n2",
    state: "waiting_approval",
    title: "夹具",
    requirement: null,
    contextId: null,
    plan: null,
    decisions: null,
    contracts: null,
    ownerGroup: null,
    parentFeatureId: null,
    stage: "需求分析",
    version: "",
    approval: "未发起",
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
    ...over,
  };
}

/** 已登记《需求确认单》的 decisions 串 */
const CONF_DOC = '["doc/v0.10.5/夹具-需求确认单.md"]';
/** 确认单 + 改造文档 双登记 */
const BOTH_DOCS = '["doc/v0.10.5/夹具-需求确认单.md","doc/v0.10.5/夹具-改造文档.md"]';

/** 主链 + 异常 / 终态全 11 枚（动态枚举，引擎加态时靠本表的行数与 `ACTOR_BY_STATE` 一起暴露） */
const ALL_STATES: FeatureState[] = [
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
];

/** 确认单 v22 逐行 `action` 草案的逐格字面（`executing` 行 = 用户点名、宿主已裁保留） */
const EXPECTED_ACTIONS: Array<[string, FeatureRecord, string]> = [
  [
    "#1 未登记确认单（与 version 无关）",
    rec({ decisions: null, version: "" }),
    "Dispatch each project's product_manager for the requirements analysis (Step 0), and land the 需求确认单.",
  ],
  [
    "#2 确认单已登记 · version 空",
    rec({ decisions: CONF_DOC, version: "" }),
    "Schedule a version first, then get the user to confirm the problem (gate 1).",
  ],
  [
    "#3 确认单已登记 · version 非空",
    rec({ decisions: CONF_DOC, version: "v0.10.5" }),
    "Get the user to confirm the problem, then migrate stage (gate 1).",
  ],
  [
    "#4/#5 门① 已过 · 改造文档未登记",
    rec({ decisions: CONF_DOC, version: "v0.10.5", stage: "改造方案" }),
    "Dispatch each project's dev_manager for its side-plan and the boundary round, and land the 改造文档.",
  ],
  [
    "#6 改造文档已登记 · approval 待审批",
    rec({ decisions: BOTH_DOCS, version: "v0.10.5", stage: "改造方案", approval: "待审批" }),
    "Wait for the user's approval, then call approve (gate 2).",
  ],
  [
    "#7 version_planning",
    rec({ state: "version_planning", decisions: BOTH_DOCS, version: "v0.10.5", stage: "改造方案", approval: "已通过" }),
    "Run the PjM procedure (each project's project_manager) and write the attribution, then advance to decomposing.",
  ],
  [
    "#8 decomposing",
    rec({ state: "decomposing", decisions: BOTH_DOCS, version: "v0.10.5", stage: "改造方案", approval: "已通过" }),
    "Dispatch each project's dev_manager for its node list, register the DAG, then advance to executing.",
  ],
  [
    "#11 / 异常 b executing",
    rec({ state: "executing", decisions: BOTH_DOCS, version: "v0.10.5", stage: "改造", approval: "已通过" }),
    "Hook `watch-feature.mjs` to monitor the feature.",
  ],
  [
    "#13 testing",
    rec({ state: "testing", decisions: BOTH_DOCS, version: "v0.10.5", stage: "回归", approval: "已通过" }),
    "Run the on-box acceptance, then advance to reviewing.",
  ],
  [
    "#14 reviewing",
    rec({ state: "reviewing", decisions: BOTH_DOCS, version: "v0.10.5", stage: "验收", approval: "已通过" }),
    "Wait for the user's acceptance verdict, then advance to completed.",
  ],
  [
    "#15/#16 completed",
    rec({ state: "completed", decisions: BOTH_DOCS, version: "v0.10.5", stage: "发版", approval: "已通过" }),
    "Wait for the release order (§8).",
  ],
  [
    "异常 a needs_input",
    rec({ state: "needs_input", decisions: BOTH_DOCS, version: "v0.10.5", stage: "改造", approval: "已通过" }),
    'Answer the clarification: advance(to="executing", answer=…).',
  ],
];

// ===========================================================================
// G2 —— 形状：平铺七键（v15 扁平版，**不是**嵌套对象）
// ===========================================================================

test("G2 平铺：出参恰为七枚平级键，无 `next` 包装、无 `next.state`", () => {
  const detail = deriveStageDetail(rec());
  assert.deepEqual(Object.keys(detail).sort(), [
    "action",
    "actor",
    "approval",
    "gate",
    "pending",
    "stage",
    "version",
  ]);
  assert.equal("next" in detail, false);
  assert.equal(
    Object.values(detail).some((v) => v !== null && typeof v === "object" && !Array.isArray(v)),
    false,
    "七枚里不得再嵌对象（平铺摆法）",
  );
});

test("G2 派生两族集合：互斥、并集 = 五枚欠账闭集（逐枚点名的前置判据）", () => {
  const host = new Set<string>(PENDING_HOST_SIDE_ITEMS);
  const user = new Set<string>(PENDING_USER_CREDENTIAL_ITEMS);
  const five = ["requirement-doc", "version", "stage", "design-doc", "approval"];
  assert.deepEqual([...host].filter((i) => user.has(i)), []);
  assert.equal(host.size + user.size, five.length);
  assert.deepEqual(five.filter((i) => !host.has(i) && !user.has(i)), []);
});

// ===========================================================================
// G3 —— `pending`：恒数组 / 终态异常态 [] / 登记欠账全清单不按当前格过滤
// ===========================================================================

test("G3 恒为数组（全态扫描，含未排期与脏组合）", () => {
  for (const state of ALL_STATES) {
    assert.ok(Array.isArray(deriveStageDetail(rec({ state })).pending), state);
  }
});

test("G3 终态 / 异常态四格 ⇒ `[]`", () => {
  for (const state of ["completed", "needs_input", "failed", "cancelled"] as FeatureState[]) {
    assert.deepEqual(deriveStageDetail(rec({ state })).pending, [], state);
  }
});

test("G3 `waiting_approval` 段逐格：确认单 → version → stage 三档欠账", () => {
  // #1 未登记确认单 ⇒ requirement-doc，**与 version 是否为空无关**（确认单 v11 注 5）
  assert.deepEqual(deriveStageDetail(rec({ decisions: null, version: "" })).pending, [
    "requirement-doc",
  ]);
  assert.deepEqual(deriveStageDetail(rec({ decisions: null, version: "v0.10.5" })).pending, [
    "requirement-doc",
  ]);
  // #2 确认单已登记、version 空
  assert.deepEqual(deriveStageDetail(rec({ decisions: CONF_DOC, version: "" })).pending, ["version"]);
  // #3 确认单已登记、version 非空、stage 仍需求分析
  assert.deepEqual(deriveStageDetail(rec({ decisions: CONF_DOC, version: "v0.10.5" })).pending, [
    "stage",
  ]);
});

test("G3 门① 之后逐格：design-doc → approval → 无欠账", () => {
  const base = { decisions: CONF_DOC, version: "v0.10.5", stage: "改造方案" } as const;
  // #4/#5 改造文档未登记
  assert.deepEqual(deriveStageDetail(rec({ ...base, approval: "未发起" })).pending, ["design-doc"]);
  // 改造文档已登记、approval 仍未发起 ⇒ 欠 `approval`（宿主置待审批）
  assert.deepEqual(deriveStageDetail(rec({ ...base, decisions: BOTH_DOCS })).pending, ["approval"]);
  // #6 待审批 ⇒ 登记侧无欠账（等的是用户门②）
  assert.deepEqual(
    deriveStageDetail(rec({ ...base, decisions: BOTH_DOCS, approval: "待审批" })).pending,
    [],
  );
});

test("G3 不按当前格过滤：executing 格上确认单未登记 ⇒ 仍报 requirement-doc（无第二套判据）", () => {
  assert.deepEqual(
    deriveStageDetail(rec({ state: "executing", decisions: null, stage: "改造", approval: "已通过" }))
      .pending,
    ["requirement-doc"],
  );
});

test("G3 `decisions` 判档名沿用 N1 严格标记：裸文件名不构成登记", () => {
  const bare = '["doc/v0.10.5/需求确认单.md","doc/v0.10.5/改造文档.md"]';
  assert.deepEqual(deriveStageDetail(rec({ decisions: bare })).pending, ["requirement-doc"]);
  assert.deepEqual(
    deriveStageDetail(
      rec({ decisions: CONF_DOC, version: "v0.10.5", stage: "改造方案", contracts: null }),
    ).pending,
    ["design-doc"],
  );
  // 裸名登记在门① 之后 ⇒ 改造文档仍未登记（同一判据、只换 marker）
  assert.deepEqual(
    deriveStageDetail(rec({ decisions: CONF_DOC, version: "v0.10.5", stage: "改造方案" })).pending,
    ["design-doc"],
  );
});

// ===========================================================================
// G4 —— `gate` 三段推导式
// ===========================================================================

test("G4 `waiting_approval`：stage=需求分析 ⇒ gate1 / 否则 ⇒ gate2（不分欠账是哪枚）", () => {
  assert.equal(deriveStageDetail(rec()).gate, "gate1");
  assert.equal(deriveStageDetail(rec({ decisions: CONF_DOC, version: "v0.10.5" })).gate, "gate1");
  assert.equal(
    deriveStageDetail(
      rec({ decisions: BOTH_DOCS, version: "v0.10.5", stage: "改造方案", approval: "待审批" }),
    ).gate,
    "gate2",
  );
});

test("G4 非 `waiting_approval` 全态 ⇒ `null`", () => {
  for (const state of ALL_STATES.filter((s) => s !== "waiting_approval")) {
    assert.equal(deriveStageDetail(rec({ state })).gate, null, state);
  }
});

// ===========================================================================
// G5 —— `actor` 逐枚点名归向（★v22 语义 = 本阶段推动方 / 执行方）
// ===========================================================================

test("G5 归向分界：门① 格仅剩 `stage` ⇒ user；同一格再多一枚宿主自办项 ⇒ host", () => {
  // #3 pending=["stage"]（人的确认凭据）⇒ user
  assert.equal(
    deriveStageDetail(rec({ decisions: CONF_DOC, version: "v0.10.5" })).actor,
    "user",
    "#3",
  );
  // #1 pending=["requirement-doc"]（宿主自办登记）⇒ host —— **不逐枚点名则本格会与逐格表冲突**
  assert.equal(deriveStageDetail(rec({ version: "v0.10.5" })).actor, "host", "#1");
  // #4 pending=["design-doc"] ⇒ host
  assert.equal(
    deriveStageDetail(rec({ decisions: CONF_DOC, version: "v0.10.5", stage: "改造方案" })).actor,
    "host",
    "#4",
  );
  // #6 pending=[]（无宿主自办项）⇒ user
  assert.equal(
    deriveStageDetail(
      rec({ decisions: BOTH_DOCS, version: "v0.10.5", stage: "改造方案", approval: "待审批" }),
    ).actor,
    "user",
    "#6",
  );
  // ⚠ 逐枚点名的规则结果：#2 pending=["version"]（宿主自办）⇒ **host**；确认单逐行草案 #2 行写的是
  // `user`（v13 措辞遗留）。本锚按**定稿规则**（改造文档 C.1#5 归向分类）锁定，差异已回传宿主。
  assert.equal(deriveStageDetail(rec({ decisions: CONF_DOC })).actor, "host", "#2");
});

test("G5 `executing` ⇒ engine **无条件**（不因静止改写、不因 stage 陈旧改写）", () => {
  for (const stage of ["改造", "回归", "改造方案"] as FeatureStage[]) {
    assert.equal(deriveStageDetail(rec({ state: "executing", stage })).actor, "engine", stage);
  }
});

test("G5 逐格：engaging 四格 host · reviewing user · needs_input host · 终态 null", () => {
  for (const state of ["version_planning", "decomposing", "integrating", "testing"] as FeatureState[]) {
    assert.equal(deriveStageDetail(rec({ state })).actor, "host", state);
  }
  assert.equal(deriveStageDetail(rec({ state: "reviewing" })).actor, "user");
  assert.equal(deriveStageDetail(rec({ state: "needs_input" })).actor, "host");
  for (const state of ["completed", "failed", "cancelled"] as FeatureState[]) {
    assert.equal(deriveStageDetail(rec({ state })).actor, null, state);
  }
});

// ===========================================================================
// G6 —— 文案表逐格在位 + 能力陈述约束 + 回显三枚恒等
// ===========================================================================

test("G6 逐格 `action` 字面锚（确认单 v22 草案 · `executing` 行字面由用户点名保留）", () => {
  for (const [label, input, expected] of EXPECTED_ACTIONS) {
    assert.equal(deriveStageDetail(input).action, expected, label);
  }
  // 全态各有文案（非空串），且 `waiting_approval` 按欠账分格 ⇒ 文案表覆盖 10 态 + 6 格
  assert.equal(Object.keys(STAGE_DETAIL_ACTIONS).length, ALL_STATES.length - 1);
  assert.equal(Object.keys(WAITING_APPROVAL_ACTIONS).length, 6);
});

test("G6 能力陈述式：`action` 一个字都不含流程判断（§6 ⑧ 的机械可核形态）", () => {
  const forbidden = [
    "前置已满足",
    "应当推进",
    "满足",
    "名额",
    "载体",
    "三档",
    "ready",
    "criteria",
    "prerequisite",
    "should advance",
  ];
  const all = [
    ...Object.values(STAGE_DETAIL_ACTIONS),
    ...Object.values(WAITING_APPROVAL_ACTIONS),
    ...EXPECTED_ACTIONS.map(([, , action]) => action),
  ];
  for (const text of all) {
    for (const word of forbidden) {
      assert.equal(text.includes(word), false, `${text} 含禁词 ${word}`);
    }
    assert.equal(text.endsWith("."), true, text);
  }
});

test("G6 回显三枚 = 传入行同值恒等（平铺摆法的代价对冲；接线后即「顶层 === 同层 `feature.*`」）", () => {
  const inputs: FeatureRecord[] = [
    rec(),
    rec({ stage: "改造方案", approval: "待审批", version: "v0.10.5", decisions: BOTH_DOCS }),
    rec({ state: "executing", stage: "回归", approval: "已通过", version: "0.11.0" }),
    rec({ state: "completed", stage: "发版", approval: "已通过", version: "v0.10.5" }),
    rec({ state: "needs_input", stage: "改造", approval: "已通过", version: "v0.10.5" }),
  ];
  for (const input of inputs) {
    const detail = deriveStageDetail(input);
    assert.equal(detail.stage, input.stage);
    assert.equal(detail.approval, input.approval);
    assert.equal(detail.version, input.version);
  }
});

// ===========================================================================
// G8 —— 不变量：五维不变 ⇒ 四枚逐字不变（陈旧 `stage` 照读、不另存第五枚）
// ===========================================================================

test("G8 与明细无关的字段（title / contextId / 时间戳 / 归属 / 父链 / plan）不得影响四枚", () => {
  const base = rec({ decisions: BOTH_DOCS, version: "v0.10.5", stage: "改造", approval: "已通过" });
  const four = (r: FeatureRecord) => {
    const d = deriveStageDetail(r);
    return JSON.stringify([d.pending, d.gate, d.actor, d.action]);
  };
  assert.equal(
    four(base),
    four(
      rec({
        ...base,
        featureId: "another",
        title: "另一条需求",
        contextId: "ctx-1",
        plan: "…",
        requirement: "…",
        contracts: "…",
        ownerGroup: "g1",
        parentFeatureId: "p1",
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ),
  );
});

test("G8 陈旧 `stage`：同 `state` 不同 `stage` ⇒ 派生四枚逐字相同，且不另存第五枚", () => {
  // #12 实测形态：引擎自动进 `integrating` 时 `stage` 仍 `改造`（O7 缺口），四枚不得因此漂移
  const fresh = deriveStageDetail(
    rec({ state: "integrating", stage: "回归", decisions: BOTH_DOCS, version: "v0.10.5", approval: "已通过" }),
  );
  const stale = deriveStageDetail(
    rec({ state: "integrating", stage: "改造", decisions: BOTH_DOCS, version: "v0.10.5", approval: "已通过" }),
  );
  assert.deepEqual([fresh.pending, fresh.gate, fresh.actor, fresh.action], [
    stale.pending,
    stale.gate,
    stale.actor,
    stale.action,
  ]);
  assert.equal(stale.stage, "改造", "陈旧值**照读**，不臆造、不纠正");
  assert.deepEqual(Object.keys(stale).sort(), Object.keys(fresh).sort(), "不得为标记陈旧而多出第五枚键");
});

test("G8 派生入参只有 FeatureRecord 一维 ⇒ 节点账面进不来（静止 / 失败不由 `actor` 承载）", () => {
  assert.equal(deriveStageDetail.length, 1);
  const a = deriveStageDetail(rec({ state: "executing" }));
  const b = deriveStageDetail(rec({ state: "executing" }));
  assert.deepEqual(a, b);
  assert.equal(a.actor, "engine");
  // 「注入 failed 节点后四枚不变」的 store 级形态随接线锚（N3/N4/N5）落地：本函数无任务入参，
  // 已在本格构成**类型级**保证（多传参数编译不过）。
});

// ===========================================================================
// N3 —— `advance` **四条成功出口**的接线锚
//
// **G7（advance 段）** 出口在场性 · **G9** 写后重读 · **G10** 五维不变 ⇒ 四枚逐字相同（不读节点态）。
// 四条出口 = 登记特例（`to` = 当前态）/ 只补归属 / 合法流转 / `retryTaskIds` 重派。
// ===========================================================================

const GROUP = "g-x-n3";
const VERSION = "0.10.5";
/** 归属写用的 project 台账行（顺序 = 先建版、再写归属，倒序必被归属写口拒） */
const PROJECT = "p-x-n3";
const PROJECT_VERSION = "1.0.0";
/** 平铺七枚（G2 钉派生函数自身的形状，本组钉**出口出参**的形状） */
const SEVEN_KEYS = ["stage", "approval", "version", "pending", "gate", "actor", "action"] as const;

function expectOk<T extends { ok: boolean }>(outcome: T, label: string): Extract<T, { ok: true }> {
  if (!outcome.ok) {
    const f = outcome as unknown as FeatureToolFailure;
    throw new Error(`${label}：期望成功，实际失败 ${f.code} ${f.error}`);
  }
  return outcome as Extract<T, { ok: true }>;
}

function advance(
  args: Parameters<typeof handleFeatureAdvance>[0],
  label: string,
): FeatureAdvanceExit {
  return expectOk(handleFeatureAdvance(args, GROUP), label);
}

/** 五维快照（G9 / G10 的「不变 / 已变」核对面 —— 派生四枚的输入域，逐维点名） */
function dims(featureId: string): Record<string, unknown> {
  const row = getFeature(featureId);
  assert.ok(row, `夹具行应可读回：${featureId}`);
  return {
    state: row.state,
    stage: row.stage,
    approval: row.approval,
    version: row.version,
    decisions: row.decisions,
  };
}

/** 派生四枚的可比对面（JSON 逐字比较，含数组与 null） */
function fourOf(out: FeatureAdvanceExit): string {
  const bag = out as unknown as Record<string, unknown>;
  return JSON.stringify([bag["pending"], bag["gate"], bag["actor"], bag["action"]]);
}

/**
 * 一张夹具卡：`close()` 起干净库 ⇒ 组台账灌版号 ⇒ 直接铺登记面（`state` 走 store 写口，
 * 本文件不重跑调度器 —— 与 `v0105-x-bbc7ea28-gate1-decision-doc.test.ts` 同款形态）。
 * `decisions` 不在 create 入参面 ⇒ 经 Context 写口落（与真实路径同一写口）。
 */
function seedCard(
  id: string,
  over: {
    state?: FeatureState;
    stage?: FeatureStage;
    approval?: "未发起" | "待审批" | "已通过";
    version?: string;
    decisions?: string | null;
    /** 挂父（增补 / 承接轨）—— N4 的 `approve` 分流夹具用；缺省无父 = 主轨 */
    parentFeatureId?: string;
  } = {},
): FeatureRecord {
  close();
  expectOk(versionLedgerCreate({ ownerGroup: GROUP, version: VERSION }), "组台账灌版号");
  createFeature({
    featureId: id,
    title: `x-n3-${id}`,
    ownerGroup: GROUP,
    state: over.state ?? "waiting_approval",
    stage: over.stage ?? "改造方案",
    approval: over.approval ?? "已通过",
    version: over.version ?? VERSION,
    parentFeatureId: over.parentFeatureId ?? null,
  });
  if (over.decisions !== undefined) {
    updateFeatureContext(id, { decisions: over.decisions });
  }
  const row = getFeature(id);
  assert.ok(row, `夹具卡应可读回：${id}`);
  return row;
}

/** 在当前卡上铺一枚可重派的 `failed` 节点（G7 / G9 的 `retryTaskIds` 出口夹具） */
function seedFailedNode(taskId: string, featureId: string): void {
  createTask({
    taskId,
    projectId: PROJECT,
    contextId: `ctx-${featureId}-${taskId}`,
    state: "working",
    featureId,
    dependencies: null,
  });
  updateTaskState(taskId, "failed", null, "boom");
}

/**
 * **带明细的成功出口形**（N3 = `advance` 四出口；N4 = `create` / `approve`；
 * N5 = `feature_status` **单查**出口）—— 供 {@link assertFlatSeven} 收口，
 * 本文件只写**一份**七枚平铺的核对面。
 */
type DetailBearingExit =
  | FeatureAdvanceExit
  | FeatureCreateSuccess
  | FeatureApproveSuccess
  | FeatureStatusSingleSuccess;

/**
 * 出口出参的形状 + 同源判据：七枚**平级在顶层**（无包装），且逐枚 === 写后重读行的
 * {@link deriveStageDetail} 值（出口不另存第二套推导）。
 */
function assertFlatSeven(out: DetailBearingExit, featureId: string, label: string): void {
  const bag = out as unknown as Record<string, unknown>;
  for (const key of SEVEN_KEYS) {
    assert.equal(key in bag, true, `${label}：七枚之「${key}」须平铺在顶层`);
  }
  for (const wrapper of ["next", "detail", "stageDetail"]) {
    assert.equal(wrapper in bag, false, `${label}：不得出现「${wrapper}」包装对象`);
  }
  const row = getFeature(featureId);
  assert.ok(row, `${label}：夹具行应可读回`);
  const fresh = deriveStageDetail(row);
  for (const key of SEVEN_KEYS) {
    assert.deepEqual(bag[key], fresh[key], `${label}：「${key}」= 写后重读行的单源派生值`);
  }
}

// ---- G7 —— 四条出口的在场性 --------------------------------------------------

test("G7（advance 段）登记特例出口 ⇒ 七枚平铺在顶层且与单源派生逐字相同", () => {
  const card = seedCard("x-n3-g7-reg", {
    stage: "改造方案",
    approval: "待审批",
    decisions: BOTH_DOCS,
  });
  const out = advance(
    { featureId: card.featureId, to: "waiting_approval", stage: "改造方案", note: "只写登记" },
    "登记特例出口",
  );
  assert.equal(out.state, "waiting_approval", "登记特例零迁移");
  assert.equal(out.note, "只写登记", "既有键 `note` 原样保留（不入明细）");
  assertFlatSeven(out, card.featureId, "登记特例出口");
  // 本格的语义读数：登记面已清账（两档名在册 · 待审批）⇒ 等的是门②
  assert.deepEqual(out.pending, []);
  assert.equal(out.gate, "gate2");
  assert.equal(out.actor, "user");
});

test("G7（advance 段）只补归属出口 ⇒ 七枚平铺在顶层（`attribution` 不入明细）", () => {
  const card = seedCard("x-n3-g7-attr", { decisions: BOTH_DOCS });
  expectOk(
    projectVersionCreate({
      ownerGroup: GROUP,
      projectId: PROJECT,
      version: PROJECT_VERSION,
    }),
    "project 台账建版",
  );
  const out = advance(
    {
      featureId: card.featureId,
      to: "waiting_approval",
      projectVersions: [{ projectId: PROJECT, version: PROJECT_VERSION }],
    },
    "只补归属出口",
  );
  assert.equal(out.state, "waiting_approval", "只补归属零迁移");
  assert.deepEqual(out.attribution, { created: 1, updated: 0, noop: 0 }, "归属写出三档计数照旧");
  assertFlatSeven(out, card.featureId, "只补归属出口");
});

test("G7（advance 段）合法流转出口 ⇒ 七枚平铺在顶层，`action` 取迁入那格的文案", () => {
  const card = seedCard("x-n3-g7-flow", { state: "integrating", stage: "回归" });
  const out = advance(
    { featureId: card.featureId, to: "testing", note: "门禁全绿" },
    "合法流转出口",
  );
  assert.equal(out.state, "testing");
  assertFlatSeven(out, card.featureId, "合法流转出口");
  assert.equal(out.action, STAGE_DETAIL_ACTIONS.testing);
});

test("G7（advance 段）retryTaskIds 出口 ⇒ 七枚平铺在顶层，`rearmed` / `unfrozen` 原样保留", () => {
  const card = seedCard("x-n3-g7-retry", { state: "executing", stage: "改造" });
  seedFailedNode("A", card.featureId);
  const out = advance(
    { featureId: card.featureId, to: "executing", retryTaskIds: ["A"] },
    "retryTaskIds 出口",
  );
  assert.deepEqual(out.rearmed, ["A"], "重派动作面原样回显");
  assert.equal(out.state, "executing", "重派无状态转移");
  assertFlatSeven(out, card.featureId, "retryTaskIds 出口");
});

// ---- G9 —— 写后重读（明细报的是**推进后**那一格，不是写前快照） ----------------

test("G9 登记特例 = 门① 那一单 ⇒ `stage` 抬完即清 `stage` 欠账（写前快照形态会报 pending:[\"stage\"]）", () => {
  const card = seedCard("x-n3-g9-gate1", {
    stage: "需求分析",
    approval: "未发起",
    decisions: CONF_DOC,
  });
  assert.deepEqual(dims(card.featureId), {
    state: "waiting_approval",
    stage: "需求分析",
    approval: "未发起",
    version: VERSION,
    decisions: CONF_DOC,
  });

  const out = advance(
    { featureId: card.featureId, to: "waiting_approval", stage: "改造方案" },
    "门① 过门单",
  );
  assert.equal(getFeature(card.featureId)?.stage, "改造方案", "登记写已落库（重读读得到）");
  assert.equal(out.stage, "改造方案", "回显枚 = 写后值，不是写前的「需求分析」");
  assert.deepEqual(out.pending, ["design-doc"], "欠账随抬位当场清账");
  assert.equal(out.actor, "host", "本阶段推动方 = 迁入那格的（宿主自办项 design-doc）");
  assert.equal(out.gate, "gate2", "门① 已过 ⇒ 前方是门②");
});

test("G9 合法流转 = `reviewing → completed` ⇒ `actor` 报迁入格（终态 null；写前快照会报 user）", () => {
  const card = seedCard("x-n3-g9-completed", {
    state: "reviewing",
    stage: "验收",
    decisions: BOTH_DOCS,
  });
  const out = advance(
    { featureId: card.featureId, to: "completed", note: "用户验收结论" },
    "验收 → 完成",
  );
  assert.equal(out.state, "completed");
  assert.equal(out.actor, null, "终态 = 本阶段无推动方（**不得**读成「卡住」）");
  assert.equal(out.action, STAGE_DETAIL_ACTIONS.completed, "文案 = 迁入格，不是被离开的 reviewing");
  assert.equal(out.pending.length, 0, "终态不携带登记欠账");
});

test("G9 只补归属 = 同单登记《改造文档》⇒ `pending` 当场清账（写前快照形态会停在 design-doc）", () => {
  const card = seedCard("x-n3-g9-attr", { decisions: CONF_DOC });
  expectOk(
    projectVersionCreate({ ownerGroup: GROUP, projectId: PROJECT, version: PROJECT_VERSION }),
    "project 台账建版",
  );
  const out = advance(
    {
      featureId: card.featureId,
      to: "waiting_approval",
      decisions: BOTH_DOCS,
      projectVersions: [{ projectId: PROJECT, version: PROJECT_VERSION }],
    },
    "归属 + 档名同单",
  );
  assert.equal(getFeature(card.featureId)?.decisions, BOTH_DOCS, "Context 写已落库");
  assert.deepEqual(out.pending, [], "`decisions` 是五维之一 ⇒ 参与推导，须读到写后值");
});

test("G9 retryTaskIds = 同单登记 `approval` 待审批 ⇒ `pending` 当场清账（重派与登记同一次写入）", () => {
  const card = seedCard("x-n3-g9-retry", {
    state: "executing",
    stage: "改造方案",
    approval: "未发起",
    decisions: BOTH_DOCS,
  });
  seedFailedNode("A", card.featureId);
  const out = advance(
    {
      featureId: card.featureId,
      to: "executing",
      retryTaskIds: ["A"],
      approval: "待审批",
    },
    "重派同单带登记",
  );
  assert.equal(getFeature(card.featureId)?.approval, "待审批", "登记写在重派校验全通过后落笔");
  assert.deepEqual(out.pending, [], "写前快照形态会报 [\"approval\"]");
  assert.equal(out.actor, "engine", "executing 格 ⇒ engine（无条件）");
});

// ---- G10 —— 五维不变 ⇒ 四枚逐字相同（不读节点态） ----------------------------

test("G10 同一出口 · 注入 failed 节点前后五维不变 ⇒ 派生四枚逐字相同（`actor` 不接节点账面）", () => {
  const card = seedCard("x-n3-g10", { state: "executing", stage: "改造", decisions: BOTH_DOCS });
  // 两次同一登记写（同值 ⇒ `updateFeatureRegistration` 的 diff 归零，五维逐字不动）
  const run1 = advance(
    { featureId: card.featureId, to: "executing", stage: "改造" },
    "G10 第一跑",
  );
  const dimsAfterRun1 = dims(card.featureId);
  const four1 = fourOf(run1);

  seedFailedNode("X", card.featureId);
  seedFailedNode("Y", card.featureId);
  const run2 = advance(
    { featureId: card.featureId, to: "executing", stage: "改造" },
    "G10 第二跑（名下已有两枚 failed 节点）",
  );

  assert.deepEqual(dims(card.featureId), dimsAfterRun1, "五维未动 ⇒ 本条的「不变」前提自证");
  assert.equal(fourOf(run2), four1, "五维不变 ⇒ 四枚逐字相同（节点账面进不来）");
  assert.equal(run2.actor, "engine", "`executing` 恒 engine：不因失败 / 静止改写");
  assert.equal(run2.action, STAGE_DETAIL_ACTIONS.executing);
});

// ===========================================================================
// N4 —— `create` / `approve` 成功出口的接线锚
//
// **G7（`create` / `approve` 段）** 出口在场性 · **G9（approve）** 写后重读。
// 本增补的域 = `create` 与 `approve` **二者都必须带**明细；`cancel` **不带** ⇒ 其负锚归 **N5**
// （G11），本段不写。`approve` 的**入参面零改动**由既有套件
// `test/v0101-o3-advance-attribution.test.ts` 的对应锚把门，本段不重复钉。
// ===========================================================================

function approve(featureId: string, label: string): FeatureApproveSuccess {
  return expectOk(handleFeatureApprove({ featureId }, GROUP), label);
}

function create(
  args: Parameters<typeof handleFeatureCreate>[0],
  label: string,
): FeatureCreateSuccess {
  return expectOk(handleFeatureCreate(args, GROUP), label);
}

// ---- G7（create 段）—— 新卡出口的在场性 -------------------------------------

test("G7（create 出口）未排期新卡 ⇒ 七枚平铺在顶层，明细按新行**硬编码初值**算", () => {
  close();
  const out = create({ title: "x-n4-create" }, "create 出口（未排期）");
  assertFlatSeven(out, out.featureId, "create 出口");
  // 既有键不回退
  assert.equal(out.state, "waiting_approval", "初态 = 主链起点");
  assert.equal(out.title, "x-n4-create");
  // 回显三枚 = create 的硬编码初值（v0.10.5 O4 初值恒定）
  assert.equal(out.stage, "需求分析");
  assert.equal(out.approval, "未发起");
  assert.equal(out.version, "", "未传 version ⇒ 空串（未排期停靠）");
  // 派生四枚 = 本格语义读数
  assert.deepEqual(out.pending, ["requirement-doc"], "create 无 decisions ⇒ 首欠确认单");
  assert.equal(out.gate, "gate1");
  assert.equal(out.actor, "host", "确认单是宿主自办登记项");
  assert.equal(out.action, WAITING_APPROVAL_ACTIONS["requirement-doc"]);
});

test("G7（create 出口）已排期新卡 ⇒ `version` 回显传入值，`pending` 仍按固定序报首欠", () => {
  close();
  expectOk(versionLedgerCreate({ ownerGroup: GROUP, version: VERSION }), "组台账灌版号");
  const out = create({ title: "x-n4-create-v", version: VERSION }, "create 出口（已排期）");
  assertFlatSeven(out, out.featureId, "create 出口（已排期）");
  assert.equal(out.version, VERSION, "回显枚 = 落库后读回的值");
  assert.deepEqual(
    out.pending,
    ["requirement-doc"],
    "欠账扫描是**固定序**（确认单 → 排期 → …）⇒ 排期已清不改变首项",
  );
});

// ---- G7（approve 段）—— 过审出口的在场性（含父链分流后的本格读数） ----------

test("G7（approve 出口 · 主轨无父）⇒ 七枚平铺在顶层，`action` 取迁入格 version_planning", () => {
  const card = seedCard("x-n4-ap-main", { approval: "待审批", decisions: BOTH_DOCS });
  const out = approve(card.featureId, "approve 出口（主轨）");
  assert.equal(out.state, "version_planning", "主轨后继 = PjM 工序格");
  assertFlatSeven(out, card.featureId, "approve 出口（主轨）");
  assert.equal(out.gate, null, "已离 `waiting_approval` ⇒ 不在用户门上");
  assert.equal(out.actor, "host", "version_planning 格由宿主推动");
  assert.equal(out.action, STAGE_DETAIL_ACTIONS.version_planning);
  assert.deepEqual(out.pending, [], "两档名在册 · 已排期 · `stage` 已抬 · approval 已通过");
});

test("G7（approve 出口 · 有父的增补 / 承接轨）⇒ 分流 decomposing，明细报 decomposing 那一格", () => {
  // 父链**只存不解析** ⇒ 分流判据 = `parentFeatureId !== null`，夹具无需真有父行
  const card = seedCard("x-n4-ap-child", {
    approval: "待审批",
    decisions: BOTH_DOCS,
    parentFeatureId: "x-n4-parent",
  });
  const out = approve(card.featureId, "approve 出口（有父）");
  assert.equal(out.state, "decomposing", "有父 ⇒ 跳过 version_planning");
  assertFlatSeven(out, card.featureId, "approve 出口（有父）");
  assert.equal(out.action, STAGE_DETAIL_ACTIONS.decomposing);
});

// ---- G9（approve）—— 写后重读（明细报的是**过审后**那一格） -----------------

test("G9（approve 出口）写后重读 ⇒ `approval` 回显「已通过」、明细报迁入格（写前快照会报 gate2 + 待审批）", () => {
  const card = seedCard("x-n4-g9-approval", { approval: "待审批", decisions: BOTH_DOCS });
  assert.equal(getFeature(card.featureId)?.approval, "待审批", "夹具起点：待审批");

  const out = approve(card.featureId, "approve 写后重读");

  assert.equal(getFeature(card.featureId)?.approval, "已通过", "过审写已落库（重读读得到）");
  assert.equal(out.approval, "已通过", "回显枚 = 写后值，不是写前快照的「待审批」");
  assert.equal(out.gate, null, "写前快照形态会报 gate2（= 被离开的 `waiting_approval` 那一格）");
  assert.equal(out.actor, "host", "写前快照形态会按 `waiting_approval` 判交报 user");
  assert.equal(out.action, STAGE_DETAIL_ACTIONS.version_planning, "文案 = 迁入格，不是被离开的那格");
});

// ===========================================================================
// N5 —— `feature_status` **单查**出口的接线锚 + 两枚**负锚**（G11）
//
// **G7（feature_status 段）** = 单查在场性 + 与 `advance` 出口的同源面；
// **G11** = ① 列表分支不带明细（本增补的域只圈单查）② `cancel` 出参不带明细
// （`cancel` 代码归 N4 的「不改」范围 —— 本段只写负锚、不动 `handleFeatureCancel`）。
// ===========================================================================

/**
 * 单查出口形。`handleFeatureStatus` 的**声明**返回两分支共用的兼容形
 * （{@link FeatureStatusSuccess}，七枚在其上可选 ⇒ 列表分支才编译得过），
 * 「单查必带」的执法点在 handler 内部出口字面量的 {@link FeatureStatusSingleSuccess} 标注；
 * 本文件的测试面在此收口为该形（`assertFlatSeven` 做运行时的在场性核对）。
 */
function statusSingle(featureId: string, label: string): FeatureStatusSingleSuccess {
  return expectOk(handleFeatureStatus({ featureId }, GROUP), label) as FeatureStatusSingleSuccess;
}

/** 出参的七枚平铺面（两出口逐枚对照用） */
function sevenOf(out: object): Record<string, unknown> {
  const bag = out as Record<string, unknown>;
  return Object.fromEntries(SEVEN_KEYS.map((key) => [key, bag[key]] as const));
}

test("G7（feature_status 单查出口）⇒ 七枚平铺在顶层、逐枚 === 单源派生；回显三枚 === 同层 `feature.*`", () => {
  const card = seedCard("x-n5-st-gate1", {
    state: "waiting_approval",
    stage: "需求分析",
    approval: "未发起",
    decisions: CONF_DOC,
  });
  const out = statusSingle(card.featureId, "单查出口（门① 前）");
  assertFlatSeven(out, card.featureId, "feature_status 单查出口");
  // 平铺摆法的代价对冲：顶层三枚与同层 `feature.*` 逐字同值（同一行、同一读口 ⇒ 无第二份事实源）
  assert.equal(out.stage, out.feature?.stage);
  assert.equal(out.approval, out.feature?.approval);
  assert.equal(out.version, out.feature?.version);
  // 本格语义读数：确认单在册 · 已排期 · `stage` 仍「需求分析」⇒ 欠的是门① 那枚抬位
  assert.deepEqual(out.pending, ["stage"]);
  assert.equal(out.gate, "gate1");
  assert.equal(out.actor, "user");
  assert.equal(out.action, WAITING_APPROVAL_ACTIONS.stage);
});

test("G7（feature_status 单查出口 · `executing` 格）⇒ 明细报该格，既有键零回退", () => {
  const card = seedCard("x-n5-st-exec", {
    state: "executing",
    stage: "改造",
    approval: "已通过",
    decisions: BOTH_DOCS,
  });
  const out = statusSingle(card.featureId, "单查出口（executing）");
  assertFlatSeven(out, card.featureId, "feature_status 单查出口（executing）");
  assert.equal(out.actor, "engine", "`executing` 恒 engine（additive 接线不改派生语义）");
  assert.equal(out.action, STAGE_DETAIL_ACTIONS.executing);
  assert.equal(out.gate, null, "已离 `waiting_approval` ⇒ 不在用户门上");
  // 既有面不回退（明细是**加**出来的，不是把单查出参换掉的）
  assert.equal(out.feature?.featureId, card.featureId);
  assert.ok(Array.isArray(out.tasks), "`tasks` 摘要照在");
  assert.ok(Array.isArray(out.artifacts), "`artifacts` 照在");
  assert.ok(Array.isArray(out.acceptance?.stages), "`acceptance` 聚合块照在");
  assert.deepEqual(out.projects, [], "归属 `projects` 照在（无归属 ⇒ 空数组，v0.10.1 O7 口径）");
});

test("G7（feature_status 单查出口）同源面 ⇒ 七枚与同一行上的 `advance` 出口逐字同值（读面不另存第二套推导）", () => {
  const card = seedCard("x-n5-st-same", {
    state: "waiting_approval",
    stage: "需求分析",
    approval: "未发起",
    decisions: CONF_DOC,
  });
  const adv = advance(
    { featureId: card.featureId, to: "waiting_approval", stage: "改造方案" },
    "门① 过门单（写侧出口）",
  );
  const st = statusSingle(card.featureId, "门① 之后单查（读侧出口）");
  assert.deepEqual(sevenOf(st), sevenOf(adv), "写侧出口与读侧出口 = 同一行、同一单源 ⇒ 七枚逐字同值");
});

// ---- G11 —— 两枚负锚：域的另一半（列表分支不带 · `cancel` 不带） ----------------

test("G11 列表分支 ⇒ 信封**不带**明细七枚（键恒缺；行内的登记字段不受影响）", () => {
  seedCard("x-n5-g11-list", { decisions: BOTH_DOCS });
  const list = expectOk(handleFeatureStatus({}, GROUP), "列表分支");
  for (const key of SEVEN_KEYS) {
    assert.equal(key in list, false, `列表信封不得出现「${key}」`);
  }
  // 列表行仍是 `FeatureRecord` 展开 ⇒ 行内 `stage`/`version`/`approval` 照在（信封与行两不相犯）
  assert.equal(list.features?.length, 1, "夹具卡可见");
  const row = list.features?.[0];
  assert.equal(row?.stage, "改造方案", "行内登记字段 = 既有形状，不是本增补新加的顶层明细");
  assert.equal("pending" in (row ?? {}), false, "行内也不派生四枚");
});

test("G11 cancel 出口 ⇒ 出参**不带**明细（负锚 = 「pending」不在 cancelOut 上 · 共用基类型未宽化的凭据）", () => {
  const card = seedCard("x-n5-g11-cancel", { state: "executing", stage: "改造", decisions: BOTH_DOCS });
  const cancelOut = expectOk(
    handleFeatureCancel({ featureId: card.featureId }, GROUP),
    "cancel 出口",
  );
  assert.equal("pending" in cancelOut, false, "cancel 不带明细（本增补域外）");
  for (const key of SEVEN_KEYS) {
    assert.equal(key in cancelOut, false, `cancel 出参不得出现「${key}」`);
  }
  assert.deepEqual(Object.keys(cancelOut).sort(), ["featureId", "from", "ok", "state"], "出参形状逐字 = 共用基形四键");
  assert.equal(cancelOut.state, "cancelled", "既有归档动作不回退");
});
