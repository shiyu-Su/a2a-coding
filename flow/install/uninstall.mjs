#!/usr/bin/env node
// a2a-coding 需求流程规范「旁路引入」卸载器（零依赖 ESM）
// 用法：node flow/install/uninstall.mjs --target <项目根> [--orch <orch路径>] [--dry-run]
//
// 仅移除 install.mjs 写入的确定性条目；不删除 <target>/flow/，不触碰 CLAUDE.md / AGENTS.md。
// install 时若用了非默认 --orch，卸载时请传入同一 --orch，方能精确匹配并移除 mcp.a2a。

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// _shared：常量与工具（与 install.mjs 保持一致）
// ---------------------------------------------------------------------------
const PACK_ROOT = path.resolve(import.meta.dirname, '..'); // .../flow
const REPO_ROOT = path.resolve(PACK_ROOT, '..');
const CONFIG_FILE = 'opencode.json';
const INSTRUCTION_ENTRIES = ['flow/spec/需求流程.md', 'flow/spec/引擎映射.md'];

const toPosix = (p) => p.replaceAll('\\', '/');

function fail(msg) {
  console.error(`\n[错误] ${msg}\n`);
  process.exit(1);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}

/** install 写入的 mcp.a2a 确定性取值：只有深度相等才允许移除。 */
function mcpEntry(orch) {
  const root = toPosix(path.resolve(orch));
  return {
    type: 'local',
    command: ['node', `${root}/dist/bridge/index.js`],
    environment: {
      MACHINES_CONFIG: `${root}/config/config.json`,
      SESSION_DB: `${root}/data/sessions.sqlite`,
    },
    enabled: true,
  };
}

function parseArgs(argv) {
  const out = { target: process.cwd(), orch: '', dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--target') out.target = argv[++i] ?? fail('--target 需要一个路径参数');
    else if (arg === '--orch') out.orch = argv[++i] ?? fail('--orch 需要一个路径参数');
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--help' || arg === '-h') { console.log('用法：node flow/install/uninstall.mjs --target <项目根> [--orch <orch路径>] [--dry-run]'); process.exit(0); }
    else fail(`未知参数：${arg}（用 --help 查看用法）`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = path.resolve(args.target);
  const flowDir = toPosix(path.join(target, 'flow'));
  const file = path.join(target, CONFIG_FILE);
  if (!existsSync(file)) {
    console.log(`未找到 ${toPosix(file)}，无需卸载（视为已完成）。`);
    console.log(`提示：${flowDir} 目录未被删除，如需彻底清理请手动删除。`);
    return;
  }

  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`无法解析 JSON 配置：${toPosix(file)}\n  原因：${e.message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) fail(`${file} 顶层不是 JSON 对象，已中止`);

  const changes = [];
  if (Array.isArray(data.instructions)) {
    const kept = data.instructions.filter((x) => !INSTRUCTION_ENTRIES.includes(x));
    const removed = data.instructions.length - kept.length;
    if (removed > 0) {
      changes.push(`instructions 移除 ${removed} 项`);
      if (kept.length === 0) delete data.instructions;
      else data.instructions = kept;
    }
  }

  const desired = mcpEntry(args.orch || path.join(REPO_ROOT, 'orch'));
  if (data.mcp && typeof data.mcp === 'object' && !Array.isArray(data.mcp) && data.mcp.a2a !== undefined) {
    if (deepEqual(data.mcp.a2a, desired)) {
      delete data.mcp.a2a;
      changes.push('mcp.a2a 移除（与安装器写入一致）');
      if (Object.keys(data.mcp).length === 0) delete data.mcp;
    } else {
      console.warn('[警告] mcp.a2a 存在但与安装器写入的不一致，已保留不动（可能由你手工配置）。');
    }
  }

  if (args.dryRun) {
    console.log('[dry-run] 计划改动：');
    console.log(changes.length ? changes.map((c) => `  ${c}`).join('\n') : '  无变化');
  } else if (changes.length === 0) {
    console.log('无变化：未发现本安装器写入的条目。');
  } else {
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    console.log('卸载完成：');
    for (const c of changes) console.log(`  ${c}`);
  }
  console.log(`提示：${flowDir} 目录未被删除，如需彻底清理请手动删除。`);
}

main();
