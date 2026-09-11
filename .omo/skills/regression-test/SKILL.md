# 回归测试 — a2a-coding

发版前必须执行回归测试，全部通过后方可发版（CLAUDE.md 发版流程**步骤 2、步骤 3**）。
本 skill 只做**静态检查**：不联网、不启动 launcher / bridge / `opencode serve`，唯一子进程是两单元的 `npm run typecheck`。

## 结构说明

```
.omo/skills/regression-test/
├── package.json          ← CommonJS 声明（根 package.json 为 "type": "module"，此处显式 commonjs）
├── index.js              ← 入口：发现并执行 tests/ 顶层所有 test-*.js（支持 async run）
├── regression.js         ← 旧入口兼容（重定向到 index.js，行为一致）
├── lib/
│   ├── common.js         ← 共享工具（ROOT / exist / read / readJson / findFilesRecursive / getVersion）
│   └── reporter.js       ← 报告模块（report / getSummary / reset / writeReport）
└── tests/
    ├── test-project-structure.js       ← TC1: 项目结构完整性
    ├── test-units-self-contained.js    ← TC2: 单元自包含（orch / machine）
    ├── test-no-cross-unit-imports.js   ← TC3: 单元间无交叉 import
    ├── test-config-samples.js          ← TC4: 配置样例（机器清单 / 启动器）
    ├── test-wrapper-session-patch.js   ← TC5: a2a-opencode 会话持久化补丁
    ├── test-trace-handling.js          ← TC6: trace 产物处理（源头 + 兜底）
    ├── test-idle-reap-and-lease.js     ← TC7: 空闲回收与租约续约
    ├── test-entry-scripts.js           ← TC8: 入口脚本契约
    ├── test-typecheck.js               ← TC9: TypeScript 类型检查（两单元）
    └── test-doc-final.js               ← TC10: 文档收尾（final / planlog）
```

> `index.js` 只发现 `tests/` **顶层**的 `test-*.js` 文件，子目录不参与执行。

## 新增测试

当引入新模块、新文件或新检测需求时，在 `tests/` 下新建 `test-xxx.js`（一个文件一个关注点）：

```javascript
const { report } = require('../lib/reporter');
const { read, exist } = require('../lib/common');

function run() {
  let ok = true;
  // 调用 report(name, ok, detail) 记录每条结果
  ok = report('描述', 是否通过, '补充信息') && ok;
  return ok; // 是否全部通过
}
module.exports = { run, name: '测试描述' };
```

无需修改入口或其他测试文件，`index.js` 会自动发现并执行（支持 `async run`）。
用例清单与预期见 **[TESTCASES.md](TESTCASES.md)**。

## 执行

```bash
# 在项目根目录执行
node .omo/skills/regression-test/index.js
```

旧入口同样可用（行为完全一致）：

```bash
node .omo/skills/regression-test/regression.js
```

> TC9 会在 `orch/` 与 `machine/` 分别运行 `npm run typecheck`（约 20s 内，超时 180s）；
> 若某单元 `node_modules/` 缺失，该用例失败并提示先执行 `npm install`。

## 报告

执行后自动写入 `reports/v{版本号}/regression-report.json`，包含项目名（`a2a-coding`）、版本号、
时间戳（UTC）、每条用例通过/失败详情。发版前检查此文件确认全部通过（CLAUDE.md 发版流程步骤 3）。

**版本号来源**：根 `package.json` 的 `version` 字段；若缺失，回退 `CHANGELOG.md` 首条 `## [vX.Y.Z]`。
（a2a-coding 无 `version.conf`。）

## 唯一门禁

本 skill 是本项目**唯一的回归测试门禁**（根 `package.json` 的 `npm run regression` 也指向它）。
早期脚手架 `scripts/regression/` 已合并移除。
