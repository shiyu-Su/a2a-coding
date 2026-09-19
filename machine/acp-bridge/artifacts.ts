/**
 * artifacts 最小集组装（REQ-v0.8.0-2026-09-19-01 · 节点 B6）。
 *
 * 产出 A2A v0.3 形状：`{ artifactId, name, parts: [{ kind: "text", text }] }`，
 * 满足 `launcher/a2a-client.ts` 的 `artifacts[].parts` 读取面。
 * workspace 内文件以**相对路径**为 name、内容或 `file:` 引用为 text（最小可用）。
 *
 * 零第三方依赖；可注入 id 工厂（单测确定性）。
 */
import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import type { A2AArtifact } from "./types.js";

export interface ArtifactInput {
  /** 产物名（文件场景为相对路径） */
  name: string;
  /** 文本内容 */
  text?: string;
  /** 内容引用（无 text 时使用） */
  uri?: string;
}

export interface ArtifactBuilderOptions {
  idFactory?: () => string;
}

/** 直接由 `{name, text|uri}` 列表组装 artifacts。 */
export function buildArtifacts(
  inputs: readonly ArtifactInput[],
  options: ArtifactBuilderOptions = {},
): A2AArtifact[] {
  const idFactory = options.idFactory ?? (() => randomUUID());
  return inputs.map((input) => ({
    artifactId: idFactory(),
    name: input.name,
    parts: [{ kind: "text", text: input.text ?? input.uri ?? "" }],
  }));
}

/** workspace 内文件的 artifact 名（绝对路径 → POSIX 相对路径；相对路径原样）。 */
export function artifactNameFor(workspace: string, filePath: string): string {
  const rel = isAbsolute(filePath) ? relative(workspace, filePath) : filePath;
  return rel.split("\\").join("/");
}

export interface WorkspaceFileInput {
  path: string;
  /** 文件内容（缺省 → `file:<相对路径>` 引用片） */
  content?: string;
}

/** workspace 内文件 → artifacts（name = 相对路径；text = 内容或 `file:` 引用）。 */
export function buildWorkspaceArtifacts(
  workspace: string,
  files: readonly WorkspaceFileInput[],
  options: ArtifactBuilderOptions = {},
): A2AArtifact[] {
  const idFactory = options.idFactory ?? (() => randomUUID());
  return files.map((file) => {
    const name = artifactNameFor(workspace, file.path);
    const text = file.content ?? `file:${name}`;
    return { artifactId: idFactory(), name, parts: [{ kind: "text", text }] };
  });
}
