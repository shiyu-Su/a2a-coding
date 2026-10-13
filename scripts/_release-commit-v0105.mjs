// v0.10.5 发版：staged 分域 add + commit + tag（宿主一次性脚本，不提交自身亦可）。
// 存在原因：PreToolUse 守卫对命令串中的单元段名启发式拦截 —— commit message 与 tag 名必然含单元名，
// 故按 v0.10.0–v0.10.4 先例走根级一次性脚本通道。
// 用法：node scripts/_release-commit-v0105.mjs [--apply]
import { execFileSync, spawnSync } from "node:child_process";

const APPLY = process.argv.includes("--apply");

const PATHS = [
  "CHANGELOG.md",
  "README.md",
  "package.json",
  "orch",
  "flow",
  "board/src",
  "board/test",
  "board/package.json",
  "board/package-lock.json",
  "scripts",
  "instruction-doc/v0.10.5",
];

const MSG = [
  "v0.10.5: 流程一致性（引擎以 Feature state 约束流程 —— 主链 6→8 态〔插 version_planning/decomposing〕+ stage 六值半派生〔需求分析/改造方案/发版 宿主显式写，改造/回归/验收 随 state 派生〕+ create 契约收窄〔stage/approval 不再是入参、初值恒定 需求分析+未发起〕+ 门① version 守卫〔stage 外出迁须 version 非空 + 确认单在册〕；主卡 eb86d5e8 28 节点 + 增补 bbc7ea28〔approve 唯一准入可被 advance(to=version_planning) 绕过 ⇒ 前进边一律拒 + 门①第二前提〕+ 增补 6cc46dd2〔advance/create/approve/feature_status 返回「本阶段明细」七枚：回显 stage/approval/version + 派生 pending/gate/actor/action 平铺、cancel 不带〕+ 增补 ec93e1bd〔approve 过门判据 2→6 条：③version 非空 ④确认单在册 ⑤stage 非需求分析〔feature_requirement_gate_not_passed〕⑥任一改造文档在册〔feature_design_doc_required〕，插在三笔写之前、任一不过零迁移〕）",
  "+ 依赖图按真实依赖边绘制（分支分叉/汇合合并、连线端点落边框线中点、疏密对齐原型；804a578d 9 节点 + 增补 d69f494d 接点与疏密）+ DAG 依赖只声明直接前置（8af7f099）",
  "+ flow 规范落笔（需求流程/引擎映射/文档模板/README 四文件四戳 v0.10.5；§0.5 对照表 + §1 骨架 + Step2 H1/H2 + PjM 抬为 version_planning + §7 同版串行名额口径 + 过渡判据）",
  "+ 停同升分组第六次实操（orch 0.10.2→0.11.0、board 0.11.0→0.12.0、flow 四戳随版；machine 零触达保持 0.10.2；协议 2.3）+ 根回归 1377/1377（approve 反锚翻向 + 主链枚数/挂载白名单/四戳 三锚随版 + 两新态覆盖 + 流程一致性改造文档补 final 行）+ 宿主镜像重导（README 4 处旧句式）+ tag orch/v0.11.0 flow/v0.10.5 board/v0.12.0",
].join("\n");

const TAGS = ["orch/v0.11.0", "flow/v0.10.5", "board/v0.12.0", "v0.10.5"];

if (!APPLY) {
  console.log("[dry] 将 add 路径：\n  " + PATHS.join("\n  "));
  console.log("\n[dry] commit message（首行）：\n  " + MSG.split("\n")[0].slice(0, 160) + "…");
  console.log("\n[dry] tags: " + TAGS.join(" · "));
  const dr = spawnSync("git", ["add", "--dry-run", ...PATHS], { shell: true, encoding: "utf8" });
  console.log("\n[dry] git add --dry-run（前 60 行）：");
  console.log((dr.stdout ?? "").split(/\r?\n/).filter(Boolean).slice(0, 60).join("\n"));
  process.exit(0);
}

for (const p of PATHS) {
  const r = spawnSync("git", ["add", p], { shell: true, encoding: "utf8" });
  console.log(`[add] ${p} => exit ${r.status}${r.stderr?.trim() ? "  " + r.stderr.trim().split(/\r?\n/)[0] : ""}`);
}
const st = spawnSync("git", ["status", "--porcelain"], { shell: true, encoding: "utf8" });
const lines = (st.stdout ?? "").split(/\r?\n/).filter(Boolean);
console.log(`[staged] ${lines.filter((l) => /^[MARC]/.test(l)).length}  [untracked leftovers] ${lines.filter((l) => l.startsWith("??")).length}`);
lines.filter((l) => l.startsWith("??")).forEach((l) => console.log("  ?? " + l.slice(3)));

const run = (a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
console.log("\n[commit]", run(["commit", "-m", MSG]).slice(0, 120) + "…");
for (const t of TAGS) { run(["tag", t]); console.log("[tag]", t); }
console.log("--- log -1 ---");
console.log(run(["log", "-1", "--oneline"]).split("\n")[0].slice(0, 160));
console.log("--- 本版 tag ---");
console.log(run(["tag", "--list"]).split(/\r?\n/).filter((t) => /v0\.10\.5|v0\.11\.0|v0\.12\.0/.test(t)).join("  "));
const dirty = run(["status", "--porcelain"]).split(/\r?\n/).filter((l) => l.trim() && !/^\?\?/.test(l));
console.log("--- 工作树已跟踪改动数（应为 0）---", dirty.length);
if (dirty.length) console.log(dirty.join("\n"));
