/**
 * contextId ↔ ACP sessionId 会话映射持久化（REQ-v0.8.0-2026-09-19-01 · 节点 B5）。
 *
 * 落点：`<baseDir>/.a2a/acp-sessions/<projectId>.json`（与 `.a2a/children`、`.a2a/outbox`
 * 同族，machine 运行态产物）。**原子写** = 临时文件 + `rename` 覆盖，避免半写文件。
 * 同步 fs ⇒ 单进程内写天然串行（满足「同进程内串行即可」）。
 *
 * **零仓内依赖**：不 import `launcher/**` / `orch/**`；文件系统与时钟经构造注入，便于单测。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 单条映射记录。 */
export interface SessionMapEntry {
  sessionId: string;
  /** 最近写入时刻（UTC ISO 8601） */
  updatedAt: string;
}

/** 可注入文件系统（缺省 `createNodeSessionMapFs()`）。 */
export interface SessionMapFs {
  /** 读取文本；文件不存在 / 不可读返回 `null`（不抛出）。 */
  readText(path: string): string | null;
  writeText(path: string, data: string): void;
  /** 原子覆盖：`from` → `to`。 */
  rename(from: string, to: string): void;
  mkdirp(dir: string): void;
}

/** 缺省文件系统实现（`node:fs` 同步 API）。 */
export function createNodeSessionMapFs(): SessionMapFs {
  return {
    readText(path: string): string | null {
      try {
        return readFileSync(path, "utf8");
      } catch {
        // 文件缺失 / 不可读：视为空映射
        return null;
      }
    },
    writeText(path: string, data: string): void {
      writeFileSync(path, data, "utf8");
    },
    rename(from: string, to: string): void {
      renameSync(from, to);
    },
    mkdirp(dir: string): void {
      mkdirSync(dir, { recursive: true });
    },
  };
}

export interface SessionMapOptions {
  projectId: string;
  /** machine 根目录；`.a2a/acp-sessions` 建于其下。 */
  baseDir: string;
  fs?: SessionMapFs;
  now?: () => Date;
  logger?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 内存映射 + 写穿（每次变更原子落盘）。构造时**启动加载**（损坏文件容错：忽略并以空映射继续）。
 */
export class SessionMap {
  private readonly entries = new Map<string, SessionMapEntry>();
  private readonly filePath: string;
  private readonly fs: SessionMapFs;
  private readonly now: () => Date;
  private readonly logger: (message: string) => void;
  private tmpCounter = 0;

  constructor(options: SessionMapOptions) {
    this.fs = options.fs ?? createNodeSessionMapFs();
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? ((): void => undefined);
    this.filePath = join(options.baseDir, ".a2a", "acp-sessions", `${options.projectId}.json`);
    this.load();
  }

  /** 持久化文件绝对路径。 */
  path(): string {
    return this.filePath;
  }

  /** 取 contextId 对应的 ACP sessionId；无则 `null`。 */
  get(contextId: string): string | null {
    return this.entries.get(contextId)?.sessionId ?? null;
  }

  /** 写入映射并原子落盘。 */
  set(contextId: string, sessionId: string): void {
    this.entries.set(contextId, { sessionId, updatedAt: this.now().toISOString() });
    this.persist();
  }

  /** 删除映射并落盘（无该键则不动）。 */
  delete(contextId: string): void {
    if (this.entries.delete(contextId)) this.persist();
  }

  /** 映射条数（观测 / 单测）。 */
  size(): number {
    return this.entries.size;
  }

  /** 启动加载：文件缺失 → 空；损坏 / 顶层非对象 → 记日志并以空映射继续。 */
  private load(): void {
    const raw = this.fs.readText(this.filePath);
    if (raw === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger(`[acp-session-map] 文件损坏，忽略并重建：${this.filePath}`);
      return;
    }
    if (!isRecord(parsed)) {
      this.logger(`[acp-session-map] 顶层非对象，忽略并重建：${this.filePath}`);
      return;
    }
    for (const [contextId, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue;
      const sessionId = value["sessionId"];
      if (typeof sessionId !== "string" || sessionId.length === 0) continue;
      const updatedAt =
        typeof value["updatedAt"] === "string" ? value["updatedAt"] : this.now().toISOString();
      this.entries.set(contextId, { sessionId, updatedAt });
    }
  }

  /** 原子落盘：先写临时文件，再 rename 覆盖。失败只记日志（不抛）。 */
  private persist(): void {
    const data: Record<string, SessionMapEntry> = {};
    for (const [contextId, entry] of this.entries) data[contextId] = entry;
    const json = `${JSON.stringify(data, null, 2)}\n`;
    this.tmpCounter += 1;
    const tmp = `${this.filePath}.tmp-${String(process.pid)}-${String(this.tmpCounter)}`;
    try {
      this.fs.mkdirp(dirname(this.filePath));
      this.fs.writeText(tmp, json);
      this.fs.rename(tmp, this.filePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger(`[acp-session-map] 落盘失败：${message}`);
    }
  }
}
