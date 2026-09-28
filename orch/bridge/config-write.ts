/**
 * O1 受控写工具落点（v0.9.4 REQ-2026-09-26-01 §2.3）：`a2a_config_write_group` 的
 * 「单组操作指令」语义 + 写路径（互斥 / 乐观校验 / dry-run / 备份 / tmp+rename 原子替换）。
 *
 * 设计口径（边界 R1/R2 冻结，见改造文档 §2.3 / §6）：
 * - **拒绝整文档替换** —— 入参只有 op/groupName/members，raw 文档不出现在接口上；
 *   RMW 全程现读 `configPath`（不依赖任何缓存），只改 `projectGroup` 一键；
 * - **dry-run 与读面同源**：拟写的 `projectGroup` 值用 `config.ts#parseProjectGroups` 校验
 *   （写进去的必然能被读出来），追加组名唯一性 / 保留首段两项结构检查（parse 不覆盖、
 *   但 `loadMachinesConfig` 启动期会拒 —— 提前到写前，防写出「桥拒启动」的文档）；
 * - **错误码闭集六元**（契约形状 `{ok, code, error, backedUpTo?}`）；HTTP 状态映射由板侧承载；
 * - **跨进程文件锁不做**（orch 单实例、无外部写者）：模块级 promise 链互斥 +
 *   mtime/内容 hash 乐观校验挡「处理途中被外部改动」（不一致 ⇒ `config_write_concurrent_modification`）。
 */
import { randomBytes, createHash } from "node:crypto";
import {
  copyFileSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { memberKey, parseProjectGroups, RESERVED_FIRST_SEGMENTS } from "../config.js";
import type { ProjectMember } from "../types.js";

/** 五操作闭集（单组操作指令；改名语义不做，挪成员 = remove+add 组合） */
export const CONFIG_WRITE_GROUP_OPS = [
  "group.add",
  "group.update",
  "group.remove",
  "group.member.add",
  "group.member.remove",
] as const;

export type ConfigWriteGroupOp = (typeof CONFIG_WRITE_GROUP_OPS)[number];

/** 失败码闭集（六元）；括号内为板侧映射的 HTTP 状态（契约只携带 code，状态归板） */
export const CONFIG_WRITE_GROUP_FAILURE_CODES = [
  "config_write_dry_run_rejected", // →422（带 parseProjectGroups 原 message）
  "config_write_unknown_machine", // →422
  "config_write_group_not_found", // →409（orch R2 定死单码）
  "config_write_duplicate_member", // →409
  "config_write_concurrent_modification", // →409（板允许单次自动重读重试）
  "config_write_io_failed", // →500（备份已回滚 / 当前 config 原样）
] as const;

export type ConfigWriteGroupFailureCode = (typeof CONFIG_WRITE_GROUP_FAILURE_CODES)[number];

export interface ConfigWriteGroupArgs {
  op: ConfigWriteGroupOp;
  /** 目标组名（group.add = 新组名） */
  groupName: string;
  /**
   * 成员集：`group.add` / `group.update`（整集替换）/ `group.member.add` / `group.member.remove` 必带；
   * `group.remove` 不消费。
   */
  members?: ProjectMember[] | undefined;
}

export interface ConfigWriteGroupSuccess {
  ok: true;
  op: ConfigWriteGroupOp;
  groupName: string;
  /** false = 操作未产生任何变更（member.remove 目标成员本不在组内，幂等放行、零写入） */
  changed: boolean;
  /** 操作后该组声明态成员；`group.remove` ⇒ null（组已不在文档中） */
  members: ProjectMember[] | null;
  /** 本次实际写入前的备份文件路径（changed=false 的零写入无备份） */
  backedUpTo?: string;
}

export interface ConfigWriteGroupFailure {
  ok: false;
  code: ConfigWriteGroupFailureCode;
  error: string;
  backedUpTo?: string;
}

export type ConfigWriteGroupOutcome = ConfigWriteGroupSuccess | ConfigWriteGroupFailure;

function fail(code: ConfigWriteGroupFailureCode, error: string): ConfigWriteGroupFailure {
  return { ok: false, code, error };
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

/** 归一成员入参：项必须对象且 `{machineId, projectId}` 均非空字符串（与读面 `asString` 同判据） */
function normalizeMembers(
  raw: ProjectMember[] | undefined,
): ProjectMember[] | ConfigWriteGroupFailure {
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail(
      "config_write_dry_run_rejected",
      `op 需要非空 members（每项 {machineId, projectId}）；group.remove 之外的写操作必须显式给出成员集`,
    );
  }
  const out: ProjectMember[] = [];
  for (const [i, m] of raw.entries()) {
    const r = asObject(m);
    if (
      r === null ||
      typeof r["machineId"] !== "string" ||
      r["machineId"].length === 0 ||
      typeof r["projectId"] !== "string" ||
      r["projectId"].length === 0
    ) {
      return fail(
        "config_write_dry_run_rejected",
        `members[${i}] 必须是 {machineId, projectId} 非空字符串对`,
      );
    }
    out.push({ machineId: r["machineId"] as string, projectId: r["projectId"] as string });
  }
  return out;
}

/** 现读文档的 `projectGroup` 值 → 可改写的组数组视图（段缺省 = 空数组；非数组拒绝） */
function currentGroups(doc: Record<string, unknown>): unknown[] | ConfigWriteGroupFailure {
  const raw = doc["projectGroup"];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    return fail(
      "config_write_dry_run_rejected",
      "当前 config 的 projectGroup 段不是组数组（配置已损坏）：拒绝在坏段上改写，请先人工修复",
    );
  }
  return raw;
}

function groupEntryName(entry: unknown): string | null {
  const r = asObject(entry);
  return r !== null && typeof r["name"] === "string" ? (r["name"] as string) : null;
}

function groupEntryMembers(entry: unknown): ProjectMember[] {
  const r = asObject(entry);
  const raw = r === null ? undefined : r["members"];
  if (!Array.isArray(raw)) return [];
  const out: ProjectMember[] = [];
  for (const m of raw) {
    const mr = asObject(m);
    if (mr !== null && typeof mr["machineId"] === "string" && typeof mr["projectId"] === "string") {
      out.push({ machineId: mr["machineId"], projectId: mr["projectId"] });
    }
  }
  return out;
}

/**
 * **纯函数**：在现读文档的 `projectGroup` 值上应用单组操作（不落盘、无 I/O，可单测）。
 * 返回拟写的 `projectGroup` 新值 + 操作后该组成员；结构化拒绝携带闭集码。
 */
export function applyGroupOp(
  doc: Record<string, unknown>,
  groups: readonly unknown[],
  machineIds: ReadonlySet<string>,
  args: ConfigWriteGroupArgs,
):
  | { ok: true; value: unknown[]; members: ProjectMember[] | null; changed: boolean }
  | ConfigWriteGroupFailure {
  const idx = groups.findIndex((g) => groupEntryName(g) === args.groupName);

  switch (args.op) {
    case "group.add": {
      if (idx !== -1) {
        return fail(
          "config_write_dry_run_rejected",
          `组名 "${args.groupName}" 已存在：group.add 拒绝重名（组名 = URL 路径首段身份，重名文档会被桥启动校验拒绝）；改成员请用 group.update / group.member.*`,
        );
      }
      const reserved = reservedFirstSegments(doc);
      if (reserved.has(args.groupName)) {
        return fail(
          "config_write_dry_run_rejected",
          `组名 "${args.groupName}" 与保留 URL 首段冲突（health / shutdown / runner / MCP 端点路径首段）：该文档能落盘但桥拒启动，写前即拒`,
        );
      }
      const members = normalizeMembers(args.members);
      if (!Array.isArray(members)) return members;
      return {
        ok: true,
        value: [...groups, { name: args.groupName, members }],
        members,
        changed: true,
      };
    }
    case "group.update": {
      if (idx === -1) return groupNotFound(args.groupName);
      const members = normalizeMembers(args.members);
      if (!Array.isArray(members)) return members;
      const value = groups.map((g, i) =>
        i === idx ? { ...asObject(g), name: args.groupName, members } : g,
      );
      return { ok: true, value, members, changed: true };
    }
    case "group.remove": {
      if (idx === -1) return groupNotFound(args.groupName);
      const value = groups.filter((_, i) => i !== idx);
      return { ok: true, value, members: null, changed: true };
    }
    case "group.member.add": {
      if (idx === -1) return groupNotFound(args.groupName);
      const members = normalizeMembers(args.members);
      if (!Array.isArray(members)) return members;
      const machineErr = checkMachineIds(members, machineIds);
      if (machineErr !== null) return machineErr;
      // 显式查重（同组重复 = parse 会静默去重 ⇒ 必须自己拒；跨组重复 = 成员互斥 ⇒ 同码报清所在组）
      for (const m of members) {
        const key = memberKey(m.machineId, m.projectId);
        for (const g of groups) {
          const gname = groupEntryName(g);
          if (groupEntryMembers(g).some((x) => memberKey(x.machineId, x.projectId) === key)) {
            return fail(
              "config_write_duplicate_member",
              gname === args.groupName
                ? `成员 { machineId: "${m.machineId}", projectId: "${m.projectId}" } 已在组 "${args.groupName}" 中（重复添加拒绝）`
                : `成员 { machineId: "${m.machineId}", projectId: "${m.projectId}" } 已属于组 "${gname}"（组间成员互斥；挪组 = 先 member.remove 再 member.add）`,
            );
          }
        }
      }
      const merged = [...groupEntryMembers(groups[idx]), ...members];
      const value = groups.map((g, i) =>
        i === idx ? { ...asObject(g), name: args.groupName, members: merged } : g,
      );
      return { ok: true, value, members: merged, changed: true };
    }
    case "group.member.remove": {
      if (idx === -1) return groupNotFound(args.groupName);
      const members = normalizeMembers(args.members);
      if (!Array.isArray(members)) return members;
      const removeKeys = new Set(members.map((m) => memberKey(m.machineId, m.projectId)));
      const current = groupEntryMembers(groups[idx]);
      const remained = current.filter((m) => !removeKeys.has(memberKey(m.machineId, m.projectId)));
      if (remained.length === current.length) {
        // 闭集无 member_not_found 码 ⇒ 删除不存在的成员 = 幂等放行、零写入（不产生备份）
        return { ok: true, value: [...groups], members: current, changed: false };
      }
      const value = groups.map((g, i) =>
        i === idx ? { ...asObject(g), name: args.groupName, members: remained } : g,
      );
      return { ok: true, value, members: remained, changed: true };
    }
  }
}

function groupNotFound(name: string): ConfigWriteGroupFailure {
  return fail(
    "config_write_group_not_found",
    `目标组 "${name}" 不存在（或已被移除）：单组操作不隐式建组，确需新建请用 group.add`,
  );
}

function checkMachineIds(
  members: readonly ProjectMember[],
  machineIds: ReadonlySet<string>,
): ConfigWriteGroupFailure | null {
  for (const m of members) {
    if (!machineIds.has(m.machineId)) {
      return fail(
        "config_write_unknown_machine",
        `成员 machineId "${m.machineId}" 不在 config 的 machines[] 中：成员必须指向已配置机器（未知机器清单请经 a2a_projects 核对）`,
      );
    }
  }
  return null;
}

/** 保留 URL 首段（与 `config.ts` 启动校验 ④ 同源判据 + 文档内 transport.http.path 首段） */
function reservedFirstSegments(doc: Record<string, unknown>): Set<string> {
  const reserved = new Set<string>(RESERVED_FIRST_SEGMENTS);
  const transport = asObject(doc["transport"]);
  const http = transport === null ? undefined : asObject(transport["http"]);
  const path =
    http !== null && http !== undefined && typeof http["path"] === "string" ? http["path"] : "/mcp";
  reserved.add(path.slice(1).split("/")[0] ?? "");
  return reserved;
}

/**
 * **dry-run（写读同源）**：以消费方的解析器对拟写值做校验 —— `parseProjectGroups` 通过
 * （成员机器指向、组名合法、成员互斥、非空 members…）且组名唯一才放行；抛错原样携带 message。
 */
export function dryRunProjectGroups(
  value: readonly unknown[],
  machineIds: ReadonlySet<string>,
): ConfigWriteGroupFailure | null {
  try {
    const parsed = parseProjectGroups(value, machineIds);
    const seen = new Set<string>();
    for (const g of parsed) {
      if (g.name !== null) {
        if (seen.has(g.name)) {
          return fail(
            "config_write_dry_run_rejected",
            `拟写文档组名 "${g.name}" 重复：组身份按名寻址，拒绝落盘`,
          );
        }
        seen.add(g.name);
      }
    }
    return null;
  } catch (err) {
    return fail(
      "config_write_dry_run_rejected",
      `拟写的 projectGroup 未过同源校验：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 写路径（I/O）
// ---------------------------------------------------------------------------

/**
 * 模块级 promise 链互斥：本进程内的配置面写一律串行（RMW 不互相踩踏）；
 * 与外部写者的竞态交给 mtime/内容 hash 乐观校验（不做跨进程文件锁，见文件头）。
 */
let writeChain: Promise<unknown> = Promise.resolve();

function withGroupWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 测试钩子：在「快照之后、写前乐观复核之前」注入回调（模拟外部写者中途改文件）；生产不传 */
export interface ConfigWriteHooks {
  afterSnapshot?: () => void | Promise<void>;
}

/**
 * 受控写入口（`a2a_config_write_group` 的 core 落点；**全组面**：不吃连接身份）。
 * 写路径 = 互斥内 `read → mutate → dry-run → 乐观复核 → backup → tmp+rename`；
 * 任一步失败：未及 rename 则当前 config 原样（tmp 清理、备份保留并经 `backedUpTo` 报出）。
 */
export async function writeGroupConfig(
  configPath: string,
  args: ConfigWriteGroupArgs,
  hooks?: ConfigWriteHooks,
): Promise<ConfigWriteGroupOutcome> {
  return withGroupWriteLock(async () => {
    let content: string;
    let mtimeMs: number;
    try {
      content = readFileSync(configPath, "utf8");
      mtimeMs = statSync(configPath).mtimeMs;
    } catch (err) {
      return fail(
        "config_write_io_failed",
        `读取 config 失败（${configPath}）：${err instanceof Error ? err.message : String(err)}（当前文件未改动）`,
      );
    }
    const snapshotHash = sha256(content);
    const snapshotMtime = mtimeMs;

    let doc: Record<string, unknown> | null;
    try {
      doc = asObject(JSON.parse(content) as unknown);
    } catch (err) {
      doc = null;
      return fail(
        "config_write_io_failed",
        `当前 config 不是合法 JSON（${configPath}）：${err instanceof Error ? err.message : String(err)}，拒绝在坏文档上 RMW（当前文件未改动）`,
      );
    }
    if (doc === null) {
      return fail("config_write_io_failed", `当前 config 顶层必须是对象（${configPath}，未改动）`);
    }

    const machines = Array.isArray(doc["machines"]) ? (doc["machines"] as unknown[]) : [];
    const machineIds = new Set<string>();
    for (const m of machines) {
      const r = asObject(m);
      if (r !== null && typeof r["machineId"] === "string") machineIds.add(r["machineId"]);
    }

    const groups = currentGroups(doc);
    if (!Array.isArray(groups)) return groups;

    const applied = applyGroupOp(doc, groups, machineIds, args);
    if (!applied.ok) return applied;

    const dryErr = dryRunProjectGroups(applied.value, machineIds);
    if (dryErr !== null) return dryErr;

    if (!applied.changed) {
      // 幂等零写入：不备份、不落盘
      return {
        ok: true,
        op: args.op,
        groupName: args.groupName,
        changed: false,
        members: applied.members,
      };
    }

    // 测试缝：外部写者在快照与乐观复核之间改动文件
    if (hooks?.afterSnapshot) await hooks.afterSnapshot();

    // 乐观复核（mtime + 内容 hash）：处理途中被外部改动 ⇒ 整单拒绝、当前文件保持外部终值
    try {
      const nowContent = readFileSync(configPath, "utf8");
      const nowMtime = statSync(configPath).mtimeMs;
      if (sha256(nowContent) !== snapshotHash || nowMtime !== snapshotMtime) {
        return fail(
          "config_write_concurrent_modification",
          "config 在本次写处理的途中被外部改动（mtime/内容 hash 不一致）：整单未写入，请重读后重试",
        );
      }
    } catch (err) {
      return fail(
        "config_write_concurrent_modification",
        `写前乐观复核读取失败（文件可能已被移除）：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${configPath}.bak-${stamp}-${randomBytes(3).toString("hex")}`;
    try {
      copyFileSync(configPath, backupPath);
    } catch (err) {
      return fail(
        "config_write_io_failed",
        `写前备份失败（${configPath} → ${backupPath}）：${err instanceof Error ? err.message : String(err)}，当前 config 原样未改`,
      );
    }

    const tmpPath = `${configPath}.tmp-${randomBytes(4).toString("hex")}`;
    const nextDoc = { ...doc, projectGroup: applied.value };
    try {
      writeFileSync(tmpPath, `${JSON.stringify(nextDoc, null, 2)}\n`, "utf8");
      renameSync(tmpPath, configPath);
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* tmp 未落盘则清理本就可失败；当前 config 未被触碰 */
      }
      return {
        ok: false,
        code: "config_write_io_failed",
        error: `原子替换失败（tmp → ${configPath}）：${err instanceof Error ? err.message : String(err)}，当前 config 原样（备份见 backedUpTo）`,
        backedUpTo: backupPath,
      };
    }
    return {
      ok: true,
      op: args.op,
      groupName: args.groupName,
      changed: true,
      members: applied.members,
      backedUpTo: backupPath,
    };
  });
}
