#!/usr/bin/env node
/**
 * 版本台账一次性迁移（v0.10.0 O1 · 改造文档 §2.1(7)）—— 板存量 `versions.json` **整表导入**
 * 引擎 `versions` 表，并补登 `features.version` 里出现过、台账缺行的版号。
 *
 * ## 为什么需要它
 * v0.10.0 把「版本状态」的事实源从板（板台账文件）**翻到引擎**（`versions` 表）。
 * 存量板台账不搬 ⇒ 升级后所有历史版号在引擎侧「不存在」⇒ 排期写存在性校验会挡掉一切已排期的卡。
 *
 * ## 三段语义（★R3，逐条对应改造文档）
 * 1. **主源 = 板 `versions.json` 整表导入**：含 `status` / `date` / `note` / `createdAt` / `updatedAt`
 *    **原值照搬**（`released` 行照搬、且自此**不可逆**）。路径经 **`--from=` 参数注入** ——
 *    ⚠ **引擎运行时不得（也不会）出现任何读板文件的路径**：本脚本是一次性离线工具，不在桥进程内。
 * 2. **补集 = `features.version`**：只补**台账缺行**的版号；**绝不覆盖**已导入的 `status`
 *    （发版事实只能在主源里）；新建行**只落 `notstart` / `active`，永不落 `released`**
 *    （派生规则见 `deriveStatusFromFeatures`）。
 * 3. **哨兵**：成功写入后落一条 `events.kind = 'version.ledger_migrated'`。
 *    判据 = **哨兵行存在 ⇒ 跳过**，**不复用台账 `exists()` / 行数** ——
 *    建版端点（O2a）自己也会造出台账行 ⇒ 「台账非空」推不出「板台账已导入」，
 *    拿台账当判据会把未迁移库误判成已迁移，从此永久漏掉只能从 `versions.json` 拿到的
 *    `status`/`date`/原始时间戳（含 `released`）。
 *
 * ## 语义与安全
 * - 缺省 **dry-run**：以 `readOnly: true` 打开，**只产出计划、不写**；`--apply` 才写。
 * - **可重入**：主源与补集都走「先查键、无行才插」（SQLite PK 含可空列 `owner_group`，
 *   唯一约束把 NULL 视为互不相等 ⇒ 禁用 `INSERT OR REPLACE` / `ON CONFLICT`）；
 *   二次 `--apply` ⇒ 0 新行；哨兵已存在 ⇒ 整体跳过。
 * - **不改写板文件**，只读；**不删任何行**。
 * - `status` 非法值 ⇒ **跳过该行并计数报告**（不静默兜成缺省态：台账 `status` 是锁的事实在，
 *   脏值会让 {@link rowToVersionLedger} 读侧抛错）。
 * - `version` 不合 semver 形状 ⇒ **照搬 + warn**（§2.1(4)「不做脏值归一」：存量自由文本行
 *   不被改写，也不因新写口的 shape 校验而被抹掉）。
 *
 * ⚠ 执行时点：本脚本在本 Feature 内**只产出、不执行**；`--apply` 由用户在**停桥窗口**手动跑
 *   （与 `migrate-feature-owner.mjs` 同纪律）。
 *
 * 用法：
 *   node scripts/migrate-versions-ledger.mjs --from=<板台账导出文件路径>              # dry-run
 *   node scripts/migrate-versions-ledger.mjs --from=<板台账导出文件路径> --apply      # 写入
 *   node scripts/migrate-versions-ledger.mjs --from=… --force --apply                          # 忽略哨兵重跑主源
 *
 * 环境变量：SESSION_DB 会话库路径（缺省 `<orch>/data/sessions.sqlite`，与 `bridgectl.mjs` 同源）
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = dirname(SCRIPT_DIR);
const DB_PATH = process.env["SESSION_DB"] ?? join(ORCH_ROOT, "data", "sessions.sqlite");

/** 与 `session/store.ts` 的 `EVENT_VERSION_LEDGER_MIGRATED` 逐字同值（脚本不经 TS 模块，手写副本） */
const SENTINEL_KIND = "version.ledger_migrated";
/** 台账三态闭集（与 `types.ts` 的 `VERSION_LEDGER_STATUSES` 同值） */
const KNOWN_STATUSES = new Set(["notstart", "active", "released"]);
/** semver 形状（与 `session/store.ts` 的 `VERSION_SHAPE_RE` 同值；只 warn、不挡） */
const VERSION_SHAPE_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const FORCE = args.includes("--force");

function parseFrom() {
  const hit = args.find((a) => a.startsWith("--from="));
  if (hit === undefined) return undefined;
  return hit.slice("--from=".length);
}

const FROM = parseFrom();
const UNKNOWN = args.filter(
  (a) => a !== "--apply" && a !== "--force" && !a.startsWith("--from="),
);

function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}

function nowIso() {
  return new Date().toISOString();
}

function hasTable(db, name) {
  return (
    db
      .prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(name) !== undefined
  );
}

/** 板两代形态都吃：`{version:2,versions:[…]}` / `{schema:1,source,count,versions:[…]}` */
function readBoardVersions(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw?.versions)) {
    throw new Error("JSON 顶层无 versions 数组（不是板导出台账的形状）");
  }
  return raw.versions.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`versions[${index}] 不是对象`);
    }
    return {
      // 板字段 `org` → 引擎 `owner_group`；空串 / 缺失 ⇒ NULL（匿名档，与 features 同口径）
      ownerGroup: typeof item.org === "string" && item.org.length > 0 ? item.org : null,
      version: typeof item.version === "string" ? item.version.trim() : "",
      status: typeof item.status === "string" ? item.status : null,
      date: typeof item.date === "string" && item.date.length > 0 ? item.date : null,
      note: typeof item.note === "string" && item.note.length > 0 ? item.note : null,
      createdAt: typeof item.createdAt === "string" && item.createdAt.length > 0 ? item.createdAt : nowIso(),
      updatedAt: typeof item.updatedAt === "string" && item.updatedAt.length > 0 ? item.updatedAt : nowIso(),
    };
  });
}

function ledgerHas(db, ownerGroup, version) {
  return (
    db
      .prepare("SELECT 1 AS hit FROM versions WHERE owner_group IS ? AND version = ? LIMIT 1")
      .get(ownerGroup, version) !== undefined
  );
}

function ledgerInsert(db, row) {
  db.prepare(
    `INSERT INTO versions (owner_group, version, status, date, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.ownerGroup,
    row.version,
    row.status,
    row.date,
    row.note,
    row.createdAt,
    row.updatedAt,
  );
}

/**
 * 补集：`features.version` 去重后的版号集合 + 其派生信息。
 * `status` 派生（**永不 released**）：名下存在**已离开 `waiting_approval`** 的卡 ⇒ 说明首批节点
 * 已派发过 ⇒ `active`；全为 `waiting_approval` ⇒ 尚未派发 ⇒ `notstart`。
 * 时间戳取名下卡的 `MIN(created_at)` / `MAX(updated_at)`（无值 ⇒ 当下）。
 */
function collectFeatureVersions(db) {
  const rows = db
    .prepare(
      `SELECT owner_group, version,
              COUNT(*) AS total,
              SUM(CASE WHEN state <> 'waiting_approval' THEN 1 ELSE 0 END) AS dispatched,
              MIN(created_at) AS first_at,
              MAX(updated_at) AS last_at
       FROM features
       WHERE version IS NOT NULL AND version <> ''
       GROUP BY owner_group, version
       ORDER BY owner_group, version`,
    )
    .all();
  return rows.map((r) => ({
    ownerGroup: typeof r.owner_group === "string" && r.owner_group.length > 0 ? r.owner_group : null,
    version: String(r.version).trim(),
    total: Number(r.total),
    dispatched: Number(r.dispatched),
    status: Number(r.dispatched) > 0 ? "active" : "notstart",
    date: null,
    note: null,
    createdAt: typeof r.first_at === "string" ? r.first_at : nowIso(),
    updatedAt: typeof r.last_at === "string" ? r.last_at : nowIso(),
  }));
}

function planMainSource(db, entries) {
  const plan = [];
  const skipped = [];
  const dirtyShape = [];
  const seen = new Set();
  for (const entry of entries) {
    const key = `${entry.ownerGroup ?? "\u0000"}\u0000${entry.version}`;
    if (entry.version.length === 0) {
      skipped.push({ ...entry, why: "缺 version" });
      continue;
    }
    if (seen.has(key)) {
      skipped.push({ ...entry, why: "源内重复键" });
      continue;
    }
    seen.add(key);
    if (entry.status === null || !KNOWN_STATUSES.has(entry.status)) {
      skipped.push({ ...entry, why: `非法 status ${JSON.stringify(entry.status)}` });
      continue;
    }
    if (!VERSION_SHAPE_RE.test(entry.version)) dirtyShape.push(entry);
    if (ledgerHas(db, entry.ownerGroup, entry.version)) continue; // 已有行 ⇒ 不覆盖
    plan.push(entry);
  }
  return { plan, skipped, dirtyShape };
}

function planComplement(db, featureVersions) {
  const plan = [];
  const existsAlready = [];
  for (const fv of featureVersions) {
    if (ledgerHas(db, fv.ownerGroup, fv.version)) {
      existsAlready.push(fv);
      continue;
    }
    plan.push(fv);
  }
  return { plan, existsAlready };
}

function hasSentinel(db) {
  return (
    db
      .prepare("SELECT 1 AS hit FROM events WHERE kind = ? LIMIT 1")
      .get(SENTINEL_KIND) !== undefined
  );
}

function writeSentinel(db, stats) {
  // --force 重跑时哨兵可能已存在 ⇒ 不重复追加（哨兵语义 = 「迁移发生过」这一事实，一条即足）
  if (hasSentinel(db)) return false;
  db.prepare(
    `INSERT INTO events (feature_id, task_id, kind, state, payload, created_at)
     VALUES (NULL, NULL, ?, NULL, ?, ?)`,
  ).run(SENTINEL_KIND, JSON.stringify(stats), nowIso());
  return true;
}

function main() {
  if (UNKNOWN.length > 0) {
    fail(`未知参数：${UNKNOWN.join(" ")}（只接受 --from=<path> / --apply / --force）`);
    return;
  }
  if (FROM === undefined || FROM.length === 0) {
    fail(
      "缺少 --from=<path>：板存量台账路径必须**显式注入**（部署参数），脚本不猜板文件位置 —— " +
        "引擎运行时不留读板文件的路径，这里也不内建（改造文档 §2.1(7)）。",
    );
    return;
  }
  if (!existsSync(FROM)) {
    fail(`板台账文件不存在：${resolve(FROM)}`);
    return;
  }
  if (!existsSync(DB_PATH)) {
    fail(`会话库不存在：${resolve(DB_PATH)}`);
    return;
  }

  console.log(`库：${resolve(DB_PATH)}`);
  console.log(`主源：${resolve(FROM)}`);
  console.log(`模式：${APPLY ? "--apply（写入）" : "dry-run（只读，不写入）"}`);

  let entries;
  try {
    entries = readBoardVersions(FROM);
  } catch (err) {
    fail(`主源解析失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const probe = new DatabaseSync(DB_PATH, { readOnly: true });
  let mainPlan;
  let mainSkipped;
  let dirtyShape;
  let complementPlan;
  let complementKept;
  let featureVersionCount = 0;
  try {
    for (const need of ["versions", "features", "events"]) {
      if (!hasTable(probe, need)) {
        fail(
          `会话库无 ${need} 表 ⇒ 请先以本版本代码起桥一次（` +
            `${need === "versions" ? "store ctor 建版本面两表" : "store ctor 建表"}），再跑本脚本。`,
        );
        return;
      }
    }
    const sentinel = probe
      .prepare("SELECT 1 AS hit FROM events WHERE kind = ? LIMIT 1")
      .get(SENTINEL_KIND);
    if (sentinel !== undefined && !FORCE) {
      console.log(
        `\n[哨兵] 已存在（events.kind = '${SENTINEL_KIND}'）⇒ 本库已迁移过，整体跳过。` +
          `确需重跑主源导入请加 --force（补集与主源都幂等，不会重复造行）。`,
      );
      return;
    }
    console.log(
      `\n[哨兵] ${sentinel === undefined ? "不存在 ⇒ 待迁移" : "存在但 --force ⇒ 重跑导入"}`,
    );

    const main = planMainSource(probe, entries);
    mainPlan = main.plan;
    mainSkipped = main.skipped;
    dirtyShape = main.dirtyShape;
    const complement = planComplement(probe, collectFeatureVersions(probe));
    complementPlan = complement.plan;
    complementKept = complement.existsAlready;
    featureVersionCount = complement.plan.length + complement.existsAlready.length;
  } finally {
    probe.close();
  }

  console.log(`\n[主源] 板台账 ${entries.length} 行 → 待导入 ${mainPlan.length} 行`);
  for (const r of mainPlan) {
    console.log(`  + ${fmt(r)}（status 照搬${r.status === "released" ? " · **released 不可逆**" : ""}）`);
  }
  if (mainSkipped.length > 0) {
    console.log(`  跳过 ${mainSkipped.length} 行：`);
    for (const r of mainSkipped) console.log(`    ! ${fmt(r)} ⇒ ${r.why}`);
  }
  if (dirtyShape.length > 0) {
    console.log(`  ⚠ 不合 semver 形状但仍照搬 ${dirtyShape.length} 行（§2.1(4) 不做脏值归一）：`);
    for (const r of dirtyShape) console.log(`    ~ ${fmt(r)}`);
  }

  console.log(
    `\n[补集] features.version 派生 ${featureVersionCount} 个版号（去重、非空串）`,
  );
  console.log(`  已有台账行（**不动 status**）：${complementKept.length} 个版号`);
  for (const r of complementKept) console.log(`    = ${fmt(r)}`);
  console.log(`  待补登（只补缺行、**永不落 released**）：${complementPlan.length} 个版号`);
  for (const r of complementPlan) console.log(`  + ${fmt(r)}（派生 status，名下卡 ${r.total} 张 / 已派发 ${r.dispatched} 张）`);

  if (!APPLY) {
    console.log(
      `\ndry-run 合计：主源待导入 ${mainPlan.length} 行 + 补集待补登 ${complementPlan.length} 行 = ` +
        `${mainPlan.length + complementPlan.length} 行。确认无误后加 --apply 执行。`,
    );
    return;
  }

  const db = new DatabaseSync(DB_PATH);
  try {
    const stats = { source: resolve(FROM), mainImported: 0, complementSeeded: 0, at: nowIso() };
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of mainPlan) {
        if (ledgerHas(db, r.ownerGroup, r.version)) continue; // 事务内再判一次（并发窗口）
        ledgerInsert(db, r);
        stats.mainImported += 1;
      }
      for (const r of complementPlan) {
        if (ledgerHas(db, r.ownerGroup, r.version)) continue;
        ledgerInsert(db, r);
        stats.complementSeeded += 1;
      }
      stats.statuses = countStatuses(db);
      stats.sentinelWritten = writeSentinel(db, stats);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    console.log(
      `\n[写入] 主源导入 ${stats.mainImported} 行 · 补集补登 ${stats.complementSeeded} 行 · ` +
        `哨兵${stats.sentinelWritten ? "已落" : "已存在（未重复追加）"}（kind=${SENTINEL_KIND}）`,
    );
    console.log(`[台账现状] ${JSON.stringify(stats.statuses)}`);
  } finally {
    db.close();
  }
  console.log("\n完成。再跑一次本脚本应报「哨兵已存在 ⇒ 跳过」（可重入）。");
}

function countStatuses(db) {
  const rows = db
    .prepare("SELECT status, COUNT(*) AS n FROM versions GROUP BY status")
    .all();
  const out = {};
  for (const r of rows) out[String(r.status)] = Number(r.n);
  return out;
}

function fmt(r) {
  return `owner_group=${r.ownerGroup === null ? "NULL" : `"${r.ownerGroup}"`} version=${r.version} status=${r.status}`;
}

main();
