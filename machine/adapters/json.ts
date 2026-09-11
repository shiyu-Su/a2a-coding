/**
 * 适配器共用的 JSON 行解析工具：解析失败或非对象一律返回 undefined，
 * 绝不抛异常（CLI 输出混杂日志行是常态）。
 */
export function parseJsonObject(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/** 读取对象中的非空字符串字段（用于 sessionID / thread_id / session_id） */
export function readStringField(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
