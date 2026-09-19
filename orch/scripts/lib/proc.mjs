#!/usr/bin/env node
/**
 * proc.mjs —— 进程工具（**可注入纯函数**；REQ-v0.7.2-2026-09-18-01 · K8/K9）。
 *
 * 定位：`scripts/bridgectl.mjs` 的 `killForce` / `isPidAlive` 与
 * `tools/bridgectl-probe.mjs` 的 `killTree` / `isPidAlive` **收敛于此一处实现**
 * （K9：避免两处各改一套 ⇒ 保留两份即构成需显式登记的冗余，orch 不主张冗余），
 * 并以依赖注入（`{ platform, kill, spawnSync }`）暴露 ⇒ 三端分支可在 win-dev
 * 以**结构级**用例确定性断言，无需真机（K8）。
 *
 * 诚实口径（改造文档 §2.2 K8 / §4.2 条件 B）：注入式断言只验证**分支选择与信号参数**，
 * **不得伪装成真正执行 POSIX 分支**；真实信号投递 / 真实 `taskkill` 的集成用例另以
 * `test.skipIf` 标注，仅在其平台可触发时运行。
 *
 * 纯 Node ESM、零第三方依赖、无顶层副作用（不读配置、不起进程、不写文件）。
 */
import { spawnSync as nodeSpawnSync } from "node:child_process";

/** 原生 kill（包装为独立函数，避免 `process.kill` 被解绑后 `this` 丢失） */
const NATIVE_KILL = (pid, signal) => process.kill(pid, signal);

/** 进程存活判定（K5a/K8）：仅 `ESRCH` 判「不存在」，其余错误**保守判活** */
export function isPidAlive(pid, deps = {}) {
  const kill = deps.kill ?? NATIVE_KILL;
  if (!isValidPid(pid)) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = 进程不存在；EPERM / EINVAL / 其它 = 无法确证不存在 ⇒ 保守视为存活
    // （与 K3 租约 liveness「宁可误判活，不可误判死」同向；错误码判据见 K8 三端用例）
    return err?.code !== "ESRCH";
  }
}

/**
 * 强杀进程（K5c/K9）：跨平台二分，返回**结果对象**而非直接抛错（调用方决定日志 / 退出码）。
 *
 *   - `win32`：`taskkill /PID <pid> /T /F`（整树强杀，行为与改动前一致）；
 *   - 非 win32（POSIX = Linux + macOS 同分支）：`kill(-pid, "SIGKILL")` **进程组**杀 ——
 *     桥经 `spawnBridgeDetached`（`detached:true` + `unref()`）拉起 ⇒ 桥为**进程组组长**，
 *     组杀可一并覆盖其子进程；组不存在（`ESRCH`；含「pid 非组长」的兜底情形）时**回落**
 *     `kill(pid, "SIGKILL")` **单 pid**，避免误伤同号进程组（`-pid` 误伤风险的兜底）。
 *
 * `ESRCH` 语义为「进程 / 组已不存在」⇒ `ok:true, gone:true`（非失败）；`EPERM` 等其余错误
 * ⇒ `ok:false` 且不静默（由调用方呈现）。`platform` 缺省取 `process.platform`。
 *
 * @param {number} pid 目标进程 pid（须为正整数；否则不触发任何副作用）
 * @param {{ platform?: string, kill?: (pid: number, signal: string) => void, spawnSync?: Function }} [deps]
 * @returns {{ ok: boolean, platform: string, method: "taskkill"|"kill-group"|"kill-pid"|"none", fallback: boolean, gone: boolean, error: Error|null, result?: unknown }}
 */
export function killForce(pid, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const kill = deps.kill ?? NATIVE_KILL;
  const spawnSync = deps.spawnSync ?? nodeSpawnSync;

  if (!isValidPid(pid)) {
    return {
      ok: false,
      platform,
      method: "none",
      fallback: false,
      gone: false,
      error: new Error(`非法 pid：${String(pid)}（不执行任何强杀）`),
    };
  }

  if (platform === "win32") {
    let result;
    try {
      result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      return win32Failure(platform, toError(err));
    }
    if (result?.error !== undefined && result?.error !== null) {
      return win32Failure(platform, toError(result.error), result);
    }
    if (result?.status !== 0) {
      return win32Failure(
        platform,
        new Error(`taskkill 退出码 ${String(result?.status ?? "null")}`),
        result,
      );
    }
    return {
      ok: true,
      platform,
      method: "taskkill",
      fallback: false,
      gone: false,
      error: null,
      result,
    };
  }

  // POSIX：优先组杀；组不存在（ESRCH）才回落单 pid
  try {
    kill(-pid, "SIGKILL");
    return {
      ok: true,
      platform,
      method: "kill-group",
      fallback: false,
      gone: false,
      error: null,
    };
  } catch (err) {
    if (err?.code !== "ESRCH") {
      return {
        ok: false,
        platform,
        method: "kill-group",
        fallback: false,
        gone: false,
        error: toError(err),
      };
    }
  }

  // 回落：pid 非组长 / 组已不存在 ⇒ 仅对单 pid 投递（避免误伤）
  try {
    kill(pid, "SIGKILL");
    return {
      ok: true,
      platform,
      method: "kill-pid",
      fallback: true,
      gone: false,
      error: null,
    };
  } catch (err) {
    if (err?.code === "ESRCH") {
      return {
        ok: true,
        platform,
        method: "kill-pid",
        fallback: true,
        gone: true,
        error: null,
      };
    }
    return {
      ok: false,
      platform,
      method: "kill-pid",
      fallback: true,
      gone: false,
      error: toError(err),
    };
  }
}

function win32Failure(platform, error, result) {
  return { ok: false, platform, method: "taskkill", fallback: false, gone: false, error, result };
}

/** pid 合法性：正整数（0 / 负数会让 `kill` 命中进程组或非法目标 ⇒ 一律拒绝） */
function isValidPid(pid) {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
