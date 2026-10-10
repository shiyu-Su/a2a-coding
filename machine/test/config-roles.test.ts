/**
 * `agentConfig.roles`（职责位 → 旋钮映射）的加载期四条 fail-closed 校验 + 播报生效值
 * （v0.10.2 · M-4 · 改造文档 §2.3 F-C2 / F-C7；§4 验收判据 6「存量全部 config.json* 过校验」）。
 *
 * 四条反例各一枚（本节点验收判据）：
 * ① 角色名须属 `TASK_TYPES` 闭集 **且不得撞** `RESERVED_AGENT_CONFIG_FLAT_KEYS`；
 * ② `role.risk` 用**显式 rank 映射** `read < write < full` 判「不得高于项目**生效** risk」
 *    （生效值含 `?? "write"` 缺省链，**只读本机值**）；
 * ③ `roles` 子对象内**未知键即拒**（防 `modle` 拼错静默失效）；
 * ④ **未配 `roles` ⇒ 逐字现状**（老配置零迁移）。
 *
 * ⚠ **两套语义并存**（F-C2 范围收窄）：`roles` 子对象 fail-closed ∧ `agentConfig` 顶层平铺
 * 保持现状（未知顶层键既不拒也不 strip）。本文件把这条口径钉成断言（见「并存」那一枚），
 * 不得后人当成不一致来「统一」。
 *
 * 运行：`npm run build && node --test dist/test/config-roles.test.js`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMachineConfig } from "../config.js";
import { describeAgentConfig } from "../launcher/config-snapshot.js";
import {
  RISK_RANK,
  ROLE_CONFIG_KEYS,
  agentRolesErrors,
  describeRoleConfig,
  effectiveRiskOf,
  riskRankOf,
  rolesOf,
} from "../agent-roles.js";
import { RESERVED_AGENT_CONFIG_FLAT_KEYS } from "../agent-kinds.js";
import { TASK_TYPES, isTaskType } from "../task-types.js";
import type { ProjectConfig, RiskLevel } from "../types.js";

// ---- 夹具 ----

/** 写一份临时机器配置（project 携带给定字段），跑完清理。 */
function withProject(fields: Record<string, unknown>, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "a2a-machine-roles-"));
  try {
    const path = join(dir, "config.json");
    const project: Record<string, unknown> = {
      projectId: "p1",
      workspace: "/ws/p1",
      agentKind: "opencode",
      a2aPort: 4100,
      ...fields,
    };
    writeFileSync(
      path,
      JSON.stringify({ machineId: "m-test", launcher: { port: 3100 }, projects: [project] }),
      "utf8",
    );
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 加载必须抛 ⇒ 返回错误文案（供含键名断言）；不抛 ⇒ 断言失败。 */
function loadErrorText(path: string): string {
  try {
    loadMachineConfig(path);
  } catch (err) {
    return String(err);
  }
  assert.fail("预期 fail-fast，但加载成功");
}

/** 一个带（或不带）`roles` 的 agentConfig；`model` 作平铺对照键。 */
function agentConfigOf(roles: unknown): Record<string, unknown> {
  return roles === undefined ? { model: "flat/model" } : { model: "flat/model", roles };
}

/** 纯函数侧的判据（自检面共用同一函数，此处不经加载器直取错误清单） */
function errorsOf(roles: unknown, projectRisk: RiskLevel = "write"): string[] {
  return agentRolesErrors(agentConfigOf(roles), projectRisk, "agentConfig.roles");
}

// ---- ④ 未配 ⇒ 逐字现状（老配置零迁移）----

test("校验④：未配 roles ⇒ 正常加载、agentConfig 逐字保留（缺省回落平铺 / 构造器）", () => {
  withProject({ agentConfig: agentConfigOf(undefined) }, (path) => {
    const project = loadMachineConfig(path).projects[0];
    assert.equal(project?.agentConfig?.["model"], "flat/model");
    assert.equal(rolesOf(project?.agentConfig), undefined, "未配不得凭空造出 roles");
    assert.deepEqual(errorsOf(undefined), []);
  });
});

test("两套语义并存（F-C2 收窄）：顶层未知键静默忽略、roles 子对象未知键必拒", () => {
  // 同一份配置里：顶层 `bogusTopKey` 放行（既不拒也不 strip）；roles 内的拼错键必拒。
  withProject({ agentConfig: { bogusTopKey: 42 } }, (path) => {
    const project = loadMachineConfig(path).projects[0];
    assert.equal(project?.agentConfig?.["bogusTopKey"], 42, "顶层未知键不得被 strip（保持现状）");
  });
  withProject({ agentConfig: agentConfigOf({ project_manager: { bogusKnob: 1 } }) }, (path) => {
    assert.match(loadErrorText(path), /bogusKnob/);
  });
});

// ---- ① 角色名：闭集 + 不撞平铺保留键 ----

test("校验①：非闭集角色名 ⇒ 拒且回显闭集（正向 = TASK_TYPES 四位全可作角色名）", () => {
  withProject({ agentConfig: agentConfigOf({ pm: { model: "x" } }) }, (path) => {
    const text = loadErrorText(path);
    assert.match(text, /pm/);
    assert.match(text, /不是合法职责位/);
    for (const taskType of TASK_TYPES)
      assert.match(text, new RegExp(taskType), "文案须列出闭集成员");
  });
  for (const taskType of TASK_TYPES) {
    assert.deepEqual(errorsOf({ [taskType]: { model: "x" } }), [], `${taskType} 应合法`);
  }
});

test("校验①：角色名撞 RESERVED_AGENT_CONFIG_FLAT_KEYS ⇒ 拒（该常量有运行期消费者）", () => {
  // 「进保留键清单」本身不算实现：此枚断言清单**被校验器逐键读出** ⇒ 清单增补即行为跟随。
  const reserved = RESERVED_AGENT_CONFIG_FLAT_KEYS as readonly string[];
  assert.ok(reserved.includes("roles"), "roles 须登记进顶层平铺保留命名空间");
  for (const key of reserved) {
    if (isTaskType(key)) continue; // 闭集成员不在此道（正向已由上一枚锁定）
    const errors = errorsOf({ [key]: {} });
    assert.ok(
      errors.some((e) => e.includes("撞") && e.includes("保留键")),
      `角色名 ${key} 撞保留键必须被拒：${JSON.stringify(errors)}`,
    );
  }
  // 闭集与保留命名空间互不重叠 ⇒ 合法配置永不被①误伤
  for (const taskType of TASK_TYPES) {
    assert.equal(reserved.includes(taskType), false, `${taskType} 不得同时是平铺保留键`);
  }
});

// ---- ② risk：显式 rank 映射 + 不得高于项目生效 risk ----

test("校验②：rank 序 = read < write < full（显式映射），**非**字面序", () => {
  assert.deepEqual({ ...RISK_RANK }, { read: 0, write: 1, full: 2 }, "rank 单源 = RISK_RANK");
  assert.ok(riskRankOf("read") < riskRankOf("write"));
  assert.ok(riskRankOf("write") < riskRankOf("full"));
  const levels: RiskLevel[] = ["read", "write", "full"];
  // 反例锚：字典序给的是 `full < read < write` —— 拿它判「不得高于」会把最宽的 full 判成最小，
  // 校验反向失效。判据一律经 RISK_RANK 显式映射（单一常量）。
  assert.deepEqual([...levels].sort(), ["full", "read", "write"]);
  assert.deepEqual(
    [...levels].sort((a, b) => riskRankOf(a) - riskRankOf(b)),
    ["read", "write", "full"],
  );
});

test("校验②：角色 risk 高于项目**显式**生效 risk ⇒ 拒（文案带两侧 rank）", () => {
  withProject({ risk: "write", agentConfig: agentConfigOf({ project_manager: { risk: "full" } }) }, (path) => {
    const text = loadErrorText(path);
    assert.match(text, /risk=full/);
    assert.match(text, /rank 2/);
    assert.match(text, /rank 1/);
  });
});

test("校验②：项目未写 risk ⇒ 上限取缺省生效值 write（生效链 = project.risk ?? write）", () => {
  const project: ProjectConfig = {
    projectId: "p1",
    workspace: "/ws/p1",
    agentKind: "opencode",
    a2aPort: 4100,
  };
  assert.equal(effectiveRiskOf(project), "write", "生效值链的缺省档");
  withProject({ agentConfig: agentConfigOf({ dev_manager: { risk: "full" } }) }, (path) => {
    assert.match(loadErrorText(path), /risk=full/);
  });
});

test("校验②：角色 risk 不高于生效值 ⇒ 放行（低于、等于两档都合法）", () => {
  assert.deepEqual(errorsOf({ project_manager: { risk: "read" } }, "write"), [], "read < write ⇒ 放行");
  assert.deepEqual(errorsOf({ project_manager: { risk: "full" } }, "full"), [], "等于生效值 ⇒ 放行");
  assert.deepEqual(errorsOf({ project_manager: { risk: "write" } }, "write"), []);
});

test("校验②：risk 非闭集取值 ⇒ 拒（不是「高于」那条，是取值那条）", () => {
  withProject({ agentConfig: agentConfigOf({ project_manager: { risk: "high" } }) }, (path) => {
    const text = loadErrorText(path);
    assert.match(text, /project_manager\.risk/);
    assert.match(text, /read \/ write \/ full/);
  });
});

// ---- ③ roles 子对象内未知键即拒 ----

test("校验③：子对象未知键 ⇒ 拒且指名该键（防 modle 之类拼错静默失效）", () => {
  for (const typo of ["modle", "sytemPrompt", "riskLevel"]) {
    withProject({ agentConfig: agentConfigOf({ project_manager: { [typo]: "x" } }) }, (path) => {
      const text = loadErrorText(path);
      assert.match(text, new RegExp(typo), `拼错的键 ${typo} 必须被拒：${text}`);
      assert.match(text, /未知键/);
    });
  }
});

test("校验③：四个旋钮全配 ⇒ 放行（键清单单源 = ROLE_CONFIG_KEYS）", () => {
  const full = { model: "m/x", systemPrompt: "be terse", systemPromptMode: "append", risk: "read" };
  for (const taskType of TASK_TYPES) {
    assert.deepEqual(errorsOf({ [taskType]: full }), [], `${taskType} 四键全配应放行`);
  }
  assert.deepEqual([...ROLE_CONFIG_KEYS], ["model", "systemPrompt", "systemPromptMode", "risk"]);
});

test("校验：roles 形态非法（非对象 / 数组 / 角色值非对象）⇒ 一律拒", () => {
  for (const bad of [42, "project_manager", [], null]) {
    assert.notDeepEqual(errorsOf(bad), [], `roles=${JSON.stringify(bad)} 应被拒`);
  }
  assert.notDeepEqual(errorsOf({ project_manager: "write" }), []);
  assert.notDeepEqual(errorsOf({ project_manager: [] }), []);
});

test("校验：取值形态（model / systemPrompt 非空串；systemPromptMode 二值）", () => {
  assert.match(errorsOf({ project_manager: { model: "" } }).join(), /model 必须是非空字符串/);
  assert.match(errorsOf({ project_manager: { model: 42 } }).join(), /model 必须是非空字符串/);
  assert.match(errorsOf({ project_manager: { systemPrompt: null } }).join(), /systemPrompt 必须是非空字符串/);
  assert.match(errorsOf({ project_manager: { systemPromptMode: "prepend" } }).join(), /append \/ replace/);
  assert.deepEqual(errorsOf({ project_manager: { systemPromptMode: "replace" } }), []);
});

// ---- 验收判据 6：存量全部 config.json* 过校验 ----

/**
 * 判据 6 的豁免集：真配 `roles` 的长期靶 project（F-N1 四 kind 探针靶，宿主授权配置）。
 * 豁免只放宽「未配 roles」那一枚断言；「过校验零抛出」对所有文件、所有 project 一律不豁免。
 */
const ROLES_CONFIGURED_TARGETS: readonly string[] = ["test_qoder"];

test("存量兼容：本单元全部 `config/config.json*` 原样过校验（roles 收窄范围后零迁移）", () => {
  // 从 dist/test/ 回溯单元根（与 self-check 源码断言同一相对深度）
  const configDir = fileURLToPath(new URL("../../config", import.meta.url));
  const files = readdirSync(configDir).filter((name) => /^config\.json(\..+)?$/.test(name));
  assert.ok(files.length >= 1, `config/ 下应至少有一枚 config.json*（实测：${files.join(",")}）`);
  for (const name of files) {
    const path = join(configDir, name);
    const projects = (): ProjectConfig[] => {
      try {
        return loadMachineConfig(path).projects;
      } catch (err) {
        assert.fail(`存量配置 ${name} 被新校验挡下（不得发生）：${String(err)}`);
      }
    };
    // 存量未过校验不得抛（上面对 loadMachineConfig 已 fail-fast 断言）；
    // 「都没配 roles」只对豁免集之外的存量 project 成立（判据 6 真实口径）。
    for (const project of projects()) {
      if (ROLES_CONFIGURED_TARGETS.includes(project.projectId)) {
        assert.notEqual(
          project.agentConfig?.["roles"],
          undefined,
          `${name}/${project.projectId} 是授权配 roles 的靶，不得被静默漂没`,
        );
        continue;
      }
      assert.equal(
        project.agentConfig?.["roles"],
        undefined,
        `${name}/${project.projectId} 未配 roles`,
      );
    }
  }
});

// ---- 播报面：describeAgentConfig 播报 roles 生效值（F-C7 取证面）----

function projectWith(
  agentConfig: Record<string, unknown> | undefined,
  risk?: RiskLevel,
): ProjectConfig {
  return {
    projectId: "p1",
    workspace: "/ws/p1",
    agentKind: "qoder-cn",
    a2aPort: 4100,
    ...(risk === undefined ? {} : { risk }),
    ...(agentConfig === undefined ? {} : { agentConfig }),
  };
}

test("播报：未配 roles ⇒ 省略该键（照 repo 先例，缺键 ≠ 报空）", () => {
  assert.equal(describeAgentConfig(projectWith({ model: "m/x" })).roles, undefined);
  assert.equal(describeAgentConfig(projectWith(undefined)).roles, undefined);
});

test("播报：配了 roles ⇒ 列出该位生效值 + 上限取本机生效 risk", () => {
  const line = describeAgentConfig(
    projectWith(agentConfigOf({ project_manager: { model: "deepseek-v4-pro", risk: "read" } })),
  ).roles;
  assert.ok(line !== undefined);
  assert.match(line, /上限 risk=write/);
  assert.match(line, /project_manager\{/);
  assert.match(line, /model=deepseek-v4-pro/);
  assert.match(line, /risk=read/);
  // 未配的角色不进播报正文（只报生效的覆盖）
  assert.equal(line.includes("dev_manager"), false);
});

test("播报：systemPrompt 只报字符数、不落正文", () => {
  const prompt = "x".repeat(1234);
  const line = describeAgentConfig(
    projectWith(agentConfigOf({ project_manager: { systemPrompt: prompt } })),
  ).roles;
  assert.match(String(line), /systemPrompt=1234chars/);
  assert.equal(String(line).includes(prompt), false);
});

test("播报：配了空对象 ⇒ 明示「无」（不是省略键）", () => {
  const line = describeAgentConfig(projectWith(agentConfigOf({}))).roles;
  assert.match(String(line), /职责位 roles：/);
  assert.match(String(line), /无/);
});

test("describeRoleConfig：无覆盖 ⇒ 明示回落", () => {
  assert.match(describeRoleConfig({}), /回落平铺/);
});
