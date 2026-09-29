import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const root = "G:/code/a2a-coding";
const planlogPath = join(root, "planlog.md");
const backupPath = join(root, "doc/_archive/planlog-v0.9.2版本待办-备份-2026-09-26.md");

const content = readFileSync(planlogPath, "utf8");
const lines = content.split("\n");

// v0.9.2 版本待办段 = 1-based 行 49..83（"## v0.9.2 版本待办" 到 "## 需求列表" 前一行）
const start = 48; // 0-based, line 49
const end = 83; // exclusive: up to line 83 (0-based index 82 = line 83)
const section = lines.slice(start, end);
if (!section[0].startsWith("## v0.9.2 版本待办")) {
  console.error("锚点不符，中止：" + section[0]);
  process.exit(1);
}
if (lines[end] && !lines[end].startsWith("## 需求列表")) {
  console.error("段尾锚点不符，中止：" + lines[end]);
  process.exit(1);
}

const backupBody = [
  "# 备份：planlog「v0.9.2 版本待办」段",
  "",
  "> v0.9.2 发版（commit `f442cf0` / tag `v0.9.2`，未 push）后按口径清出，备份于 2026-09-26。",
  "> 实现结果 / 门禁与真机 / 未覆盖明细的事实源 = `CHANGELOG.md [v0.9.2]` 与 `doc/v0.9.2/`。",
  "",
  ...section,
  "",
].join("\n");
writeFileSync(backupPath, backupBody, "utf8");

const newSection = `## v0.9.2（已发布 · 2026-09-26）

> **✅ 已发布**（板侧随版优化轨 II；commit \`f442cf0\` / tag \`v0.9.2\`，未 push）。本版「版本待办」段（Step 0 核实 · 两需求与三条增补全过程 · Step 3 反馈与纪律登记 · v0.9.3 优先级排序）已按口径清出，备份见 [planlog-v0.9.2版本待办-备份-2026-09-26.md](doc/_archive/planlog-v0.9.2版本待办-备份-2026-09-26.md)。
> **未立项遗留（随本版归档，续做时从备份起手）**：反馈 ① 阶段产出版本级聚合（读法 A/B 待用户裁）· 排期拖拽交互（并 v0.9.3 多 View）。
> 实现结果 / 门禁与真机 / 未覆盖明细的事实源 = \`CHANGELOG.md [v0.9.2]\` 与 \`doc/v0.9.2/\`（各确认单与改造文档 final）。

## v0.9.3 版本待办（flow 修订 + 板多视图收编 + V2 组织管理）

> **2026-09-26 起手**（v0.9.2 发版当日，三需求同步 Step 0；按新纪律「需求提出即入板」三 Feature 已以观测态入板需求池）。**优先级**（2026-09-26 用户认可）：① flow 修订 → ② 多 View + 3300 收编 → ③ V2 组织管理。**同版多需求串行**照旧（approve 时点把控）。基线 = v0.9.2 已发布（\`f442cf0\`）。

| # | 需求 | REQ-ID | 当前步骤 | 状态 |
|---|---|---|---|---|
| 1 | **flow 规范修订**（验收增补挂主需求〔三档定性判据成文 + 回炉通道正名与真机验证〕· 运维步骤嵌套 · 混合反馈分拣 · 「需求提出即入板」成文） | 待定 | **Step 0 核实进行中**（orch inquiry：flow 机制点） | 🔄 进行中 |
| 2 | **板多视图与 3300 收编**（Timeline / Graph / Agent View · 旧 3300 运维页收编后退役 · 拖拽排期搭头） | 待定 | **Step 0 核实进行中**（board inquiry：3300 盘点 + 数据面） | 🔄 进行中 |
| 3 | **V2 板上组织管理**（表单建组织 / 增删成员 / 删除可逆 / machine 登记引导） | 待定 | **Step 0 核实进行中**（board + orch inquiry：写面与配置事实源） | 🔄 进行中 |

- **需求 1 承载内容（2026-09-26 用户确认的需求描述）**：主规则 = **验收期增补默认挂主需求 Feature**（同 featureId：实现级 = 原 Feature 登记新节点 / \`needs_input → executing\` 续推；改造文档在父需求文档 +1 版；不另立 REQ、不另立 Feature）；例外闭集 = 方案级回炉（cancel + Step 0 新建，新树承接新方案）与全新 scope；**「用户验收结论下在全部增补收口之后」升纪律**（completed 无回边）。**动机 = v0.11.x 一需求一树**（Feature↔树 1:1 ⇒ 增补另立 Feature 会开新树/挂错树；反向锚已入 v0.11 预研）。**混合反馈分拣**：用户可能一次性提多个需求的问题点 ⇒ 宿主逐条归位（分拣清单：归属需求 / 定性档位 / 处置，回贴确认后再动，模糊条目问清不猜）；板侧可选项 = 详情页便于对照需求提问题点（写面守「板不做编排」\`引擎映射.md\` §8）。**两个引擎机制点核实**：① \`reviewing\` 态能否给 Feature 登记新节点、登记后怎么回 \`executing\`；② \`reviewing → needs_input → executing\` 回边真机未验。
- **落点**：\`需求流程.md\` Step 3 分水岭 + §4 命名（增补·父需求标注）+ Step 0 判据（提出即入板）+ 运维嵌套条（Step 2/3 间「载体升级」标准动作）+ \`引擎映射.md\` §2 / §3.5 时序补句。
- **已入板观测态**：三 Feature 均 version=v0.9.3 · stage=需求分析 · approval=未发起（板需求池可见）。
`;

const out = [...lines.slice(0, start), ...newSection.split("\n"), ...lines.slice(end)];
const tmp = planlogPath + ".tmp";
writeFileSync(tmp, out.join("\n"), "utf8");
renameSync(tmp, planlogPath);
console.log("OK 备份=" + backupPath + " 新段行数=" + newSection.split("\n").length + " 总行数=" + out.length);
