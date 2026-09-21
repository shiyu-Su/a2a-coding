/**
 * ACP 后端命令的**形态解析**：把项目配置的平铺键 `agentConfig.backendCmd` 归一为桥可直调的
 * 一对 `<command, args>`。
 *
 * 背景（REQ-v0.8.5-2026-09-21-01 · M8 **实现级增补**，宿主 2026-09-21 定稿选型）：桥的
 * `--backend-cmd` 是**单个可直调命令**（`parseBridgeArgs` 取单 token，原样交给
 * `spawn(command, args, { shell:false })`）⇒ **不能承载「命令 + 参数」的命令串** ——
 * `node <adapter>/dist/index.js` 这类含空格的取值在 win32 必 `ENOENT`（本机实测）。而
 * codex / claude 两家适配器**本体是 JS 入口**（包 `bin` → `dist/index.js`），故原本无可用形态。
 *
 * 归一规则（用户配置的语义 = **适配器入口**，由适配器决定怎么拉它）：
 * - 以 `.js` / `.mjs` / `.cjs` 结尾 ⇒ **脚本形态**：`command = process.execPath`
 *   （adapter 与 launcher 同为 node 进程）、`args = [<脚本路径>, ...kindArgs]`；
 * - 其余（`.exe` 等可执行体）⇒ **直调形态**：`command = <原样>`、`args = [...kindArgs]`。
 *
 * 三点说明：
 * - **桥零改动**：两种形态都只经既有 `--backend-cmd` / `--backend-args` 表达，不动 `spawn` 主链。
 * - **`process.execPath` 可含空格**（如 `C:\Program Files\nodejs\node.exe`）—— 它是**单个 argv
 *   元素**（不是命令串），桥按整条路径 spawn ⇒ 无引号雷（已真机实测：桥 ready + `initialize` 往返）。
 * - **不启用范围**：opencode / qoder 当前只走直调形态（其 `opencode.exe` / `qoderclicn.exe` 有
 *   `.exe` 真身）；本模块对它们**暂不接线**（授权范围外）。
 *
 * 本模块**不做存在性 / 取值校验**（与 machine 侧既有纪律一致：校验归调用方与运行期报错）；
 * 路径不存在时由 `spawn` 给出既有的 ENOENT 明确报错。
 */
import { extname } from "node:path";

/** 需要以 node 直跑的脚本扩展名（win32 `shell:false` 下 `.js` 不可直调 ⇒ `EFTYPE`）。 */
export const SCRIPT_BACKEND_EXTS: readonly string[] = [".js", ".mjs", ".cjs"];

/** 桥可直调的后端启动对：`--backend-cmd <command>` + `--backend-args <args>`。 */
export interface BackendSpawnSpec {
  command: string;
  args: string[];
}

/**
 * 解析 `backendCmd` 的启动形态（见模块头注）。
 *
 * `kindArgs` = 该 kind 的固定后端参数（codex / claude 均为 `[]`：自带 bin + stdio 入口、无
 * kind 级子命令）。串接顺序：脚本形态下脚本路径在前、kind 参数在后（即 `node <script> <kindArgs…>`）。
 */
export function resolveBackendSpawn(
  backendCmd: string,
  kindArgs: readonly string[] = [],
): BackendSpawnSpec {
  const ext = extname(backendCmd).toLowerCase();
  if (SCRIPT_BACKEND_EXTS.includes(ext)) {
    return { command: process.execPath, args: [backendCmd, ...kindArgs] };
  }
  return { command: backendCmd, args: [...kindArgs] };
}
