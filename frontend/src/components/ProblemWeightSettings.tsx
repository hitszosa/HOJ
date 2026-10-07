"use client";

import { useEffect, useState } from "react";
import type { BatchDetail } from "@/api/generated/BatchDetail";
import { api } from "@/lib/api";
import { weightShare } from "@/lib/grading";
import { Button, Card, CardTitle } from "@/components/ui";

export function ProblemWeightSettings({ data, onSaved }: { data: BatchDetail; onSaved: (problems: BatchDetail["problems"]) => void }) {
  const [values, setValues] = useState(data.problems.map(p => String(p.score)));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => setValues(data.problems.map(p => String(p.score))), [data.problems]);
  const preview = data.problems.map((p, i) => ({ ...p, score: Number(values[i]) }));
  const valid = values.every(v => v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 999.99 && Math.abs(Number(v) * 100 - Math.round(Number(v) * 100)) < 0.000001)
    && preview.some(p => p.required && p.score > 0);
  const readOnly = data.offering.status === "archived";
  return <Card>
    <CardTitle title="题目权重与自动评分" meta="每次实验满分 100。按计分题权重占比自动给分；权重为 0 或选做题不计分。修改后会重新计算已有提交的成绩。" />
    <div className="overflow-auto my-4">
      <table className="w-full text-left"><thead><tr><th>题目</th><th>权重</th><th>分数占比</th></tr></thead>
        <tbody>{preview.map((p, i) => <tr key={p.problem_id}><td className="py-3 pr-3">{p.title}</td><td className="pr-3">
          <input aria-label={`${p.title} 权重`} type="number" min="0" max="999.99" step="0.01" disabled={readOnly || busy}
            className="w-28 rounded-control border border-line bg-surface px-3 py-2 text-fg"
            value={values[i]} onChange={e => setValues(values.map((v, n) => n === i ? e.target.value : v))} />
        </td><td>{valid ? `${weightShare(p, preview)}%` : "—"}{!p.required && " · 选做不计分"}</td></tr>)}</tbody>
      </table>
    </div>
    <p className="mb-3 text-meta text-fg-muted">例如权重 30 和 70：只 AC 第一题得 30 分，两题都 AC 得 100 分；同一道题重复 AC 不会重复加分。</p>
    {!valid && <p role="alert" className="mb-3 text-meta text-danger">请输入 0–999.99 的权重，最多两位小数，至少一道必做题权重大于 0。</p>}
    <Button disabled={readOnly || busy || !valid} onClick={async () => {
      setBusy(true); setMessage("");
      try {
        await api(`/batches/${data.batch.batch_id}`, "PATCH", { problem_weights: preview.map(p => ({ problem_id: p.problem_id, score: p.score })) });
        onSaved(preview);
        setMessage("权重已保存，已有提交的成绩已按新权重重新计算。");
      } catch (error) { setMessage(String(error).split("|").pop() || "权重保存失败"); }
      finally { setBusy(false); }
    }}>{busy ? "正在保存…" : "保存题目权重"}</Button>
    {message && <p role="status" className="mt-3 text-meta text-brand">{message}</p>}
  </Card>;
}
