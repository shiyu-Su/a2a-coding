/**
 * 配置模板「拆分不变量」（v0.10.2 · 配置模板拆分 · S2/machine b2）。
 *
 * **作用域只钉两枚模板**：`config/config.json.default` 与 `config/config.json.example`。
 * 不得扩成「`config/` 下所有 json」—— 同目录 `model-catalog.json` 的 `_comment` 是既有资产，
 * 已被根回归 `test-v0.8.4-key-layout.js` 正向锚定，扩域即红。
 *
 * 四组断言（① 无 `_` 前缀键 · ② 有缺省常量的键值逐等于常量 · ③ 递归叶子值不含尖括号占位
 * · ④ 键集 ⊆ 分层白名单）+ 反向纪律（保留但无平铺读点的四名必须在白名单之外）
 * + 两枚自检（顶层三键不被误判 · 负向对照，证明③④不是空跑）。
 *
 * 运行：`npm run build && node --test dist/test/config-template-invariants.test.js`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_IDLE_STOP_MS } from "../launcher/manager.js";
import { DEFAULT_STARTUP_CHECK_TIMEOUT_MS } from "../launcher/self-check.js";
import { DEFAULT_RISK_LEVEL } from "../agent-roles.js";
import { RESERVED_AGENT_CONFIG_FLAT_KEYS } from "../agent-kinds.js";

// ---- 两枚模板（唯一作用域） ----

const TEMPLATE_NAMES = ["config.json.default", "config.json.example"] as const;

/** dist/test/ 下相对两格 = machine 单元根（与 config-snapshot-model.test.ts 同一取法） */
function readTemplate(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../config/${name}`, import.meta.url), "utf8"),
  ) as unknown;
}

// ---- 通用扫描 ----

/** 一次扫描同时产出「键出现处」与「递归叶子」，③④共用同一次遍历 */
type KeyOccurrence = { path: string; parentPath: string; key: string };
type Leaf = { path: string; value: string | number | boolean };

type Scan = {
  keys: KeyOccurrence[];
  leaves: Leaf[];
  /** path ⇒ 该 path 上的值（含对象/数组），②按路径取值用 */
  values: Map<string, unknown>;
};

function scan(root: unknown): Scan {
  const keys: KeyOccurrence[] = [];
  const leaves: Leaf[] = [];
  const values = new Map<string, unknown>();

  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, idx) => walk(item, `${path}[${String(idx)}]`));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const childPath = path === "" ? key : `${path}.${key}`;
        keys.push({ path: childPath, parentPath: path, key });
        values.set(childPath, child);
        walk(child, childPath);
      }
      return;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      if (path !== "") leaves.push({ path, value });
    }
  };

  walk(root, "");
  return { keys, leaves, values };
}

/** 深度 ≥ 2 的叶子（③的「递归」而非「只判顶层」由此可证） */
function nestedLeaves(leaves: Leaf[]): Leaf[] {
  return leaves.filter((leaf) => leaf.path.includes(".") || leaf.path.includes("["));
}

// ---- ④ 分层白名单：machine = 32 键 / 5 组 ----

const TOP_KEYS = ["machineId", "launcher", "projects"];
const LAUNCHER_KEYS = [
  "port",
  "idleStopMs",
  "startupCheck",
  "startupCheckTimeoutMs",
  "startupCheckPrompt",
  "listenHost",
  "shutdownEndpoint",
  "shutdownToken",
  "bridge",
];
const BRIDGE_KEYS = ["url", "token"];
const PROJECT_KEYS = [
  "projectId",
  "workspace",
  "agentKind",
  "a2aPort",
  "risk",
  "repo",
  "agentConfig",
];
const AGENT_CONFIG_KEYS = [
  "backendCmd",
  "model",
  "systemPrompt",
  "systemPromptMode",
  "sessionTimeoutMs",
  "continueMarginMs",
  "sessionRetentionDays",
  "sessionRetentionMax",
  "maxConcurrentWrites",
  "maxConcurrentReads",
  "roles",
];

const WHITELIST_GROUPS: Record<string, string[]> = {
  "": TOP_KEYS,
  launcher: LAUNCHER_KEYS,
  "launcher.bridge": BRIDGE_KEYS,
  project: PROJECT_KEYS,
  agentConfig: AGENT_CONFIG_KEYS,
};

/** 分组成员数即改造文档口径，改动必须在两处同时登记 */
const EXPECTED_GROUP_SIZES: Record<string, number> = {
  "": 3,
  launcher: 9,
  "launcher.bridge": 2,
  project: 7,
  agentConfig: 11,
};

/** 按路径前缀取组：`projects[i]` 归 project 组、`projects[i].agentConfig` 归 agentConfig 组 */
function groupOfParent(parentPath: string): string | null {
  if (parentPath === "" || parentPath === "launcher" || parentPath === "launcher.bridge") {
    return parentPath;
  }
  if (/^projects\[\d+\]$/.test(parentPath)) return "project";
  if (/^projects\[\d+\]\.agentConfig$/.test(parentPath)) return "agentConfig";
  return null;
}

type WhitelistViolation = { path: string; reason: string };

function whitelistViolations(root: unknown): {
  violations: WhitelistViolation[];
  groups: Map<string, string>;
} {
  const groups = new Map<string, string>();
  const violations: WhitelistViolation[] = [];
  for (const { path, parentPath, key } of scan(root).keys) {
    const group = groupOfParent(parentPath);
    if (group === null) {
      violations.push({ path, reason: `父路径「${parentPath}」未登记分组` });
      continue;
    }
    groups.set(path, group);
    const members = WHITELIST_GROUPS[group];
    if (!members || !members.includes(key)) {
      violations.push({ path, reason: `键「${key}」不在「${group}」组白名单内` });
    }
  }
  return { violations, groups };
}

// ---- ② 缺省常量绑定 ----

/** 有代码缺省常量 ∧ 语义为「模板缺省即代码缺省」的键；按路径精确绑定 */
const DEFAULT_BINDINGS: { path: string; expected: string | number | boolean; source: string }[] = [
  {
    path: "launcher.idleStopMs",
    expected: DEFAULT_IDLE_STOP_MS,
    source: "launcher/manager.ts:34 DEFAULT_IDLE_STOP_MS",
  },
  {
    path: "launcher.startupCheckTimeoutMs",
    expected: DEFAULT_STARTUP_CHECK_TIMEOUT_MS,
    source: "launcher/self-check.ts:33 DEFAULT_STARTUP_CHECK_TIMEOUT_MS",
  },
  {
    path: "launcher.startupCheck",
    expected: true,
    source: "launcher/index.ts:291 `startupCheck ?? true`",
  },
  {
    path: "launcher.shutdownEndpoint",
    expected: false,
    source: "launcher/index.ts:128 / launcher/server.ts:195 `=== true` ⇒ 缺省不注册",
  },
];

/** 项目骨架 `risk` 的绑定（路径带下标，单独走正则） */
const PROJECT_RISK_PATH = /^projects\[\d+\]\.risk$/;

/**
 * 偏离白名单：**唯一成员** = `launcher.listenHost`。
 * 代码缺省绑全部网卡，模板刻意收紧到 loopback —— 模板是外发资产
 * （`scripts/pack.mjs` 只排除 `config/config.json`），缺省不得开出全网卡绑定。
 */
const DEFAULT_DEVIATIONS: {
  path: string;
  templateValue: string;
  codeDefault: string;
  source: string;
  reason: string;
}[] = [
  {
    path: "launcher.listenHost",
    templateValue: "127.0.0.1",
    codeDefault: "0.0.0.0",
    source: 'launcher/index.ts:177 `listenHost ?? "0.0.0.0"`',
    reason: "刻意 loopback 安全收紧：模板随部署包外发，缺省值不得绑全网卡",
  },
];

/**
 * 无代码缺省常量 ⇒ 豁免②的键：`launcher.port` 是必填项（`config.ts:178`），
 * 属「甲-占位」，没有可比对的常量。登记在此，避免后人把它当漏项补进来。
 */
const NO_CONSTANT_EXEMPT = ["launcher.port"];

// ---- 用例 ----

test("拆分不变量①：两枚模板均无 `_` 前缀键（作用域只钉这两枚文件）", () => {
  for (const name of TEMPLATE_NAMES) {
    const underscored = scan(readTemplate(name)).keys.filter((entry) => entry.key.startsWith("_"));
    assert.deepEqual(
      underscored.map((entry) => entry.path),
      [],
      `${name} 不得出现下划线前缀键（递归全层）`,
    );
  }
});

test("拆分不变量②：有代码缺省常量的键 ⇒ 值逐等于该常量；偏离白名单唯一成员 = launcher.listenHost", () => {
  // 偏离白名单自身先自证：唯一一名 ∧ 确实偏离（模板值 ≠ 代码缺省）∧ 不与绑定表重叠
  assert.deepEqual(
    DEFAULT_DEVIATIONS.map((d) => d.path),
    ["launcher.listenHost"],
    "偏离白名单的唯一成员",
  );
  for (const deviation of DEFAULT_DEVIATIONS) {
    assert.notEqual(
      deviation.templateValue,
      deviation.codeDefault,
      `${deviation.path} 登记为偏离，但模板值与代码缺省相同 ⇒ 登记无效（${deviation.source}）`,
    );
    assert.ok(deviation.reason.length > 0, `${deviation.path} 的偏离理由必须写明`);
    assert.ok(
      !DEFAULT_BINDINGS.some((b) => b.path === deviation.path),
      `${deviation.path} 不得同时出现在绑定表与偏离白名单`,
    );
  }
  for (const exempt of NO_CONSTANT_EXEMPT) {
    assert.ok(
      !DEFAULT_BINDINGS.some((b) => b.path === exempt) &&
        !DEFAULT_DEVIATIONS.some((d) => d.path === exempt),
      `${exempt} 无代码缺省常量 ⇒ 只能以豁免面存在，不得进绑定表/偏离白名单`,
    );
  }

  for (const name of TEMPLATE_NAMES) {
    const { values } = scan(readTemplate(name));
    for (const binding of DEFAULT_BINDINGS) {
      if (!values.has(binding.path)) continue; // 键未出现 ⇒ 走代码缺省，无需比对
      assert.equal(
        values.get(binding.path),
        binding.expected,
        `${name} 的 ${binding.path} 须逐等于代码缺省（${binding.source}）`,
      );
    }
    for (const deviation of DEFAULT_DEVIATIONS) {
      if (!values.has(deviation.path)) continue;
      assert.equal(
        values.get(deviation.path),
        deviation.templateValue,
        `${name} 的 ${deviation.path} 须等于偏离白名单登记值（理由：${deviation.reason}）`,
      );
    }
    for (const [path, value] of values) {
      if (!PROJECT_RISK_PATH.test(path)) continue;
      assert.equal(
        value,
        DEFAULT_RISK_LEVEL,
        `${name} 的 ${path} 须逐等于代码缺省（agent-roles.ts:44 DEFAULT_RISK_LEVEL）`,
      );
    }
  }
});

test("拆分不变量③：两枚模板的递归叶子值（字符串/数字/布尔）不含 < >", () => {
  for (const name of TEMPLATE_NAMES) {
    const { leaves } = scan(readTemplate(name));
    assert.ok(
      nestedLeaves(leaves).length > 0,
      `${name} 未扫到任何深度 ≥ 2 的叶子 ⇒ 本条退化成「只判顶层」，递归要求失效`,
    );
    const placeholders = leaves
      .filter((leaf) => /[<>]/.test(String(leaf.value)))
      .map((leaf) => `${leaf.path}=${String(leaf.value)}`);
    assert.deepEqual(placeholders, [], `${name} 的叶子值不得残留 <...> 占位符（全层递归）`);
  }
});

test("拆分不变量④：两枚模板键集 ⊆ 分层白名单（machine = 32 键 / 5 组，按路径前缀取组）", () => {
  assert.deepEqual(
    Object.entries(EXPECTED_GROUP_SIZES).map(([group, size]) => [
      group === "" ? "顶层" : group,
      size,
    ]),
    [
      ["顶层", 3],
      ["launcher", 9],
      ["launcher.bridge", 2],
      ["project", 7],
      ["agentConfig", 11],
    ],
    "分组数与各组键数（改动须同步改造文档）",
  );
  assert.equal(
    Object.values(WHITELIST_GROUPS)
      .map((members) => members.length)
      .reduce((sum, n) => sum + n, 0),
    Object.values(EXPECTED_GROUP_SIZES).reduce((sum, n) => sum + n, 0),
    "每组实际成员数须与登记的组大小一致",
  );

  for (const name of TEMPLATE_NAMES) {
    const { violations } = whitelistViolations(readTemplate(name));
    assert.deepEqual(violations, [], `${name} 不得出现白名单外的键`);
  }
});

test("拆分不变量④ 反向纪律：保留但无平铺读点的四名必须不在白名单内（白名单 ≠ 保留清单）", () => {
  const reservedWithoutFlatRead = ["timeouts", "agentCard", "events", "mcp"];
  for (const key of reservedWithoutFlatRead) {
    assert.ok(
      (RESERVED_AGENT_CONFIG_FLAT_KEYS as readonly string[]).includes(key),
      `${key} 应属 RESERVED_AGENT_CONFIG_FLAT_KEYS`,
    );
    assert.ok(
      !AGENT_CONFIG_KEYS.includes(key),
      `${key} 无平铺读点 ⇒ 必须不在 agentConfig 白名单内（否则「有人把它写进模板」抓不到）`,
    );
  }
  // 白名单一旦被替换成保留清单（合并），差集即空 ⇒ 本条红
  assert.deepEqual(
    (RESERVED_AGENT_CONFIG_FLAT_KEYS as readonly string[]).filter(
      (key) => !AGENT_CONFIG_KEYS.includes(key),
    ),
    reservedWithoutFlatRead,
    "保留清单 − agentConfig 白名单 = 四名无读点者（白名单不得与保留清单合并）",
  );
});

test("自检：第④条按路径前缀取组 ⇒ 顶层三键不被 11 键的 agentConfig 组误判为未知键", () => {
  const { groups } = whitelistViolations(readTemplate("config.json.example"));
  for (const key of TOP_KEYS) {
    assert.equal(groups.get(key), "", `${key} 须归「顶层」组（parentPath = 根）`);
  }
  assert.equal(groups.get("launcher.port"), "launcher", "launcher.port 归 launcher 组");
  assert.equal(groups.get("projects[0].risk"), "project", "projects[0].risk 归 project 组");
  assert.equal(
    groups.get("projects[0].agentConfig.model"),
    "agentConfig",
    "projects[0].agentConfig.model 归 agentConfig 组",
  );
});

test("自检：负向对照 ⇒ 嵌套占位符与未登记键确实会被③④抓到", () => {
  // 「只判顶层」会漏 bridge.url、「按顶层组校验」会漏 agentConfig 子键 —— 本枚证明两处都在场
  const poisoned = {
    machineId: "machine-01",
    launcher: {
      port: 3100,
      bridge: { url: "http://<host>:8787", token: "<token>" },
    },
    projects: [
      {
        projectId: "demo",
        workspace: "C:/demo/ws",
        agentKind: "opencode",
        a2aPort: 3010,
        agentConfig: { timeouts: { session: 1 } },
      },
    ],
  };
  assert.deepEqual(
    scan(poisoned)
      .leaves.filter((leaf) => /[<>]/.test(String(leaf.value)))
      .map((leaf) => leaf.path)
      .sort(),
    ["launcher.bridge.token", "launcher.bridge.url"],
    "③须抓到嵌套对象里的尖括号占位符",
  );
  assert.deepEqual(
    whitelistViolations(poisoned)
      .violations.map((v) => v.path)
      .sort(),
    // `timeouts` 本身被 agentConfig 组拒；其子键因父路径未登记分组也被拒（两道都该响）
    ["projects[0].agentConfig.timeouts", "projects[0].agentConfig.timeouts.session"],
    "④须抓到无平铺读点的保留键被写进模板",
  );
});
