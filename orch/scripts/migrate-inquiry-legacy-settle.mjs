#!/usr/bin/env node
/**
 * 存量「待澄清」询问行一次性收口（v0.10.8 · Feature 849445f3 · M3 · 改造文档 §3.1 冻结件）
 *
 * 干什么：历史上宿主用同 contextId 续答接走了某枚询问任务，但旧行永远停在 `input-required`
 * （M2 的建行结算只接 `updated_at` 最新一枚，其余留给本脚本追补）。本脚本按 §3.1 凭据把这类
 * 旧行结算为 `completed` 并记 `settled_by` = 接管行 taskId。
 *
 * ⚠ **本节点只交付到 dry-run**：缺省运行 = 只读连接、**零写入**（不落任何文件、不碰库）；
 *   `--apply` 必须由宿主显式传且另行择窗执行（动存量数据、属不可逆侧）。脚本内无自动 apply 路径。
 *
 * ## 判据（§3.1 冻结件，一字不放宽）
 * - **目标集**：`mode = 'inquiry'` ∧ `state = 'input-required'` ∧ `context_id` 非空。
 * - **接管凭据**：同 `context_id` ∧ `mode = 'inquiry'` ∧ 非自身 ∧ `created_at` 晚于目标 ∧ 该行已非待澄清。
 *   **凭据行存在本身即「宿主已续派」凭据**，不要求其终态（`completed` / `failed` / `working` 都算）。
 * - 查不到凭据的目标行 ⇒ 进**遗留登记表**、不动（§6.2 遗留②）。
 * - 多枚凭据同时成立 ⇒ 取 `created_at` 最早那一枚（首个真实续答），报表记 candidateCount。
 *
 * ## 唯一不可自愈风险 = 误结算真 DAG 行 ⇒ 判据全程只有列值严格等式
 * - `mode` 在本脚本里**只以等式命中**（SQL 绑定 `mode = ?` + JS 等式复核，见 R-1 断言）；
 *   **禁读侧归一函数、禁把 mode 写成不等式筛**（不等式会把 `mode IS NULL` 的存量真 DAG 行
 *   捞进目标集 ⇒ 该行永久失去 `advance(answer)` 续推点，不可自愈）。
 * - 灰区（`mode IS NULL`）不可反查 ⇒ 天然落选、不登记、不回填。
 * - R-2 断言：`mode IS NULL` 行数**前后快照恒等**（dry-run 也打印该计数）。
 *
 * ## 安全垫
 * - dry-run：`{readOnly: true}` 连接，只出三列报表 + 遗留登记表 + 回滚报表**路径**（不写文件）。
 * - apply：① **先落回滚报表**（逐行 taskId / state / finished_at / updated_at，落盘成功才开始写）；
 *   ② 逐行前置复检 state 仍为待澄清（防双清），再走 M1 的 `updateTaskState`（CAS `expectedFrom`
 *   由此必为待澄清、`settled_by` 与 CAS 同一条 UPDATE）；③ 逐行独立语句、**不开长事务**
 *   （中途失败由回滚报表兜、重跑可追补 —— 判据结算后不再命中 ⇒ 可重入）；④ 事后重算判据自证剩 0。
 *   ⚠ **apply 窗口 = 桥重启之后**（宿主 2026-10-18 裁定，执行序 M4 构建 → 重启桥 → apply → M5）：
 *     `settled_by` 的 DDL 写手必须**唯一** = M1 的 ctor try-ALTER（由重启后的引擎进程执行）。本脚本
 *     自身不开任何结构语句，但若在重启前跑，存储层构造器会顺带建列 ⇒ 既多出第二个 DDL 写手，又开出
 *     「列已存在、运行中的旧进程不认识它」的窗口，且结算落的是旧码语义的账 —— 三者都要避开。
 *
 * 用法：
 *   node scripts/migrate-inquiry-legacy-settle.mjs                 # dry-run（缺省，零写入）
 *   node scripts/migrate-inquiry-legacy-settle.mjs --apply         # 写入（宿主在桥重启后择窗）
 *
 * 环境变量：SESSION_DB 会话库路径（缺省 `<orch>/data/sessions.sqlite`，与 `bridgectl.mjs` 同源）
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = dirname(SCRIPT_DIR);
const DB_PATH = process.env["SESSION_DB"] ?? join(ORCH_ROOT, "data", "sessions.sqlite");
const STORE_JS = join(ORCH_ROOT, "dist", "session", "store.js");

/** 待澄清（目标集的前置态，也是每行 CAS 的 expectedFrom） */
const OPEN_STATE = "input-required";
/** 结算目标态（与 M2 建行路径的结算字面量一致） */
const SETTLED_STATE = "completed";
/** 通道位等式值：本脚本内 `mode` 只允许与此值做等式比较 */
const MODE_EQ = "inquiry";
/** 判据函数名：报表与回滚报表都带此标记 ⇒ 可证「dry-run 与 apply 同一判据」 */
const CRITERIA = "buildPlan";

/** 裸读：一次取回 `mode` 等式命中的全部行；其余判据全在 {@link buildPlan} 的 JS 里做 */
const INQUIRY_SCAN = `SELECT task_id, context_id, state, mode, created_at
                      FROM tasks WHERE mode = ?`;

function nowIso() {
  return new Date().toISOString();
}

function countTasks(reader, where, ...params) {
  return Number(reader.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${where}`).get(...params).n);
}

/** 快照（R-2 的前后对照量）：mode 三档 + 总行；只读、不参与判据筛选 */
function snapshot(reader) {
  return {
    modeNull: countTasks(reader, "mode IS NULL"),
    modeDag: countTasks(reader, "mode = ?", "dag"),
    modeInquiry: countTasks(reader, "mode = ?", MODE_EQ),
    total: Number(reader.prepare("SELECT COUNT(*) AS n FROM tasks").get().n),
  };
}

function hasColumn(reader, name) {
  return reader
    .prepare("PRAGMA table_info(tasks)")
    .all()
    .some((c) => c.name === name);
}

/** 晚于目标才算「后建的续答行」；created_at 是同时区 ISO 串 ⇒ 字典序即时序 */
function createdAfter(target, other) {
  return (
    typeof other.created_at === "string" &&
    typeof target.created_at === "string" &&
    other.created_at > target.created_at
  );
}

/**
 * **唯一判据函数** —— dry-run 与 apply 共用（本文件禁止第二份目标集/凭据实现，
 * 两份实现的口径漂移正是本卡的风险面）。只读、不写任何列。
 * @param {{prepare: (sql: string) => {all: (...p) => any[], get: (...p) => any}}} reader
 */
function buildPlan(reader) {
  const rows = reader.prepare(INQUIRY_SCAN).all(MODE_EQ);
  const byContext = new Map();
  for (const row of rows) {
    if (row.context_id === null) continue;
    const bucket = byContext.get(row.context_id);
    if (bucket === undefined) byContext.set(row.context_id, [row]);
    else bucket.push(row);
  }
  const targets = [];
  const legacy = [];
  for (const target of rows) {
    if (target.state !== OPEN_STATE) continue;
    const siblings = (byContext.get(target.context_id) ?? []).filter(
      (r) => r.task_id !== target.task_id,
    );
    const credentials = siblings.filter((r) => createdAfter(target, r) && r.state !== OPEN_STATE);
    if (credentials.length === 0) {
      legacy.push({ row: target, reason: legacyReason(target, siblings) });
      continue;
    }
    credentials.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    targets.push({ old: target, takeover: credentials[0], candidateCount: credentials.length });
  }
  targets.sort((a, b) => (a.old.created_at < b.old.created_at ? -1 : 1));
  legacy.sort((a, b) => (a.row.created_at < b.row.created_at ? -1 : 1));
  return { criteria: CRITERIA, at: nowIso(), targets, legacy };
}

/** 遗留登记原因（逐枚给得出、不含糊） */
function legacyReason(target, siblings) {
  if (target.context_id === null) return "context_id 为空 ⇒ 无法反查接管行";
  if (siblings.length === 0) return "同 context 无其它 inquiry 行（无续派事实）";
  if (!siblings.some((r) => createdAfter(target, r)))
    return "同 context 只有不晚于目标的 inquiry 行";
  return "同 context 的后建行仍全部停在待澄清（无接管凭据）";
}

/** 共用判据断言（代码级闸）：任何报表/回滚/apply 的 plan 都必须出自 {@link buildPlan} */
function assertSharedCriteria(plan, stage) {
  if (plan.criteria !== CRITERIA) {
    throw new Error(
      `[判据闸] ${stage} 的 plan 来自 ${plan.criteria}，非 ${CRITERIA} ⇒ dry-run 与 apply 必须共用同一判据函数`,
    );
  }
}

/** R-1：目标集两侧必须全部 mode 等式命中（零 `mode IS NULL` / `dag` 行入集）；计数式核对，判据全程只用等式 */
function assertNoNonInquiry(plan) {
  const pool = [
    ...plan.targets.flatMap((t) => [t.old, t.takeover]),
    ...plan.legacy.map((l) => l.row),
  ];
  const offenders = pool.length - pool.filter((r) => r.mode === MODE_EQ).length;
  if (offenders > 0) {
    throw new Error(
      `[R-1] 目标集混入非等式命中行 ${offenders} 枚 ⇒ 整批不写（判据只用列值等式，出现即口径被改坏）`,
    );
  }
  return pool.length;
}

/** 回滚报表：apply 前逐行原值（taskId / state / finished_at / updated_at [+ settled_by 若列已存在]） */
function writeRollbackReport(reader, plan, path) {
  assertSharedCriteria(plan, "回滚报表");
  const withSettledBy = hasColumn(reader, "settled_by");
  const stmt = reader.prepare(
    withSettledBy
      ? "SELECT state, finished_at, updated_at, settled_by FROM tasks WHERE task_id = ?"
      : "SELECT state, finished_at, updated_at FROM tasks WHERE task_id = ?",
  );
  const rows = plan.targets.map((t) => {
    const cur = stmt.get(t.old.task_id);
    return {
      taskId: t.old.task_id,
      contextId: t.old.context_id,
      state: cur.state,
      finishedAt: cur.finished_at,
      updatedAt: cur.updated_at,
      ...(withSettledBy ? { settledBy: cur.settled_by } : {}),
      takeoverTaskId: t.takeover.task_id,
    };
  });
  writeFileSync(
    path,
    JSON.stringify(
      {
        at: nowIso(),
        db: resolve(DB_PATH),
        criteria: plan.criteria,
        withSettledBy,
        note: withSettledBy
          ? "还原口径：逐行把 state / finished_at / updated_at 写回本表原值，并把 settled_by 置空"
          : "还原口径：逐行把 state / finished_at / updated_at 写回本表原值（本库尚未落 settled_by 列）",
        rows,
      },
      null,
      2,
    ),
    "utf8",
  );
  return { path, rowCount: rows.length };
}

/** 三列报表：旧 taskId / 接管 taskId / 接管行态 */
function printThreeColumnReport(plan) {
  console.log(`\n[三列报表] 待结算 ${plan.targets.length} 枚（接管凭据命中）`);
  console.log("旧 taskId".padEnd(40) + "接管 taskId".padEnd(40) + "接管行态");
  for (const t of plan.targets) {
    const candidates = t.candidateCount > 1 ? `（凭据 ${t.candidateCount} 枚，取最早）` : "";
    console.log(
      t.old.task_id.padEnd(40) + t.takeover.task_id.padEnd(40) + t.takeover.state + candidates,
    );
  }
}

function printLegacyRegistry(plan) {
  console.log(`\n[遗留登记表] 凭据查不到的目标行 ${plan.legacy.length} 枚（不动、不结算）`);
  if (plan.legacy.length === 0) {
    console.log("（空）");
    return;
  }
  console.log("taskId".padEnd(40) + "contextId".padEnd(40) + "created_at".padEnd(28) + "原因");
  for (const l of plan.legacy) {
    console.log(
      l.row.task_id.padEnd(40) +
        String(l.row.context_id).padEnd(40) +
        String(l.row.created_at).padEnd(28) +
        l.reason,
    );
  }
}

function printSnapshot(tag, snap) {
  console.log(
    `[快照·${tag}] mode IS NULL=${snap.modeNull} · mode='dag'=${snap.modeDag} · ` +
      `mode='inquiry'=${snap.modeInquiry} · 总行=${snap.total}`,
  );
}

/** R-2：mode IS NULL 行数前后快照恒等（dry-run 与 apply 同一条断言） */
function assertModeNullStable(before, after) {
  if (before.modeNull !== after.modeNull) {
    throw new Error(
      `[R-2] mode IS NULL 行数 ${before.modeNull} → ${after.modeNull}（应恒等）⇒ 触达了存量 DAG 行`,
    );
  }
  console.log(`[断言 R-2] mode IS NULL 前后快照恒等：${before.modeNull} → ${after.modeNull} ✓`);
}

async function applyPlan(plan, rollback) {
  assertSharedCriteria(plan, "apply");
  if (!existsSync(STORE_JS)) {
    throw new Error(
      `未找到构建产物 ${STORE_JS} ⇒ 先 npm run build（M1 的 updateTaskState 在 dist 侧）`,
    );
  }
  const { SessionStore } = await import(pathToFileURL(STORE_JS).href);
  const store = new SessionStore(resolve(DB_PATH));
  const settled = [];
  const skipped = [];
  try {
    for (const t of plan.targets) {
      // 前置复检：state 已非待澄清 ⇒ 跳过（幂等防双清，不刷新别人的 finished_at）
      const current = store.getTask(t.old.task_id);
      if (current === null) {
        skipped.push(`${t.old.task_id} 行已不存在`);
        continue;
      }
      if (current.state !== OPEN_STATE) {
        skipped.push(`${t.old.task_id} 现态=${current.state}（CAS 前置不成立，不动）`);
        continue;
      }
      const rec = store.updateTaskState(
        t.old.task_id,
        SETTLED_STATE,
        null,
        null,
        t.takeover.task_id,
      );
      if (rec === null || rec.state !== SETTLED_STATE) {
        throw new Error(
          `结算未落地：${t.old.task_id} 期望 ${SETTLED_STATE}，实得 ${rec === null ? "null" : rec.state} ⇒ 余下行不追写`,
        );
      }
      settled.push(t.old.task_id);
    }
  } finally {
    store.close();
  }
  console.log(`\n[写入] 结算 ${settled.length} 枚（逐行 CAS expectedFrom='${OPEN_STATE}'）`);
  if (skipped.length > 0) console.log(`[跳过] ${skipped.length} 枚：\n- ${skipped.join("\n- ")}`);
  console.log(`[回滚凭据] ${rollback.path}（${rollback.rowCount} 行原值）`);
  return settled.length;
}

/** 只读连接内跑一段 fn，用完即关（dry-run 全程只有这种连接 ⇒ 零写入） */
function withProbe(fn) {
  const probe = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    return fn(probe);
  } finally {
    probe.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const APPLY = args.includes("--apply");
  const unknown = args.filter((a) => a !== "--apply");
  if (unknown.length > 0) {
    console.error(`未知参数：${unknown.join(" ")}（本脚本只接受 --apply；缺省一律 dry-run）`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(DB_PATH)) {
    console.error(`会话库不存在：${resolve(DB_PATH)}`);
    process.exitCode = 1;
    return;
  }

  const rollbackPath = join(
    ORCH_ROOT,
    "data",
    `inquiry-legacy-settle-rollback-${nowIso().replace(/[:.]/g, "-")}.json`,
  );

  // 判据与快照一律走只读连接：不带 --apply 时本进程无任何写语句、无文件落盘
  let before;
  let plan;
  withProbe((probe) => {
    before = snapshot(probe);
    plan = buildPlan(probe);
  });
  assertSharedCriteria(plan, "dry-run 报表");
  const poolSize = assertNoNonInquiry(plan);

  printSnapshot("前", before);
  console.log(`库：${resolve(DB_PATH)}`);
  console.log(`模式：${APPLY ? "--apply（写入，宿主择窗）" : "dry-run（只读，零写入）"}`);
  console.log(`判据：目标集 = mode='${MODE_EQ}' ∧ state='${OPEN_STATE}' ∧ context_id 非空`);
  console.log(
    `      凭据 = 同 context_id ∧ mode='${MODE_EQ}' ∧ 非自身 ∧ created_at 晚于目标 ∧ 该行非待澄清`,
  );
  console.log(`[断言 R-1] 目标集 mode 全等式命中：${poolSize} 行入检、零 mode IS NULL / dag 行 ✓`);
  printThreeColumnReport(plan);
  printLegacyRegistry(plan);

  if (!APPLY) {
    // R-2 的「后快照」另开一条只读连接重读库文件 ⇒ 证明 dry-run 期间盘上数据没动过
    const after = withProbe((probe) => snapshot(probe));
    assertModeNullStable(before, after);
    console.log(`[回滚报表] 将在 --apply 前落盘：${rollbackPath}（本次 dry-run 未写任何文件）`);
    console.log(
      `[dry-run 合计] 待结算 ${plan.targets.length} · 遗留 ${plan.legacy.length} · 库文件未被写入。` +
        `确认无误后由宿主另择窗口加 --apply。`,
    );
    return;
  }

  // apply：回滚报表**先落盘**（落盘失败即整批不写）
  const rollback = withProbe((probe) => writeRollbackReport(probe, plan, rollbackPath));
  console.log(`\n[回滚报表] 已落盘 ${rollback.path}（${rollback.rowCount} 行原值，先于任何写入）`);
  await applyPlan(plan, rollback);

  // 事后自证：R-2 恒等 + 重算判据剩 0（可重入 ⇒ 再跑一次 dry-run 也是空表）
  const after = withProbe((probe) => ({ snap: snapshot(probe), replan: buildPlan(probe) }));
  assertModeNullStable(before, after.snap);
  console.log(
    `[可重入自证] 重算判据剩待结算 ${after.replan.targets.length} 枚（期望 0）· ` +
      `遗留 ${after.replan.legacy.length} 枚 · mode='inquiry' 总量 ${after.snap.modeInquiry} 不变`,
  );
  if (after.replan.targets.length !== 0 || after.snap.modeInquiry !== before.modeInquiry) {
    throw new Error("[事后自证] 判据未清空或 inquiry 总量漂移 ⇒ 按回滚报表核对");
  }
  console.log(`[apply 完成] 判据 R-1/R-2 + 可重入自证全绿。`);
}

function reportFailure(err) {
  console.error(`\n[中止] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}

main().catch(reportFailure);
