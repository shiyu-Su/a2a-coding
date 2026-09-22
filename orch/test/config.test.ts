/**
 * `orch/config.ts` 配置解析单元测试（v0.4.1 transport 段 / v0.5.0 web 段 / v0.7.0 runner 段；`node:test`，无新依赖）。
 *
 * 覆盖：无 `transport` 段（缺省 http，旧配置零改动可用）、显式 stdio（⇒ 退役 fail-fast）、
 * 显式 http（含 `http` 段部分缺省）、空段、非法 mode、非法 http 端口 / 路径。
 * 覆盖（v0.5.0 web）：无 `web` 段 / 空段缺省、部分缺省、显式覆盖、非法端口（含 1/65535 边界）、
 * 非法 host / enabled、段非对象、`allowStdio` 死配置 warn + 忽略，以及「非 loopback host 不在解析层拒绝」的边界锁定。
 * 覆盖（v0.6.0 projectGroup / v0.8.6 一桥多组）：段缺省 / 空数组 ⇒ groups=[] 全量接纳（**不得 fail-fast**）、
 * 键名沿用 `projectGroup` 但形状扩为**组数组**、每组 selective=true、派生集合（memberKeys / memberMachineIds）、
 * ★ **B 形态启动校验（N2）**：`transport.http.path` 拒尾斜杠 / 不得为 /health /shutdown /runner 本身或前缀、
 * `name` **必填**且字符集 `[A-Za-z0-9_-]+`、组名不得与保留 URL 首段（health/shutdown/runner/options.path 首段）冲突、
 * 空数组 ⇒ fail、成员项缺字段 / 非对象 / 非字符串 ⇒ fail、未知 `machineId` ⇒ fail、
 * ★ **组间成员互斥 fail-fast**（同一 `(machineId, projectId)` 落两组）、组内重复项仅集合去重、
 * `memberKey` 单射性与集合去重、`defaultProjectGroup` 唯一默认构造、N1 过渡聚合视图 `projectGroup` = 各组并集。
 * 覆盖（v0.7.0 A1）：`launcherUrl` 必填→可选（缺省解析成功 + warn；存在非法 ⇒ warn + 忽略；
 * 存在合法 ⇒ 原样保留且不告警）、`machines[].token` 可选解析（存在须非空字符串）、
 * 顶层可选 `runner` 段（缺省 / 空段 / 部分缺省 ⇒ 25000 / 60000；非法结构 ⇒ fail-fast）、
 * 协议常量 `PROTOCOL_VERSION === "2.2"` 与 `SUPPORTED_PEER_PROTOCOL_MAJORS === [2]`。
 * 覆盖（v0.7.2 K6）：warn **文案级 once-per-process 去重** —— 同一坏配置重复解析 ⇒ 同文案仅
 * warn 一次（次数 = 1）、不同文案（缺省 / 非法 / 不同机器下标 / allowStdio）互不去重、
 * 去重不改解析语义（结果一致、合法配置仍零告警）；`resetWarnOnceCache` 提供用例级隔离。
 * 覆盖（v0.8.3 O2）：`callback` 段与 `machines[].pushCallback` 退役 ⇒ 旧配置宽容解析（不抛错、
 * 返回对象无 `callback` 键）+ 两条退役 warn 各恰一次（文案级 once-per-process）。
 * 覆盖（v0.8.6 FIX-2 R-2）：模板 `config/config.json.default` 的 `_projectGroupExample`（组数组样例）
 * 原样喂给 `parseProjectGroups` 正向接受（防样例与 schema 二次漂移）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appRootFromModule } from "../app-root.js";
import {
  defaultProjectGroup,
  defaultRunner,
  loadMachinesConfig,
  memberKey,
  parseProjectGroups,
  resetWarnOnceCache,
} from "../config.js";
import { PROTOCOL_VERSION, SUPPORTED_PEER_PROTOCOL_MAJORS } from "../types.js";

// v0.7.2 K6：warn 文案级 once-per-process 去重 —— 每个用例前重置去重态，
// 保证「同一文案在本用例内的首次告警」可观测（仅测试隔离，不改生产语义）。
beforeEach(() => {
  resetWarnOnceCache();
});

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

// ── v0.8.6 N2 B 形态启动校验（身份 = URL 首段：path 尾斜杠 / 保留路由前缀）─────

test("transport.http.path 尾斜杠 ⇒ fail-fast（②：身份首段解析下尾斜杠产生空段歧义）", () => {
  for (const path of ["/", "/mcp/", "/orch/mcp/"]) {
    assert.throws(
      () =>
        withConfig(
          minimalConfig({ transport: { mode: "http", http: { path } } }),
          loadMachinesConfig,
        ),
      /\[config\] transport\.http\.path "\/.*" 非法：不得以 "\/" 结尾/,
      `path=${path} 应被拒`,
    );
  }
});

test("transport.http.path 撞保留路由 ⇒ fail-fast（①：/health /shutdown /runner 本身或其前缀）", () => {
  for (const path of ["/health", "/healthz", "/shutdown", "/runner", "/runner/register"]) {
    assert.throws(
      () =>
        withConfig(
          minimalConfig({ transport: { mode: "http", http: { path } } }),
          loadMachinesConfig,
        ),
      /\[config\] transport\.http\.path .* 非法：MCP 端点不得为 \/(health|shutdown|runner) 本身或其前缀/,
      `path=${path} 应被拒`,
    );
  }
  // 不撞保留段的多段路径合法（身份 = 首段、其余须恰等于 path 的 B 形态入口）
  const ok = withConfig(
    minimalConfig({ transport: { mode: "http", http: { path: "/orch/mcp" } } }),
    loadMachinesConfig,
  );
  assert.equal(ok.transport.http.path, "/orch/mcp");
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
    // K6：逐次重置去重态 —— 每个 bad 值都应观测到「本窗口内的首次」allowStdio 告警
    resetWarnOnceCache();
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

// ── v0.8.6 一桥多组 `projectGroup` 段（组数组 + 组间成员互斥 fail-fast）─────────

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

/** 1/ 缺省兼容：无 `projectGroup` 段 ⇒ 顶层 groups=[]（全量接纳）、聚合视图 selective=false，**不 fail-fast** */
test("projectGroup 缺省：无该段 → groups=[]（全量接纳）、聚合 name=null/成员空/selective=false，且不抛错", () => {
  const cfg = withConfig(minimalConfig(), loadMachinesConfig);
  assert.deepEqual(cfg.groups, []);
  const agg = cfg.projectGroup;
  assert.ok(agg, "段缺省也必须产出 N1 过渡聚合视图（不得 undefined）");
  assert.equal(agg.selective, false);
  assert.equal(agg.name, null);
  assert.deepEqual(agg.members, []);
  assert.equal(agg.memberKeys.size, 0);
  assert.equal(agg.memberMachineIds.size, 0);
});

test("projectGroup 缺省：多机配置下同样 groups=[] 且聚合 selective=false（缺省绝不因机器数变化而 fail）", () => {
  const cfg = withConfig(twoMachinesConfig(), loadMachinesConfig);
  assert.deepEqual(cfg.groups, []);
  assert.equal(cfg.projectGroup?.selective, false);
  assert.equal(cfg.projectGroup?.members.length, 0);
});

test("projectGroup 空数组段：[] 视同未配组（全量接纳 ⇒ groups=[]）", () => {
  const cfg = withConfig(twoMachinesConfig({ projectGroup: [] }), loadMachinesConfig);
  assert.deepEqual(cfg.groups, []);
  assert.equal(cfg.projectGroup?.selective, false);
});

// 2/ 单组正常解析 + 派生集合 + 聚合同步
test("projectGroup 单组：声明态保留顺序，派生 memberKeys / memberMachineIds / selective 正确 + 聚合同步", () => {
  const cfg = withConfig(
    twoMachinesConfig({
      projectGroup: [
        {
          name: "team-a",
          members: [
            { machineId: "m1", projectId: "p1" },
            { machineId: "m1", projectId: "p2" },
            { machineId: "m2", projectId: "p3" },
          ],
        },
      ],
    }),
    loadMachinesConfig,
  );
  assert.equal(cfg.groups?.length, 1);
  const g = cfg.groups![0]!;
  assert.equal(g.selective, true);
  assert.equal(g.name, "team-a");
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
  // N1 过渡聚合视图：单组即该组（并集）
  assert.equal(cfg.projectGroup?.selective, true);
  assert.equal(cfg.projectGroup?.memberKeys.size, 3);
});

// 3/ 多组解析 + 聚合并集
test("projectGroup 多组：两组各自 selective=true、聚合 memberKeys / memberMachineIds 为并集、name 取首组", () => {
  const cfg = withConfig(
    twoMachinesConfig({
      projectGroup: [
        { name: "gA", members: [{ machineId: "m1", projectId: "p1" }] },
        {
          name: "gB",
          members: [
            { machineId: "m1", projectId: "p2" },
            { machineId: "m2", projectId: "p3" },
          ],
        },
      ],
    }),
    loadMachinesConfig,
  );
  assert.equal(cfg.groups?.length, 2);
  assert.deepEqual(
    cfg.groups!.map((g) => g.name),
    ["gA", "gB"],
  );
  assert.equal(cfg.groups![0]!.selective, true);
  assert.equal(cfg.groups![1]!.memberKeys.size, 2);
  assert.equal(cfg.projectGroup?.selective, true);
  assert.equal(cfg.projectGroup?.memberKeys.size, 3);
  assert.equal(cfg.projectGroup?.memberKeys.has(memberKey("m1", "p1")), true);
  assert.equal(cfg.projectGroup?.memberKeys.has(memberKey("m2", "p3")), true);
  assert.deepEqual([...cfg.projectGroup!.memberMachineIds].sort(), ["m1", "m2"]);
  assert.equal(cfg.projectGroup?.name, "gA");
});

test("projectGroup[].name 必填（B 形态：组名 = URL 首段身份）：缺省 / null / 非字符串 ⇒ fail-fast；合法值按声明取", () => {
  // 缺省与显式 null 不再产出 `name:null` 组（配组下无名组不可寻址 = 死配置 ⇒ 启动校验 ③ 拒绝）
  for (const bad of [undefined, null]) {
    assert.throws(
      () =>
        withConfig(
          twoMachinesConfig({
            projectGroup: [{ ...(bad === undefined ? {} : { name: bad }), members: [{ machineId: "m1", projectId: "p1" }] }],
          }),
          loadMachinesConfig,
        ),
      /\[config\] projectGroup\[0\]\.name 组名必填/,
      `name=${String(bad)} 应被拒`,
    );
  }
  for (const bad of ["", 1, true]) {
    assert.throws(
      () =>
        withConfig(
          twoMachinesConfig({
            projectGroup: [{ name: bad, members: [{ machineId: "m1", projectId: "p1" }] }],
          }),
          loadMachinesConfig,
        ),
      /\[config\] projectGroup\[0\]\.name 必须是非空字符串/,
      `name=${String(bad)} 应被拒`,
    );
  }

  const named = withConfig(
    twoMachinesConfig({
      projectGroup: [{ name: "g", members: [{ machineId: "m1", projectId: "p1" }] }],
    }),
    loadMachinesConfig,
  );
  assert.equal(named.groups![0]!.name, "g");
});

test("projectGroup[].name 字符集 [A-Za-z0-9_-]+（启动校验 ③：组名进 URL 路径首段）", () => {
  // 合法：字母 / 数字 / 下划线 / 连字符
  for (const ok of ["g1", "team-a", "T_2", "0"]) {
    const cfg = withConfig(
      twoMachinesConfig({
        projectGroup: [{ name: ok, members: [{ machineId: "m1", projectId: "p1" }] }],
      }),
      loadMachinesConfig,
    );
    assert.equal(cfg.groups![0]!.name, ok);
  }
  // 非法：空白 / 路径分隔 / 中文 / 点号（URL 段不安全）
  for (const bad of ["bad name", "a/b", "团队A", "g.env", "%41"]) {
    assert.throws(
      () =>
        withConfig(
          twoMachinesConfig({
            projectGroup: [{ name: bad, members: [{ machineId: "m1", projectId: "p1" }] }],
          }),
          loadMachinesConfig,
        ),
      /\[config\] projectGroup\[0\]\.name .* 非法：组名进 URL 路径首段/,
      `name=${bad} 应被拒`,
    );
  }
});

test("组名不得与保留 URL 首段冲突（启动校验 ④：health / shutdown / runner / options.path 首段）", () => {
  for (const bad of ["health", "shutdown", "runner", "mcp"]) {
    assert.throws(
      () =>
        withConfig(
          twoMachinesConfig({
            projectGroup: [{ name: bad, members: [{ machineId: "m1", projectId: "p1" }] }],
          }),
          loadMachinesConfig,
        ),
      /\[config\] projectGroup\[0\]\.name ".*" 与保留 URL 首段冲突/,
      `默认 /mcp 下组名 ${bad} 应被拒`,
    );
  }
  // 自定义 options.path=/orch/mcp ⇒ 保留首段含 "orch"，而 "mcp" 脱离保留集 ⇒ 放行
  assert.throws(
    () =>
      withConfig(
        twoMachinesConfig({
          transport: { http: { path: "/orch/mcp" } },
          projectGroup: [{ name: "orch", members: [{ machineId: "m1", projectId: "p1" }] }],
        }),
        loadMachinesConfig,
      ),
    /与保留 URL 首段冲突/,
  );
  const ok = withConfig(
    twoMachinesConfig({
      transport: { http: { path: "/orch/mcp" } },
      projectGroup: [{ name: "mcp", members: [{ machineId: "m1", projectId: "p1" }] }],
    }),
    loadMachinesConfig,
  );
  assert.equal(ok.groups![0]!.name, "mcp");
});

// 4/ 段形态：顶层必须数组（旧单组对象形状已废弃）；组项必须对象
test("projectGroup 段非数组（旧单组对象 / 字符串 / 数字）→ 结构化报错（形状已扩为组数组）", () => {
  for (const projectGroup of [{ members: [{ machineId: "m1", projectId: "p1" }] }, "on", 1]) {
    assert.throws(
      () => withConfig(twoMachinesConfig({ projectGroup }), loadMachinesConfig),
      /\[config\] projectGroup 必须是组数组/,
    );
  }
});

test("projectGroup[i] 组项非对象（字符串 / 数字 / 数组 / null）→ 结构化报错", () => {
  for (const item of ["on", 1, [], null]) {
    assert.throws(
      () => withConfig(twoMachinesConfig({ projectGroup: [item] }), loadMachinesConfig),
      /\[config\] projectGroup\[0\] 必须是对象/,
    );
  }
});

// 5/ members：空数组 / 非数组 ⇒ fail（U1 裁定：要么删段、要么列成员）
test("projectGroup[].members 空数组 → fail-fast（不得静默锁死 / 不得 fail-open）", () => {
  assert.throws(
    () =>
      withConfig(
        twoMachinesConfig({ projectGroup: [{ name: "g", members: [] }] }),
        loadMachinesConfig,
      ),
    /\[config\] projectGroup\[0\]\.members 必须是非空数组/,
  );
});

test("projectGroup[].members 非数组（缺失 / 字符串 / 对象 / null）→ 结构化报错", () => {
  assert.throws(
    () => withConfig(twoMachinesConfig({ projectGroup: [{ name: "g" }] }), loadMachinesConfig),
    /\[config\] projectGroup\[0\]\.members 必须是数组/,
  );
  for (const members of ["m1", { machineId: "m1" }, null]) {
    assert.throws(
      () =>
        withConfig(
          twoMachinesConfig({ projectGroup: [{ name: "g", members }] }),
          loadMachinesConfig,
        ),
      /\[config\] projectGroup\[0\]\.members 必须是数组/,
    );
  }
});

// 6/ 成员项缺字段 / 非法 ⇒ fail
test("projectGroup[].members 成员项缺字段 / 非字符串 → 结构化报错（machineId / projectId 均须非空字符串）", () => {
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
        withConfig(
          twoMachinesConfig({ projectGroup: [{ name: "g", members: [member] }] }),
          loadMachinesConfig,
        ),
      /\[config\] projectGroup\[0\]\.members\[0\]/,
    );
  }
});

// 7/ 未知 machineId ⇒ fail-fast（错误定位到出错组与该组内下标）
test("projectGroup[].members[].machineId 不在 machines[] → fail-fast（拼错机器名不得被静默接受）", () => {
  assert.throws(
    () =>
      withConfig(
        twoMachinesConfig({
          projectGroup: [{ name: "g", members: [{ machineId: "m9", projectId: "p1" }] }],
        }),
        loadMachinesConfig,
      ),
    /\[config\] projectGroup\[0\]\.members\[0\]\.machineId "m9" 不在 machines\[\] 中/,
  );
  // 第二组第三项才越界：错误信息须指向该组该下标（不误报第一项）
  assert.throws(
    () =>
      withConfig(
        twoMachinesConfig({
          projectGroup: [
            { name: "gA", members: [{ machineId: "m1", projectId: "p1" }] },
            {
              name: "gB",
              members: [
                { machineId: "m1", projectId: "p2" },
                { machineId: "m2", projectId: "p2b" },
                { machineId: "nope", projectId: "p3" },
              ],
            },
          ],
        }),
        loadMachinesConfig,
      ),
    /\[config\] projectGroup\[1\]\.members\[2\]\.machineId "nope" 不在 machines\[\] 中/,
  );
});

// 8/ memberKey（唯一构造）与组内去重
test("memberKey：同一元组恒定、不同元组分叉，且对含分隔符的 id 不碰撞（禁第二套拼接）", () => {
  assert.equal(memberKey("m1", "p1"), memberKey("m1", "p1"));
  assert.notEqual(memberKey("m1", "p1"), memberKey("m1", "p2"));
  assert.notEqual(memberKey("m1", "p1"), memberKey("m2", "p1"));
  assert.notEqual(memberKey("m1", "p1"), memberKey("p1", "m1"));
  // 对抗用例：若用 ":" / "/" 拼接，下面两组会互相碰撞
  assert.notEqual(memberKey("a", "b:c"), memberKey("a:b", "c"));
  assert.notEqual(memberKey("a", "b/c"), memberKey("a/b", "c"));
});

test("组内重复成员项 ⇒ 集合去重（memberKeys 不重复、声明态 members 保留原样），不触发跨组互斥", () => {
  const cfg = withConfig(
    twoMachinesConfig({
      projectGroup: [
        {
          name: "g",
          members: [
            { machineId: "m1", projectId: "p1" },
            { machineId: "m1", projectId: "p1" },
            { machineId: "m1", projectId: "p2" },
          ],
        },
      ],
    }),
    loadMachinesConfig,
  );
  const g = cfg.groups![0]!;
  assert.equal(g.members.length, 3);
  assert.equal(g.memberKeys.size, 2);
  assert.equal(g.memberMachineIds.size, 1);
});

// 9/ ★ 组间成员互斥（用户 2026-09-21 已裁）：同一 (machineId, projectId) 只能属一个组 ⇒ 配置期 fail-fast
test("组间互斥负例：同一 (m1,p1) 出现在两组 → fail-fast（文案给两组下标 + 对策）", () => {
  assert.throws(
    () =>
      withConfig(
        twoMachinesConfig({
          projectGroup: [
            { name: "gA", members: [{ machineId: "m1", projectId: "p1" }] },
            { name: "gB", members: [{ machineId: "m1", projectId: "p1" }] },
          ],
        }),
        loadMachinesConfig,
      ),
    /\[config\] projectGroup 组间成员互斥：\{ machineId: "m1", projectId: "p1" \} 同时出现在 projectGroup\[0\] 与 projectGroup\[1\]（同一成员只能属于一个组，请从其中一组删除）/,
  );
});

test("组间互斥负例：重复项落在两组的不同位置也须捕获（首组第 2 项 = 次组第 1 项）", () => {
  assert.throws(
    () =>
      withConfig(
        twoMachinesConfig({
          projectGroup: [
            {
              name: "gA",
              members: [
                { machineId: "m2", projectId: "p9" },
                { machineId: "m1", projectId: "p1" },
              ],
            },
            { name: "gB", members: [{ machineId: "m1", projectId: "p1" }] },
          ],
        }),
        loadMachinesConfig,
      ),
    /组间成员互斥[\s\S]*projectGroup\[0\][\s\S]*projectGroup\[1\]/,
  );
});

test("组间互斥正例：三组分摊不同成员 → 全部通过、各组 selective=true、聚合 key 为并集（含同 projectId 不同 machineId）", () => {
  const cfg = withConfig(
    twoMachinesConfig({
      projectGroup: [
        { name: "gA", members: [{ machineId: "m1", projectId: "p1" }] },
        { name: "gB", members: [{ machineId: "m1", projectId: "p2" }] },
        { name: "gC", members: [{ machineId: "m2", projectId: "p1" }] },
      ],
    }),
    loadMachinesConfig,
  );
  assert.equal(cfg.groups!.length, 3);
  assert.ok(
    cfg.groups!.every((g) => g.selective),
    "配了组 ⇒ 每组恒 selective=true",
  );
  // (m1,p1) 与 (m2,p1) 是不同 key（同 projectId 不同 machineId ⇒ 不算跨组冲突）
  assert.equal(cfg.projectGroup!.memberKeys.size, 3);
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

// ★ 模板样例 ↔ schema 防漂移（v0.8.6 FIX-2 R-2）：把 config/config.json.default 的
// `_projectGroupExample` 原样喂给 parseProjectGroups 断言被接受 —— 样例回退单组对象、
// 组名非法、成员不在模板 machines[]、跨组重复等任一回归都会让本用例变红。
test("config.json.default 的 _projectGroupExample 组数组被 parseProjectGroups 接受（machineId 取模板自身 machines[]）", () => {
  const tplPath = join(appRootFromModule(import.meta.url), "config", "config.json.default");
  const tpl = JSON.parse(readFileSync(tplPath, "utf8")) as {
    _comment: string;
    machines: { machineId: string }[];
    _projectGroupExample: unknown;
  };
  assert.ok(tpl._comment.includes("组数组"), "_comment 必须是组数组口径（不得回退「单组」）");
  assert.ok(
    tpl._comment.includes("group_identity_required"),
    "_comment 须含「配组后连接带组名首段」口径",
  );
  assert.ok(Array.isArray(tpl._projectGroupExample), "_projectGroupExample 必须是组数组");
  assert.ok(tpl._projectGroupExample.length >= 2, "样例至少演示两个组");
  const machineIds = new Set(tpl.machines.map((m) => m.machineId));
  const groups = parseProjectGroups(tpl._projectGroupExample, machineIds);
  assert.equal(groups.length, tpl._projectGroupExample.length);
  assert.ok(
    groups.every((g) => g.selective),
    "配了组 ⇒ 每组恒 selective=true",
  );
});

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

test("协议常量（线协议 2.2）：PROTOCOL_VERSION=2.2 / SUPPORTED_PEER_PROTOCOL_MAJORS=[2]", () => {
  assert.equal(PROTOCOL_VERSION, "2.2");
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
    // K6：同文案逐次重置去重态，观测每个取值的「本窗口首次」告警
    resetWarnOnceCache();
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

// ── v0.7.2 K6：warn 文案级 once-per-process 去重（防 per-request 现读刷屏）──────

test("K6 去重：同一坏配置重复解析 ⇒ 同文案仅 warn 一次（次数 = 1）", () => {
  const { warnings } = captureWarn(() => {
    for (let i = 0; i < 3; i += 1) {
      withConfig(machineConfig({ machineId: "m1" }), loadMachinesConfig);
    }
  });
  const hits = warnings.filter((w) => w.includes("machines[0].launcherUrl 缺省"));
  assert.equal(hits.length, 1, `期望同文案恰 1 次，实际：${JSON.stringify(warnings)}`);
  assert.equal(warnings.length, 1, `期望整轮仅 1 条告警，实际：${JSON.stringify(warnings)}`);
});

test("K6 去重：不同文案互不去重（缺省 vs 非法、不同机器下标各自一条）", () => {
  const badConfig = {
    machines: [{ machineId: "m1" }, { machineId: "m2", launcherUrl: 3100 }],
  };
  const { warnings } = captureWarn(() => {
    withConfig(badConfig, loadMachinesConfig);
    withConfig(badConfig, loadMachinesConfig);
  });
  const missing = warnings.filter((w) => w.includes("machines[0].launcherUrl 缺省"));
  const illegal = warnings.filter((w) => w.includes("machines[1].launcherUrl 非法"));
  assert.equal(missing.length, 1, `缺省文案应恰 1 次：${JSON.stringify(warnings)}`);
  assert.equal(illegal.length, 1, `非法文案应恰 1 次：${JSON.stringify(warnings)}`);
  assert.equal(warnings.length, 2, `两次解析同配置应恰 2 条告警：${JSON.stringify(warnings)}`);
});

test("K6 去重：allowStdio 与 launcherUrl 文案相互独立（各自仅一次）", () => {
  const badConfig = { machines: [{ machineId: "m1" }], web: { allowStdio: true } };
  const { warnings } = captureWarn(() => {
    withConfig(badConfig, loadMachinesConfig);
    withConfig(badConfig, loadMachinesConfig);
  });
  assert.equal(
    warnings.filter((w) => w.includes("web.allowStdio")).length,
    1,
    JSON.stringify(warnings),
  );
  assert.equal(
    warnings.filter((w) => w.includes("machines[0].launcherUrl 缺省")).length,
    1,
    JSON.stringify(warnings),
  );
  assert.equal(warnings.length, 2, JSON.stringify(warnings));
});

test("K6：去重不改变解析语义（解析结果逐字段一致；合法配置仍零告警）", () => {
  const { value: parsed, warnings } = captureWarn(() => {
    const first = withConfig(machineConfig({ machineId: "m1" }), loadMachinesConfig);
    const second = withConfig(machineConfig({ machineId: "m1" }), loadMachinesConfig);
    return { first, second };
  });
  assert.equal(parsed.first.machines[0]?.launcherUrl, "");
  assert.equal(parsed.second.machines[0]?.launcherUrl, "");
  assert.deepEqual(parsed.first.machines, parsed.second.machines);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));

  const legal = captureWarn(() => withConfig(minimalConfig(), loadMachinesConfig));
  assert.deepEqual(legal.warnings, []);
});

// ── v0.8.3 REQ-01 O2：callback / pushCallback 退役 ⇒ 死配置宽容 warn + 忽略 ──────

/** 旧配置（含 `callback` 段 + `machines[].pushCallback`），其余字段均合法 */
function retiredPushConfig(): unknown {
  return {
    machines: [{ machineId: "m1", launcherUrl: "http://127.0.0.1:3100", pushCallback: true }],
    callback: { enabled: true, host: "127.0.0.1", port: 3200 },
  };
}

test("callback/pushCallback 退役：旧配置解析成功不抛错、返回对象无 callback 键（宽容忽略，非 fail-fast）", () => {
  const { value: cfg } = captureWarn(() => withConfig(retiredPushConfig(), loadMachinesConfig));
  assert.equal("callback" in cfg, false, "退役后返回对象不得含 callback 键");
  assert.equal(cfg.machines[0]?.machineId, "m1");
  assert.equal("pushCallback" in (cfg.machines[0] ?? {}), false, "MachineRef 不得再带 pushCallback");
});

test("callback/pushCallback 退役：重复解析同一旧配置 ⇒ 两条退役 warn 各恰一次（文案级 once-per-process）", () => {
  const callbackText = "[config] callback 段已退役（push 通知链拆除）：按死配置 warn + 忽略。";
  const pushCallbackText =
    "[config] machines[0].pushCallback 已退役（push 通知链拆除）：按死配置 warn + 忽略。";
  const { warnings } = captureWarn(() => {
    withConfig(retiredPushConfig(), loadMachinesConfig);
    withConfig(retiredPushConfig(), loadMachinesConfig);
  });
  assert.equal(
    warnings.filter((w) => w === callbackText).length,
    1,
    `callback 退役文案应恰 1 次：${JSON.stringify(warnings)}`,
  );
  assert.equal(
    warnings.filter((w) => w === pushCallbackText).length,
    1,
    `pushCallback 退役文案应恰 1 次：${JSON.stringify(warnings)}`,
  );
});
