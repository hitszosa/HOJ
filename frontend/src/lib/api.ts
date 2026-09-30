import type { ApiResponse } from "@/api/generated/ApiResponse";

/** 后端错误：status 为 HTTP 状态码，code 为稳定错误码（如 NOT_FOUND），message 为可直接展示的中文提示。 */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public data: unknown = null) {
    // 保留 "状态码|提示" 的旧格式，已有的错误展示逻辑按 "|" 拆分。
    super(`${status}|${message}`);
    this.name = "ApiError";
  }
  /** 去掉状态码前缀的提示文本。 */
  get text() {
    return this.message.slice(this.message.indexOf("|") + 1);
  }
}

/**
 * 调用后端接口并解开 `{code, message, data}` 信封，返回 data。
 * 响应类型来自 `@/api/generated`（由 Rust 后端 ts-rs 生成）：`api<BatchDetail>(\`/batches/${bid}\`)`。
 */
export async function api<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "服务暂时不可达");
  }
  const envelope = (await response.json().catch(() => null)) as ApiResponse<T> | null;
  if (!envelope || typeof envelope.code !== "string") {
    throw new ApiError(response.status, "BAD_RESPONSE", response.ok ? "服务返回格式不正确" : "服务暂时不可达");
  }
  if (!response.ok || envelope.code !== "OK") {
    throw new ApiError(response.status, envelope.code, envelope.message || "请求失败", envelope.data);
  }
  return envelope.data;
}

/** 拼查询串，忽略 undefined / null / 空串。 */
export function qs(params: Record<string, string | number | boolean | null | undefined>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  const text = s.toString();
  return text ? `?${text}` : "";
}
