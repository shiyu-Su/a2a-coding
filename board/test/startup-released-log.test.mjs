/**
 * v0.10.0 尾段 N2 —— **启动日志「已发版锁定」清单换源引擎投影**（`readStartupReleasedVersions`）。
 *
 * 判据（改造文档 §2.3(1) / 本节点任务书）：
 * - 清单的事实源 = **引擎版本台账**（`GET /api/versions`），板本地台账只在**启动期读不到投影**时
 *   充当降级读缓存，并如实带 warn（`degraded`）与数据源标注（`sourceNote`）；
 * - **启动期桥不可达 ⇒ 不得让启动崩** ⇒ 本函数三档（projection / absent / 读取器抛错）**一律不抛**；
 * - 本函数**只出日志、不判锁**：锁的执法仍由写口 fail-closed 承担（口径 = B4「锁只紧不松」，
 *   此处不另立一套），故降级档不放松任何锁。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { readStartupReleasedVersions } from "../dist/index.js";
import { createVersion, emptyVersionsLedger, setVersionStatus } from "../dist/versions-ledger.js";
import { engineProjectionAbsentFetcher, engineProjectionFetcher } from "./engine-versions-fixture.mjs";

const NOW = "2026-10-08T12:00:00.000Z";
const LOCAL_FILE = "C:/tmp/board/.data/versions.json";

/** 本地台账夹具（**与引擎夹具故意不同值** ⇒ 换源断言不会被两源同值掩盖）。 */
function localLedgerWith(entries) {
  let l = emptyVersionsLedger();
  for (const [org, v, status] of entries) {
    l = createVersion(l, v, NOW, org).ledger;
    if (status !== "notstart") l = setVersionStatus(l, v, status, NOW).ledger;
  }
  return l;
}

const LOCAL = localLedgerWith([
  ["alpha", "v9.9.9", "released"],
  ["alpha", "v0.1.0", "active"],
]);

test("N2-S① projection 档：清单读引擎投影（本地台账不同值 ⇒ 以投影为准）；只 released 入清单、带组织维度", async () => {
  const out = await readStartupReleasedVersions({
    engineVersions: engineProjectionFetcher([
      { org: "alpha", version: "v1.0.0", status: "released" },
      { org: "beta", version: "v0.9.0", status: "released" },
      { org: "alpha", version: "v2.0.0", status: "active" },
      { org: "alpha", version: "v0.5.0", status: "notstart" },
    ]),
    localLedger: () => LOCAL,
    localLedgerFile: LOCAL_FILE,
  });
  assert.deepEqual(
    out.labels,
    ["v1.0.0（alpha）", "v0.9.0（beta）"],
    "released 两条按投影登记序出列；active / notstart 不入已发版清单；本地台账的 v9.9.9 不露出",
  );
  assert.equal(out.degraded, null, "读到投影 ⇒ 无降级行");
  assert.match(out.sourceNote, /引擎版本台账/, "日志如实标注清单数据源 = 引擎");
  assert.equal(out.sourceNote.includes(LOCAL_FILE), false, "正常档不提名本地台账文件（避免误读成事实源还在板侧）");
});

test("N2-S② absent 档（启动期桥不可达）：不抛 + 清单退本地台账读缓存 + degraded 带根因", async () => {
  const out = await readStartupReleasedVersions({
    engineVersions: engineProjectionAbsentFetcher("versions_unreachable", "connect ECONNREFUSED 127.0.0.1:8787"),
    localLedger: () => LOCAL,
    localLedgerFile: LOCAL_FILE,
  });
  assert.deepEqual(out.labels, ["v9.9.9（alpha）"], "降级档 = 读缓存的 released 条目（清单不空转、不静默消失）");
  assert.equal(out.degraded !== null, true, "必须出声：降级档带 warn 文案");
  assert.match(out.degraded ?? "", /versions_unreachable/, "根因码如实点出");
  assert.match(out.degraded ?? "", /ECONNREFUSED/, "根因文案透传（不压成「未知」）");
  assert.match(out.degraded ?? "", /不影响启动/, "口径写明「只降日志、不动启动、不放松锁」");
  assert.match(out.sourceNote, /降级读缓存/, "数据源标注落在读缓存档");
  assert.match(out.sourceNote, new RegExp(LOCAL_FILE.replace(/[./\\]/g, (c) => `\\${c}`)), "读缓存档点名本地台账文件");
});

test("N2-S③ 读取器抛错（第三方注入违约）：仍不抛 ⇒ 启动不被清单读取打断，按 absent 档降级", async () => {
  const out = await readStartupReleasedVersions({
    engineVersions: async () => {
      throw new Error("boom: fetcher 违约");
    },
    localLedger: () => LOCAL,
    localLedgerFile: LOCAL_FILE,
  });
  assert.deepEqual(out.labels, ["v9.9.9（alpha）"], "抛错 ⇒ 退读缓存，清单不空");
  assert.match(out.degraded ?? "", /versions_fetch_threw · boom: fetcher 违约/, "抛错原因进 degraded 文案（不静默吞）");
});

test("N2-S④ 空投影 = 合法事实「引擎零已发版」⇒ 清单空、无降级行（调用方据此不出「已发版锁定」行）", async () => {
  const out = await readStartupReleasedVersions({
    engineVersions: engineProjectionFetcher([]),
    localLedger: () => LOCAL,
    localLedgerFile: LOCAL_FILE,
  });
  assert.deepEqual(out.labels, [], "引擎无 released ⇒ 清单空（**不回灌本地台账**，否则降级读缓存会冒充事实源）");
  assert.equal(out.degraded, null, "读到投影即正常档，与「读不到」两档不得混");
});
