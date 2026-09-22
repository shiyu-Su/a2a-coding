#!/usr/bin/env node
// a2a-coding 需求流程规范「旁路引入」安装器（零依赖 ESM）
// 用法：node flow/install/install.mjs --target <项目根> [--host opencode] [--bridge-url <url>] [--group <组名>] [--dry-run] [--force]
//
// 硬约束：只增不改。绝不触碰目标项目既有的 CLAUDE.md / AGENTS.md；
// 宿主配置仅按下述确定性条目追加，且可被 uninstall.mjs 精确还原。
//
// 组身份（v0.8.6）：--group 把组名拼为条目 url 的路径首段（…/mcp → …/<组名>/mcp）；
// 缺省不拼 = 现状 /mcp（未配组环境零破坏）。⚠ 组不是安全边界——桥端点零鉴权，
// 分组只界定该连接的可见性与派发范围，不是鉴权/授权机制。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// _shared：常量与工具
// ---------------------------------------------------------------------------
const PACK_ROOT = path.resolve(import.meta.dirname, '..'); // .../flow（本包根）
const CONFIG_FILE = 'opencode.json';
const SCHEMA_URL = 'https://opencode.ai/config.json';

/** remote 桥的默认 MCP 端点（可用 --bridge-url 覆盖）。 */
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8787/mcp';

/** 旁路加载的 instructions 条目（目标项目根相对路径；opencode 相对配置文件目录解析）。 */
const INSTRUCTION_ENTRIES = ['flow/spec/需求流程.md', 'flow/spec/引擎映射.md'];

/** 需复制进 <target>/flow/ 的包内条目（相对 PACK_ROOT，缺失则跳过）。 */
const COPY_ITEMS = ['spec', 'hosts', 'install', 'README.md'];

/** v0.4.1 仅 opencode 路径完整可用，其余宿主给指引。 */
const SUPPORTED_HOSTS = new Set(['opencode']);

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

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return fail(`无法解析 JSON 配置：${file}\n  原因：${e.message}`);
  }
}

/** install 会写入的 mcp.a2a 确定性取值（uninstall 以此为还原判据）。 */
function mcpEntry(bridgeUrl) {
  return {
    type: 'remote',
    url: bridgeUrl,
    enabled: true,
  };
}

/** 组身份 = url 路径首段（v0.8.6）：…/mcp → …/<组名>/mcp；不传组名则原样返回（现状 /mcp）。 */
function applyGroup(url, group) {
  if (!group) return url;
  if (!/^[A-Za-z0-9_-]+$/.test(group)) fail(`--group 组名不合法：${group}（允许字符集 [A-Za-z0-9_-]+，不得含 /）`);
  if (['health', 'shutdown', 'runner', 'mcp'].includes(group.toLowerCase())) fail(`--group 组名 "${group}" 与桥的保留首段冲突（health / shutdown / runner / mcp），请改用其它组名`);
  let u;
  try {
    u = new URL(url);
  } catch {
    return fail(`--bridge-url 无法解析，无法拼组名段：${url}`);
  }
  u.pathname = `/${group}${u.pathname === '/' ? '' : u.pathname}`;
  return u.toString();
}

// ---------------------------------------------------------------------------
// 参数与规划
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { target: process.cwd(), host: 'opencode', bridgeUrl: DEFAULT_BRIDGE_URL, group: '', orchIgnored: false, dryRun: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--target') out.target = argv[++i] ?? fail('--target 需要一个路径参数');
    else if (arg === '--host') out.host = argv[++i] ?? fail('--host 需要一个值');
    else if (arg === '--bridge-url') out.bridgeUrl = argv[++i] ?? fail('--bridge-url 需要一个 URL 参数');
    else if (arg === '--group') out.group = argv[++i] ?? fail('--group 需要一个组名参数');
    else if (arg === '--orch') { argv[++i] ?? fail('--orch 需要一个路径参数'); out.orchIgnored = true; }
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--help' || arg === '-h') { console.log('用法：node flow/install/install.mjs --target <项目根> [--host opencode] [--bridge-url <url>] [--group <组名>] [--dry-run] [--force]\n  --group：把组名写为条目 url 的路径首段（…/mcp → …/<组名>/mcp，组身份=本组视野）；缺省不拼，维持现状 /mcp。\n  ⚠ 组不是安全边界：桥端点零鉴权，分组只界定可见性与派发范围。\n  --orch 已弃用（接受并忽略，仅为兼容既有调用）。'); process.exit(0); }
    else fail(`未知参数：${arg}（用 --help 查看用法）`);
  }
  out.bridgeUrl = applyGroup(out.bridgeUrl, out.group);
  return out;
}

function collectFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectFiles(full));
    else out.push(full);
  }
  return out;
}

/** 规划文件复制：缺失→新增；内容相同→跳过；不同→报错（除非 --force）。 */
function planCopies(target, force) {
  const adds = [];
  for (const item of COPY_ITEMS) {
    const src = path.join(PACK_ROOT, item);
    if (!existsSync(src)) continue;
    const files = statSync(src).isDirectory() ? collectFiles(src) : [src];
    for (const from of files) {
      const to = path.join(target, 'flow', path.relative(PACK_ROOT, from));
      if (!existsSync(to)) { adds.push({ from, to }); continue; }
      if (!statSync(to).isFile()) fail(`目标路径被同名目录占据，无法写入文件：${to}`);
      if (readFileSync(from).equals(readFileSync(to))) continue;
      if (!force) fail(`目标已存在同名但内容不同的文件，拒绝覆盖（加 --force 可强制覆盖）：\n  ${to}`);
      adds.push({ from, to });
    }
  }
  return adds;
}

/** 规划宿主配置改动：只追加缺失项，绝不删改既有条目。 */
function planConfig(target, bridgeUrl) {
  const file = path.join(target, CONFIG_FILE);
  let data;
  let created = false;
  if (existsSync(file)) {
    data = readJson(file);
  } else {
    const jsonc = path.join(target, 'opencode.jsonc');
    if (existsSync(jsonc)) {
      fail(`检测到 ${toPosix(jsonc)}，本安装器不会改写 jsonc（会破坏注释）。\n  请手动把以下两项加入其 instructions 数组后重试：\n    - ${INSTRUCTION_ENTRIES.join('\n    - ')}`);
    }
    data = { $schema: SCHEMA_URL };
    created = true;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) fail(`${file} 顶层不是 JSON 对象，已中止`);

  const changes = [];
  if (data.instructions !== undefined && !Array.isArray(data.instructions)) {
    fail(`${file} 的 instructions 不是数组，已中止（不覆盖既有配置）`);
  }
  const list = Array.isArray(data.instructions) ? data.instructions : (data.instructions = []);
  for (const entry of INSTRUCTION_ENTRIES) {
    if (!list.includes(entry)) { list.push(entry); changes.push(`instructions += ${entry}`); }
  }

  if (data.mcp !== undefined && (typeof data.mcp !== 'object' || data.mcp === null || Array.isArray(data.mcp))) {
    fail(`${file} 的 mcp 不是对象，已中止（不覆盖既有配置）`);
  }
  const desired = mcpEntry(bridgeUrl);
  if (data.mcp?.a2a === undefined) {
    data.mcp = data.mcp ?? {};
    data.mcp.a2a = desired;
    changes.push(`mcp.a2a = 新增 remote 桥（url=${bridgeUrl}）`);
  } else if (!deepEqual(data.mcp.a2a, desired)) {
    fail(`mcp.a2a 已存在且与预期不一致，已中止（不覆盖既有配置）。\n  如确需更新，请手动修改 ${toPosix(file)} 或先移除该项后重试。`);
  }
  return { file, data, created, changes };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!SUPPORTED_HOSTS.has(args.host)) {
    fail(`宿主 "${args.host}" 暂未支持（v0.4.1 仅 opencode 路径完整可用）。\n  请参考 flow/hosts/${args.host}.md 手动接入（若不存在，见 flow/README.md 的宿主清单）。`);
  }
  const target = path.resolve(args.target);
  if (!existsSync(target) || !statSync(target).isDirectory()) fail(`目标目录不存在或不是目录：${target}`);
  if (args.orchIgnored) console.warn('[警告] --orch 已弃用（remote 形态不再需要 orch 路径），本次已忽略。');

  const adds = planCopies(target, args.force);
  const cfg = planConfig(target, args.bridgeUrl);

  if (args.dryRun) {
    console.log('[dry-run] 以下为计划改动，未写入任何文件：');
    for (const a of adds) console.log(`  新增文件  ${toPosix(path.relative(target, a.to))}`);
    for (const c of cfg.changes) console.log(`  配置改动  ${CONFIG_FILE}：${c}`);
    if (adds.length === 0 && cfg.changes.length === 0) console.log('  无变化');
    console.log(`\n[dry-run] 目标：${toPosix(target)}；宿主：${args.host}；bridge-url：${args.bridgeUrl}`);
    return;
  }

  for (const a of adds) {
    mkdirSync(path.dirname(a.to), { recursive: true });
    writeFileSync(a.to, readFileSync(a.from));
  }
  if (cfg.created || cfg.changes.length > 0) writeFileSync(cfg.file, `${JSON.stringify(cfg.data, null, 2)}\n`);

  if (adds.length === 0 && cfg.changes.length === 0) {
    console.log('无变化：流程规范与宿主配置均已是最新，未写入任何内容。');
    return;
  }
  console.log('安装完成：');
  for (const a of adds) console.log(`  新增文件  ${toPosix(path.relative(target, a.to))}`);
  for (const c of cfg.changes) console.log(`  配置改动  ${CONFIG_FILE}：${c}`);
  if (args.group) console.log(`\n提示：本次以组身份安装（url=${args.bridgeUrl}，视野=组 "${args.group}"）。⚠ 组不是安全边界（桥端点零鉴权，只界定可见性/派发范围）。卸载时请给 uninstall.mjs 传同一 --bridge-url ${args.bridgeUrl} 以精确还原。`);
  console.log('\n请重启宿主以加载 instructions 与 mcp.a2a；目标项目既有 CLAUDE.md / AGENTS.md 未被改动。');
}

main();
