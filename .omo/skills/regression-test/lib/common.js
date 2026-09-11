// 共享工具函数 — a2a-coding 回归测试
const fs = require('fs');
const path = require('path');

/** 项目根目录（lib → regression-test → skills → .omo → 项目根，共 4 层） */
const ROOT = path.resolve(__dirname, '../../../../');

/** 检查文件/目录是否存在（相对项目根，或绝对路径） */
function exist(p) {
  return fs.existsSync(path.resolve(ROOT, p));
}

/** 读取文件内容（相对项目根） */
function read(p) {
  try { return fs.readFileSync(path.resolve(ROOT, p), 'utf-8'); } catch { return ''; }
}

/** 读取并解析 JSON（相对项目根），失败返回 null */
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(path.resolve(ROOT, p), 'utf-8')); } catch { return null; }
}

/**
 * 递归查找目录下所有匹配文件（排除 node_modules/.venv 和 . 开头目录）
 * @param {string} dir - 相对项目根的目录路径
 * @param {function} predicate - 文件名判定函数 (name) => boolean
 * @returns {string[]} 绝对路径数组
 */
function findFilesRecursive(dir, predicate) {
  const found = [];
  const absDir = path.resolve(ROOT, dir);
  if (!fs.existsSync(absDir)) return found;
  function walk(dirPath) {
    let entries;
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.venv'
          || entry.name === '__pycache__' || entry.name.startsWith('.')) continue;
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (predicate(entry.name)) found.push(full);
    }
  }
  walk(absDir);
  return found;
}

/**
 * 获取当前版本号：优先根 package.json 的 version，回退 CHANGELOG 首条 `## [vX.Y.Z]`。
 * （a2a-coding 无 version.conf，版本源为根 package.json）
 * @returns {string|null} 如 '0.1.0'
 */
function getVersion() {
  try {
    const pkg = JSON.parse(read('package.json'));
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim() !== '') {
      return pkg.version.trim();
    }
  } catch { /* 回退 CHANGELOG */ }
  const c = read('CHANGELOG.md');
  const m = c.match(/^## \[v(\d+\.\d+\.\d+)\]/m);
  return m ? m[1] : null;
}

module.exports = { ROOT, exist, read, readJson, findFilesRecursive, getVersion };
