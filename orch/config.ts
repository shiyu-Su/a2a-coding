import { readFileSync } from "node:fs";
import type {
  CallbackConfig,
  HttpTransportConfig,
  MachineRef,
  MachinesConfig,
  TransportConfig,
  TransportMode,
} from "./types.js";

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

function asTransportMode(v: unknown, ctx: string): TransportMode {
  if (v !== "stdio" && v !== "http") fail(`${ctx} 必须是 "stdio" 或 "http"`);
  return v;
}

function asHttpPath(v: unknown, ctx: string): string {
  const s = asString(v, ctx);
  if (!s.startsWith("/")) fail(`${ctx} 必须以 "/" 开头`);
  return s;
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

/**
 * 桥 transport 缺省（v0.4.1）：`mode` 缺省 `stdio` = 与旧配置行为一致；
 * http 绑定 loopback，端口避开 Launcher 3100、项目 A2A 3010-3012 与回调 3200。
 */
const DEFAULT_TRANSPORT_MODE: TransportMode = "stdio";
const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 8787;
const DEFAULT_HTTP_PATH = "/mcp";

/** `http` 段缺省值（`transport` 或 `transport.http` 缺失时使用） */
function defaultHttpTransport(): HttpTransportConfig {
  return { host: DEFAULT_HTTP_HOST, port: DEFAULT_HTTP_PORT, path: DEFAULT_HTTP_PATH };
}

/** 无 `transport` 段时的解析结果（旧 `config.json` 零改动可用） */
function defaultTransport(): TransportConfig {
  return { mode: DEFAULT_TRANSPORT_MODE, http: defaultHttpTransport() };
}

/** 解析 `transport.http`（缺省字段补默认值） */
function parseHttpTransport(v: unknown): HttpTransportConfig {
  const h = asRecord(v, "transport.http");
  const hostRaw = h["host"];
  const portRaw = h["port"];
  const pathRaw = h["path"];
  return {
    host: hostRaw === undefined ? DEFAULT_HTTP_HOST : asString(hostRaw, "transport.http.host"),
    port: portRaw === undefined ? DEFAULT_HTTP_PORT : asPort(portRaw, "transport.http.port"),
    path: pathRaw === undefined ? DEFAULT_HTTP_PATH : asHttpPath(pathRaw, "transport.http.path"),
  };
}

/**
 * 解析 `transport` 配置（段可选；`mode` 缺省 `stdio`）。
 * 非法 mode / 端口 / 路径一律结构化报错（复用 `fail`），不静默降级。
 */
function parseTransport(v: unknown): TransportConfig {
  const t = asRecord(v, "transport");
  const modeRaw = t["mode"];
  const mode =
    modeRaw === undefined ? DEFAULT_TRANSPORT_MODE : asTransportMode(modeRaw, "transport.mode");
  const httpRaw = t["http"];
  const http = httpRaw === undefined ? defaultHttpTransport() : parseHttpTransport(httpRaw);
  return { mode, http };
}

/** 加载并校验「orch 侧机器清单」（含可选回调端点 / 桥 transport 配置） */
export function loadMachinesConfig(path: string): MachinesConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const o = asRecord(raw, "machines config");
  const machines = o["machines"];
  if (!Array.isArray(machines)) fail("machines 必须是数组");
  const callbackRaw = o["callback"];
  const callback = callbackRaw === undefined ? undefined : parseCallback(callbackRaw);
  const transportRaw = o["transport"];
  const transport = transportRaw === undefined ? defaultTransport() : parseTransport(transportRaw);
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
    transport,
  };
}
