/**
 * `orch/config.ts` 配置解析单元测试（v0.4.1 transport 段 / v0.5.0 web 段 / v0.7.0 runner 段；`node:test`，无新依赖）。
 *
 * 覆盖：无 `transport` 段（缺省 http，旧配置零改动可用）、显式 stdio（⇒ 退役 fail-fast）、
 * 显式 http（含 `http` 段部分缺省）、空段、非法 mode、非法 http 端口 / 路径。
 * 覆盖（v0.5.0 web）：无 `web` 段 / 空段缺省、部分缺省、显式覆盖、非法端口（含 1/65535 边界）、
 * 非法 host / enabled、段非对象、`allowStdio` 死配置 warn + 忽略，以及「非 loopback host 不在解析层拒绝」的边界锁定。
 * 覆盖（v0.6.0 projectGroup）：段缺省 ⇒ selective=false 全量接纳（**不得 fail-fast**）、
 * 正常解析 + 派生集合（memberKeys / memberMachineIds / selective）、`name` 缺省 null、
 * 空数组 ⇒ fail、成员项缺字段 / 非对象 / 非字符串 ⇒ fail、未知 `machineId` ⇒ fail、
 * `memberKey` 单射性与集合去重、`defaultProjectGroup` 唯一默认构造。
 * 覆盖（v0.7.0 A1）：`launcherUrl` 必填→可选（缺省解析成功 + warn；存在非法 ⇒ warn + 忽略；
 * 存在合法 ⇒ 原样保留且不告警）、`machines[].token` 可选解析（存在须非空字符串）、
 * 顶层可选 `runner` 段（缺省 / 空段 / 部分缺省 ⇒ 25000 / 60000；非法结构 ⇒ fail-fast）、
 * 协议常量 `PROTOCOL_VERSION === "2.0"` 与 `SUPPORTED_PEER_PROTOCOL_MAJORS === [2]`。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProjectGroup, defaultRunner, loadMachinesConfig, memberKey } from "../config.js";
import { PROTOCOL_VERSION, SUPPORTED_PEER_PROTOCOL_MAJORS } from "../types.js";

/** 在临时目录落一份配置文件并交给回调解析（用例结束即清理） */
function withConfig<T>(raw: unknown, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "orch-config-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(raw), "utf8");
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 最小可用配置（默认不含 transport：模拟旧 config.json） */
function minimalConfig(extra: Record<string, unknown> = {}): unknown {
  return {
    machines: [{ machineId: "m1", launcherUrl: "http://127.0.0.1:3100" }],
    ...extra,
  };
}

const HTTP_DEFAULTS = { host: "127.0.0.1", port: 8787, path: "/mcp" };

/** v0.5.0 `web` 段缺省（v0.7.1 起 `allowStdio` 已随 stdio 退役移除） */
const WEB_DEFAULTS = { enabled: true, host: "127.0.0.1", port: 3300 };

test("缺省：无 transport 段 → mode=http 且 http 取默认值（v0.7.1 缺省反转，旧配置零改动可用）", () => {
  const cfg = withConfig(minimalConfig(), loadMachinesConfig);
  assert.equal(cfg.transport.mode, "http");
  assert.deepEqual(cfg.transport.http, HTTP_DEFAULTS);
});

test("显式 stdio：已退役 ⇒ 结构化 fail-fast（不得静默降级为 http）", () => {
  assert.throws(
    () => withConfig(minimalConfig({ transport: { mode: "stdio" } }), loadMachinesConfig),
    /\[config\] transport\.mode "stdio" 已退役/,
  );
});

test("显式 http：按声明覆盖 http 段，未声明字段回退默认", () => {
  const full = withConfig(
    minimalConfig({
      transport: { mode: "http", http: { host: "0.0.0.0", port: 9000, path: "/a2a" } },
    }),
    loadMachinesConfig,
  );
  assert.equal(full.transport.mode, "http");
  assert.deepEqual(full.transport.http, { host: "0.0.0.0", port: 9000, path: "/a2a" });

  const partial = withConfig(
    minimalConfig({ transport: { mode: "http", http: { port: 9100 } } }),
    loadMachinesConfig,
  );
  assert.equal(partial.transport.mode, "http");
  assert.deepEqual(partial.transport.http, { host: "127.0.0.1", port: 9100, path: "/mcp" });
});

test("空 transport 段：{} 视同缺省（http + http 默认）", () => {
  const cfg = withConfig(minimalConfig({ transport: {} }), loadMachinesConfig);
  assert.equal(cfg.transport.mode, "http");
  assert.deepEqual(cfg.transport.http, HTTP_DEFAULTS);
});

test("非法 mode → 结构化报错（[config] 前缀 + 字段路径），不静默接受", () => {
  const bad: unknown[] = ["sse", "HTTP", "", 1, null, true];
  for (const mode of bad) {
    assert.throws(
      () => withConfig(minimalConfig({ transport: { mode } }), loadMachinesConfig),
      /\[config\] transport\.mode 必须是 "http"/,
    );
  }
});

test("非法 http 端口 → 结构化报错（非整数 / 越界 / 类型错）", () => {
  const bad: unknown[] = [0, 65536, 1.5, "8787", null];
  for (const port of bad) {
    assert.throws(
      () =>
        withConfig(
          minimalConfig({ transport: { mode: "http", http: { port } } }),
          loadMachinesConfig,
        ),
      /\[config\] transport\.http\.port 必须是 1-65535 的整数/,
    );
  }
});

test("非法 http 路径 → 结构化报错（非空字符串且以 / 开头）", () => {
  const bad: unknown[] = ["mcp", "", 42];
  for (const path of bad) {
    assert.throws(
      () =>
        withConfig(
          minimalConfig({ transport: { mode: "http", http: { path } } }),
          loadMachinesConfig,
        ),
      /\[config\] transport\.http\.path 必须/,
    );
  }
});

// ── v0.5.0 `web` 段（网页端只读工作台）────────────────────────────────────────

test("web 缺省：无 web 段 → enabled=true / host=127.0.0.1 / port=3300", () => {
  const cfg = withConfig(minimalConfig(), loadMachinesConfig);
  assert.deepEqual(cfg.web, WEB_DEFAULTS);
});

test("web 空段：{} 视同缺省（旧配置零改动可用）", () => {
  const cfg = withConfig(minimalConfig({ web: {} }), loadMachinesConfig);
  assert.deepEqual(cfg.web, WEB_DEFAULTS);
});

test("web 部分缺省：仅声明 port → 其余字段回退缺省（host 回退 127.0.0.1）", () => {
  const cfg = withConfig(minimalConfig({ web: { port: 3400 } }), loadMachinesConfig);
  assert.deepEqual(cfg.web, { enabled: true, host: "127.0.0.1", port: 3400 });
});

test("web 显式覆盖：三个字段均按声明取值（allowStdio 已退役不参与）", () => {
  const cfg = withConfig(
    minimalConfig({ web: { enabled: false, host: "localhost", port: 3301 } }),
    loadMachinesConfig,
  );
  assert.deepEqual(cfg.web, { enabled: false, host: "localhost", port: 3301 });
});

test("web.enabled：显式 false 被接受（语义 = 不另起只读工作台）", () => {
  const cfg = withConfig(minimalConfig({ web: { enabled: false } }), loadMachinesConfig);
  assert.equal(cfg.web.enabled, false);
  assert.equal(cfg.web.host, WEB_DEFAULTS.host);
  assert.equal(cfg.web.port, WEB_DEFAULTS.port);
});

test("web.allowStdio：已退役（死配置）⇒ 显式出现仅 warn + 忽略，不 fail-fast", () => {
  const { value: cfg, warnings } = captureWarn(() =>
    withConfig(minimalConfig({ web: { allowStdio: true } }), loadMachinesConfig),
  );
  assert.deepEqual(cfg.web, WEB_DEFAULTS);
  assert.ok(
    warnings.some((w) => w.includes("web.allowStdio")),
    `期望 allowStdio 退役告警，实际：${JSON.stringify(warnings)}`,
  );
});

test("非法 web.port → 结构化报错（非整数 / 越界 / 类型错），不静默降级", () => {
  const bad: unknown[] = [0, 65536, -1, 1.5, "3300", null, true];
  for (const port of bad) {
    assert.throws(
      () => withConfig(minimalConfig({ web: { port } }), loadMachinesConfig),
      /\[config\] web\.port 必须是 1-65535 的整数/,
    );
  }
});

test("web.port 边界：1 与 65535 被接受", () => {
  for (const port of [1, 65535]) {
    const cfg = withConfig(minimalConfig({ web: { port } }), loadMachinesConfig);
    assert.equal(cfg.web.port, port);
  }
});

test("非法 web.host → 结构化报错（非空字符串）", () => {
  const bad: unknown[] = ["", 42, null, true];
  for (const host of bad) {
    assert.throws(
      () => withConfig(minimalConfig({ web: { host } }), loadMachinesConfig),
      /\[config\] web\.host 必须是非空字符串/,
    );
  }
});

test("web.host 非 loopback：解析层**接受**（loopback 拒起属运行时，不在此拒绝）", () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.10"]) {
    const cfg = withConfig(minimalConfig({ web: { host } }), loadMachinesConfig);
    assert.equal(cfg.web.host, host);
  }
});

test("非法 web.enabled → 结构化报错（必须布尔值）；web.allowStdio 已退役 ⇒ warn + 忽略", () => {
  for (const bad of ["true", 1, null]) {
    assert.throws(
      () => withConfig(minimalConfig({ web: { enabled: bad } }), loadMachinesConfig),
      /\[config\] web\.enabled 必须是布尔值/,
    );
    const { warnings } = captureWarn(() =>
      withConfig(minimalConfig({ web: { allowStdio: bad } }), loadMachinesConfig),
    );
    assert.ok(
      warnings.some((w) => w.includes("web.allowStdio")),
      `期望 allowStdio 退役告警，实际：${JSON.stringify(warnings)}`,
    );
  }
});

test("web 段非对象 → 结构化报错（字符串 / 数字 / 数组 / null）", () => {
  const bad: unknown[] = ["on", 1, [], null];
  for (const web of bad) {
    assert.throws(
      () => withConfig(minimalConfig({ web }), loadMachinesConfig),
      /\[config\] web 必须是对象/,
    );
  }
});

// ── v0.6.0 `projectGroup` 段（项目组与选择性连接）──────────────────────────────

/** 两台机器的配置（成员校验需要 `machineId ∈ machines[]`） */
function twoMachinesConfig(extra: Record<string, unknown> = {}): unknown {
  return {
    machines: [
      { machineId: "m1", launcherUrl: "http://127.0.0.1:3100" },
      { machineId: "m2", launcherUrl: "http://127.0.0.1:3200" },
    ],
    ...extra,
  };
}

/** 1/ 缺省兼容：无 `projectGroup` 段 ⇒ selective=false（全量接纳），**不 fail-fast** */
test("projectGroup 缺省：无该段 → selective=false（全量接纳）、name=null、成员集合空，且不抛错", () => {
  const cfg = withConfig(minimalConfig(), loadMachinesConfig);
  const g = cfg.projectGroup;
  assert.ok(g, "段缺省也必须产出完整 projectGroup（不得 undefined）");
  assert.equal(g.selective, false);
  assert.equal(g.name, null);
  assert.deepEqual(g.members, []);
  assert.equal(g.memberKeys.size, 0);
  assert.equal(g.memberMachineIds.size, 0);
});

test("projectGroup 缺省：多机配置下同样 selective=false（缺省绝不因机器数变化而 fail）", () => {
  const cfg = withConfig(twoMachinesConfig(), loadMachinesConfig);
  assert.equal(cfg.projectGroup?.selective, false);
  assert.equal(cfg.projectGroup?.members.length, 0);
});

// 2/ 正常解析 + 派生集合
test("projectGroup 正常解析：声明态保留顺序，派生 memberKeys / memberMachineIds / selective 正确", () => {
  const cfg = withConfig(
    twoMachinesConfig({
      projectGroup: {
        name: "团队A",
        members: [
          { machineId: "m1", projectId: "p1" },
          { machineId: "m1", projectId: "p2" },
          { machineId: "m2", projectId: "p3" },
        ],
      },
    }),
    loadMachinesConfig,
  );
  const g = cfg.projectGroup;
  assert.ok(g);
  assert.equal(g.selective, true);
  assert.equal(g.name, "团队A");
  assert.deepEqual(g.members, [
    { machineId: "m1", projectId: "p1" },
    { machineId: "m1", projectId: "p2" },
    { machineId: "m2", projectId: "p3" },
  ]);
  assert.deepEqual([...g.memberMachineIds].sort(), ["m1", "m2"]);
  assert.equal(g.memberKeys.size, 3);
  assert.equal(g.memberKeys.has(memberKey("m1", "p2")), true);
  assert.equal(g.memberKeys.has(memberKey("m1", "p3")), false);
  assert.equal(g.memberKeys.has(memberKey("m2", "p2")), false);
});

test("projectGroup.name：缺省 / 显式 null ⇒ null；非空字符串按声明取值", () => {
  const noName = withConfig(
    twoMachinesConfig({ projectGroup: { members: [{ machineId: "m1", projectId: "p1" }] } }),
    loadMachinesConfig,
  );
  assert.equal(noName.projectGroup?.name, null);

  const nullName = withConfig(
    twoMachinesConfig({
      projectGroup: { name: null, members: [{ machineId: "m1", projectId: "p1" }] },
    }),
    loadMachinesConfig,
  );
  assert.equal(nullName.projectGroup?.name, null);

  const named = withConfig(
    twoMachinesConfig({
      projectGroup: { name: "g", members: [{ machineId: "m1", projectId: "p1" }] },
    }),
    loadMachinesConfig,
  );
  assert.equal(named.projectGroup?.name, "g");
});

test("projectGroup.name 非法（空串 / 非字符串）→ 结构化报错", () => {
  for (const name of ["", 1, true]) {
    assert.throws(
      () =>
        withConfig(
          twoMachinesConfig({
            projectGroup: { name, members: [{ machineId: "m1", projectId: "p1" }] },
          }),
          loadMachinesConfig,
        ),
      /\[config\] projectGroup\.name 必须是非空字符串/,
    );
  }
});

// 3/ 空数组 ⇒ fail（U1 裁定：要么删段、要么列成员）
test("projectGroup.members 空数组 → fail-fast（不得静默锁死 / 不得 fail-open）", () => {
  assert.throws(
    () => withConfig(twoMachinesConfig({ projectGroup: { members: [] } }), loadMachinesConfig),
    /\[config\] projectGroup\.members 必须是非空数组/,
  );
});

test("projectGroup.members 非数组（缺失 / 字符串 / 对象 / null）→ 结构化报错", () => {
  assert.throws(
    () => withConfig(twoMachinesConfig({ projectGroup: {} }), loadMachinesConfig),
    /\[config\] projectGroup\.members 必须是数组/,
  );
  for (const members of ["m1", { machineId: "m1" }, null]) {
    assert.throws(
      () => withConfig(twoMachinesConfig({ projectGroup: { members } }), loadMachinesConfig),
      /\[config\] projectGroup\.members 必须是数组/,
    );
  }
});

test("projectGroup 段非对象（字符串 / 数字 / 数组 / null）→ 结构化报错", () => {
  for (const projectGroup of ["on", 1, [], null]) {
    assert.throws(
      () => withConfig(twoMachinesConfig({ projectGroup }), loadMachinesConfig),
      /\[config\] projectGroup 必须是对象/,
    );
  }
});

// 4/ 成员项缺字段 / 非法 ⇒ fail
test("projectGroup 成员项缺字段 / 非字符串 → 结构化报错（machineId / projectId 均须非空字符串）", () => {
  const badMembers: unknown[] = [
    { projectId: "p1" },
    { machineId: "m1" },
    { machineId: "", projectId: "p1" },
    { machineId: "m1", projectId: "" },
    { machineId: 1, projectId: "p1" },
    { machineId: "m1", projectId: null },
    "m1/p1",
    null,
  ];
  for (const member of badMembers) {
    assert.throws(
      () =>
        withConfig(twoMachinesConfig({ projectGroup: { members: [member] } }), loadMachinesConfig),
      /\[config\] projectGroup\.members\[0\]/,
    );
  }
});

// 5/ 未知 machineId ⇒ fail-fast
test("projectGroup.members[].machineId 不在 machines[] → fail-fast（拼错机器名不得被静默接受）", () => {
  assert.throws(
    () =>
      withConfig(
        twoMachinesConfig({ projectGroup: { members: [{ machineId: "m9", projectId: "p1" }] } }),
        loadMachinesConfig,
      ),
    /\[config\] projectGroup\.members\[0\]\.machineId "m9" 不在 machines\[\] 中/,
  );
  // 第二项才越界：错误信息须指向该下标（定位到出错项，不误报第一项）
  assert.throws(
    () =>
      withConfig(
        twoMachinesConfig({
          projectGroup: {
            members: [
              { machineId: "m1", projectId: "p1" },
              { machineId: "m2", projectId: "p2" },
              { machineId: "nope", projectId: "p3" },
            ],
          },
        }),
        loadMachinesConfig,
      ),
    /\[config\] projectGroup\.members\[2\]\.machineId "nope" 不在 machines\[\] 中/,
  );
});

// 6/ memberKey（唯一构造）与集合去重
test("memberKey：同一元组恒定、不同元组分叉，且对含分隔符的 id 不碰撞（禁第二套拼接）", () => {
  assert.equal(memberKey("m1", "p1"), memberKey("m1", "p1"));
  assert.notEqual(memberKey("m1", "p1"), memberKey("m1", "p2"));
  assert.notEqual(memberKey("m1", "p1"), memberKey("m2", "p1"));
  assert.notEqual(memberKey("m1", "p1"), memberKey("p1", "m1"));
  // 对抗用例：若用 ":" / "/" 拼接，下面两组会互相碰撞
  assert.notEqual(memberKey("a", "b:c"), memberKey("a:b", "c"));
  assert.notEqual(memberKey("a", "b/c"), memberKey("a/b", "c"));
});

test("memberKeys / memberMachineIds 去重：重复成员项 ⇒ 集合不重复，声明态 members 保留原样", () => {
  const cfg = withConfig(
    twoMachinesConfig({
      projectGroup: {
        members: [
          { machineId: "m1", projectId: "p1" },
          { machineId: "m1", projectId: "p1" },
          { machineId: "m1", projectId: "p2" },
        ],
      },
    }),
    loadMachinesConfig,
  );
  const g = cfg.projectGroup;
  assert.ok(g);
  assert.equal(g.members.length, 3);
  assert.equal(g.memberKeys.size, 2);
  assert.equal(g.memberMachineIds.size, 1);
});

test("defaultProjectGroup：唯一「全量接纳」默认构造（段缺省态与缺省解析结果一致）", () => {
  const cfg = withConfig(minimalConfig(), loadMachinesConfig);
  const def = defaultProjectGroup();
  assert.equal(def.selective, false);
  assert.equal(def.name, null);
  assert.deepEqual(def.members, []);
  assert.equal(def.memberKeys.size, 0);
  assert.equal(def.memberMachineIds.size, 0);
  assert.deepEqual(cfg.projectGroup, def);
});

// ── v0.7.0 A1：协议常量 + launcherUrl/token + runner 段 ─────────────────────────

/** 捕获解析期 `console.warn`（断言「缺省/非法告警」与「合法不告警」） */
function captureWarn<T>(fn: () => T): { value: T; warnings: string[] } {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

/** 单机配置（可精确控制该机器对象字段，便于 launcherUrl / token 用例） */
function machineConfig(machine: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return { machines: [machine], ...extra };
}

const RUNNER_DEFAULTS = { holdMs: 25000, heartbeatTimeoutMs: 60000 };

test("协议常量（v0.7.0 硬切 2.0）：PROTOCOL_VERSION=2.0 / SUPPORTED_PEER_PROTOCOL_MAJORS=[2]", () => {
  assert.equal(PROTOCOL_VERSION, "2.0");
  assert.deepEqual([...SUPPORTED_PEER_PROTOCOL_MAJORS], [2]);
});

test("launcherUrl 缺省（可选）：解析成功 + warn，不 fail-fast、不回退全量接纳", () => {
  const { value: cfg, warnings } = captureWarn(() =>
    withConfig(machineConfig({ machineId: "m1" }), loadMachinesConfig),
  );
  assert.equal(cfg.machines[0]?.machineId, "m1");
  assert.equal(cfg.machines[0]?.launcherUrl, "");
  assert.equal(cfg.projectGroup?.selective, false);
  assert.ok(
    warnings.some((w) => w.includes("machines[0].launcherUrl 缺省")),
    `期望 launcherUrl 缺省告警，实际：${JSON.stringify(warnings)}`,
  );
});

test("launcherUrl 存在且合法：原样保留，且不产生告警（旧配置零改动）", () => {
  const { value: cfg, warnings } = captureWarn(() => withConfig(minimalConfig(), loadMachinesConfig));
  assert.equal(cfg.machines[0]?.launcherUrl, "http://127.0.0.1:3100");
  assert.deepEqual(warnings, []);
});

test("launcherUrl 存在但非法（空串 / 非字符串）：warn + 忽略（归一为 \"\"），不抛错", () => {
  for (const launcherUrl of ["", 3100, null, true]) {
    const { value: cfg, warnings } = captureWarn(() =>
      withConfig(machineConfig({ machineId: "m1", launcherUrl }), loadMachinesConfig),
    );
    assert.equal(cfg.machines[0]?.launcherUrl, "");
    assert.ok(
      warnings.some((w) => w.includes("machines[0].launcherUrl 非法")),
      `期望 launcherUrl 非法告警，实际：${JSON.stringify(warnings)}`,
    );
  }
});

test("machines[].token：缺省 ⇒ undefined；显式非空字符串 ⇒ 原样保留", () => {
  const absent = withConfig(machineConfig({ machineId: "m1" }), loadMachinesConfig);
  assert.equal(absent.machines[0]?.token, undefined);

  const present = withConfig(
    machineConfig({ machineId: "m1", token: "runner-tok-1" }),
    loadMachinesConfig,
  );
  assert.equal(present.machines[0]?.token, "runner-tok-1");
});

test("machines[].token 非法（空串 / 非字符串 / null）→ 结构化报错", () => {
  for (const token of ["", 123, null, true]) {
    assert.throws(
      () => withConfig(machineConfig({ machineId: "m1", token }), loadMachinesConfig),
      /\[config\] machines\[0\]\.token 必须是非空字符串/,
    );
  }
});

test("runner 缺省：无 runner 段 → { holdMs: 25000, heartbeatTimeoutMs: 60000 }", () => {
  const cfg = withConfig(minimalConfig(), loadMachinesConfig);
  assert.deepEqual(cfg.runner, RUNNER_DEFAULTS);
});

test("runner 空段：{} 视同缺省（旧配置零改动可用）", () => {
  const cfg = withConfig(minimalConfig({ runner: {} }), loadMachinesConfig);
  assert.deepEqual(cfg.runner, RUNNER_DEFAULTS);
});

test("runner 部分缺省：仅声明 holdMs ⇒ heartbeatTimeoutMs 回退缺省；两者均声明 ⇒ 按声明取值", () => {
  const partial = withConfig(minimalConfig({ runner: { holdMs: 30000 } }), loadMachinesConfig);
  assert.deepEqual(partial.runner, { holdMs: 30000, heartbeatTimeoutMs: 60000 });

  const full = withConfig(
    minimalConfig({ runner: { holdMs: 10000, heartbeatTimeoutMs: 45000 } }),
    loadMachinesConfig,
  );
  assert.deepEqual(full.runner, { holdMs: 10000, heartbeatTimeoutMs: 45000 });
});

test("runner 段非对象（字符串 / 数字 / 数组 / null）→ 结构化报错", () => {
  for (const runner of ["on", 1, [], null]) {
    assert.throws(
      () => withConfig(minimalConfig({ runner }), loadMachinesConfig),
      /\[config\] runner 必须是对象/,
    );
  }
});

test("runner 阈值非法（0 / 负 / 小数 / 类型错）→ 结构化报错，不静默降级", () => {
  const bad: unknown[] = [0, -1, 1.5, "25000", null, true];
  for (const holdMs of bad) {
    assert.throws(
      () => withConfig(minimalConfig({ runner: { holdMs } }), loadMachinesConfig),
      /\[config\] runner\.holdMs 必须是正整数（毫秒，>=1）/,
    );
  }
  for (const heartbeatTimeoutMs of bad) {
    assert.throws(
      () => withConfig(minimalConfig({ runner: { heartbeatTimeoutMs } }), loadMachinesConfig),
      /\[config\] runner\.heartbeatTimeoutMs 必须是正整数（毫秒，>=1）/,
    );
  }
});

test("defaultRunner：唯一缺省构造（段缺省态与缺省解析结果一致）", () => {
  assert.deepEqual(defaultRunner(), RUNNER_DEFAULTS);
});
