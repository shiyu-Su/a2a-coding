/**
 * 内置轻量分析 Agent 的 **LLM 通路唯一 IO 口**（v0.11.0 N2）。
 *
 * 冻结口径（宿主裁定 U1，本节点**不可改**）：写死 `opencode go` 一型通路 —— chat 模式、
 * 模型 `deepseek-v4.1-flash`、端点 loopback `:9355`；多端点 / 多模型的方案设计归 R1.5。
 * 缺省常量落在 `config.ts` 的 `llm` 段，该段可配**只为离线注入留门**。三条硬边界：
 * **零重试**（失败只出一条结构化结果交调用方记账，不抛错中断合成循环）、**零 SDK**
 * （只用 Node 内置 `fetch`）、**非流式**（`stream: false`）。
 *
 * ⚠ 与任务卡签名 `complete(prompt): Promise<string>` 的**有意偏离**：判据 3 要求「失败返回
 * 结构化错误且不抛到调用方」，而 `Promise<string>` 承载不了失败通道（要么抛、要么把原因
 * 塞进正文污染解析）⇒ 本口返回 {@link LlmOutcome} 判别联合，`ok` 分支才是文本；
 * 注入点 {@link LlmClient} 随之同形（N3 的假实现只需还 `{ ok: true, text }`）。
 */
import type { LlmConfig } from "../types.js";

/**
 * 失败分类（与判据 3 三类一一对应；进留痕面供板 / 宿主读一句原因）：
 * `network` = fetch 本身炸（DNS / 拒连 / 连接重置）或墙钟到点 · `http_status` = 非 2xx
 * · `parse` = 响应体 JSON 不可解析，或不是 `{ choices[].message.content }` 形状。
 */
export type LlmFailureKind = "network" | "http_status" | "parse";

/** 一次请求的结果：成功 = 完整文本；失败 = 分类 + 一句可读原因（**恒不抛**） */
export type LlmOutcome =
  | { ok: true; text: string }
  | { ok: false; kind: LlmFailureKind; reason: string };

/** 合成循环（N3）依赖的**注入接口**：真实现 = {@link createLlmClient}，测试 = 假对象 */
export interface LlmClient {
  complete(prompt: string): Promise<LlmOutcome>;
}

/** 可注入 fetch（缺省 = 进程内置 `globalThis.fetch`；测试传替身 ⇒ 全程零真实网络） */
export type LlmFetch = typeof globalThis.fetch;

export interface LlmClientOptions {
  fetchImpl?: LlmFetch;
}

/** `baseUrl` 去尾斜杠后拼 chat 端点（配 `…/v1` 与 `…/v1/` 同解） */
function completionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/** 网络失败的一句话原因（`AbortSignal.timeout` 到点报 TimeoutError，与普通 fetch 异常分别措辞） */
function networkReason(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  const detail = err instanceof Error ? err.message : String(err);
  return name === "TimeoutError" || name === "AbortError"
    ? `LLM 请求超时或被中止（${name}）：${detail}`
    : `LLM 网络请求失败：${detail}`;
}

/** 取 OpenAI 兼容形态的第一条 choice 正文；取不到 ⇒ `null`（调用方归 `parse`，不做宽松兜底） */
function extractText(payload: unknown): string | null {
  const shape = payload as { choices?: { message?: { content?: unknown } }[] } | null;
  const content = shape?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : null;
}

/**
 * 按 `llm` 配置构造真实 client：单次 `POST …/chat/completions`（`stream:false` +
 * `max_tokens` 上限 + `AbortSignal.timeout(timeoutMs)` 墙钟）；三类失败按
 * {@link LlmOutcome} 结构化返回，**不重试、不抛**。
 */
export function createLlmClient(config: LlmConfig, options: LlmClientOptions = {}): LlmClient {
  const url = completionsUrl(config.baseUrl);
  const doFetch: LlmFetch = options.fetchImpl ?? globalThis.fetch;
  // 凭据可选：trim 后非空才发 Authorization；未配置 ⇒ 请求头与补凭据前逐字等价。
  // 值只出现在这一处（请求头），禁止进 log / 失败原因 / 任何回显面。
  const apiKey = config.apiKey?.trim();
  const headers: Record<string, string> = apiKey
    ? { "content-type": "application/json", authorization: `Bearer ${apiKey}` }
    : { "content-type": "application/json" };
  return {
    async complete(prompt: string): Promise<LlmOutcome> {
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: config.model,
            messages: [{ role: "user", content: prompt }],
            stream: false,
            max_tokens: config.maxTokens,
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (err) {
        return { ok: false, kind: "network", reason: networkReason(err) };
      }
      if (!response.ok) {
        return {
          ok: false,
          kind: "http_status",
          reason: `LLM 端点返回非 2xx：HTTP ${response.status}（url=${url}，model=${config.model}）`,
        };
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { ok: false, kind: "parse", reason: `LLM 响应体 JSON 不可解析：${detail}` };
      }
      const text = extractText(payload);
      return text === null
        ? { ok: false, kind: "parse", reason: "LLM 响应缺少 choices[0].message.content（字符串正文）" }
        : { ok: true, text };
    },
  };
}
