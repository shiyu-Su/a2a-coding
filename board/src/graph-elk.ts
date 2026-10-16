/**
 * 依赖图 ELK 构造 + 求解 + 出参摊平（v0.10.7 N2/N3 · REQ-2026-10-15-01 · 改造文档 §2.1-3 / §2.4）。
 *
 * 两段职责，同一模块：
 *
 * 1. **构造**（{@link buildElkGraph}）—— 把 {@link GraphPipeline} 分组后的管道与依赖边翻译成
 *    elkjs 的 `ElkNode` 树。**不碰渲染、不产 HTML/CSS**。出参是一棵可直接喂给 `ELK.layout` 的层级图：
 *
 * - **root**：`layered` + `elk.direction=RIGHT` + `elk.edgeRouting=ORTHOGONAL`
 *   + `elk.hierarchyHandling=INCLUDE_CHILDREN`（跨 lane 的边在 root 上声明、由 ELK 下探子树解析端点）。
 * - **每 project 一枚 lane 容器**（compound，来自 {@link groupPipelines} 的有序管道序）：
 *   `labels` 按**竖排**声明（`width={@link LABEL_H}`、`height=projectId.length*{@link LABEL_LINE_H}+{@link LABEL_PAD}`）
 *   + `elk.nodeLabels.placement=INSIDE_LEFT` + `elk.padding=[left=22,…]`。
 * - **chip 尺寸取单源** —— `DG_NODE_W` / `DG_NODE_H`（{@link module:graph-view} 的网格几何事实源），
 *   本文件**不另写常量**。
 * - **节点带 `FIXED_SIDE` + WEST / EAST 居中 port** —— 保证走线「源右缘（EAST port）→ 目标左缘（WEST port）」，
 *   与既有自绘走线的端点定义式（源 chip 右缘 → 目标 chip 左缘）同一意图（几何交给 ELK 求解，本节点不摆坐标）。
 * - **每条边带唯一 `id`** —— {@link buildEdgeId} 以边序号定 uniquely，重复调用逐字相等。
 *
 * 2. **求解 + 摊平**（{@link layoutGraph} / {@link flatten}）—— 跑一次 `elk.layout()`，把 ELK 的
 *    **逐层相对坐标**累加成**画布绝对坐标**，`sections → pts` 去重，并对每条边自核「端点偏差」
 *    （{@link FlatEdge.dev}）。出参 {@link FlatGraph} 是渲染层唯一的几何来源。
 * 3. **兜底面**（{@link layoutGraphGuarded}，v0.10.7 N4 · 改造文档 §2.4 宿主裁定）—— 构造 / 求解 /
 *    摊平任一环节抛错 ⇒ **不抛异常、不静默**，回 `{ flat: null, reason }`；调用侧据此回吐空图 +
 *    一行提示（页面不 500）。{@link layoutGraph} 本体仍原样上抛（N3 契约不变）。
 */
// elkjs 是 CJS 包：NodeNext 下默认导入拿到的类型是「整个模块命名空间」（不可 new），
// 构造子在该命名空间的 `default` 成员上。
import ElkPackage from "elkjs";
import type {
  ElkEdgeSection,
  ElkExtendedEdge,
  ElkLabel,
  ElkNode,
  ElkPort,
  LayoutOptions,
} from "elkjs";
import { DG_BADGE_H, DG_GRID_ORIGIN_Y, DG_NODE_H, DG_NODE_W, type GraphPipeline } from "./graph-view.js";

/** lane 竖排标签的**宽度**（横占位，与 chip 无关；测试锚 `labels[0].width === 16`）。 */
export const LABEL_H = 16;
/** 竖排标签每个字符的**行高** —— `height = projectId.length * LABEL_LINE_H + LABEL_PAD`。 */
export const LABEL_LINE_H = 7;
/** 竖排标签高度的**上下留白**加数。 */
export const LABEL_PAD = 8;

/** lane 容器左内缘（`elk.padding` 的 `left` —— 给竖排标签让位）。 */
const LANE_PAD_LEFT = 22;
/** lane 容器 right / bottom 内缘。 */
const LANE_PAD_REST = 8;
/**
 * lane 容器**上**内缘 —— 与 DOM 帧壳让位量**同一事实源**（v0.10.7 N5 接线）。
 *
 * `details.pipe` 的网格原点相对框外缘 = {@link DG_GRID_ORIGIN_Y}（1px 边框 + 20px 标题带），
 * 其下每枚 cell 又恒留 {@link DG_BADGE_H} 角标带 ⇒ chip 顶缘最低只能落在 `lane.y + 35`。
 * 本值若小于该和，渲染层把 ELK 的 chip 绝对盒换算成 cell 局部 `top` 就得到**负值** ⇒ 节点压进标题带。
 *
 * **写成函数、不写成顶层常量**：本模块与 {@link module:graph-view} 互为 import 环，
 * 环上 `graph-view` 先求值时其 `DG_*` 仍是 TDZ —— 顶层求值会当场 ReferenceError。
 */
const lanePadTop = (): number => DG_GRID_ORIGIN_Y + DG_BADGE_H;

/** port 标识后缀：源侧出（右缘）。 */
const PORT_EAST = "east";
/** port 标识后缀：目标侧入（左缘）。 */
const PORT_WEST = "west";

/** {@link buildElkGraph} 入参 —— 本仓图的构造原料（管道 = lane，边 = 已净化的可画边集）。 */
export interface ElkGraphSource {
  /** 每 project 一枚有序管道（{@link groupPipelines} 出参，决定 lane 序与组内节点序）。 */
  readonly pipelines: readonly GraphPipeline[];
  /** 可画的依赖边（依赖项 → 依赖者）。调用方决定吃全 `edges` 还是约简后 `kept`，本节点不干预。 */
  readonly edges: readonly { from: string; to: string }[];
}

/** port id = `${taskId}~${side}` —— 全局唯一（INCLUDE_CHILDREN 下 root 直接按 id 引用深端点）。 */
const portId = (taskId: string, side: string): string => `${taskId}~${side}`;

/** 边 id：以序号定 unique，附两端 taskId 便于调试；重复调用逐字相等。 */
const buildEdgeId = (index: number, from: string, to: string): string => `e${index}:${from}>${to}`;

/** 一枚 chip 节点的 WEST / EAST 居中 port（`FIXED_SIDE` 定死左右缘，纵向居中）。 */
function chipPorts(taskId: string): ElkPort[] {
  const west: ElkPort = {
    id: portId(taskId, PORT_WEST),
    layoutOptions: { "elk.port.side": "WEST" } satisfies LayoutOptions,
  };
  const east: ElkPort = {
    id: portId(taskId, PORT_EAST),
    layoutOptions: { "elk.port.side": "EAST" } satisfies LayoutOptions,
  };
  return [west, east];
}

/** 一枚节点 chip（尺寸取 {@link DG_NODE_W}/{@link DG_NODE_H} 单源，端口 {@link chipPorts}）。 */
function chipNode(taskId: string): ElkNode {
  return {
    id: taskId,
    width: DG_NODE_W,
    height: DG_NODE_H,
    layoutOptions: { "elk.portConstraints": "FIXED_SIDE" } satisfies LayoutOptions,
    ports: chipPorts(taskId),
  };
}

/** lane 竖排标签（`width=LABEL_H`、`height=pid.length*LABEL_LINE_H+LABEL_PAD`）。 */
function laneLabel(projectId: string): ElkLabel {
  return {
    text: projectId,
    width: LABEL_H,
    height: projectId.length * LABEL_LINE_H + LABEL_PAD,
  };
}

/** 一枚 project lane 容器（compound：竖排 label + 组内有序 chip）。 */
function laneNode(pipeline: GraphPipeline): ElkNode {
  const padding = `[left=${LANE_PAD_LEFT},top=${lanePadTop()},right=${LANE_PAD_REST},bottom=${LANE_PAD_REST}]`;
  return {
    id: `lane:${pipeline.projectId}`,
    labels: [laneLabel(pipeline.projectId)],
    layoutOptions: {
      "elk.container": "true",
      "elk.nodeLabels.placement": "INSIDE_LEFT",
      "elk.padding": padding,
    } satisfies LayoutOptions,
    children: pipeline.nodes.map((n) => chipNode(n.taskId)),
  };
}

/**
 * 本仓图 → ElkGraph（纯构造，不求解）。
 *
 * - root 携带层级算法与方向；{@link ElkGraphSource.pipelines} 逐枚翻成 lane 容器；
 *   {@link ElkGraphSource.edges} 逐条翻成 root 上的 `ElkExtendedEdge`（源取 `~east`、目标取 `~west`）。
 * - 端点 taskId 必须在某条 pipeline 的节点集内（{@link groupPipelines} 与 {@link module:graph-view#buildTaskGraph}
 *   的契约保证 `edges` 端点恒为节点集子集）；此处不重复净化，未知端点按 ELK 语义原样引用其 port id。
 * - 出参确定性：lane 序 / 组内 chip 序 = 入参 `pipelines` 顺序；边序 = 入参 `edges` 数组序。
 */
export function buildElkGraph(source: ElkGraphSource): ElkNode {
  const root: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    } satisfies LayoutOptions,
    children: source.pipelines.map((p) => laneNode(p)),
    edges: source.edges.map((e, i) => edgeNode(i, e.from, e.to)),
  };
  return root;
}

/** 一条边（root 上声明，端点落两侧 chip 的 EAST/WEST port）。 */
function edgeNode(index: number, from: string, to: string): ElkExtendedEdge {
  return {
    id: buildEdgeId(index, from, to),
    sources: [portId(from, PORT_EAST)],
    targets: [portId(to, PORT_WEST)],
  };
}

// ---------------------------------------------------------------------------
// v0.10.7 N3（REQ-2026-10-15-01 · 改造文档 §2.4）：求解 + 出参摊平（绝对坐标 / pts 去重 / 端点偏差自核）
// ---------------------------------------------------------------------------

/**
 * `elk` 实例**进程内单例**（改造文档 §2.4 性能口径）—— 每请求新建会重装算法目录，
 * 真板 28 节点上冷跑 ≈ 230ms、复用后热跑 ≈ 90ms。
 */
const elk = new ElkPackage.default();

/** lane 容器 id 前缀（`lane:{projectId}`）。 */
const LANE_PREFIX = "lane:";

/** 相邻重复点的去重阈值（px）—— ELK 相邻段共享端点，直接串起来会产出逐字相同的相邻点。 */
const DEDUP_EPS = 0.01;
/** {@link FlatEdge.dev} 的报出精度（px，一位小数 —— 与原型度量尺 `devOf` 同口径）。 */
const DEV_PRECISION = 10;

/** 画布坐标系下的一个绝对盒（左上原点）。 */
export interface FlatBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 折线的一个点（绝对坐标）。 */
export type FlatPoint = readonly [number, number];

/** lane 容器标题 —— ELK 回读盒的绝对位置（渲染层照此盒画竖排字，本文件不画）。 */
export interface FlatLabel extends FlatBox {
  readonly text: string;
}

/** 一条 lane（= 一个 project 的容器带）的绝对几何。 */
export interface FlatLane extends FlatBox {
  readonly id: string;
  readonly projectId: string;
  /** ELK 未回读 label 盒 ⇒ null（本仓构造恒声明一枚，见 {@link laneLabel}）。 */
  readonly label: FlatLabel | null;
}

/** 一枚 chip 节点的绝对几何 + 所属 lane。 */
export interface FlatNode extends FlatBox {
  readonly id: string;
  readonly laneId: string;
}

/** 一条边的绝对折线 + 端点偏差自核。 */
export interface FlatEdge {
  readonly id: string;
  /** 源 chip 的 taskId（{@link portId} 的反向：去掉 `~east`）。 */
  readonly from: string;
  /** 目标 chip 的 taskId（去掉 `~west`）。 */
  readonly to: string;
  /** `sections → pts` 去重后的绝对折线；ELK 未产 sections ⇒ 空数组（**本节点不做兜底**，兜底面 = {@link layoutGraphGuarded}）。 */
  readonly pts: readonly FlatPoint[];
  /**
   * 端点偏差自核 = max(‖pts 首点 − 源右缘中点‖, ‖pts 末点 − 目标左缘中点‖)，0.1px 精度。
   * 无折线（`pts.length < 2`）或端点 taskId 不在节点集 ⇒ null（无从核起，不猜）。
   */
  readonly dev: number | null;
}

/** {@link layoutGraph} / {@link flatten} 的出参 —— 渲染层唯一几何来源。 */
export interface FlatGraph {
  readonly width: number;
  readonly height: number;
  readonly lanes: readonly FlatLane[];
  readonly nodes: readonly FlatNode[];
  readonly edges: readonly FlatEdge[];
}

/** 摊平第一趟的中间记录：绝对盒 + 自 root 起的父容器链（求边的参照系用）。 */
interface Placed {
  readonly box: FlatBox;
  /** 不含自身的父容器 id 链：lane ⇒ `[root]`，chip ⇒ `[root, lane]`，root ⇒ `[]`。 */
  readonly chain: readonly string[];
}

/** port id → 所属 chip 的 taskId（{@link portId} 的反向；缺端点 ⇒ 空串，交由 {@link FlatEdge.dev} 记 null）。 */
const nodeOfPort = (endpoint: string | undefined): string => (endpoint ?? "").replace(/~(?:east|west)$/, "");

/** 两条父链的**最深公共容器** id；无公共项（端点未收录）⇒ undefined（按 root 参照系 = 零偏移处理）。 */
function commonContainer(a: readonly string[], b: readonly string[]): string | undefined {
  let common: string | undefined;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    if (x === undefined || x !== b[i]) break;
    common = x;
  }
  return common;
}

/** 一列 `sections` 摊成一条绝对折线：首段起点 → 各段转折点 → 段末点，逐点加容器偏移，相邻重复点去掉。 */
function flattenSections(sections: readonly ElkEdgeSection[] | undefined, fx: number, fy: number): FlatPoint[] {
  const raw: FlatPoint[] = [];
  for (const section of sections ?? []) {
    // 只有首段带 startPoint —— 其余段的起点与前一段末点逐字相同，去重那一趟会把它收掉
    if (raw.length === 0) raw.push([fx + section.startPoint.x, fy + section.startPoint.y]);
    for (const bend of section.bendPoints ?? []) raw.push([fx + bend.x, fy + bend.y]);
    raw.push([fx + section.endPoint.x, fy + section.endPoint.y]);
  }
  const pts: FlatPoint[] = [];
  for (const p of raw) {
    const prev = pts[pts.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > DEDUP_EPS) pts.push(p);
  }
  return pts;
}

/** 端点偏差自核：pts 首点 vs 源右缘中点、pts 末点 vs 目标左缘中点，取较大者（0.1px 精度）。 */
function endpointDeviation(pts: readonly FlatPoint[], source: FlatBox | undefined, target: FlatBox | undefined): number | null {
  const head = pts[0];
  const tail = pts[pts.length - 1];
  if (!source || !target || !head || !tail || pts.length < 2) return null;
  const fromRightMid = Math.hypot(head[0] - (source.x + source.w), head[1] - (source.y + source.h / 2));
  const toLeftMid = Math.hypot(tail[0] - target.x, tail[1] - (target.y + target.h / 2));
  return Math.round(Math.max(fromRightMid, toLeftMid) * DEV_PRECISION) / DEV_PRECISION;
}

/** ELK 回读的 label 盒 → 绝对 label 盒（label 的 x/y 本就相对其容器）。 */
function flatLabel(label: ElkLabel | undefined, ox: number, oy: number): FlatLabel | null {
  if (!label) return null;
  return {
    text: label.text ?? "",
    x: ox + (label.x ?? 0),
    y: oy + (label.y ?? 0),
    w: label.width ?? 0,
    h: label.height ?? 0,
  };
}

/**
 * 摊平第一趟：绝对坐标累加（父 → 子逐层加），同时按层分出 lane（root 的直接子）与 chip（更深层）。
 * `placed` 恒含每个节点 id 的绝对盒与父链，供第二趟求边的参照系。
 */
function placeNodes(
  node: ElkNode,
  ox: number,
  oy: number,
  chain: readonly string[],
  placed: Map<string, Placed>,
  lanes: FlatLane[],
  nodes: FlatNode[],
): void {
  const x = ox + (node.x ?? 0);
  const y = oy + (node.y ?? 0);
  placed.set(node.id, { box: { x, y, w: node.width ?? 0, h: node.height ?? 0 }, chain });
  const childChain = [...chain, node.id];
  for (const child of node.children ?? []) {
    const cx = x + (child.x ?? 0);
    const cy = y + (child.y ?? 0);
    const box: FlatBox = { x: cx, y: cy, w: child.width ?? 0, h: child.height ?? 0 };
    if (chain.length === 0) {
      lanes.push({ id: child.id, projectId: child.id.slice(LANE_PREFIX.length), ...box, label: flatLabel(child.labels?.[0], cx, cy) });
    } else {
      nodes.push({ id: child.id, laneId: node.id, ...box });
    }
    placeNodes(child, x, y, childChain, placed, lanes, nodes);
  }
}

/**
 * 摊平第二趟：逐边定参照系并摊成绝对折线。
 *
 * **边的参照系 = 两端点的最低公共容器**（不是边对象所在的容器）—— `INCLUDE_CHILDREN` 下
 * ELK 把边路由在该公共容器里，`sections` 坐标即该容器的局部坐标：带内边相对其 lane、
 * 跨带边相对 root。按 `edge` 对象所在层加偏移会把带内边整体平移一个 lane 原点。
 */
function flatEdge(edge: ElkExtendedEdge, placed: Map<string, Placed>): FlatEdge {
  const from = nodeOfPort(edge.sources[0]);
  const to = nodeOfPort(edge.targets[0]);
  const source = placed.get(from);
  const target = placed.get(to);
  const frameId = commonContainer(source?.chain ?? [], target?.chain ?? []);
  const frame = frameId === undefined ? undefined : placed.get(frameId)?.box;
  const pts = flattenSections(edge.sections, frame?.x ?? 0, frame?.y ?? 0);
  return { id: edge.id, from, to, pts, dev: endpointDeviation(pts, source?.box, target?.box) };
}

/** 递归收边（本仓构造把全部边声明在 root 上；更深层的边同样被收到，序 = 遍历序）。 */
function collectEdges(node: ElkNode, placed: Map<string, Placed>, out: FlatEdge[]): void {
  for (const edge of node.edges ?? []) out.push(flatEdge(edge, placed));
  for (const child of node.children ?? []) collectEdges(child, placed, out);
}

/**
 * ELK 出参 → 绝对几何（纯函数，不求解）：两趟遍历 —— 第一趟累加绝对坐标并分出 lane / chip，
 * 第二趟按「两端点最低公共容器」把 `sections` 摊成去重后的绝对折线，并逐边自核端点偏差。
 *
 * - 数组序确定：lanes / nodes = 入参树的先序，edges = 声明序。
 * - `x` / `width` / `sections` 等 ELK 侧皆 optional，此处逐字段显式收窄为数值（缺 ⇒ 0 / 空折线），
 *   **不在此处判错、不回吐空图**（兜底面 = {@link layoutGraphGuarded}）。
 */
export function flatten(layoutRoot: ElkNode): FlatGraph {
  const placed = new Map<string, Placed>();
  const lanes: FlatLane[] = [];
  const nodes: FlatNode[] = [];
  placeNodes(layoutRoot, 0, 0, [], placed, lanes, nodes);
  const edges: FlatEdge[] = [];
  collectEdges(layoutRoot, placed, edges);
  return { width: layoutRoot.width ?? 0, height: layoutRoot.height ?? 0, lanes, nodes, edges };
}

/**
 * 本仓图 → 绝对几何：{@link buildElkGraph} + 一次 `elk.layout()`（单例 {@link elk}）+ {@link flatten}。
 *
 * - 入参契约与 {@link buildElkGraph} 完全一致（lane 序 / 组内序 / 边序由入参决定，本函数不重排）。
 * - **不做兜底**：ELK 抛错时原样上抛，由兜底面 {@link layoutGraphGuarded} 决定回吐空图；本函数不吞异常、不加提示。
 */
export async function layoutGraph(source: ElkGraphSource): Promise<FlatGraph> {
  const layouted = await elk.layout(buildElkGraph(source));
  return flatten(layouted);
}

// ---------------------------------------------------------------------------
// v0.10.7 N4（REQ-2026-10-15-01 · 改造文档 §2.4 兜底条）：catch 面 = 求解 / 摊平出错回吐空图信号
// ---------------------------------------------------------------------------

/** {@link layoutGraphGuarded} 出参 —— `flat === null` ⇔ `reason` 非空（任一环节抛错、已捕获）。 */
export interface GuardedLayout {
  /** 成功 = 绝对几何；出错 = null（调用侧回吐空图，不画任何节点 / 连线）。 */
  readonly flat: FlatGraph | null;
  /** 出错时的人读一句错因（入页内提示行）；成功 ⇒ null。 */
  readonly reason: string | null;
}

/**
 * {@link layoutGraph} 的**兜底面**（改造文档 §2.4 宿主裁定）：构造 / 求解 / 摊平任一环节抛错 ⇒
 * **不抛异常、不静默**，回 `{ flat: null, reason }` —— 调用侧（graph-view 的 async 出口）据此
 * 回吐空图 + 一行 `class="hint warn"` 提示，页面不 500。
 *
 * 正常路径逐字不变：同一单例 {@link elk}、同一 {@link flatten}、不改 {@link layoutGraph} 的上抛契约。
 * `solve` = 求解子步骤的注入面（缺省单例 {@link elk}），供测试注入**抛错桩**走真实 catch 面。
 */
export async function layoutGraphGuarded(
  source: ElkGraphSource,
  solve: (graph: ElkNode) => Promise<ElkNode> = (graph) => elk.layout(graph),
): Promise<GuardedLayout> {
  try {
    return { flat: flatten(await solve(buildElkGraph(source))), reason: null };
  } catch (err) {
    return { flat: null, reason: err instanceof Error ? err.message : String(err) };
  }
}
