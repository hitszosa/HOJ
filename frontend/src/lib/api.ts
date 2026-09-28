export async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({ detail: "服务暂时不可达" }));
  if (!response.ok) {
    throw new Error(
      `${response.status}|${typeof data.detail === "string" ? data.detail : "请求格式不正确"}`
    );
  }
  return data;
}
