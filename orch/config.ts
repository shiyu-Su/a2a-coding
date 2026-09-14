import { readFileSync } from "node:fs";
import type { CallbackConfig, MachineRef, MachinesConfig } from "./types.js";

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

function asBool(v: unknown, ctx: string): boolean {
  if (typeof v !== "boolean") fail(`${ctx} 必须是布尔值`);
  return v;
}

function asPort(v: unknown, ctx: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) {
    fail(`${ctx} 必须是 1-65535 的整数`);
  }
  return v;
}

/** 回调端点默认绑定 loopback / 默认端口（避开 Launcher 3100 与项目 A2A 3010-3012） */
const DEFAULT_CALLBACK_HOST = "127.0.0.1";
const DEFAULT_CALLBACK_PORT = 3200;

/** 解析 `callback` 配置（缺省字段补默认值；`enabled` 缺省 false） */
function parseCallback(v: unknown): CallbackConfig {
  const c = asRecord(v, "callback");
  const enabled = c["enabled"] === undefined ? false : asBool(c["enabled"], "callback.enabled");
  const host =
    c["host"] === undefined ? DEFAULT_CALLBACK_HOST : asString(c["host"], "callback.host");
  const port = c["port"] === undefined ? DEFAULT_CALLBACK_PORT : asPort(c["port"], "callback.port");
  const tokenRaw = c["token"];
  const token = tokenRaw === undefined ? undefined : asString(tokenRaw, "callback.token");
  return token === undefined ? { enabled, host, port } : { enabled, host, port, token };
}

/** 加载并校验「orch 侧机器清单」（含可选回调端点配置） */
export function loadMachinesConfig(path: string): MachinesConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const o = asRecord(raw, "machines config");
  const machines = o["machines"];
  if (!Array.isArray(machines)) fail("machines 必须是数组");
  const callbackRaw = o["callback"];
  const callback = callbackRaw === undefined ? undefined : parseCallback(callbackRaw);
  return {
    machines: machines.map((m, i): MachineRef => {
      const r = asRecord(m, `machines[${i}]`);
      const pushCallbackRaw = r["pushCallback"];
      return {
        machineId: asString(r["machineId"], `machines[${i}].machineId`),
        launcherUrl: asString(r["launcherUrl"], `machines[${i}].launcherUrl`),
        pushCallback:
          pushCallbackRaw === undefined
            ? undefined
            : asBool(pushCallbackRaw, `machines[${i}].pushCallback`),
      };
    }),
    callback,
  };
}
