/**
 * 应用根目录定位（machine 单元副本）。
 *
 * 源码运行（<root>/machine/launcher）与构建运行（<root>/dist/machine/launcher）
 * 到应用根的深度不同，固定层级相对路径无法兼顾，改为自模块目录向上查找
 * 含 package.json 的目录。
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 从 startDir 向上查找含 package.json 的目录；找不到时返回解析后的 startDir */
export function findAppRoot(startDir: string): string {
  const resolvedStart = resolve(startDir);
  let current = resolvedStart;
  for (;;) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolvedStart;
    current = parent;
  }
}

/** 以模块 URL（import.meta.url）所在目录为起点定位应用根目录 */
export function appRootFromModule(importMetaUrl: string): string {
  return findAppRoot(dirname(fileURLToPath(importMetaUrl)));
}
