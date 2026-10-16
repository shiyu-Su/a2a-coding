/**
 * 依赖图几何度量尺（公共面）。
 *
 * v0.10.7 承接轨 M2（REQ-2026-10-15-01 · 改造文档 §6「承接轨（二次拆分）」M2 行）：
 * 三把尺自 `test/graph-elk.test.mjs` 的 N3 内联实现原样搬来，**语义与阈值逐字保留**
 * （内缩 0.5px / advance 7 每字 / ascent 10 / descent 3）。
 *
 * v0.10.7 承接轨 N6（降级 14 枚几何内部锚 → 行为级四把尺）补入第四、第五枚 ——
 * {@link penCount}（折线穿入障碍盒的**段计数**）与 {@link devOf}（折线两端到「源右缘中点 /
 * 目标左缘中点」的**偏差自核**）。二者**只吃盒与点列**（`{x,y,w,h}` + `[x,y][]`），
 * 不认识任何渲染层内部符号 ⇒ 取数面可从 HTML / SVG 出参直接喂进来。
 * `devOf` 的精度与 `src/graph-elk.ts` 的 `endpointDeviation` 同口径（0.1px）。
 */

/** 轴对齐线段是否穿入盒内部（贴边不算穿：内缩 0.5px；斜段一律计穿）。 */
export const segRect = (a, b, r) => {
  const L = r.x + 0.5;
  const R = r.x + r.w - 0.5;
  const T = r.y + 0.5;
  const B = r.y + r.h - 0.5;
  if (Math.abs(a[0] - b[0]) < 0.01) {
    const x = a[0];
    if (x <= L || x >= R) return false;
    return Math.max(a[1], b[1]) > T && Math.min(a[1], b[1]) < B;
  }
  if (Math.abs(a[1] - b[1]) < 0.01) {
    const y = a[1];
    if (y <= T || y >= B) return false;
    return Math.max(a[0], b[0]) > L && Math.min(a[0], b[0]) < R;
  }
  return true;
};

/** 两盒真交（贴边不算交：内缩 0.5px）。 */
export const overlap = (a, b) =>
  a.x + 0.5 < b.x + b.w - 0.5 &&
  b.x + 0.5 < a.x + a.w - 0.5 &&
  a.y + 0.5 < b.y + b.h - 0.5 &&
  b.y + 0.5 < a.y + a.h - 0.5;

/**
 * 竖排标签「画出来的字」的外接墨盒（12px/600 字，ascent 10 / descent 3、advance 7/字 ——
 * 与 `LABEL_LINE_H` / `LABEL_PAD` 同一套参数）：字在 ELK 回读盒中心 `rotate(-90)`，
 * 故墨盒宽 = ascent+descent、高 = 字数 × advance。度量对象 = 墨盒，不是声明盒。
 */
export const labelInk = (label) => {
  const textH = label.text.length * 7;
  const cx = label.x + Math.round(label.w / 2);
  const cy = label.y + Math.round(label.h / 2);
  return { x: cx - 10, y: cy - textH / 2, w: 13, h: textH };
};

/**
 * 折线穿透计数 = 「逐段 × 逐障碍盒」命中 {@link segRect} 的段数之和。
 * 0 ⇒ 该折线不穿入任何障碍盒内部（贴边不算）。障碍集由调用侧给（本尺不认识「chip / 框」这些概念，
 * 只吃矩形 ⇒ 任何取数面都能喂）。
 */
export const penCount = (pts, rects) => {
  let n = 0;
  for (let i = 0; i + 1 < pts.length; i += 1) {
    for (const r of rects) if (segRect(pts[i], pts[i + 1], r)) n += 1;
  }
  return n;
};

/**
 * 端点偏差 = max(‖首点 − 源盒右缘中点‖, ‖末点 − 目标盒左缘中点‖)，0.1px 精度（与
 * `src/graph-elk.ts` 的 `endpointDeviation` 同式同精度）。点列不足两点或盒缺失 ⇒ null（不猜）。
 */
export const devOf = (pts, source, target) => {
  const head = pts[0];
  const tail = pts[pts.length - 1];
  if (!head || !tail || pts.length < 2 || !source || !target) return null;
  const fromRightMid = Math.hypot(head[0] - (source.x + source.w), head[1] - (source.y + source.h / 2));
  const toLeftMid = Math.hypot(tail[0] - target.x, tail[1] - (target.y + target.h / 2));
  return Math.round(Math.max(fromRightMid, toLeftMid) * 10) / 10;
};
