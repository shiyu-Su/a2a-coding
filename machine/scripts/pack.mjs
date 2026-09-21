#!/usr/bin/env node
/**
 * 打包脚本：把 machine 单元打成可移植 zip（一键部署包，用于复制到另一台机器验证）。
 *
 * 用法：
 *   npm run zip                                    # 缺省输出 <单元根>/../machine-<version>-validation.zip
 *   node scripts/pack.mjs [--out <path>] [--dry-run]
 *
 * 打包范围 = 单元内源码 / 配置 / 脚本 / 测试 / 补丁全量，按排除表剔除：
 *   - 任何深度：node_modules（依赖树）· .git · 系统垃圾（.DS_Store / Thumbs.db）
 *   - 仅顶层：dist（构建产物，目标机自行 npm run build）· .a2a（launcher 运行态：pidfile / 日志 /
 *     会话 / 任务落盘）· agents（launcher 生成的包装器配置，见 .gitignore）· 工具缓存
 *     （.omo / .qoder / .codegraph / coverage / .nyc_output）
 *   - 后缀：.zip（历史打包产物）· .log · .tsbuildinfo（增量构建索引）
 *   - 特定相对路径：config/config.json（**本机实例配置**：含 bridge token 明文与本机路径，
 *     被工作区根 .gitignore 排除；目标机应自 config/config.json.default 生成自己的实例配置）
 *   - 本次输出文件自身（--out 落在单元内时自排除）
 * 排除口径与 .gitignore 一致（agents/ · .a2a/ · machine/config/config.json），另补构建产物与打包产物。
 *
 * 实现：零第三方依赖，纯 Node 内置模块手写 ZIP（deflate + CRC-32；正斜杠路径、UTF-8 文件名标记
 * 0x0800、Unix 权限段）。**不用 PowerShell Compress-Archive**：其 .NET Framework 实现写出反斜杠
 * 分隔路径（不合 ZIP 规范，见 APPNOTE 4.4.17.1），macOS 解压易生异常目录名。
 * 需要 Node >= 22.5（zlib.crc32 自 22.2.0 起提供；低于该版本启动即 fail-fast）。
 *
 * 退出码：0 成功 / 1 失败（参数错误、缺件、读写失败）。
 */
import { crc32, deflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 任何深度都不打入 */
const EXCLUDE_ANY_DEPTH = new Set(["node_modules", ".git", ".DS_Store", "Thumbs.db"]);
/** 仅顶层不打入（构建 / 运行态产物，与 .gitignore 口径一致并补构建产物） */
const EXCLUDE_TOP_LEVEL = new Set([
  "dist",
  "agents",
  ".a2a",
  ".omo",
  ".qoder",
  ".codegraph",
  "coverage",
  ".nyc_output",
]);
/** 后缀不打入（打包产物 / 日志 / 增量构建索引） */
const EXCLUDE_SUFFIXES = [".zip", ".log", ".tsbuildinfo"];
/**
 * 特定相对路径不打入（本机实例配置，永不外发）：
 * config/config.json 含 bridge token 明文 + 本机绝对路径，属本机资产（被工作区根 .gitignore 排除）；
 * 部署包只带 config/config.json.default 模板，目标机自行生成实例配置。
 */
const EXCLUDE_RELATIVE_PATHS = new Set(["config/config.json"]);
/** 缺件哨兵：这些不在包里即判目录结构异常，fail-fast 而非静默出残包 */
const REQUIRED_ENTRIES = [
  "package.json",
  "launcher/index.ts",
  "acp-bridge/index.ts",
  "config/config.json.default",
  "scripts/launcherctl.mjs",
];
/** 禁入哨兵：一旦出现在待打包列表即 fail-fast（本机敏感文件，误外发代价 > 打包失败代价） */
const FORBIDDEN_ENTRIES = ["config/config.json"];

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
/** 通用位 11：文件名为 UTF-8（APPNOTE 4.4.4） */
const ZIP_FLAG_UTF8 = 0x0800;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
/** 外部属性高 16 位 = Unix 权限（version made by = Unix 3.0 ⇒ 0x031E） */
const UNIX_VERSION_MADE_BY = 0x031e;
const UNIX_REGULAR_FILE = 0o100644;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MACHINE_ROOT = findMachineRoot(SCRIPT_DIR);

function fail(message) {
  console.error(`[pack] ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`[pack] ${message}`);
}

/** 自脚本目录向上查找含 package.json 的目录（machine 单元根）；与 launcherctl.mjs 同口径 */
function findMachineRoot(startDir) {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}

/** 读 package.json 的 version（缺省输出文件名用）；缺失/非法回落 0.0.0 而非中断 */
function readPackageVersion(root) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch (err) {
    fail(`读取 package.json 失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return typeof raw?.version === "string" && raw.version !== "" ? raw.version : "0.0.0";
}

/** 路径归一化（Windows 盘符大小写不敏感 ⇒ 比较用统一小写） */
function normalizePath(path) {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * 深度优先收集待打包文件（仅普通文件；软链等其它类型跳过）。
 * 返回 `{ name, path }[]`，`name` 为相对单元根的 `/` 分隔路径，按字典序排序（输出确定性）。
 * `outPath` 命中时自排除：`--out` 落在单元内且旧包已存在时，避免把上一次的产物打进新包。
 */
function collectEntries(root, outPath) {
  const outNormalized = normalizePath(outPath);
  const entries = [];
  const walk = (dir, prefix) => {
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      fail(`读取目录失败 ${dir}：${err instanceof Error ? err.message : String(err)}`);
    }
    for (const dirent of dirents) {
      const name = dirent.name;
      if (EXCLUDE_ANY_DEPTH.has(name)) continue;
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const full = join(dir, name);
      if (dirent.isDirectory()) {
        if (prefix === "" && EXCLUDE_TOP_LEVEL.has(name)) continue;
        walk(full, rel);
      } else if (dirent.isFile()) {
        if (EXCLUDE_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue;
        if (EXCLUDE_RELATIVE_PATHS.has(rel)) continue;
        if (normalizePath(full) === outNormalized) continue;
        entries.push({ name: rel, path: full });
      }
    }
  };
  walk(root, "");
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

/** JS Date → DOS 时间/日期（ZIP 本地头字段；1980 年前钳到 1980） */
function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** 本地文件头（30 字节定长 + 文件名） */
function localHeader(nameLength, method, time, day, checksum, compressedSize, size) {
  const buf = Buffer.alloc(30);
  buf.writeUInt32LE(ZIP_LOCAL_SIG, 0);
  buf.writeUInt16LE(20, 4); // version needed = 2.0（支持 deflate）
  buf.writeUInt16LE(ZIP_FLAG_UTF8, 6);
  buf.writeUInt16LE(method, 8);
  buf.writeUInt16LE(time, 10);
  buf.writeUInt16LE(day, 12);
  buf.writeUInt32LE(checksum, 14);
  buf.writeUInt32LE(compressedSize, 18);
  buf.writeUInt32LE(size, 22);
  buf.writeUInt16LE(nameLength, 26);
  buf.writeUInt16LE(0, 28); // 扩展字段长度
  return buf;
}

/** 中央目录项（46 字节定长 + 文件名） */
function centralHeader(nameLength, method, time, day, checksum, compressedSize, size, offset) {
  const buf = Buffer.alloc(46);
  buf.writeUInt32LE(ZIP_CENTRAL_SIG, 0);
  buf.writeUInt16LE(UNIX_VERSION_MADE_BY, 4);
  buf.writeUInt16LE(20, 6);
  buf.writeUInt16LE(ZIP_FLAG_UTF8, 8);
  buf.writeUInt16LE(method, 10);
  buf.writeUInt16LE(time, 12);
  buf.writeUInt16LE(day, 14);
  buf.writeUInt32LE(checksum, 16);
  buf.writeUInt32LE(compressedSize, 20);
  buf.writeUInt32LE(size, 24);
  buf.writeUInt16LE(nameLength, 28);
  buf.writeUInt16LE(0, 30); // 扩展字段长度
  buf.writeUInt16LE(0, 32); // 注释长度
  buf.writeUInt16LE(0, 34); // 起始磁盘号
  buf.writeUInt16LE(0, 36); // 内部属性
  buf.writeUInt32LE((UNIX_REGULAR_FILE << 16) >>> 0, 38);
  buf.writeUInt32LE(offset, 42);
  return buf;
}

/** 中央目录结尾记录（22 字节） */
function endOfCentralDirectory(count, centralSize, centralOffset) {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(ZIP_EOCD_SIG, 0);
  buf.writeUInt16LE(0, 4); // 本磁盘号
  buf.writeUInt16LE(0, 6); // 中央目录起始磁盘号
  buf.writeUInt16LE(count, 8);
  buf.writeUInt16LE(count, 10);
  buf.writeUInt32LE(centralSize, 12);
  buf.writeUInt32LE(centralOffset, 16);
  buf.writeUInt16LE(0, 20); // 注释长度
  return buf;
}

/** 组装完整 ZIP：逐条 本地头 + 数据，末尾中央目录 + EOCD */
function buildZip(entries) {
  if (entries.length > 0xffff) {
    fail(`条目数 ${entries.length} 超过 ZIP 单盘上限 65535（需 ZIP64，本脚本未实现）`);
  }
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    let data;
    let mtime;
    try {
      data = readFileSync(entry.path);
      mtime = statSync(entry.path).mtime;
    } catch (err) {
      fail(`读取文件失败 ${entry.path}：${err instanceof Error ? err.message : String(err)}`);
    }
    const nameBuf = Buffer.from(entry.name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    // 压缩反而变大（已压缩内容 / 极小文件）⇒ 退化为 stored
    const method = deflated.length < data.length ? ZIP_METHOD_DEFLATE : ZIP_METHOD_STORE;
    const payload = method === ZIP_METHOD_DEFLATE ? deflated : data;
    const checksum = crc32(data) >>> 0;
    const { time, day } = dosDateTime(mtime);

    const local = localHeader(
      nameBuf.length,
      method,
      time,
      day,
      checksum,
      payload.length,
      data.length,
    );
    const central = centralHeader(
      nameBuf.length,
      method,
      time,
      day,
      checksum,
      payload.length,
      data.length,
      offset,
    );
    localChunks.push(local, nameBuf, payload);
    centralChunks.push(central, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }

  const centralSize = centralChunks.reduce((sum, buf) => sum + buf.length, 0);
  const eocd = endOfCentralDirectory(entries.length, centralSize, offset);
  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

/** 按顶层条目汇总文件数（dry-run / 摘要输出用） */
function summarizeByTopLevel(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const slash = entry.name.indexOf("/");
    const top = slash === -1 ? "(根文件)" : entry.name.slice(0, slash);
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function parseArgs(argv) {
  const flags = { out: undefined, dryRun: false, help: false };
  const unknown = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out" || arg === "-o") {
      i += 1;
      if (argv[i] === undefined || argv[i] === "") fail("--out 需要一个路径");
      flags.out = argv[i];
    } else if (arg.startsWith("--out=")) {
      const value = arg.slice("--out=".length);
      if (value === "") fail("--out 需要一个路径");
      flags.out = value;
    } else if (arg === "--dry-run" || arg === "-n") {
      flags.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else {
      unknown.push(arg);
    }
  }
  if (unknown.length > 0) fail(`未知参数：${unknown.join(" ")}（--help 查看用法）`);
  return flags;
}

function printUsage() {
  console.log(`pack — 把 machine 单元打成可移植 zip（缺省输出 <单元根>/../machine-<version>-validation.zip）

用法：
  node scripts/pack.mjs [options]     （npm run zip 等价）

选项：
  -o, --out <path>   输出 zip 路径（缺省 ../machine-<version>-validation.zip，version 读 package.json）
  -n, --dry-run      只列出将打包的文件（按顶层条目汇总），不写出
  -h, --help         显示帮助

排除表：
  任何深度  node_modules · .git · .DS_Store · Thumbs.db
  仅顶层    dist · agents · .a2a · .omo · .qoder · .codegraph · coverage · .nyc_output
  后缀      .zip · .log · .tsbuildinfo
  相对路径  config/config.json（本机实例配置：含 bridge token 与本机路径，永不外发）
  另有      本次 --out 输出文件自身（落在单元内时自排除）

退出码：0 成功 / 1 失败（参数错误、缺件、读写失败）。`);
}

function main() {
  if (typeof crc32 !== "function") {
    fail(`需要 Node >= 22.5（zlib.crc32 自 Node 22.2.0 起提供）；当前 ${process.version}`);
  }
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printUsage();
    process.exit(0);
  }

  const version = readPackageVersion(MACHINE_ROOT);
  const outPath =
    flags.out !== undefined
      ? resolve(flags.out)
      : join(dirname(MACHINE_ROOT), `machine-${version}-validation.zip`);

  const entries = collectEntries(MACHINE_ROOT, outPath);
  const missing = REQUIRED_ENTRIES.filter((name) => !entries.some((entry) => entry.name === name));
  if (missing.length > 0) {
    fail(`打包缺件（目录结构异常？）：${missing.join(", ")}`);
  }
  const leaked = FORBIDDEN_ENTRIES.filter((name) => entries.some((entry) => entry.name === name));
  if (leaked.length > 0) {
    fail(`禁入文件出现在待打包列表（排除表失效？）：${leaked.join(", ")}；已中止，未写出任何文件`);
  }

  if (flags.dryRun) {
    info(`dry-run：将打包 ${entries.length} 个文件（未写出）；按顶层条目汇总：`);
    for (const [top, count] of summarizeByTopLevel(entries)) info(`  ${top}  ${count}`);
    process.exit(0);
  }

  const buffer = buildZip(entries);
  const outDir = dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  try {
    writeFileSync(outPath, buffer);
  } catch (err) {
    fail(`写入失败 ${outPath}：${err instanceof Error ? err.message : String(err)}`);
  }

  info(`machine ${version} → ${outPath}`);
  info(`${entries.length} 个文件，${formatBytes(buffer.length)}`);
  info(
    `已排除：dist · node_modules · .a2a · agents · .git 等构建/运行态产物，及本机实例配置 config/config.json`,
  );
  info(`目标机：解压后 npm install && npm run build && npm start`);
  process.exit(0);
}

main();
