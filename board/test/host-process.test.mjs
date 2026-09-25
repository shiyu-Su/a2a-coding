import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { delimiter, resolve } from "node:path";

import {
  allocateFreePort,
  buildChildEnv,
  createTreeKiller,
  probeTcpPort,
  quoteForCmd,
} from "../dist/host-process.js";

/** 起一个仅用于探测的本地监听（**不是宿主桥**，不 spawn 任何子进程）。 */
function listenOnce() {
  return new Promise((res, rej) => {
    const srv = createServer((sock) => sock.destroy());
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      res({ port, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

/** 找一个当前确定没人在听的端口（先分配再放开 ⇒ 无监听者）。 */
async function deadPort() {
  const port = await allocateFreePort();
  return port;
}

// ---------------------------------------------------------------------------
// 子进程环境（PATH 前置 machine 的 node_modules/.bin）
// ---------------------------------------------------------------------------

/** 与被测实现同法的期望 bin 目录（Windows 上 `resolve` 会规范化分隔符 / 补盘符）。 */
function binDir(machineRoot) {
  return resolve(machineRoot, "node_modules", ".bin");
}

test("buildChildEnv: 把 <machine 根>/node_modules/.bin 前置到 PATH，其余键原样保留", () => {
  const env = buildChildEnv("D:/repo/machine", { FOO: "bar", PATH: "C:/Windows" });
  assert.ok(env.PATH.startsWith(`${binDir("D:/repo/machine")}${delimiter}`), env.PATH);
  assert.ok(env.PATH.endsWith("C:/Windows"));
  assert.equal(env.FOO, "bar");
});

test("buildChildEnv: 沿用原有键名大小写（Windows 上可能是 Path），不另开重复键", () => {
  const env = buildChildEnv("/repo/machine", { Path: "/usr/bin" });
  assert.equal(env.PATH, undefined, "不得另开一个 PATH 键");
  assert.ok(env.Path.startsWith(`${binDir("/repo/machine")}${delimiter}`), env.Path);
});

test("buildChildEnv: 原 PATH 缺失 ⇒ 只放 .bin 一项，前后不留分隔符", () => {
  const env = buildChildEnv("/repo/machine", {});
  assert.equal(env.PATH, binDir("/repo/machine"));
});

// ---------------------------------------------------------------------------
// Windows 参数转义（shell 模式不转义 ⇒ 自行加引号）
// ---------------------------------------------------------------------------

test("quoteForCmd: 无空白无引号原样；含空白加引号；内含双引号按 cmd 规则加倍", () => {
  assert.equal(quoteForCmd("--port"), "--port");
  assert.equal(quoteForCmd("D:/my org/ws"), '"D:/my org/ws"');
  assert.equal(quoteForCmd('a"b'), '"a""b"');
  assert.equal(quoteForCmd(""), "");
  assert.equal(quoteForCmd('{"type":"http","name":"a2a"}'), '"{""type"":""http"",""name"":""a2a""}"');
});

test("quoteForCmd: MCP 负载这类含特殊字符的参数不漏引（cmd 解引用后可还原）", () => {
  const json = JSON.stringify([
    { type: "http", name: "a2a", url: "http://127.0.0.1:8787/g mcp/mcp", headers: [] },
  ]);
  assert.match(json, /\s/, "本例故意带空白，走加引号分支");
  const quoted = quoteForCmd(json);
  assert.ok(quoted.startsWith('"') && quoted.endsWith('"'));
  assert.equal(quoted.slice(1, -1).replace(/""/g, '"'), json, "cmd 侧解引用后须还原原 JSON");
});

// ---------------------------------------------------------------------------
// 探活（「查」的实现口径：TCP 可连）
// ---------------------------------------------------------------------------

test("probeTcpPort: 端口在听 ⇒ true（不依赖任何 HTTP 路由）", async () => {
  const srv = await listenOnce();
  try {
    assert.equal(await probeTcpPort(srv.port, "127.0.0.1", 2000), true);
  } finally {
    await srv.close();
  }
});

test("probeTcpPort: 端口无人听 ⇒ false（拒连即判不可达，不抛）", async () => {
  assert.equal(await probeTcpPort(await deadPort(), "127.0.0.1", 1000), false);
});

test("probeTcpPort: 对方接受连接但不回包 ⇒ 仍判活（口径 = 端口在听，不做协议握手），且必有界返回", async () => {
  const held = await new Promise((res, rej) => {
    const sockets = [];
    const srv = createServer((sock) => sockets.push(sock));
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      res({
        port: addr !== null && typeof addr === "object" ? addr.port : 0,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            srv.close(() => r());
          }),
      });
    });
  });
  try {
    const t0 = Date.now();
    assert.equal(await probeTcpPort(held.port, "127.0.0.1", 300), true, "connect 即算活（口径 = 端口在听）");
    assert.ok(Date.now() - t0 < 1000);
  } finally {
    await held.close();
  }
});

// ---------------------------------------------------------------------------
// 空闲端口分配
// ---------------------------------------------------------------------------

test("allocateFreePort: 返回可用端口，且用完即放开（可被再次分配/监听）", async () => {
  const p1 = await allocateFreePort();
  assert.ok(Number.isInteger(p1) && p1 > 0 && p1 <= 65535, String(p1));
  // 放开后应能立刻被真正监听（说明没占着端口）
  const srv = createServer();
  await new Promise((res, rej) => {
    srv.once("error", rej);
    srv.listen(p1, "127.0.0.1", res);
  });
  await new Promise((res) => srv.close(res));
});

test("allocateFreePort: 连续分配不返回 0（0 会被上层判成非法端口）", async () => {
  for (let i = 0; i < 3; i += 1) {
    assert.ok((await allocateFreePort()) > 0);
  }
});

// ---------------------------------------------------------------------------
// 树杀入口的护栏（**本节点不真杀进程**：只断言非法 pid 一律不动手）
// ---------------------------------------------------------------------------

test("createTreeKiller: pid <= 1 / 非整数 ⇒ 直接返回，绝不发出信号（防 kill(-1) 广播）", async () => {
  const kill = createTreeKiller("linux");
  for (const pid of [0, 1, -1, 2.5, Number.NaN]) {
    await kill(pid); // 不抛即通过；真信号路径由下一节点真机验证
  }
});

test("createTreeKiller: 合法但不存在的 pid ⇒ 不抛（进程可能已退出，失败须被吞在收尾路径里）", async () => {
  // 走 POSIX 分支：只发信号、不 spawn 任何子进程（本节点硬约束 = 不起真进程）
  const kill = createTreeKiller("linux");
  await kill(2_147_483_646);
});
