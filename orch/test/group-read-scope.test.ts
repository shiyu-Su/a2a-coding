/**
 * v0.8.6 req01 · N3 · 只读面出口的按身份隔离（`bridge/index.ts`：§2.4 出口补齐 A + §1.3 R-2）。
 *
 * 覆盖节点验收（改造文档 §2.4 / §2.5-R2 / §3.3 出口穷举表 6/7/8 / §6.1-2）：
 * ① `a2a_tasks` 成员前置（照 `handleTaskStatus` 形态）：本组项目可见、他组项目
 *    `project_not_a_member`；无身份 ⇒ 全组**并集**（配组下仍非并集外的项目照样拒）；
 * ② **可达性探测按身份**：同一 `projectId` 在两组里落在**不同机器**时，本组探测只看本组
 *    成员机器 ⇒ 他组机器上报了该项目也**不得**让本组判 `reachable=true`
 *    （全局组形态下正是这个泄漏：会跨组探到并谎报可达）；
 * ③ **「他组有新事件」场景**（§6.1-2 明文要求构造）：全局 `latestEventId()` 已长进，但本组
 *    `latestEventId(scope)` 不长进 ⇒ `a2a_events` 空返回且**游标不被抬高**、`a2a_wait`
 *    超时空返回（不空转、不误唤醒）；随后本组自己的新事件**照常读到**（证按身份游标
 *    不是「永久漏读」，而是 R-2 要修的那个反面）；
 * ④ **孤儿事件**（`feature_id` / `task_id` 皆 NULL，如 `runner.*`）⇒ 对两组都可见；
 * ⑤ **未知身份 fail-closed**（I2）：连错组名 ⇒ 只见孤儿事件，**绝不回退全量**；
 * ⑥ 防 vacuous：全局 `fetch` 替换为**计数桩且一律抛错** ⇒ 只读三路（tasks / events / wait）
 *    全程零出站。
 *
 * 夹具约束同 `project-group.test.ts`：`MACHINES_CONFIG_PATH` 是 `bridge/index.ts` 的
 * **模块加载期常量** ⇒ `MACHINES_CONFIG` 必须在 **import 之前**设好（本文件用动态 import）。
 * 游标 Map 是**模块级**（进程内共享）⇒ 用例 ③/④ 刻意写在**同一个 test 内按序推进**，
 * 让「游标初值 → 他组事件 → 本组事件」的时序可精确断言。
 */
process.env["SESSION_DB"] = ":memory:"; // 必须在首次触碰 store 之前

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvent,
  createTask,
  latestEventId,
  runnerProjectsReplace,
  upsertRunner,
} from "../session/store.js";
import type { BridgeCore } from "../bridge/index.js";

// ---------------------------------------------------------------------------
// 零出站计数桩
// ---------------------------------------------------------------------------

let outboundCount = 0;
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const originalFetch = globalThis.fetch;
const throwingFetch: FetchFn = async (input) => {
  outboundCount += 1;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`只读出口不应有任何出站请求：${url}`);
};
globalThis.fetch = throwingFetch;

// ---------------------------------------------------------------------------
// 机器清单：3 台机器 + **两个组**
//   gA = { m1 / alpha }
//   gB = { m2 / beta, m3 / alpha }   ← `alpha` 在两组落在**不同机器**（成员互斥按
//                                        (machineId, projectId) 对，故这是合法配置），
//                                        专门用来验 ②「探测按身份」
// ---------------------------------------------------------------------------

const CFG_DIR = mkdtempSync(join(tmpdir(), "a2a-n3-readscope-"));
const CFG_PATH = join(CFG_DIR, "config.json");
process.env["MACHINES_CONFIG"] = CFG_PATH; // 必须在 import bridge/index.js **之前**

function twoGroupConfig(): Record<string, unknown> {
  return {
    machines: [{ machineId: "m1" }, { machineId: "m2" }, { machineId: "m3" }],
    projectGroup: [
      { name: "gA", members: [{ machineId: "m1", projectId: "alpha" }] },
      {
        name: "gB",
        members: [
          { machineId: "m2", projectId: "beta" },
          { machineId: "m3", projectId: "alpha" },
        ],
      },
    ],
  };
}

function writeTwoGroupConfig(): void {
  writeFileSync(CFG_PATH, JSON.stringify(twoGroupConfig(), null, 2), "utf8");
}

writeTwoGroupConfig();

const { createCore } = await import("../bridge/index.js");
const coreA: BridgeCore = createCore("gA");
const coreB: BridgeCore = createCore("gB");
const coreAnon: BridgeCore = createCore(null);
const coreBogus: BridgeCore = createCore("typo");

after(() => {
  globalThis.fetch = originalFetch;
  rmSync(CFG_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 夹具助手
// ---------------------------------------------------------------------------

function registerRunner(machineId: string, projectIds: string[]): void {
  upsertRunner({ runnerId: machineId, machineId, protocolVersion: "2.0" });
  runnerProjectsReplace(
    machineId,
    projectIds.map((projectId) => ({
      projectId,
      workspace: `C:/secret-ws/${projectId}`,
      agentKind: "opencode" as const,
      a2aPort: 3010,
      status: "online" as const,
      endpoint: `http://127.0.0.1:3010/${projectId}`,
      startedAt: "2026-09-22T00:00:00Z",
    })),
  );
}

interface FailureShape {
  ok: false;
  code: string;
  error: string;
}

function isFailure(v: unknown): v is FailureShape {
  return typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;
}

function expectFailure(v: unknown): FailureShape {
  assert.equal(isFailure(v), true, `期望结构化失败，实得：${JSON.stringify(v)}`);
  return v as FailureShape;
}

interface EventView {
  eventId: number;
  featureId: string | null;
  taskId: string | null;
  kind: string;
  state: string | null;
}

interface EventsShape {
  ok: true;
  cursor: number;
  count: number;
  events: EventView[];
}

interface WaitShape extends EventsShape {
  timedOut: boolean;
}

interface TasksShape {
  ok: true;
  projectId: string;
  reachable: boolean;
  notice?: string;
  tasks: Array<{ taskId: string; state: string }>;
}

function expectEvents(v: unknown): EventsShape {
  assert.equal(isFailure(v), false, `期望事件视图，实得失败：${JSON.stringify(v)}`);
  return v as EventsShape;
}

function expectWait(v: unknown): WaitShape {
  assert.equal(isFailure(v), false, `期望 wait 视图，实得失败：${JSON.stringify(v)}`);
  return v as WaitShape;
}

function expectTasks(v: unknown): TasksShape {
  assert.equal(isFailure(v), false, `期望任务视图，实得失败：${JSON.stringify(v)}`);
  return v as TasksShape;
}

// ---------------------------------------------------------------------------
// ① a2a_tasks 成员前置
// ---------------------------------------------------------------------------

test("① a2a_tasks：本组项目可见 / 他组项目 project_not_a_member / 未知身份同拒，全程零出站", async () => {
  outboundCount = 0;
  registerRunner("m1", ["alpha"]);
  registerRunner("m2", ["beta"]);
  createTask({ taskId: "t-alpha", projectId: "alpha", contextId: "c-a", state: "completed" });
  createTask({ taskId: "t-beta", projectId: "beta", contextId: "c-b", state: "completed" });
  createTask({ taskId: "t-gamma", projectId: "gamma", contextId: "c-g", state: "completed" });

  const ownA = expectTasks(await coreA.tasks("alpha"));
  assert.deepEqual(
    ownA.tasks.map((t) => t.taskId),
    ["t-alpha"],
    "本组项目正常列出",
  );
  const ownB = expectTasks(await coreB.tasks("beta"));
  assert.deepEqual(
    ownB.tasks.map((t) => t.taskId),
    ["t-beta"],
  );

  // 他组项目：gA 无 beta / 两组都无 gamma ⇒ 同一码，且**零副作用**（不查库不探测 ⇒ 零出站）
  assert.equal(expectFailure(await coreA.tasks("beta")).code, "project_not_a_member");
  assert.equal(expectFailure(await coreA.tasks("gamma")).code, "project_not_a_member");
  assert.equal(expectFailure(await coreB.tasks("gamma")).code, "project_not_a_member");
  // 未知身份 ⇒ 与「他组」同口径 fail-closed（不回退全量）
  assert.equal(expectFailure(await coreBogus.tasks("alpha")).code, "project_not_a_member");

  // 无身份（未配组环境 / web 运维视图 §2.7）⇒ **全组聚合**视图：两组项目都可见（并集），
  // 但「不属任何组」的项目仍在成员判据外（聚合 ≠ 全量接纳；全量接纳只出现在**未配组**时）
  assert.equal(expectTasks(await coreAnon.tasks("alpha")).tasks.length, 1);
  assert.equal(expectTasks(await coreAnon.tasks("beta")).tasks.length, 1);
  assert.equal(expectFailure(await coreAnon.tasks("gamma")).code, "project_not_a_member");

  const raw = JSON.stringify(await coreA.tasks("beta"));
  for (const forbidden of ["workspace", "secret-ws", "runnerId", "protocolVersion"]) {
    assert.equal(raw.includes(forbidden), false, `失败文案不得泄漏 ${forbidden}：${raw}`);
  }
  assert.equal(outboundCount, 0, "a2a_tasks 全程零出站");
});

// ---------------------------------------------------------------------------
// ② 可达性探测按身份
// ---------------------------------------------------------------------------

test("② reachability 探测按身份：他组机器上报了同名项目 ⇒ 本组不得判可达（聚合视图会跨组探到）", async () => {
  outboundCount = 0;
  // alpha 在 gA 落 m1、在 gB 落 m3 ⇒ 让 m1 **不**上报 alpha、只让 m3 上报
  registerRunner("m1", ["other"]);
  registerRunner("m3", ["alpha"]);
  createTask({ taskId: "t-w1", projectId: "alpha", contextId: "c-w1", state: "working" });

  const viewA = expectTasks(await coreA.tasks("alpha"));
  assert.equal(viewA.reachable, false, "本组成员机器（m1）未上报 alpha ⇒ 不得跨组经 m3 探到");
  assert.match(viewA.notice ?? "", /未在 Runner 注册表找到项目 alpha/);

  const viewB = expectTasks(await coreB.tasks("alpha"));
  assert.equal(viewB.reachable, true, "gB 的成员机器 m3 上报了 alpha ⇒ 该组判可达");
  assert.equal(viewB.notice, undefined, "命中本组机器 ⇒ 无 notice");
  assert.equal(outboundCount, 0);
});

// ---------------------------------------------------------------------------
// ③④⑤ 事件可见性 + 按身份游标（同一 test 内按序推进，见文件头说明）
// ---------------------------------------------------------------------------

test("③④⑤ 他组新事件：本组 latestEventId 不长进、游标不抬高、a2a_wait 不空转；本组事件照常读到；孤儿事件两组可见；未知身份只见孤儿", async () => {
  outboundCount = 0;

  // --- 起点：两组都空 ⇒ 游标初值 = **本组可见**最大值（此刻 0）
  const startA = expectEvents(coreA.events());
  assert.equal(startA.count, 0);
  assert.equal(startA.cursor, 0, "游标初值必须按身份取（本组无可见事件 ⇒ 0）");

  // --- 他组（gB）造两条可见事件：Feature 级（经 features.owner_group 反查）+ 仅任务级（经项目）
  const featB = coreB.featureCreate({ title: "N3 夹具 · gB Feature" });
  assert.equal(isFailure(featB), false, `gB 建 Feature 应成功：${JSON.stringify(featB)}`);
  const featureIdB = (featB as { ok: true; featureId: string }).featureId;
  createTask({ taskId: "t-b2", projectId: "beta", contextId: "c-b2", state: "completed" });
  appendEvent({ featureId: featureIdB, kind: "feature.state", state: "executing" }); // eventId 1
  appendEvent({ taskId: "t-b2", kind: "task.settled", state: "completed" }); // eventId 2

  // --- 全局口径确实长进了（防 vacuous：不是「压根没事件」，而是「有事件但本组不可见」）
  assert.equal(latestEventId(), 2, "全局最大 eventId 已长进 = 2（他组确有两条新事件）");
  assert.equal(latestEventId({ ownerGroup: "gB", projectIds: ["alpha", "beta"] }), 2);
  assert.equal(latestEventId({ ownerGroup: "gA", projectIds: ["alpha"] }), 0, "本组口径不得长进");

  // --- 本组读：空返回，且**游标绝不被他组事件抬高**（抬高 = 永久漏读本组其后事件）
  const midA = expectEvents(coreA.events());
  assert.deepEqual(
    { count: midA.count, cursor: midA.cursor },
    { count: 0, cursor: 0 },
    "他组事件不得进入本组增量、也不得推进本组游标",
  );

  // --- 他组侧确认这两条**确实**可见（谓词写错会让两组都空 ⇒ 必须排掉）
  const midB = expectEvents(coreB.events(0));
  assert.equal(midB.count, 2, "gB 自读应拿到 Feature 级 + 仅任务级两条");
  assert.deepEqual(
    midB.events.map((e) => [e.eventId, e.kind]),
    [
      [1, "feature.state"],
      [2, "task.settled"],
    ],
  );

  // --- 长轮询：只有他组事件 ⇒ 必须等到超时且零事件（全局判定会误唤醒 ⇒ 空转到超时）
  const waited = await coreA.wait(1_200);
  const waitShape = expectWait(waited);
  assert.equal(waitShape.timedOut, true, "本组无可见新事件 ⇒ 只能超时，不得误报有事件");
  assert.deepEqual({ count: waitShape.count, cursor: waitShape.cursor }, { count: 0, cursor: 0 });

  // --- 本组自己的事件（经 features.owner_group='gA' 归属）⇒ 必须照常读到（无永久漏读）
  const featA = coreA.featureCreate({ title: "N3 夹具 · gA Feature" });
  const featureIdA = (featA as { ok: true; featureId: string }).featureId;
  appendEvent({ featureId: featureIdA, kind: "feature.state", state: "executing" }); // eventId 3

  const ownA = expectEvents(coreA.events());
  assert.equal(ownA.count, 1, "本组新事件必须被本组读到（游标未被跳号）");
  assert.deepEqual(
    { eventId: ownA.events[0]?.eventId, cursor: ownA.cursor },
    { eventId: 3, cursor: 3 },
  );
  // 他组不得读到本组这条
  const afterB = expectEvents(coreB.events());
  assert.equal(afterB.count, 0, "本组事件不得出现在他组增量里");
  assert.equal(
    afterB.events.some((e) => e.eventId === 3),
    false,
  );

  // --- 孤儿事件（feature_id / task_id 皆 NULL：机器级 `runner.*`）⇒ 两组都可见
  appendEvent({ kind: "runner.offline", state: "offline" }); // eventId 4
  const orphanA = expectEvents(coreA.events(0));
  const orphanB = expectEvents(coreB.events(0));
  for (const [name, view] of [
    ["gA", orphanA],
    ["gB", orphanB],
  ] as const) {
    assert.ok(
      view.events.some(
        (e) => e.kind === "runner.offline" && e.featureId === null && e.taskId === null,
      ),
      `孤儿事件必须对 ${name} 可见：${JSON.stringify(view.events.map((e) => e.kind))}`,
    );
  }
  // gA 的完整可见集 = 自己的 feature 事件 + 孤儿；gB = 自己两条 + 孤儿
  assert.deepEqual(
    orphanA.events.map((e) => e.eventId),
    [3, 4],
    "gA 可见集 = 本组归属 + 孤儿（他组两条不得混入）",
  );
  assert.deepEqual(
    orphanB.events.map((e) => e.eventId),
    [1, 2, 4],
  );

  // --- **非成员项目**（gamma 不属任何组）的仅任务事件 ⇒ 任何组都不可见
  //     （孤儿 = 两键皆 NULL 的机器级事件，**不是**「反查不到归属就放行」的兜底）
  createTask({ taskId: "t-g2", projectId: "gamma", contextId: "c-g2", state: "completed" });
  appendEvent({ taskId: "t-g2", kind: "task.settled", state: "completed" }); // eventId 5

  // --- 无身份（未配组匿名 / web 运维视图）⇒ 不过滤，全量可见
  const anon = expectEvents(coreAnon.events(0));
  assert.deepEqual(
    anon.events.map((e) => e.eventId),
    [1, 2, 3, 4, 5],
    "无身份 ⇒ 案 B 不加谓词（零破坏，§2.7）",
  );
  assert.equal(
    expectEvents(coreA.events(0)).events.some((e) => e.eventId === 5),
    false,
    "gA 不得看到非成员项目的事件",
  );

  // --- 未知身份 ⇒ fail-closed：连孤儿事件之外的一条都拿不到（绝不回退全量）
  const bogus = expectEvents(coreBogus.events(0));
  assert.deepEqual(
    bogus.events.map((e) => e.eventId),
    [4],
    "未知身份 ⇒ 只可见孤儿事件（I2：空组谓词，不回落全量）",
  );

  assert.equal(outboundCount, 0, "events / wait 全程零出站");
});

// ---------------------------------------------------------------------------
// ⑥ 配置不可读 ⇒ 失败而非静默「0 条事件」
// ---------------------------------------------------------------------------

test("⑥ 机器清单不可读：只读三路一律 machines_config_error（不静默降级成空结果）", async () => {
  outboundCount = 0;
  writeFileSync(CFG_PATH, "{ not json", "utf8");
  try {
    assert.equal(expectFailure(coreA.events()).code, "machines_config_error");
    assert.equal(expectFailure(await coreA.wait(200)).code, "machines_config_error");
    assert.equal(expectFailure(await coreA.tasks("alpha")).code, "machines_config_error");
    assert.equal(outboundCount, 0);
  } finally {
    // 恢复可读：本文件不重启桥，配置现读 ⇒ 复原后其余断言不受影响
    writeTwoGroupConfig();
  }
});
