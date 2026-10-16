/**
 * v0.10.7 N2 用例（REQ-2026-10-15-01 · 改造文档 §2.1-3 / §2.4）：
 * `buildElkGraph` 的纯构造判据 —— 3 lane / lane 标签竖排几何 / 容器 padding / 边 id 唯一 /
 * 方向与路由 / 接点方向（源右缘 EAST → 目标左缘 WEST）。输入取 `eb86d5e8` 真板夹具。
 *
 * v0.10.7 N3 用例（改造文档 §2.1-3 / §2.4 / §4）：`layoutGraph` + `flatten` 的求解与摊平判据 ——
 * 枚数与 `pts` 长度 / 绝对坐标累加 / 端点恒落「源右缘中点 → 目标左缘中点」/ 标签墨盒与穿节点两把
 * 几何尺（`N3-④`）+ 另四把尺（`N3-⑨` · 承接轨 M4 补齐：墨盒 vs 其它 lane 盒 / 边穿非本端 lane 盒 /
 * 墨盒 vs 本 lane 首列节点间隙 / 全边 `dev` 重申）/ 单例复用热跑确定性与无量级退化 /
 * 「边的参照系 = 两端点的最低公共容器」/ 相邻重复点去重 / `flatten` 纯函数性与不兜底语义。
 * 度量尺（`segRect` / `overlap` / `labelInk`）在 `test/helpers/geom-assert.mjs`（承接轨 M2 提出）；
 * `penCount` / `devOf` 属 N6。
 * N2/N3 断言均为「本节点契约」，不做兜底、不碰渲染；**N4 段**专测兜底面（catch 面 = 出错回吐空图信号）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildGraphWithPipelines } from "../dist/graph-view.js";
import { DG_NODE_H, DG_NODE_W } from "../dist/graph-view.js";
import { buildElkGraph, flatten, LABEL_H, layoutGraph, layoutGraphGuarded } from "../dist/graph-elk.js";
import { labelInk, overlap, segRect } from "./helpers/geom-assert.mjs";

const FIXTURE = new URL("fixtures/eb86d5e8-tasks.json", import.meta.url);
const realTasks = () => JSON.parse(readFileSync(FIXTURE, "utf8")).tasks;

/** 取 eb86d5e8 真板源。 */
const realSource = () => {
  const graph = buildGraphWithPipelines(realTasks());
  return { graph, source: { pipelines: graph.pipelines, edges: graph.edges } };
};

test("N2-① children = 3（每 project 一枚 lane 容器）", () => {
  const { source } = realSource();
  const root = buildElkGraph(source);
  assert.equal(root.children?.length, 3);
  const laneProjects = root.children.map((c) => c.id.slice("lane:".length)).sort();
  assert.deepEqual(laneProjects, ["board", "flow", "orch"]);
});

test("N2-② 每 lane labels[0].width = LABEL_H 且 height = pid.length*7+8（竖排）", () => {
  const { source } = realSource();
  const root = buildElkGraph(source);
  for (const lane of root.children ?? []) {
    const pid = lane.id.slice("lane:".length);
    const label = lane.labels?.[0];
    assert.ok(label, `lane ${pid} 缺 label`);
    assert.equal(label.width, LABEL_H);
    assert.equal(label.width, 16);
    assert.equal(label.height, pid.length * 7 + 8);
    assert.equal(label.text, pid);
  }
});

test("N2-③ lane padding 串含 left=22", () => {
  const { source } = realSource();
  const root = buildElkGraph(source);
  for (const lane of root.children ?? []) {
    const padding = lane.layoutOptions?.["elk.padding"] ?? "";
    assert.match(padding, /left=22/);
  }
});

test("N2-④ 边 id 唯一（Set.size === 边数）", () => {
  const { source } = realSource();
  const root = buildElkGraph(source);
  const edges = root.edges ?? [];
  assert.equal(edges.length, source.edges.length);
  const ids = new Set(edges.map((e) => e.id));
  assert.equal(ids.size, edges.length);
});

test("N2-⑤ root 方向 / 算法 / 路由 / INCLUDE_CHILDREN", () => {
  const { source } = realSource();
  const root = buildElkGraph(source);
  assert.equal(root.layoutOptions?.["elk.algorithm"], "layered");
  assert.equal(root.layoutOptions?.["elk.direction"], "RIGHT");
  assert.equal(root.layoutOptions?.["elk.edgeRouting"], "ORTHOGONAL");
  assert.equal(root.layoutOptions?.["elk.hierarchyHandling"], "INCLUDE_CHILDREN");
});

test("N2-⑥ chip 尺寸取 graph-view 单源（DG_NODE_W/H，非本文件另写常量）", () => {
  const { graph, source } = realSource();
  const root = buildElkGraph(source);
  const allChips = (root.children ?? []).flatMap((lane) => lane.children ?? []);
  assert.equal(allChips.length, graph.nodes.length);
  for (const chip of allChips) {
    assert.equal(chip.width, DG_NODE_W);
    assert.equal(chip.height, DG_NODE_H);
  }
});

test("N2-⑦ 端点接点方向：源 ~east → 目标 ~west", () => {
  const { source } = realSource();
  const root = buildElkGraph(source);
  const byId = new Map(source.edges.map((e, i) => [`e${i}:${e.from}>${e.to}`, e]));
  for (const edge of root.edges ?? []) {
    const src = byId.get(edge.id);
    assert.ok(src, `边 ${edge.id} 找不到原边`);
    assert.deepEqual(edge.sources, [`${src.from}~east`]);
    assert.deepEqual(edge.targets, [`${src.to}~west`]);
  }
});

test("N2-⑧ 每个 chip 带 WEST/EAST 居中 port + FIXED_SIDE", () => {
  const { source } = realSource();
  const root = buildElkGraph(source);
  const allChips = (root.children ?? []).flatMap((lane) => lane.children ?? []);
  for (const chip of allChips) {
    assert.equal(chip.layoutOptions?.["elk.portConstraints"], "FIXED_SIDE");
    const sides = (chip.ports ?? []).map((p) => p.layoutOptions?.["elk.port.side"]).sort();
    assert.deepEqual(sides, ["EAST", "WEST"]);
  }
});

// ---------------------------------------------------------------------------
// N3（REQ-2026-10-15-01 · 改造文档 §2.4）：求解 + 出参摊平
//   判据 = 真板 28 节点入 ⇒ 3 lane / 28 node / 全边有折线；标签墨盒零压、边零穿；
//          端点偏差自核 0；单例复用热跑确定性 + 无量级退化。
//   度量尺见 `test/helpers/geom-assert.mjs`（承接轨 M2 由本文件内联提出）。
// ---------------------------------------------------------------------------

test("N3-① 真板 28 节点入 ⇒ 3 lane / 28 node / 31 边且全有折线", async () => {
  const { graph, source } = realSource();
  const flat = await layoutGraph(source);
  assert.equal(flat.lanes.length, 3);
  assert.equal(flat.nodes.length, 28);
  assert.equal(flat.nodes.length, graph.nodes.length);
  assert.equal(flat.edges.length, source.edges.length);
  assert.ok(flat.edges.every((e) => e.pts.length > 1), "存在未摊出折线的边（ELK 未产 sections）");
  assert.ok(flat.width > 0 && flat.height > 0);
});

test("N3-② 绝对坐标累加：lane 先序、chip 落在所属 lane 盒内（同 project 节点同框）", async () => {
  const { source } = realSource();
  const flat = await layoutGraph(source);
  const laneById = new Map(flat.lanes.map((l) => [l.id, l]));
  const projectIdByLaneId = new Map(flat.lanes.map((l) => [l.id, l.projectId]));
  const taskProject = new Map();
  for (const pipeline of source.pipelines) {
    for (const node of pipeline.nodes) taskProject.set(node.taskId, pipeline.projectId);
  }
  for (const node of flat.nodes) {
    const lane = laneById.get(node.laneId);
    assert.ok(lane, `节点 ${node.id} 的 laneId ${node.laneId} 不在 lanes 里`);
    assert.equal(projectIdByLaneId.get(node.laneId), taskProject.get(node.id), `${node.id} 落错 lane`);
    assert.ok(node.x >= lane.x - 0.01 && node.y >= lane.y - 0.01, `${node.id} 越出 lane 左上`);
    assert.ok(node.x + node.w <= lane.x + lane.w + 0.01 && node.y + node.h <= lane.y + lane.h + 0.01, `${node.id} 越出 lane 右下`);
    assert.equal(node.w, DG_NODE_W);
    assert.equal(node.h, DG_NODE_H);
  }
  assert.equal(flat.lanes.length, new Set(flat.lanes.map((l) => l.projectId)).size);
});

test("N3-③ 端点偏差自核：全边 dev === 0（源右缘中点 → 目标左缘中点）", async () => {
  const { source } = realSource();
  const flat = await layoutGraph(source);
  const byId = new Map(flat.nodes.map((n) => [n.id, n]));
  for (const edge of flat.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    assert.ok(from && to, `边 ${edge.id} 端点不在节点集`);
    const head = edge.pts[0];
    const tail = edge.pts[edge.pts.length - 1];
    assert.deepEqual([head[0], head[1]], [from.x + from.w, from.y + from.h / 2], `${edge.id} 起点非源右缘中点`);
    assert.deepEqual([tail[0], tail[1]], [to.x, to.y + to.h / 2], `${edge.id} 末点非目标左缘中点`);
    assert.equal(edge.dev, 0);
  }
});

test("N3-④ 度量尺：标签墨盒 vs 节点盒 overlap === 0 且边 segRect 穿节点 === 0", async () => {
  const { source } = realSource();
  const flat = await layoutGraph(source);
  const inkHits = flat.lanes.flatMap((lane) => {
    assert.ok(lane.label, `lane ${lane.projectId} 无 label 盒`);
    const ink = labelInk(lane.label);
    return flat.nodes.filter((node) => overlap(ink, node)).map((node) => `${lane.projectId}→${node.id}`);
  });
  assert.deepEqual(inkHits, []);
  const penetrations = flat.edges.flatMap((edge) =>
    flat.nodes
      .filter((node) => edge.pts.slice(1).some((p, m) => segRect(edge.pts[m], p, node)))
      .map((node) => `${edge.id}→${node.id}`),
  );
  assert.deepEqual(penetrations, []);
});

test("N3-⑨ 度量尺补齐：另四把尺在真板 28 节点上全 0（墨盒 vs 他 lane / 边穿非本端 lane / 首列间隙 / 全边 dev）", async () => {
  const { source } = realSource();
  const flat = await layoutGraph(source);
  // 尺①：本 lane 的标签**墨盒**不得压进**其它 lane** 的容器盒（度量对象 = 画出来的墨盒，非声明盒）
  const inkOnOtherLanes = flat.lanes.flatMap((lane) => {
    assert.ok(lane.label, `lane ${lane.projectId} 无 label 盒`);
    const ink = labelInk(lane.label);
    return flat.lanes
      .filter((other) => other.id !== lane.id && overlap(ink, other))
      .map((other) => `${lane.projectId}→${other.projectId}`);
  });
  assert.equal(inkOnOtherLanes.length, 0, `标签墨盒压进其它 lane 容器盒：${inkOnOtherLanes.join(", ")}`);
  // 尺②：边的折线不得穿入**非本端所属**的 lane 容器盒（两端节点所在 lane 各放行一枚）
  const laneOf = new Map(flat.nodes.map((node) => [node.id, node.laneId]));
  const edgeThroughForeignLane = flat.edges.flatMap((edge) => {
    const ownLanes = new Set([laneOf.get(edge.from), laneOf.get(edge.to)]);
    return flat.lanes
      .filter((lane) => !ownLanes.has(lane.id) && edge.pts.slice(1).some((p, m) => segRect(edge.pts[m], p, lane)))
      .map((lane) => `${edge.id}→${lane.projectId}`);
  });
  assert.equal(edgeThroughForeignLane.length, 0, `边穿入非本端所属 lane 容器盒：${edgeThroughForeignLane.join(", ")}`);
  // 尺③：本 lane 标签墨盒右缘 → 本 lane **首列节点**左缘的最小间隙须 > 0（padding.left=22 管的就是这段间隙）
  const firstColGaps = flat.lanes.map((lane) => {
    const ink = labelInk(lane.label);
    const mine = flat.nodes.filter((node) => node.laneId === lane.id);
    const firstX = Math.min(...mine.map((node) => node.x));
    const gap = Math.min(...mine.filter((node) => node.x <= firstX + 0.01).map((node) => node.x - (ink.x + ink.w)));
    return { projectId: lane.projectId, gap };
  });
  assert.equal(firstColGaps.filter((g) => g.gap <= 0).length, 0, `标签墨盒与本 lane 首列节点无间隙：${firstColGaps.filter((g) => g.gap <= 0).map((g) => `${g.projectId}=${g.gap}`).join(", ")}`);
  for (const g of firstColGaps) assert.ok(g.gap > 0, `lane ${g.projectId} 墨盒与首列节点间隙须 > 0（实测 ${g.gap}）`);
  // 尺④：全边端点偏差 === 0 的重申（`null` = 无从核，同样计入非 0）
  const offEndpoint = flat.edges.filter((edge) => edge.dev !== 0).map((edge) => `${edge.id}=${edge.dev}`);
  assert.equal(offEndpoint.length, 0, `端点偏差非 0 的边：${offEndpoint.join(", ")}`);
});

test("N3-⑤ elk 实例进程内单例：热跑确定性 + 无量级退化 + 源码面单例锚", async () => {
  const { source } = realSource();
  await layoutGraph(source); // 冷跑（首次装载算法）
  const firstStart = Date.now();
  const flat1 = await layoutGraph(source);
  const first = Date.now() - firstStart;
  const secondStart = Date.now();
  const flat2 = await layoutGraph(source);
  const second = Date.now() - secondStart;
  // 行为级①：确定性 —— 同一 source 连跑两次逐字相等（单例复用不改求解结果）
  assert.deepEqual(flat1, flat2);
  // 行为级②：宽松上限 —— 只钉「没有量级退化」，不卡与机器抖动同阶的具体毫秒阈值
  assert.ok(second < first * 3 + 500, `热跑 ${second}ms 相对首跑 ${first}ms 出现量级退化`);
  assert.equal(flat2.nodes.length, 28);
  // 源码面单例锚：全模块仅一枚 `new ElkPackage.default()`（grep -c 语义 = 命中行数）
  const elkSrc = readFileSync(new URL("../src/graph-elk.ts", import.meta.url), "utf8");
  const singletonHits = elkSrc.split("\n").filter((line) => line.includes("new ElkPackage.default()")).length;
  assert.equal(singletonHits, 1, "elk 实例应全模块单例（new ElkPackage.default() 恰一枚）");
});

/** 一棵**已求解**的合成树：lane 内边 = 相对其 lane、跨 lane 边 = 相对 root（ELK INCLUDE_CHILDREN 的参照系）。 */
const laidSynthetic = () => ({
  id: "root",
  x: 0,
  y: 0,
  width: 300,
  height: 200,
  children: [
    {
      id: "lane:a",
      x: 10,
      y: 20,
      width: 120,
      height: 76,
      labels: [{ text: "a", x: 0, y: 0, width: 16, height: 15 }],
      children: [
        { id: "n1", x: 22, y: 8, width: 74, height: 28 },
        { id: "n2", x: 22, y: 40, width: 74, height: 28 },
      ],
    },
    {
      id: "lane:b",
      x: 150,
      y: 100,
      width: 120,
      height: 76,
      labels: [{ text: "b", x: 0, y: 0, width: 16, height: 15 }],
      children: [{ id: "n3", x: 22, y: 8, width: 74, height: 28 }],
    },
  ],
  edges: [
    {
      id: "e-intra",
      sources: ["n1~east"],
      targets: ["n2~west"],
      sections: [{ startPoint: { x: 96, y: 22 }, bendPoints: [{ x: 110, y: 22 }, { x: 110, y: 54 }], endPoint: { x: 22, y: 54 } }],
    },
    {
      // raw 5 点 ⇒ pts 4 点：跨段首点由『非首段不推 startPoint』收、段内重复点由 `DEDUP_EPS` 收
      id: "e-cross",
      sources: ["n2~east"],
      targets: ["n3~west"],
      sections: [
        { startPoint: { x: 106, y: 74 }, bendPoints: [{ x: 200, y: 74 }], endPoint: { x: 200, y: 122 } },
        { startPoint: { x: 200, y: 122 }, bendPoints: [{ x: 172, y: 122 }], endPoint: { x: 172, y: 122 } },
      ],
    },
  ],
});

test("N3-⑥ flatten 参照系 = 两端点最低公共容器（带内边相对 lane、跨带边相对 root）", () => {
  const flat = flatten(laidSynthetic());
  // n1 绝对 = (32,28) → 右缘中点 (106,42)；e-intra 的 sections 是 lane 局部坐标 (96,22)
  assert.deepEqual(flat.edges.find((e) => e.id === "e-intra")?.pts, [[106, 42], [120, 42], [120, 74], [32, 74]]);
  assert.equal(flat.edges.find((e) => e.id === "e-intra")?.dev, 0);
  // e-cross 的 sections 已是 root 坐标 ⇒ 不加 lane 偏移
  assert.deepEqual(flat.edges.find((e) => e.id === "e-cross")?.pts, [[106, 74], [200, 74], [200, 122], [172, 122]]);
  assert.equal(flat.edges.find((e) => e.id === "e-cross")?.dev, 0);
});

test("N3-⑦ sections → pts 去重（相邻重复点去掉）+ lane/chip 分出", () => {
  const flat = flatten(laidSynthetic());
  assert.deepEqual(flat.lanes.map((l) => l.projectId), ["a", "b"]);
  assert.deepEqual(flat.nodes.map((n) => [n.id, n.laneId]), [["n1", "lane:a"], ["n2", "lane:a"], ["n3", "lane:b"]]);
  for (const edge of flat.edges) {
    for (let i = 1; i < edge.pts.length; i += 1) {
      const prev = edge.pts[i - 1];
      const cur = edge.pts[i];
      assert.ok(Math.hypot(cur[0] - prev[0], cur[1] - prev[1]) > 0.01, `${edge.id} 第 ${i} 点与前一点重复`);
    }
  }
  assert.equal(flat.edges.find((e) => e.id === "e-cross")?.pts.length, 4);
});

test("N3-⑧ flatten 是纯函数（同一棵树两次调用逐字相等），且无兜底：端点缺失 ⇒ dev null、无 sections ⇒ 空折线", () => {
  const tree = laidSynthetic();
  assert.deepEqual(flatten(tree), flatten(tree));
  const broken = {
    ...tree,
    edges: [
      { id: "e-ghost", sources: ["ghost~east"], targets: ["n3~west"], sections: [{ startPoint: { x: 1, y: 1 }, endPoint: { x: 2, y: 2 } }] },
      { id: "e-nosec", sources: ["n1~east"], targets: ["n2~west"] },
    ],
  };
  const flat = flatten(broken);
  const ghost = flat.edges.find((e) => e.id === "e-ghost");
  assert.equal(ghost.from, "ghost");
  assert.equal(ghost.dev, null);
  const noSec = flat.edges.find((e) => e.id === "e-nosec");
  assert.deepEqual(noSec.pts, []);
  assert.equal(noSec.dev, null);
  assert.equal(flat.nodes.length, 3); // 节点面不受边异常影响
});

// ---------------------------------------------------------------------------
// v0.10.7 N4（REQ-2026-10-15-01 · 改造文档 §2.4 兜底条）：catch 面 = 出错回吐空图信号
//   判据 = 求解 / 摊平任一环节抛错 ⇒ layoutGraphGuarded **resolve 不 reject**、`flat === null`、
//          `reason` 带人读错因（不静默）；layoutGraph 本体的上抛契约逐字不变（正常路径零改动）。
// ---------------------------------------------------------------------------

/** 真会抛错的源：末端挂一枚悬空边（`ghost-task` 不在任何 pipeline 节点集）⇒ ELK 导入层当场拒。 */
const ghostEdgeSource = () => {
  const { source } = realSource();
  const last = source.edges[source.edges.length - 1];
  return { pipelines: source.pipelines, edges: [...source.edges, { from: last.from, to: "ghost-task" }] };
};

test("N4-① catch 面：真抛错输入（悬空端点）⇒ resolve 不 reject、flat null、reason 非空", async () => {
  const res = await layoutGraphGuarded(ghostEdgeSource());
  assert.equal(res.flat, null);
  assert.equal(typeof res.reason, "string");
  assert.ok(res.reason.length > 0, "错因不得为空（静默兜底 = 本节点负钉）");
});

test("N4-② 同一输入的 layoutGraph 契约不变 ⇒ 仍原样上抛（catch 只在兜底面）", async () => {
  await assert.rejects(() => layoutGraph(ghostEdgeSource()));
});

test("N4-③ 正常输入 ⇒ reason null + flat 与 layoutGraph 出参逐字相等（正常路径零改动）", async () => {
  const { source } = realSource();
  const res = await layoutGraphGuarded(source);
  assert.equal(res.reason, null);
  assert.deepEqual(res.flat, await layoutGraph(source));
  assert.equal(res.flat.nodes.length, 28);
});

test("N4-④ 注入抛错的求解桩 ⇒ catch 面捕获、reason = 桩的原话（转义属出口面，不在本层）", async () => {
  const { source } = realSource();
  const boom = 'solve failed: "quote" <tag>';
  const res = await layoutGraphGuarded(source, async () => {
    throw new Error(boom);
  });
  assert.equal(res.flat, null);
  assert.equal(res.reason, boom);
});

test("N4-⑤ 摊平环节抛错同样落 catch 面（不只求解）：桩返回畸形树 ⇒ flat null + reason 非空", async () => {
  const { source } = realSource();
  const res = await layoutGraphGuarded(source, async () => null);
  assert.equal(res.flat, null);
  assert.ok(res.reason.length > 0);
});

// ---------------------------------------------------------------------------
// v0.10.7 N11（REQ-2026-10-15-01 · 承接轨 · 改造文档 §4「测试锚面 · 补 2 枚」ELK 面）
//   板侧 ELK 模块不得染指退休符号（阵型/画布族 + `DG_APPROACH_*` 三枚 + `layerCrossApproach`）：
//   graph-elk.ts 是 ELK 出参摊平层，走线族一旦回填即「两套坐标系并存」= 结构性缺陷；
//   体量登记（快照）：`src/graph-elk.ts` 行数 ≤ 700（当前 ~409 · 只增不减的口径给 ELK 摊平层）。
// ---------------------------------------------------------------------------

/** 去块注释（`/* … * /`）与去 `//` 到行尾的粗筛（与 graph-view.test.mjs N11 同口径 · 两处各自持一份）。 */
const stripTsComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("N11负钉⑤ 退休符号在去注释后的 src/graph-elk.ts 内各命中 0（ELK 层不得接走线族 · 两套坐标系并存 = 结构性缺陷）", () => {
  const code = stripTsComments(readFileSync(new URL("../src/graph-elk.ts", import.meta.url), "utf8"));
  for (const sym of [
    "layerCrossApproach",
    "DG_APPROACH_SNAP_PX",
    "DG_APPROACH_LATERAL_PX",
    "DG_APPROACH_STUB_PX",
    "planCanvas",
    "pipeGridLayout",
  ]) {
    const hits = code.split(sym).length - 1;
    assert.equal(hits, 0, `退休符号 ${sym} 在去注释后的 src/graph-elk.ts 不得残留（实得 ${hits} 处）`);
  }
});

test("N11登记⑥ 体量快照：src/graph-elk.ts 行数 ≤ 700（当前 ~409 · ELK 摊平层只可缩不可弹回走线族体量）", () => {
  const lines = readFileSync(new URL("../src/graph-elk.ts", import.meta.url), "utf8").split("\n").length;
  assert.ok(lines <= 700, `src/graph-elk.ts 行数 ${lines} > 700 ⇒ ELK 层出现非摊平职责回填`);
});


