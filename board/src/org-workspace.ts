/**
 * 组织工作区的纯文件系统语义。
 *
 * v0.11.0 B1 起板只负责组织目录 / 文档落点，不再用该路径启动任何宿主 agent 进程。
 */
import { statSync } from "node:fs";
import { resolve, sep } from "node:path";

export type DirKind = "dir" | "file" | "missing" | "other";
export type DirKindProbeFn = (path: string) => DirKind;

export const ORGS_DIR_NOT_CONFIGURED = "board_orgs_dir_not_configured";
export const ORGS_DIR_MISSING = "board_orgs_dir_missing";
export const ORG_NAME_INVALID = "board_org_name_invalid";
export const ORG_DISABLED = "board_org_disabled";

export type OrgWorkspaceResolution =
  | { ok: true; workspace: string }
  | { ok: false; code: string; error: string };

/** 文件系统探针；任何异常都收敛为 `missing`，由调用方按既有结构化错误处理。 */
export function statDirKind(path: string): DirKind {
  try {
    const st = statSync(path);
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  } catch {
    return "missing";
  }
}

/** 组织名必须是 `<orgsDir>` 下的一级安全目录名。 */
export function resolveOrgWorkspace(orgsDir: string, org: string): OrgWorkspaceResolution {
  const name = org.trim();
  if (name === "") return { ok: false, code: ORG_NAME_INVALID, error: "组织名为空：无法定位组织目录" };
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes(":")) {
    return { ok: false, code: ORG_NAME_INVALID, error: `组织名含路径分隔符，不可作为目录名：${name}` };
  }
  const root = resolve(orgsDir);
  const workspace = resolve(root, name);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const inside =
    process.platform === "win32"
      ? workspace.toLowerCase().startsWith(prefix.toLowerCase())
      : workspace.startsWith(prefix);
  if (!inside) {
    return { ok: false, code: ORG_NAME_INVALID, error: `组织目录落在组织根之外：${name}` };
  }
  return { ok: true, workspace };
}

/** `orgsDir` 的存在性诊断；未配置由调用方另判 `ORGS_DIR_NOT_CONFIGURED`。 */
export function diagnoseOrgsDir(orgsDir: string, kind: DirKind): { code: string; message: string } | null {
  if (kind === "dir") return null;
  const abs = resolve(orgsDir);
  const remedy =
    kind === "missing"
      ? `对策：改 config.json 的 orgsDir 指向已有目录，或先 mkdir "${abs}" —— 板不会代建根`
      : `对策：该路径上是个文件，请改 config.json 的 orgsDir（或移开该文件）`;
  return {
    code: ORGS_DIR_MISSING,
    message: `组织目录根${kind === "missing" ? "不存在" : "不是目录"}：${abs} ⇒ 组织工作区没有落点。${remedy}`,
  };
}
