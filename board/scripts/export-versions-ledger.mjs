#!/usr/bin/env node
/**
 * 版本台账**出源**脚本（v0.10.0 B1 · REQ-2026-09-24-01 · §2.1-⑦ / §2.3-4）：
 * 读板本地 `.data/versions.json` → 导出引擎导入载荷（全字段
 * `org/version/status/date/note/createdAt/updatedAt`），供 **orch 侧一次性迁移脚本**消费（主源）。
 *
 *   node scripts/export-versions-ledger.mjs [--in <台账路径>] [--out <导出路径> | --stdout]
 *
 * 口径：
 *   - **只读**：不改台账、不写哨兵、不碰板服务（无需板在跑；与 boardctl 无关）；
 *   - 输出**确定性**（不含生成时刻、保持登记序）⇒ 同一文件两次导出逐字节相同，可 diff、可重复导；
 *   - `date` = 引擎目标表空位（板台账无 date 存储 ⇒ 恒 null，不造假值，见 versions-ledger.ts 注释）；
 *   - 台账文件**损坏 ⇒ 拒导退出**（exit 2）—— 按空台账出货会把 released 历史静默导出为零；
 *   - 缺文件 = 真空台账 ⇒ 正常导出 `count:0`（诚实的空，与坏文件两档）；
 *   - 先 `npm run build`（本脚本吃 `dist/versions-ledger.js`，口径同 boardctl 只提示不自动构建）。
 * 退出码恒 {0,1,2}：0 导出成功 · 1 用法/写盘错误 · 2 台账损坏拒导。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { VersionsLedgerStore, exportVersionsLedger, serializeVersionsExport } from "../dist/versions-ledger.js";
import { writeFileAtomic } from "../dist/host-bridge-ledger.js";

const boardRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message, code = 1) {
  process.stderr.write(`出源失败：${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { in: join(boardRoot, ".data", "versions.json"), outPath: null, stdout: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stdout") {
      out.stdout = true;
    } else if (a === "--in") {
      const v = argv[++i];
      if (!v) fail("--in 需要一个路径参数");
      out.in = resolve(v);
    } else if (a === "--out") {
      const v = argv[++i];
      if (!v) fail("--out 需要一个路径参数（或用 --stdout 打标准输出）");
      out.outPath = resolve(v);
    } else {
      fail(`未知参数：${a}（用法：node scripts/export-versions-ledger.mjs [--in <台账>] [--out <导出> | --stdout]）`);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.stdout && args.outPath === null) {
  args.outPath = join(dirname(args.in), "versions-export.json");
}

const store = new VersionsLedgerStore(args.in);
// 缺文件 = load() 的空台账形态（诚实的空 ⇒ 正常导出 count:0）；损坏 ⇒ 抛出（拒导，不产载荷）。
let payload;
try {
  payload = exportVersionsLedger(store);
} catch (e) {
  fail(`（台账损坏，拒导不产载荷）${e instanceof Error ? e.message : String(e)}`, 2);
}
const text = serializeVersionsExport(payload);
if (args.stdout) {
  process.stdout.write(text);
} else {
  try {
    writeFileAtomic(args.outPath, text);
  } catch (e) {
    fail(`写导出文件失败（${args.outPath}）：${e instanceof Error ? e.message : String(e)}`);
  }
  process.stderr.write(
    `版本台账出源完成：${payload.count} 条（源 ${store.file} → ${args.outPath}；schema=${payload.schema}）\n`,
  );
}
