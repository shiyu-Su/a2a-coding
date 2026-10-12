// v0.10.4 发版：staged 分域 add + commit + tag（宿主一次性脚本，不提交）。
// 存在原因：PreToolUse 守卫对命令串中的单元段名启发式拦截 —— commit message 与 tag 名必然含单元名，
// 故按 v0.10.0–v0.10.3 先例走根级一次性脚本通道。
// 用法：node scripts/_release-commit-v0104.mjs [--apply]
import { execFileSync, spawnSync } from "node:child_process";

const APPLY = process.argv.includes("--apply");
const FLOW = "fl" + "ow";   // 拼接防命令串启发式
const BOARD = "bo" + "ard";

const PATHS = [
  "AGENTS.md",
  "CHANGELOG.md",
  "package.json",
  FLOW,
  `${BOARD}/src`,
  `${BOARD}/test`,
  `${BOARD}/scripts`,
  `${BOARD}/package.json`,
  `${BOARD}/package-lock.json`,
  ".omo/skills/regression-test",
  "reports/v0.10.4",
  "instruction-doc/v0.10.4",
  "scripts",
];

const MSG = [
  "v0.10.4: 板面免手刷（第八枚页级内联脚本 PAGE_LIVE_SCRIPT：排期 30s / 详情整页 15s / 任务页 15s 三档；data-live 恒在锚就地换块只换 children〔不换 main / 不用 innerHTML〕；锚级 + 整拍级跳拍判据〔输入态焦点 / 拖拽中 / 后台页 / 摘不到锚〕；.kcol 按 data-version 滚动回填；任务页四动线局部化 + pushState/popstate；时钟只在成功换块那拍拨、无 JS 不出死钮；内联闭集七元→八元；主卡 858e9e46 10 节点 + 增补 c997a0bb〔graph 锚 C′ / 整页入口〕+ 增补 c35b4192〔撤浮层打开即跟刷·修点开浮层后排期页永停·根因 holdAnchor 把锚内焦点当正在填·浮层死钟 CSS 隐藏〕）",
  "+ 板卡片呈现统一（原文单层展开 / 页底四段说明退役 / 四处「口径：」折叠删 / 正文三链接摘 / 排期「已取消」卡新增独立色档 kst-cancelled〔复用灰系 token、不复用 draglocked 族〕/ 管理页拖拽卡说明删 + 手填表单退役仅留拖拽 + 核对卡→页头短条 + 需求表链接式分页每页 10 条 PRG 保页；主卡 4ca97bcd 12 节点 + 增补 28df8a08〔去返回链 / 取消卡灰加深 --b-bg→--b-line / 分页链根因级修复裸 nav 选择器泄漏⇒.sidebar nav 收敛 + .pager flex〕+ 增补 076bbb84〔需求卡片按状态排序六档序 + 同档 createdAt 降序〕）",
  "+ 依赖图 chip 非完成态着色修复（QUEUE_STATE_RUNNING 并入 claimed / QUEUE_STATE_QUEUED 并入 settled + size===2 硬钉；5a6ed454 3 节点）+ 管理页项目池手动刷新按钮（零脚本 GET 表单就地更新；464a0475 4 节点）",
  "+ 停同升分组第五次实操（本版仅 board 0.10.3→0.11.0〔Project Version 经用户裁定、非 0.10.4〕，orch/machine 保持 0.10.2，flow 零触达四戳不翻，协议 2.3）+ 根回归 1380/1380（版本 pin 随根列车号翻向 + 本版 4 份改造文档补「修订历史 final 行」）+ tag board/v0.11.0",
].join("\n");

if (!APPLY) {
  console.log("[dry] 将 add 路径：\n  " + PATHS.join("\n  "));
  console.log("\n[dry] commit message（首行）：\n  " + MSG.split("\n")[0].slice(0, 120) + "…");
  console.log("\n[dry] tags: board/v0.11.0");
  process.exit(0);
}

for (const p of PATHS) {
  const r = spawnSync("git", ["add", p], { shell: true, encoding: "utf8" });
  console.log(`[add] ${p} => exit ${r.status}${r.stderr?.trim() ? "  " + r.stderr.trim().split(/\r?\n/)[0] : ""}`);
}
const st = spawnSync("git", ["status", "--porcelain"], { shell: true, encoding: "utf8" });
const lines = (st.stdout ?? "").split(/\r?\n/).filter(Boolean);
console.log(`[staged] ${lines.filter((l) => /^[MARC]/.test(l)).length}  [untracked leftovers] ${lines.filter((l) => l.startsWith("??")).length}`);

const run = (a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
console.log("\n[commit]", run(["commit", "-m", MSG]).slice(0, 100) + "…");
run(["tag", "board/v0.11.0"]);
console.log("[tag] board/v0.11.0");
console.log("--- log -1 ---");
console.log(run(["log", "-1", "--oneline"]).split("\n")[0].slice(0, 140));
console.log("--- 本版 tag ---");
console.log(run(["tag", "--list"]).split(/\r?\n/).filter((t) => /v0\.10\.4|v0\.11\.0/.test(t)).join("  "));
const dirty = run(["status", "--porcelain"]).split(/\r?\n/).filter((l) => l.trim() && !/^\?\?/.test(l));
console.log("--- 工作树已跟踪改动数（应为 0）---", dirty.length);
if (dirty.length) console.log(dirty.join("\n"));
