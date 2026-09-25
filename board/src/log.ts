/**
 * 板服务统一日志出口（BD13″ · v0.9.0）—— **行级时间戳**。
 *
 * 刻意改进（不继承 machine 痛点）：`launcher.log` 无行级时间戳 ⇒ 排查只能靠邻近锚点行；
 * 板的 `board.log` **每行必须带 `[ISO时间] [tag] …`**。分卷不做（登记口径见改造文档）。
 *
 * 实现 = {@link patchStreamTimestamp} 包装 `process.stdout/stderr` 的 `write`：
 * 板内所有输出路径（启动横幅、`process.stdout.write`、将来任何 `console.*`）统一落到同一出口，
 * 调用方无需逐处改造。仅当 `index.ts` 作为入口直跑时安装（`main()` 首行）；
 * 前台终端同样看到带时间戳的行（与后台合并重定向到 `board.log` 的口径一致）。
 */

export type LogTag = "board" | "shutdown" | "error";

const patchedMark = Symbol("boardTimestampPatched");

/** 单行的时间戳前缀：`[<ISO8601>] [<tag>] `（每次 write 落一个时间戳，跨 chunk 不漂移）。 */
export function timestampPrefix(tag: LogTag, at: Date = new Date()): string {
  return `[${at.toISOString()}] [${tag}] `;
}

/**
 * 给任意可写流的 `write` 加行级时间戳前缀（幂等守卫：已打过补丁的流不再套第二层）。
 * 返回是否安装成功（已装过 ⇒ false）。Buffer 等非字符串 chunk 原样透传、不加前缀。
 */
export function patchStreamTimestamp(
  stream: NodeJS.WriteStream,
  tagForChunk: (chunk: unknown) => LogTag = () => "board",
): boolean {
  // 幂等标记必须查在**当前** `stream.write` 上（`bind()` 产生的新函数不继承原函数自有属性 ⇒ 查绑定副本会漏判）
  const current = stream.write as typeof stream.write & { [patchedMark]?: boolean };
  if (current[patchedMark] === true) return false;
  const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  const patched = function patchedWrite(...args: unknown[]): boolean {
    const chunk = args[0];
    if (typeof chunk === "string") {
      args[0] = timestampPrefix(tagForChunk(chunk)) + chunk;
    }
    return Reflect.apply(original, undefined, args);
  } as typeof stream.write & { [patchedMark]?: boolean };
  patched[patchedMark] = true;
  stream.write = patched;
  return true;
}
