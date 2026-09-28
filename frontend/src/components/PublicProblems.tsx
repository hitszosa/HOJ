"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { Badge, Button, Card, CardTitle, Empty, Progress } from "@/components/ui";
import { CodeEditor } from "@/components/CodeEditor";
import { api } from "@/lib/api";
import { draftStorageKey } from "@/lib/routes";
import { MarkdownView } from "@/components/MarkdownView";
import { JudgeDetailView } from "@/components/JudgeDetailView";

type Row = Record<string, any>;

const fieldClass =
  "w-full rounded-control border border-line bg-surface px-3 py-2 text-body text-fg focus:outline-none focus:ring-2 focus:ring-brand";
const actionClass =
  "inline-flex rounded-control bg-brand px-4 py-2 text-meta font-medium text-brand-fg hover:opacity-90 transition";

function getVerdictTone(result: number): "ok" | "warn" | "danger" | "brand" | "neutral" {
  if (result === 4) return "ok";
  if ([0, 1, 2, 3, 14].includes(result)) return "brand";
  if ([10, 11].includes(result)) return "danger";
  if ([5, 6, 7, 8, 9].includes(result)) return "warn";
  return "neutral";
}

function getDifficultyTone(diff: string): "ok" | "brand" | "warn" | "danger" | "neutral" {
  if (!diff) return "neutral";
  if (diff.startsWith("L1") || diff.includes("入门")) return "ok";
  if (diff.startsWith("L2") || diff.includes("基础")) return "brand";
  if (diff.startsWith("L3") || diff.includes("进阶")) return "warn";
  if (diff.startsWith("L4") || diff.includes("综合")) return "danger";
  return "neutral";
}

export function PublicProblemListView() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/student/categories");
  }, [router]);

  return (
    <div className="mx-auto max-w-xl py-20 text-center">
      <Card>
        <CardTitle title="开放题库已全面升级" meta="已整合至算法题库" />
        <Empty
          title="正在为您跳转至算法题库"
          hint="平台现已全面升级为包含 5 大知识支柱、48 个算法专题与 2,148 道试题的标准算法题库。"
        />
        <div className="mt-6">
          <Link href="/student/categories" className={actionClass}>
            立即进入算法题库 →
          </Link>
        </div>
      </Card>
    </div>
  );
}

export function PublicProblemWorkspace({ pid, user }: { pid: string; user: string }) {
  const [problem, setProblem] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [code, setCode] = useState("");
  const [lang, setLang] = useState("python");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [sid, setSid] = useState<number | null>(null);
  const [result, setResult] = useState<Row | null>(null);
  const [copiedSample, setCopiedSample] = useState(false);

  // Load problem details and restore draft
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");

    // Restore draft from local storage
    if (typeof localStorage !== "undefined") {
      const saved = localStorage.getItem(draftStorageKey(user, "public", pid));
      if (saved) setCode(saved);
    }

    api(`/public-problems/${pid}`)
      .then((data) => {
        if (active) setProblem(data);
      })
      .catch((e) => {
        if (active) setError(String(e).split("|").pop() || "题目加载失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [pid, user]);

  const handleCodeChange = (next: string) => {
    setCode(next);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(draftStorageKey(user, "public", pid), next);
    }
  };

  // Poll submission result
  useEffect(() => {
    if (!sid) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;

    const poll = async () => {
      try {
        const r = await api(`/submissions/${sid}`);
        if (!active) return;
        setResult(r);
        // Result codes: 0-等待, 1-等待重测, 2-编译中, 3-评测中, 14-队列中
        if ([0, 1, 2, 3, 14].includes(Number(r.result)) && attempts++ < 60) {
          timer = setTimeout(poll, 1500);
        } else {
          setSubmitting(false);
          if (attempts >= 60) setSubmitError("判题排队较久，可前往评测状态查看最终结果。");
        }
      } catch (e) {
        if (active) {
          setSubmitError(String(e).split("|").pop() || "读取判题结果失败");
          setSubmitting(false);
        }
      }
    };

    poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [sid]);

  const handleSubmit = async () => {
    if (!code.trim()) {
      setSubmitError("代码内容不能为空");
      return;
    }
    setSubmitting(true);
    setSubmitError("");
    setResult(null);

    try {
      const res = await api(`/public-problems/${pid}/submissions`, "POST", {
        code,
        language: lang,
      });
      setSid(res.submissionId);
    } catch (e) {
      setSubmitError(String(e).split("|").pop() || "提交失败");
      setSubmitting(false);
    }
  };

  const copySample = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSample(true);
    setTimeout(() => setCopiedSample(false), 2000);
  };

  if (loading) {
    return <p className="py-20 text-center text-fg-muted">正在加载题目内容…</p>;
  }

  if (error || !problem) {
    return (
      <div className="space-y-4">
        <Empty title={error || "题目不存在"} hint="请核对题目编号或返回算法题库浏览。" />
        <Link href="/student/categories" className={actionClass}>
          返回算法题库
        </Link>
      </div>
    );
  }

  const problemId = problem.slug || problem.problemId || problem.problem_id;
  const timeLimit = problem.timeLimit ?? problem.time_limit;
  const memoryLimit = problem.memoryLimit ?? problem.memory_limit;
  const sampleInput = problem.sampleInput ?? problem.sample_input;
  const sampleOutput = problem.sampleOutput ?? problem.sample_output;
  const passRateVal = Number(problem.passRate ?? problem.pass_rate) || 0;
  const passRatePct = passRateVal <= 1 ? Math.round(passRateVal * 100) : Math.round(passRateVal);

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
        <div>
          <div className="flex items-center gap-2">
            <Link
              href="/student/categories"
              className="text-meta text-brand hover:underline inline-flex items-center gap-1 font-medium"
            >
              ← 返回算法题库
            </Link>
            <span className="text-fg-subtle">/</span>
            <span className="text-meta text-fg-muted">算法解题工作台</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2.5">
            {problem.difficulty && (
              <Badge tone={getDifficultyTone(problem.difficulty)}>
                {problem.difficulty}
              </Badge>
            )}
            {problem.solvedStatus === "passed" && (
              <Badge tone="ok">✓ 已完成</Badge>
            )}
            {problem.solvedStatus === "tried" && (
              <Badge tone="warn">尝试中</Badge>
            )}
            <h1 className="text-2xl lg:text-3xl font-semibold tracking-tight text-fg">
              {problem.title}
            </h1>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-meta text-fg-muted">
            {problem.categoryName && (
              <span className="rounded-control bg-surface-muted px-2 py-0.5 text-xs text-fg-muted">
                {problem.categoryName}
              </span>
            )}
            {problem.provenance && (
              <span className="rounded-control bg-surface-muted px-2 py-0.5 text-xs text-fg-muted">
                来源: {problem.provenance}
              </span>
            )}
            {(problem.tags || []).slice(0, 3).map((tag: string) => (
              <span key={tag} className="rounded-control bg-surface-muted px-2 py-0.5 text-xs text-fg-muted">
                #{tag}
              </span>
            ))}
            <span>时间限制: {timeLimit} 秒</span>
            <span>·</span>
            <span>内存限制: {memoryLimit} MB</span>
            {problem.submit > 0 && (
              <>
                <span>·</span>
                <span>通过率: {passRatePct}% ({problem.accepted}/{problem.submit})</span>
              </>
            )}
          </div>
        </div>
        <div>
          {problem.numericPid && (
            <Link
              href={`/student/status?problemId=${problem.numericPid}`}
              className="text-meta text-brand hover:underline"
            >
              查看本题评测记录 ↗
            </Link>
          )}
        </div>
      </header>

      {/* Main Two-Column Layout */}
      <div className="grid items-start gap-stack lg:grid-cols-2">
        {/* Left: Problem Statement */}
        <div className="space-y-stack">
          <Card>
            <CardTitle title="题目描述" />
            <MarkdownView content={problem.description} placeholder="暂无描述" />

            {problem.input && (
              <>
                <h3 className="mt-6 font-semibold text-fg">输入说明</h3>
                <div className="mt-2 whitespace-pre-wrap leading-relaxed text-fg-muted">
                  {problem.input}
                </div>
              </>
            )}

            {problem.output && (
              <>
                <h3 className="mt-6 font-semibold text-fg">输出说明</h3>
                <div className="mt-2 whitespace-pre-wrap leading-relaxed text-fg-muted">
                  {problem.output}
                </div>
              </>
            )}

            {sampleInput && (
              <>
                <div className="mt-6 flex items-center justify-between">
                  <h3 className="font-semibold text-fg">样例输入</h3>
                  <Button
                    variant="ghost"
                    onClick={() => copySample(sampleInput)}
                  >
                    {copiedSample ? "已复制" : "复制样例"}
                  </Button>
                </div>
                <pre className="sample mt-2">{sampleInput}</pre>
              </>
            )}

            {sampleOutput && (
              <>
                <h3 className="mt-4 font-semibold text-fg">样例输出</h3>
                <pre className="sample mt-2">{sampleOutput}</pre>
              </>
            )}

            {problem.hint && (
              <>
                <h3 className="mt-6 font-semibold text-fg">提示与数据范围</h3>
                <div className="mt-2 rounded-control border border-line bg-surface-muted p-3 text-meta text-fg-muted whitespace-pre-wrap">
                  {problem.hint}
                </div>
              </>
            )}
          </Card>
        </div>

        {/* Right: Code Editor & Submission */}
        <div className="space-y-stack">
          <Card>
            <CardTitle
              title="编写代码"
              meta="支持 Python、C、C++、Java。代码自动保存在本地浏览器草稿中。"
            />

            <div className="my-3">
              <label className="block text-meta text-fg-muted mb-1">选择编程语言</label>
              <select
                className={fieldClass}
                value={lang}
                onChange={(e) => setLang(e.target.value)}
              >
                <option value="python">Python 3</option>
                <option value="cpp">C++ (g++ 17)</option>
                <option value="c">C (gcc 11)</option>
                <option value="java">Java (OpenJDK 11)</option>
              </select>
            </div>

            <CodeEditor
              value={code}
              language={lang}
              onChange={handleCodeChange}
            />

            <div className="mt-4 flex items-center justify-between">
              <button
                type="button"
                className={`${actionClass} disabled:opacity-40`}
                disabled={submitting}
                onClick={handleSubmit}
              >
                {submitting ? "正在判题中…" : "提交评测"}
              </button>
              <span className="text-meta text-fg-muted">
                {submitting ? "系统正在执行沙箱测试…" : "评测结果由后台实时判定"}
              </span>
            </div>

            {submitError && (
              <div className="mt-3 rounded-control bg-danger-soft p-3 text-danger">
                {submitError}
              </div>
            )}

            {/* Verdict Result */}
            {result && (
              <div className="mt-4 border-t border-line pt-4 space-y-3">
                {String(result.result) === "4" && (
                  <div className="rounded-control bg-ok-soft p-4 border border-ok/30 flex items-center gap-3">
                    <span className="text-2xl">🎉</span>
                    <div>
                      <h4 className="text-sm font-semibold text-ok">恭喜！本题已完全通过评测 (Accepted)！</h4>
                      <p className="text-xs text-fg-muted mt-0.5">该题已记录至您的做题历史中，可随时返回算法题库继续挑战其他试题。</p>
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <Badge tone={getVerdictTone(Number(result.result))}>
                    #{sid} · {result.label}
                  </Badge>
                  <span className="text-meta text-fg-muted font-mono">
                    {result.time} ms · {result.memory} KB
                  </span>
                </div>

                {result.error && (
                  <div className="mt-4">
                    <JudgeDetailView error={result.error} />
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
