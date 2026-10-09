/**
 * **发版分支（`released`）** —— v0.10.0 O7（REQ-v0.10.0-2026-09-24-01 · 改造文档 §2.1(1)(3)(6)）。
 *
 * 本文件是「标记 `released`」这条**意图**的组合点：发版闸（O4 {@link evaluateReleaseGate}）
 * + 快照入参的**边界校验** + 同事务写口（O7 `SessionStore.versionLedgerMarkReleased`）。
 * O2b 的 `PATCH /api/versions/{version}/status` 端点在 `status === "released"` 分支
 * **必须**转进本函数（端点本身归 O2b，本节点不建第二份 HTTP 面、不接路由）。
 *
 * ## 为什么闸在这里、事务在 store
 *
 * 闸判据要读 `features` 聚合（O3 面），搬进事务会把聚合读纳入写锁窗口；故
 * 「**闸在事务前、写在事务内**」，与 `versionLedgerCreate`
 * 的「先 get 再 INSERT」同一套并发口径（SQLite 单写者 + 同进程同步 API 兜窗口）。
 * 「同事务」指的是 **`versions.status` 迁 `released`、`releases` 落快照、以及 project 版本级联置
 * `released`（v0.10.1 O4 · C-4）这三笔写同事务**（缺一必留半成品版本，见 `versionLedgerMarkReleased`），
 * 不是指把聚合读也圈进来。
 *
 * ## `repoId` 为什么不从注册表取（★ 节点硬约束）
 *
 * 快照的 `projects[].repoId` **只取发版动作带入的原值**，引擎**不回查 `runner_projects`**：
 * 该投影表每次 Runner 上报**全量替换**（`runnerProjectsReplace`），
 * 机未上线 / 未上报 ⇒ 表为空。拿它当数据源会把「上报缺位」写成「这一版不含该仓」=
 * **假事实**，且快照不可变、写错即永久错。缺省解释（未配 `repo` ⇒ 宿主仓）由
 * **调用方**在发版动作里落地，引擎不猜。
 */
import {
  ERR_RELEASE_PROJECTS,
  ERR_VERSION_SHAPE,
  ERR_VERSION_UNKNOWN,
  versionLedgerMarkReleased,
  versionLedgerStatus,
} from "../session/store.js";
import type {
  ReleaseSnapshotProject,
  ReleaseSnapshotRecord,
  VersionLedgerRecord,
} from "../session/store.js";
import { evaluateReleaseGate } from "./feature-tools.js";

/** 发版动作入参（= `PATCH …/status` 的 `released` 分支请求体） */
export interface MarkVersionReleasedInput {
  /** 台账键的一部分：`null` = 匿名档（未配组），由 HTTP 面按连接身份注入，不接受 `undefined` */
  ownerGroup: string | null;
  version: string;
  /** CHANGELOG 锚点（原值入快照，引擎不解析文档） */
  changelogAnchor?: string | null;
  /**
   * 各仓当期发版引用（**原始 JSON** ⇒ 本层做形状校验）。缺省 = 空数组（单仓未配 `repo` 的现状，
   * 快照仍落行）。v0.10.1 O4 起项形状 = `{projectId, version, repoId, ref}`，四键皆
   * `string | null | 缺省`；前两条是 C-5 新增的可选键（旧形状 `{repoId, ref}` 继续合法）。
   */
  projects?: unknown;
  note?: string | null;
}

/** 三桶计数（发版闸放行时的回执，供端点 / 宿主留痕，见 O4 {@link evaluateReleaseGate}） */
export interface ReleaseGateCounts {
  total: number;
  completed: number;
  cancelled: number;
  open: number;
}

export type MarkVersionReleasedResult =
  | {
      ok: true;
      snapshot: ReleaseSnapshotRecord;
      ledger: VersionLedgerRecord;
      /** 本次真的迁了 `status`（`false` = 台账原本已 `released`） */
      statusMigrated: boolean;
      /** 本次真的落了快照（`false` = 快照已存在 ⇒ 不可变，入参被忽略、原样回读） */
      snapshotWritten: boolean;
      /** 闸回执；`null` = 本次未过闸（已 `released` 的重复标记 / 补写，见下文「幂等不过闸」） */
      gateCounts: ReleaseGateCounts | null;
    }
  | { ok: false; code: string; message: string; status: number };

/**
 * `projects` 的**边界校验**（入参来自 JSON，形状不可信）：数组 / 每项是普通对象 /
 * `projectId` `version` `repoId` `ref` ∈ `string | null | 缺省`。
 *
 * **只做形状、不做归一**（§2.1(6)）：不 trim、不折叠大小写、不去重、不排序、不校验 ref 是否为
 * 真 commit/tag、不校验 projectId 是否已注册 —— 引擎不解析 git，校验只会误伤（短 sha / tag 名空间
 * `<project>/vX.Y.Z` 都归调用方与根仓库的口径）。
 *
 * **v0.10.1 O4 · C-5 形状扩**：快照项由 `{repoId, ref}` 扩为 `{projectId, version, repoId, ref}`。
 * 两个新键**可选**、既有键语义**不收紧** ⇒ 按协议版本判据**不升协议版本**（`PROTOCOL_VERSION`
 * 保持 `2.3`）。**缺省即不写键**（不填 `null`、不从归属表反查），历史旧形状行读写两端形状不变。
 */
function validateProjects(
  raw: unknown,
): { projects: ReleaseSnapshotProject[] } | { error: string } {
  if (raw === undefined || raw === null) return { projects: [] };
  if (!Array.isArray(raw)) {
    return {
      error: `projects 期望数组（收到 ${typeof raw === "object" ? "非数组对象" : String(raw)}）`,
    };
  }
  const projects: ReleaseSnapshotProject[] = [];
  for (const [i, item] of raw.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { error: `projects[${i}] 期望对象（发版快照项 = {projectId, version, repoId, ref}）` };
    }
    const entry = item as Record<string, unknown>;
    for (const key of ["repoId", "ref", "projectId", "version"] as const) {
      const value = entry[key];
      if (value !== undefined && value !== null && typeof value !== "string") {
        return { error: `projects[${i}].${key} 期望 string | null（收到 ${String(value)}）` };
      }
    }
    const project: ReleaseSnapshotProject = {
      repoId: (entry["repoId"] ?? null) as string | null,
      ref: (entry["ref"] ?? null) as string | null,
    };
    if (entry["projectId"] !== undefined) {
      project.projectId = (entry["projectId"] ?? null) as string | null;
    }
    if (entry["version"] !== undefined) {
      project.version = (entry["version"] ?? null) as string | null;
    }
    projects.push(project);
  }
  return { projects };
}

/**
 * 发版闸失败码 → HTTP 状态（端点据此直接映射信封；闸本身不回显 status，O4 出参只有
 * `code` / `error`）。**未知码按 409 处理**（发版是写操作，判据不过 = 冲突，不是 404 的「找不到」；
 * fail-closed 方向）。
 */
function gateStatus(code: string): number {
  return code === ERR_VERSION_UNKNOWN ? 404 : 409;
}

/**
 * **标记 `released`（同事务落发版快照）** —— 见文件头。
 *
 * 判据序（**任一不过 ⇒ 零写入**）：
 *
 * 1. `version` 非空（trim 后）⇒ 否则 400 {@link ERR_VERSION_SHAPE}；
 * 2. **台账事实源**：台账未落地（`ledgerReady = false`）⇒ 404 {@link ERR_VERSION_UNKNOWN}
 *    （中间态禁令 fail-closed，同 O4 发版闸口径）；行不存在 ⇒ 404（发版不得代发版号，建版归 O2a）；
 * 3. **幂等不过闸**：台账已 `released` ⇒ **跳过发版闸**直接进事务 —— 闸是「进入 `released`」的
 *    准入，不是「读回 / 补写快照」的准入（迁移主源导入的历史 `released` 行本就无快照，
 *    §2.1(7)；重复标记的幂等交本口 + store 处理，与 O4 doc「本闸不再判」同口径）；
 * 4. 未 `released` ⇒ 过发版闸（O4 `evaluateReleaseGate`，含收口判据与全 `cancelled` 挡闸）；
 * 5. `projects` 形状校验 ⇒ 否则 400 {@link ERR_RELEASE_PROJECTS}；
 * 6. 进 store 事务：`UPDATE versions.status` + `INSERT releases` + **级联 UPDATE 被触达的
 *    `project_versions.status`**（C-4，本层不另立第二份级联逻辑）+ `version.released` 事件同事务。
 *
 * **不可变**由 store 侧保证（快照已存在 ⇒ 不覆写任何一列，本次入参被忽略、回读既有快照），
 * 本层不重复判（判据只落一处）。
 */
export function markVersionReleased(input: MarkVersionReleasedInput): MarkVersionReleasedResult {
  const version = input.version.trim();
  if (version.length === 0) {
    return {
      ok: false,
      code: ERR_VERSION_SHAPE,
      message: "version 不得为空串（标记 released 必须指名版号）",
      status: 400,
    };
  }

  const { status: currentStatus, ledgerReady } = versionLedgerStatus(input.ownerGroup, version);
  if (!ledgerReady || currentStatus === null) {
    return {
      ok: false,
      code: ERR_VERSION_UNKNOWN,
      message:
        `标记 released：version "${version}" 不在引擎版本台账（owner_group=` +
        `${input.ownerGroup === null ? "NULL" : `"${input.ownerGroup}"`}）` +
        `${ledgerReady ? "" : "（台账尚未落地 ⇒ 中间态，fail-closed 不得发版）"}；` +
        `发版事实源须在引擎，先经引擎建版号`,
      status: 404,
    };
  }

  let gateCounts: ReleaseGateCounts | null = null;
  if (currentStatus !== "released") {
    const gate = evaluateReleaseGate({ ownerGroup: input.ownerGroup, version });
    if (!gate.ok) {
      return { ok: false, code: gate.code, message: gate.error, status: gateStatus(gate.code) };
    }
    gateCounts = gate.counts;
  }

  const checked = validateProjects(input.projects);
  if ("error" in checked) {
    return {
      ok: false,
      code: ERR_RELEASE_PROJECTS,
      message: checked.error,
      status: 400,
    };
  }

  const written = versionLedgerMarkReleased({
    ownerGroup: input.ownerGroup,
    version,
    changelogAnchor: input.changelogAnchor ?? null,
    projects: checked.projects,
    note: input.note ?? null,
  });
  if (!written.ok) {
    return { ok: false, code: written.code, message: written.message, status: written.status };
  }
  return {
    ok: true,
    snapshot: written.snapshot,
    ledger: written.ledger,
    statusMigrated: written.statusMigrated,
    snapshotWritten: written.snapshotWritten,
    gateCounts,
  };
}
