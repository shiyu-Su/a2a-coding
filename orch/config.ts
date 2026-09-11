import { readFileSync } from "node:fs";
import type { MachinesConfig } from "./types.js";

function fail(msg: string): never {
  throw new Error(`[config] ${msg}`);
}

function asRecord(v: unknown, ctx: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    fail(`${ctx} 必须是对象`);
  }
  return v as Record<string, unknown>;
}

function asString(v: unknown, ctx: string): string {
  if (typeof v !== "string" || v.length === 0) fail(`${ctx} 必须是非空字符串`);
  return v;
}

/** 加载并校验「orch 侧机器清单」 */
export function loadMachinesConfig(path: string): MachinesConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const o = asRecord(raw, "machines config");
  const machines = o["machines"];
  if (!Array.isArray(machines)) fail("machines 必须是数组");
  return {
    machines: machines.map((m, i) => {
      const r = asRecord(m, `machines[${i}]`);
      return {
        machineId: asString(r["machineId"], `machines[${i}].machineId`),
        launcherUrl: asString(r["launcherUrl"], `machines[${i}].launcherUrl`),
      };
    }),
  };
}
