/** 单进程单写手的原子文件替换：同目录临时文件写完再 rename。 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}
