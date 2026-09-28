/**
 * v0.9.4 O1（REQ-2026-09-26-01 改造文档 §2.3）—— **受控写工具 `a2a_config_write_group`**。
 *
 * 锁定的行为面：
 * 1. **五操作正例**（group.add / group.update 整集替换 / group.remove / group.member.add /
 *    group.member.remove）经 `writeGroupConfig` 端到端落盘，`loadMachinesConfig` 读回一致；
 * 2. **错误码闭集六条负例**：dry_run_rejected（带原 message）/ unknown_machine / group_not_found /
 *    duplicate_member（同组与跨组）/ concurrent_modification / io_failed；
 * 3. **乐观校验**：快照后被外部改动 ⇒ 整单拒绝、当前文件保持外部终值（本写未落地）；
 * 4. **备份语义**：成功写入的 `backedUpTo` 含写前原样；幂等零写入（remove 不存在的成员）不备份、不落盘；
 * 5. **互斥**：并发两写经模块级 promise 链串行，互不踩踏（双生效）；
 * 6. **注册证据**：registerTools 静态注册（工具面 13→14）+ MCP callTool 直通
 *    `core.configWriteGroup`（成功 text / 失败 isError，契约形状 `{ok, code, error, backedUpTo?}`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadMachinesConfig } from "../config.js";
import {
  CONFIG_WRITE_GROUP_FAILURE_CODES,
  CONFIG_WRITE_GROUP_OPS,
  applyGroupOp,
  writeGroupConfig,
  type ConfigWriteGroupArgs,
  type ConfigWriteGroupFailure,
  type ConfigWriteGroupSuccess,
} from "../bridge/config-write.js";
import { configWriteGroupSchema, createServer } from "../bridge/register-tools.js";
import type { BridgeCore } from "../bridge/index.js";
import type { ProjectMember } from "../types.js";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function tmpConfigDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `a2a-v094-o1-${tag}-`));
}

function seedConfig(dir: string, doc: Record<string, unknown>): string {
  const path = join(dir, "config.json");
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return path;
}

/** 最小可解析文档（两台机器 + 一个组 g1 一成员） */
function baseDoc(): Record<string, unknown> {
  return {
    machines: [{ machineId: "m1" }, { machineId: "m2" }],
    projectGroup: [{ name: "g1", members: [{ machineId: "m1", projectId: "p1" }] }],
  };
}

function readGroups(path: string): { name: string; members: ProjectMember[] }[] {
  const doc = JSON.parse(readFileSync(path, "utf8")) as { projectGroup?: unknown };
  return (doc.projectGroup ?? []) as { name: string; members: ProjectMember[] }[];
}

function mustOk(
  outcome: ConfigWriteGroupSuccess | ConfigWriteGroupFailure,
): ConfigWriteGroupSuccess {
  if (!outcome.ok) throw new Error(`期望成功，实际失败：${outcome.code} ${outcome.error}`);
  return outcome;
}

function mustFail<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: false }> {
  if (outcome.ok) throw new Error("期望失败，实际成功");
  return outcome as Extract<T, { ok: false }>;
}

const args = (
  over: Partial<ConfigWriteGroupArgs> & { op: ConfigWriteGroupArgs["op"]; groupName: string },
): ConfigWriteGroupArgs => over;

// ---------------------------------------------------------------------------
// 1. 五操作正例（端到端）
// ---------------------------------------------------------------------------

test("O1 正例：group.add 新建组 ⇒ 落盘可被 loadMachinesConfig 读回，backedUpTo 含写前原样", async () => {
  const dir = tmpConfigDir("add");
  try {
    const path = seedConfig(dir, baseDoc());
    const before = readFileSync(path, "utf8");
    const ok = mustOk(
      await writeGroupConfig(
        path,
        args({
          op: "group.add",
          groupName: "g2",
          members: [{ machineId: "m2", projectId: "p2" }],
        }),
      ),
    );
    assert.equal(ok.changed, true);
    assert.ok(ok.backedUpTo, "成功写入必带备份路径");
    assert.equal(readFileSync(ok.backedUpTo!, "utf8"), before, "备份 = 写前原样");
    const cfg = loadMachinesConfig(path);
    assert.deepEqual(
      (cfg.groups ?? []).map((g) => g.name),
      ["g1", "g2"],
    );
    // 未消费段原样保留（拒绝整文档替换 ⇒ machines 段不动）
    assert.equal(readGroups(path).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("O1 正例：group.member.add 追加成员（board B 档「增」的映射目标）", async () => {
  const dir = tmpConfigDir("madd");
  try {
    const path = seedConfig(dir, baseDoc());
    const ok = mustOk(
      await writeGroupConfig(
        path,
        args({
          op: "group.member.add",
          groupName: "g1",
          members: [{ machineId: "m2", projectId: "px" }],
        }),
      ),
    );
    assert.deepEqual(ok.members, [
      { machineId: "m1", projectId: "p1" },
      { machineId: "m2", projectId: "px" },
    ]);
    assert.deepEqual(readGroups(path)[0]!.members, ok.members);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("O1 正例：group.member.remove 摘除成员（board B 档「删」）；热生效 = 读面无该成员", async () => {
  const dir = tmpConfigDir("mremove");
  try {
    const path = seedConfig(
      dir,
      (() => {
        const d = baseDoc();
        (d.projectGroup as { members: ProjectMember[] }[])[0]!.members.push({
          machineId: "m2",
          projectId: "p2",
        });
        return d;
      })(),
    );
    const ok = mustOk(
      await writeGroupConfig(
        path,
        args({
          op: "group.member.remove",
          groupName: "g1",
          members: [{ machineId: "m2", projectId: "p2" }],
        }),
      ),
    );
    assert.deepEqual(ok.members, [{ machineId: "m1", projectId: "p1" }]);
    const cfg = loadMachinesConfig(path);
    assert.equal(
      (cfg.groups ?? []).flatMap((g) => [...g.memberKeys]).length,
      1,
      "读面派生集合同步收窄（写读同源）",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("O1 正例：group.update 整集替换 members；group.remove 摘整组（出参 members=null）", async () => {
  const dir = tmpConfigDir("upd-rm");
  try {
    const path = seedConfig(dir, {
      machines: [{ machineId: "m1" }, { machineId: "m2" }],
      projectGroup: [
        { name: "g1", members: [{ machineId: "m1", projectId: "p1" }] },
        { name: "g2", members: [{ machineId: "m2", projectId: "p2" }] },
      ],
    });
    const upd = mustOk(
      await writeGroupConfig(
        path,
        args({
          op: "group.update",
          groupName: "g1",
          members: [{ machineId: "m2", projectId: "q9" }],
        }),
      ),
    );
    assert.deepEqual(upd.members, [{ machineId: "m2", projectId: "q9" }]);
    const rm = mustOk(await writeGroupConfig(path, args({ op: "group.remove", groupName: "g2" })));
    assert.equal(rm.members, null, "group.remove ⇒ 组已不在文档中");
    assert.deepEqual(
      readGroups(path).map((g) => g.name),
      ["g1"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("O1 幂等：member.remove 目标成员本不在组内 ⇒ changed=false、零写入、无备份（mtime 不变）", async () => {
  const dir = tmpConfigDir("idempotent");
  try {
    const path = seedConfig(dir, baseDoc());
    const mtimeBefore = statSync(path).mtimeMs;
    const ok = mustOk(
      await writeGroupConfig(
        path,
        args({
          op: "group.member.remove",
          groupName: "g1",
          members: [{ machineId: "m1", projectId: "ghost" }],
        }),
      ),
    );
    assert.equal(ok.changed, false);
    assert.equal(ok.backedUpTo, undefined, "零写入不产生备份");
    assert.equal(statSync(path).mtimeMs, mtimeBefore, "文件未被触碰");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. 错误码闭集六条负例
// ---------------------------------------------------------------------------

test("O1 负例①：dry_run_rejected —— 组名字符集非法 ⇒ 422 码 + 携带 parseProjectGroups 原 message，配置原样", async () => {
  const dir = tmpConfigDir("dryrun");
  try {
    const path = seedConfig(dir, baseDoc());
    const before = readFileSync(path, "utf8");
    const denied = mustFail(
      await writeGroupConfig(
        path,
        args({
          op: "group.add",
          groupName: "bad name",
          members: [{ machineId: "m1", projectId: "p9" }],
        }),
      ),
    );
    assert.equal(denied.code, "config_write_dry_run_rejected");
    assert.match(denied.error, /非法/, "错误透传同源解析器的原 message");
    assert.equal(readFileSync(path, "utf8"), before, "坏写不落盘");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("O1 负例①b：dry_run_rejected —— group.add 重名 / 保留首段 / member.remove 掏空组（parse 拒空 members）", async () => {
  const dir = tmpConfigDir("dryrun2");
  try {
    const path = seedConfig(dir, baseDoc());
    const dup = mustFail(
      await writeGroupConfig(
        path,
        args({ op: "group.add", groupName: "g1", members: [{ machineId: "m2", projectId: "p9" }] }),
      ),
    );
    assert.equal(dup.code, "config_write_dry_run_rejected");
    const reserved = mustFail(
      await writeGroupConfig(
        path,
        args({
          op: "group.add",
          groupName: "health",
          members: [{ machineId: "m2", projectId: "p9" }],
        }),
      ),
    );
    assert.equal(reserved.code, "config_write_dry_run_rejected");
    const empty = mustFail(
      await writeGroupConfig(
        path,
        args({
          op: "group.member.remove",
          groupName: "g1",
          members: [{ machineId: "m1", projectId: "p1" }],
        }),
      ),
    );
    assert.equal(
      empty.code,
      "config_write_dry_run_rejected",
      "掏空末位成员 = 空 members 段，读面解析必拒 ⇒ 写前即拒",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("O1 负例②：unknown_machine —— 成员 machineId 不在 machines[] ⇒ 422 码", async () => {
  const dir = tmpConfigDir("unknownmachine");
  try {
    const path = seedConfig(dir, baseDoc());
    const before = readFileSync(path, "utf8");
    const denied = mustFail(
      await writeGroupConfig(
        path,
        args({
          op: "group.member.add",
          groupName: "g1",
          members: [{ machineId: "m-ghost", projectId: "p9" }],
        }),
      ),
    );
    assert.equal(denied.code, "config_write_unknown_machine");
    assert.match(denied.error, /m-ghost/);
    assert.equal(readFileSync(path, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("O1 负例③：group_not_found —— update/remove/member.* 四类目标组不存在 ⇒ 同一 409 码（R2 定死单码）", async () => {
  const dir = tmpConfigDir("notfound");
  try {
    const path = seedConfig(dir, baseDoc());
    const member = [{ machineId: "m1", projectId: "p1" }];
    for (const op of [
      "group.update",
      "group.remove",
      "group.member.add",
      "group.member.remove",
    ] as const) {
      const denied = mustFail(
        await writeGroupConfig(path, args({ op, groupName: "g-none", members: member })),
      );
      assert.equal(denied.code, "config_write_group_not_found", `${op} 缺失组 ⇒ 单码`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("O1 负例④：duplicate_member —— 同组重复添加 与 跨组已有（成员互斥）⇒ 同码，跨组文案报所在组", async () => {
  const dir = tmpConfigDir("dupmember");
  try {
    const path = seedConfig(dir, baseDoc());
    const same = mustFail(
      await writeGroupConfig(
        path,
        args({
          op: "group.member.add",
          groupName: "g1",
          members: [{ machineId: "m1", projectId: "p1" }],
        }),
      ),
    );
    assert.equal(same.code, "config_write_duplicate_member");
    // 预置 g2 后测跨组互斥
    writeFileSync(
      path,
      JSON.stringify(
        {
          machines: [{ machineId: "m1" }, { machineId: "m2" }],
          projectGroup: [
            { name: "g1", members: [{ machineId: "m1", projectId: "p1" }] },
            { name: "g2", members: [{ machineId: "m2", projectId: "p2" }] },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    const xg = mustFail(
      await writeGroupConfig(
        path,
        args({
          op: "group.member.add",
          groupName: "g1",
          members: [{ machineId: "m2", projectId: "p2" }],
        }),
      ),
    );
    assert.equal(xg.code, "config_write_duplicate_member");
    assert.match(xg.error, /g2/, "跨组重复 ⇒ 文案指出所在组（挪组 = remove+add）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("O1 负例⑤：concurrent_modification —— 快照后外部改动 ⇒ 整单拒绝、外部终值保留、无备份", async () => {
  const dir = tmpConfigDir("concurrent");
  try {
    const path = seedConfig(dir, baseDoc());
    const outcome = await writeGroupConfig(
      path,
      args({
        op: "group.member.add",
        groupName: "g1",
        members: [{ machineId: "m2", projectId: "p9" }],
      }),
      {
        afterSnapshot: () => {
          // 模拟外部写者在处理途中整档改写
          writeFileSync(
            path,
            JSON.stringify({ ...baseDoc(), _external: "touched" }, null, 2),
            "utf8",
          );
        },
      },
    );
    const denied = mustFail(outcome);
    assert.equal(denied.code, "config_write_concurrent_modification");
    assert.equal(denied.backedUpTo, undefined, "复核在备份之前 ⇒ 未产生备份文件");
    const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    assert.equal(doc["_external"], "touched", "外部终值未被本写覆盖");
    const groups = doc["projectGroup"] as { members: ProjectMember[] }[];
    assert.equal(groups[0]!.members.length, 1, "本写未落地");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("O1 负例⑥：io_failed —— config 不存在 / 非合法 JSON ⇒ 500 码、拒绝在坏文档上 RMW", async () => {
  const dir = tmpConfigDir("iofailed");
  try {
    const missing = mustFail(
      await writeGroupConfig(join(dir, "nope.json"), args({ op: "group.remove", groupName: "g1" })),
    );
    assert.equal(missing.code, "config_write_io_failed");
    const path = join(dir, "config.json");
    writeFileSync(path, "{ not json", "utf8");
    const broken = mustFail(
      await writeGroupConfig(path, args({ op: "group.remove", groupName: "g1" })),
    );
    assert.equal(broken.code, "config_write_io_failed");
    assert.equal(readFileSync(path, "utf8"), "{ not json", "坏文档原样保留（不格式化、不覆盖）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. 互斥（模块级 promise 链）
// ---------------------------------------------------------------------------

test("O1 互斥：同文件并发两笔 member.add（不 await 直发）⇒ 双生效、无丢写", async () => {
  const dir = tmpConfigDir("mutex");
  try {
    const path = seedConfig(dir, baseDoc());
    const [a, b] = await Promise.all([
      writeGroupConfig(
        path,
        args({
          op: "group.member.add",
          groupName: "g1",
          members: [{ machineId: "m1", projectId: "pa" }],
        }),
      ),
      writeGroupConfig(
        path,
        args({
          op: "group.member.add",
          groupName: "g1",
          members: [{ machineId: "m2", projectId: "pb" }],
        }),
      ),
    ]);
    mustOk(a);
    mustOk(b);
    const projectIds = readGroups(path)[0]!
      .members.map((m) => m.projectId)
      .sort();
    assert.deepEqual(projectIds, ["p1", "pa", "pb"], "RMW 全程重读 ⇒ 第二笔看到第一笔的产出");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. applyGroupOp 纯函数面（op 语义不经 I/O 的直断）
// ---------------------------------------------------------------------------

test("O1 纯函数：五操作闭集与失败码闭集常量形状钉", () => {
  assert.deepEqual(
    [...CONFIG_WRITE_GROUP_OPS],
    ["group.add", "group.update", "group.remove", "group.member.add", "group.member.remove"],
  );
  assert.deepEqual(
    [...CONFIG_WRITE_GROUP_FAILURE_CODES],
    [
      "config_write_dry_run_rejected",
      "config_write_unknown_machine",
      "config_write_group_not_found",
      "config_write_duplicate_member",
      "config_write_concurrent_modification",
      "config_write_io_failed",
    ],
  );
});

test("O1 纯函数：缺 members 的写 op ⇒ dry_run_rejected（按-op 参数校验落纯函数、单一错误面）", () => {
  const doc = baseDoc();
  const denied = mustFail(
    applyGroupOp(
      doc,
      doc["projectGroup"] as unknown[],
      new Set(["m1", "m2"]),
      args({ op: "group.add", groupName: "gX" }),
    ),
  );
  assert.equal(denied.code, "config_write_dry_run_rejected");
});

// ---------------------------------------------------------------------------
// 5. schema + MCP 注册证据
// ---------------------------------------------------------------------------

const toolArgs = z.object(configWriteGroupSchema);

test("O1 schema：op 必填闭集；members 项 machineId/projectId 非空；未知键 strip", () => {
  assert.equal(toolArgs.safeParse({ op: "no-such-op", groupName: "g1" }).success, false);
  assert.equal(toolArgs.safeParse({ groupName: "g1" }).success, false, "缺 op 被拒");
  assert.equal(
    toolArgs.safeParse({
      op: "group.member.add",
      groupName: "g1",
      members: [{ machineId: "", projectId: "p" }],
    }).success,
    false,
  );
  assert.equal(
    toolArgs.safeParse({ op: "group.remove", groupName: "g1", wholeDocument: {} }).success,
    true,
    "未知键被 strip（入参面根本没有整文档通道）",
  );
});

test("O1 注册证据：createServer 工具面 13→14 含 a2a_config_write_group；callTool 直通 core.configWriteGroup", async () => {
  const calls: ConfigWriteGroupArgs[] = [];
  const core = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "configWriteGroup") {
          return async (a: ConfigWriteGroupArgs) => {
            calls.push(a);
            return {
              ok: true,
              op: a.op,
              groupName: a.groupName,
              changed: true,
              members: a.members ?? null,
              backedUpTo: "/tmp/x.bak",
            } satisfies ConfigWriteGroupSuccess;
          };
        }
        return () => {
          throw new Error(`不得触碰其它 BridgeCore 方法：${String(prop)}`);
        };
      },
    },
  ) as unknown as BridgeCore;

  const server: McpServer = createServer(core);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "v094-o1-test", version: "1.0.0" }, {});
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const listed = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.ok(listed.includes("a2a_config_write_group"), "静态注册证据");
  assert.equal(listed.length, 14, "泛型 7 + Feature 6 + 配置面 1");

  const res = await client.callTool({
    name: "a2a_config_write_group",
    arguments: {
      op: "group.member.add",
      groupName: "g1",
      members: [{ machineId: "m1", projectId: "p2" }],
    },
  });
  assert.notEqual(res.isError, true);
  const payload = JSON.parse(
    (res.content as Array<{ text: string }>)[0]!.text,
  ) as ConfigWriteGroupSuccess;
  assert.equal(payload.ok, true);
  assert.equal(payload.backedUpTo, "/tmp/x.bak");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.op, "group.member.add", "入参原样透至 core 落点");
  assert.equal(calls[0]!.groupName, "g1");
  await server.close();
  await client.close();
});
