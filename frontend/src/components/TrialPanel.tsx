"use client";

import { useEffect, useRef, useState } from "react";

import { Card, CardTitle } from "@/components/ui";

type Trial = { state: "running" | "finished"; label: string; result: number; time: number; memory: number; output: string; compileError: string; truncated: boolean };
async function request(path: string, body?: unknown) {
  const response = await fetch(`/api${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const data = await response.json().catch(() => ({ detail: "自测服务暂不可用" }));
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "自测请求失败");
  return data;
}

export function TrialPanel({ bid, pid, code, language, sampleInput, sampleOutput, disabled = false, className }: {
  bid: string; pid: string; code: string; language: string; sampleInput: string; sampleOutput: string; disabled?: boolean; className?: string;
}) {
  const input = sampleInput || "";
  const [result, setResult] = useState<Trial | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [runSource, setRunSource] = useState<{ code: string; language: string; input: string } | null>(null);
  const active = useRef(true);
  const posting = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => { active.current = true; return () => { active.current = false; clearTimeout(timer.current); }; }, []);
  const changed = runSource && (runSource.code !== code || runSource.language !== language || runSource.input !== input);

  async function poll(id: string, attempt = 0) {
    try {
      const next: Trial = await request(`/trials/${encodeURIComponent(id)}`);
      if (!active.current) return;
      setResult(next);
      if (next.state === "running" && attempt < 80) timer.current = setTimeout(() => { void poll(id, attempt + 1); }, 1000);
      else { setBusy(false); if (next.state === "running") setError("自测仍在队列中，可稍后刷新结果。"); }
    } catch (e) { if (active.current) { setError(e instanceof Error ? e.message : "读取结果失败"); setBusy(false); } }
  }
  async function run() {
    if (posting.current || busy || disabled || !code.trim()) return;
    if (new TextEncoder().encode(input).length > 16384) { setError("测例输入不能超过16KB。"); return; }
    posting.current = true; setBusy(true); setError(""); setResult(null); setRunId(null); clearTimeout(timer.current);
    setRunSource({ code, language, input });
    try {
      const data = await request(`/batches/${bid}/problems/${pid}/trials`, { code, language, input });
      if (!active.current) return;
      setRunId(data.runId); void poll(data.runId);
    } catch (e) { if (active.current) { setError(e instanceof Error ? e.message : "自测失败"); setBusy(false); } }
    finally { posting.current = false; }
  }

  return <Card as="section" aria-label="提交前自测" className={`trial-panel flex flex-col h-full overflow-hidden ${className || ""}`}>
    <CardTitle title="提交前自测" meta="不计入作业提交次数，固定使用题目样例验证逻辑。" />
    <div className="flex-1 overflow-y-auto min-h-0 space-y-4 pr-1">
      <div><h4 className="mb-2 text-meta font-medium">样例输入（stdin）</h4><pre aria-label="样例输入" className="trial-output">{input || "（空输入）"}</pre></div>
      <p className="text-meta text-fg-muted">自测固定使用题目提供的样例输入。</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="rounded-control border border-brand px-4 py-2 text-meta font-medium text-brand hover:bg-brand-soft disabled:opacity-40" disabled={busy || disabled || !code.trim()} onClick={() => void run()}>{busy ? "正在自测…" : "运行自测"}</button>
        <span className="text-meta text-fg-muted">不计入作业提交次数</span>
      </div>
      {disabled && <p className="text-meta text-fg-muted">历史课程只读，不能发起自测。</p>}
      {error && <div role="alert" className="text-sm text-danger">{error}{runId && !busy && <button type="button" className="ml-3 underline" onClick={() => { setError(""); setBusy(true); void poll(runId); }}>刷新自测结果</button>}</div>}
      {changed && result && <p className="text-meta text-warn">代码、语言或题目样例已修改，下面是上一次运行的结果。</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <div><h4 className="mb-2 text-meta font-medium">运行输出 / 错误信息</h4><pre aria-label="自测运行输出" className="trial-output">{result?.compileError || result?.output || (busy ? "等待运行结果…" : result?.state === "finished" ? "（无输出）" : "运行后显示结果")}</pre></div>
        <div><h4 className="mb-2 text-meta font-medium">题目样例输出（仅供对照）</h4><pre className="trial-output">{sampleOutput || "（未提供）"}</pre></div>
      </div>
      {result && <p role="status" className="text-meta text-fg-muted">{result.label} · {result.time} ms · {result.memory} KB{result.truncated ? " · 输出已截断" : ""}</p>}
      <p className="text-meta text-fg-muted">自测只运行题目样例，结束不代表正式判题通过。请检查输出，再提交作业。</p>
    </div>
  </Card>;
}
