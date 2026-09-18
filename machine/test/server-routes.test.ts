/**
 * `machine/launcher/server.ts` 入站端点退役单元测试（v0.7.0 · 节点 M5·MC1）。
 *
 * 门禁判据：
 * - 退役：`GET /projects`、`POST /projects/:id/ensure`、`POST /projects/:id/stop` 一律 **404**
 *   （不再是 503 就绪门 / 200 业务响应）；
 * - 保留：`GET /health`（200 + `ok` / `protocolVersion` / `status` / `bridge`）与
 *   `POST /shutdown`（`shutdownEndpoint=true` 时注册；loopback + 可选 Bearer）；
 * - 就绪门退役后，`isReady=false` 只影响 `/health` 的 `status`，不再拦截业务路由（无业务路由）。
 *
 * 运行：`npm test`（先 `tsc` 构建，再 `node --test dist/test/`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createLauncherApp, type LauncherAppOptions } from "../launcher/server.js";
import { PROTOCOL_VERSION } from "../types.js";

interface ErrorBody {
  error: { code: string; message: string };
}

/** 起真实 HTTP 服务跑一段断言后关闭（不引 supertest 依赖） */
async function withApp<T>(
  options: LauncherAppOptions,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const app = createLauncherApp(options);
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("无法解析监听端口");
    }
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

async function expectNotFound(res: Response): Promise<void> {
  assert.equal(res.status, 404);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, "NOT_FOUND");
}

test("退役端点：GET /projects 返回 404（不再是项目清单）", async () => {
  await withApp({}, async (base) => {
    await expectNotFound(await fetch(`${base}/projects`));
  });
});

test("退役端点：POST /projects/:id/ensure 返回 404（不再拉起 Agent）", async () => {
  await withApp({}, async (base) => {
    await expectNotFound(
      await fetch(`${base}/projects/alpha/ensure`, { method: "POST" }),
    );
  });
});

test("退役端点：POST /projects/:id/stop 返回 404（不再停止 Agent）", async () => {
  await withApp({}, async (base) => {
    await expectNotFound(await fetch(`${base}/projects/alpha/stop`, { method: "POST" }));
  });
});

test("退役端点不受就绪门影响：isReady=false 时 /projects 仍 404（非 503）", async () => {
  await withApp({ isReady: () => false }, async (base) => {
    await expectNotFound(await fetch(`${base}/projects`));

    // 就绪态仍经 /health 暴露（status=starting）
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const body = (await health.json()) as { status: string };
    assert.equal(body.status, "starting");
  });
});

test("/health 保留：200 + ok/protocolVersion/status/bridge（未启用 bridge 恒未注册）", async () => {
  await withApp({}, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      protocolVersion: string;
      status: string;
      bridge: { registered: boolean; lastHeartbeatAt: string | null; lastError: string | null };
    };
    assert.equal(body.ok, true);
    assert.equal(body.protocolVersion, PROTOCOL_VERSION);
    assert.equal(body.status, "ok");
    assert.deepEqual(body.bridge, {
      registered: false,
      lastHeartbeatAt: null,
      lastError: null,
    });
  });
});

test("/shutdown 保留：注册后可触发回调（loopback）", async () => {
  let called = 0;
  await withApp(
    {
      shutdownEndpoint: true,
      onShutdown: () => {
        called += 1;
      },
    },
    async (base) => {
      const res = await fetch(`${base}/shutdown`, { method: "POST" });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { result: string; data: { shuttingDown: boolean } };
      assert.equal(body.result, "ok");
      assert.equal(body.data.shuttingDown, true);
      assert.equal(called, 1);
    },
  );
});

test("/shutdown：未注册（缺省）时返回 404", async () => {
  await withApp({}, async (base) => {
    await expectNotFound(await fetch(`${base}/shutdown`, { method: "POST" }));
  });
});

test("/shutdown：配置 token 后错误 Bearer 返回 401", async () => {
  let called = 0;
  await withApp(
    {
      shutdownEndpoint: true,
      shutdownToken: "secret",
      onShutdown: () => {
        called += 1;
      },
    },
    async (base) => {
      const res = await fetch(`${base}/shutdown`, {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      });
      assert.equal(res.status, 401);
      assert.equal(called, 0);

      const ok = await fetch(`${base}/shutdown`, {
        method: "POST",
        headers: { authorization: "Bearer secret" },
      });
      assert.equal(ok.status, 200);
      assert.equal(called, 1);
    },
  );
});
