"use client";

import Link from "next/link";
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

export function PublicProblemListView() {
  const [problems, setProblems] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const limit = 25;

  const loadProblems = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", String(limit));
      params.set("limit", String(limit));
      if (searchQuery.trim()) {
        params.set("keyword", searchQuery.trim());
        params.set("q", searchQuery.trim());
      }

      const res = await api(`/public-problems?${params.toString()}`);
      setProblems(res.items || res.problems || []);
      setTotal(res.total || 0);
    } catch (e) {
      setError(String(e).split("|").pop() || "加载公开题库失败");
    } finally {
      setLoading(false);
    }
  }, [page, limit, searchQuery]);

  useEffect(() => {
    loadProblems();
  }, [loadProblems]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setSearchQuery(keyword);
  };

  const totalPages = Math.ceil(total / limit) || 1;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">OPEN PRACTICE BANK</p>
          <h1 className="text-3xl font-semibold tracking-tight">开放练习题库</h1>
          <p className="mt-2 text-fg-muted">
            面向全校开放的算法与程序设计公开题库，支持日常自主刷题、练习积累与自我测评。
          </p>
        </div>
      </header>

      {/* Search Bar */}
      <Card>
        <form onSubmit={handleSearch} className="flex gap-3">
          <input
            type="text"
            placeholder="输入题目编号或题目标题关键词搜索…"
            className={fieldClass}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Button type="submit" variant="primary" disabled={loading}>
            搜索
          </Button>
          {searchQuery && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setKeyword("");
                setSearchQuery("");
                setPage(1);
              }}
            >
              重置
            </Button>
          )}
        </form>
      </Card>

      {/* Problems Table */}
      <Card>
        <CardTitle
          title={`题目列表 (共 ${total} 道题)`}
          meta={`第 ${page} / ${totalPages} 页`}
        />

        {error ? (
          <div className="py-4 text-center text-danger">{error}</div>
        ) : problems.length === 0 ? (
          <Empty
            title="未找到匹配的题目"
            hint={searchQuery ? "请尝试更换搜索词后再试。" : "题库目前尚无公开题目。"}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left zebra">
              <thead>
                <tr>
                  <th className="py-3 w-20">我的状态</th>
                  <th className="w-24">编号</th>
                  <th>题目名称</th>
                  <th>通过 / 提交</th>
                  <th className="w-36">通过率</th>
                  <th>资源限制</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {problems.map((p) => {
                  const pid = p.problemId ?? p.problem_id;
                  const passRateVal = Number(p.passRate ?? p.pass_rate) || 0;
                  const passRatePct = passRateVal <= 1 ? Math.round(passRateVal * 100) : Math.round(passRateVal);
                  const status = p.solvedStatus || p.my_status;
                  const timeLimit = p.timeLimit ?? p.time_limit;
                  const memoryLimit = p.memoryLimit ?? p.memory_limit;
                  return (
                    <tr key={pid} className="border-t border-line">
                      <td className="py-3">
                        {status === "passed" || status === "accepted" ? (
                          <Badge tone="ok">已通过</Badge>
                        ) : status === "tried" || status === "attempted" ? (
                          <Badge tone="warn">尝试中</Badge>
                        ) : (
                          <Badge tone="neutral">未尝试</Badge>
                        )}
                      </td>
                      <td className="font-mono text-meta text-fg-muted">#{pid}</td>
                      <td>
                        <Link
                          href={`/student/problems/${pid}`}
                          className="font-medium text-fg hover:text-brand hover:underline transition-colors"
                        >
                          {p.title}
                        </Link>
                      </td>
                      <td className="text-meta text-fg">
                        <span className="text-ok font-medium">{p.accepted}</span>
                        <span className="text-fg-subtle"> / {p.submit}</span>
                      </td>
                      <td>
                        <div className="space-y-1">
                          <span className="text-meta text-fg-muted">{passRatePct}%</span>
                          <Progress
                            value={passRatePct}
                            tone={passRatePct > 50 ? "ok" : "brand"}
                          />
                        </div>
                      </td>
                      <td className="text-meta text-fg-muted font-mono whitespace-nowrap">
                        {timeLimit}s / {memoryLimit}MB
                      </td>
                      <td>
                        <Link
                          href={`/student/problems/${pid}`}
                          className="text-meta font-medium text-brand hover:underline"
                        >
                          开始解题 →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
            <span className="text-meta text-fg-muted">
              显示 {(page - 1) * limit + 1} - {Math.min(page * limit, total)} 共 {total} 道
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                上一页
              </Button>
              <Button
                variant="secondary"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                下一页
              </Button>
            </div>
          </div>
        )}
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
        <Empty title={error || "题目不存在"} hint="请核对题目编号或返回题库浏览。" />
        <Link href="/student/problems" className={actionClass}>
          返回公开题库
        </Link>
      </div>
    );
  }

  const problemId = problem.problemId ?? problem.problem_id;
  const timeLimit = problem.timeLimit ?? problem.time_limit;
  const memoryLimit = problem.memoryLimit ?? problem.memory_limit;
  const sampleInput = problem.sampleInput ?? problem.sample_input;
  const sampleOutput = problem.sampleOutput ?? problem.sample_output;
  const passRateVal = Number(problem.passRate ?? problem.pass_rate) || 0;
  const passRatePct = passRateVal <= 1 ? Math.round(passRateVal * 100) : Math.round(passRateVal);

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Link
              href="/student/problems"
              className="text-meta text-brand hover:underline"
            >
              ← 返回公开题库
            </Link>
            <span className="text-fg-subtle">/</span>
            <span className="text-meta text-fg-muted">自主练习</span>
          </div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            #{problemId} · {problem.title}
          </h1>
          <p className="mt-2 text-meta text-fg-muted">
            时间限制: {timeLimit} 秒 · 内存限制: {memoryLimit} MB · 通过率:{" "}
            {passRatePct}% ({problem.accepted}/{problem.submit})
          </p>
        </div>
        <div>
          <Link
            href={`/student/status?problemId=${problemId}`}
            className="text-meta text-brand hover:underline"
          >
            查看本题全站提交记录 ↗
          </Link>
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
