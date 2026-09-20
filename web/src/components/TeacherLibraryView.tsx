"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge, Button, Card, CardTitle, Empty, Stat } from "@/components/ui";
import { api } from "@/lib/api";

type ProblemItem = {
  slug: string;
  title: string;
  statement: string;
  knowledge: string[];
  difficulty: string;
  samples: { input: string; output: string }[];
  samplesCount: number;
  testsCount: number;
  draftId: string;
  draftTitle: string;
  origin: string;
  updatedAt: string;
};

type SetItem = {
  draftId: string;
  offeringId: number | null;
  title: string;
  status: "draft" | "published";
  origin: "teacher" | "ai";
  batchId: number | null;
  updatedAt: string;
  count: number;
  problems: ProblemItem[];
  courseCode?: string;
  courseName?: string;
  offeringTerm?: string;
  offeringSection?: string;
  offeringTitle?: string;
};

type OfferingItem = {
  offering_id: number;
  code: string;
  name: string;
  term: string;
  section: string;
  status: string;
  title?: string;
};

const AVAILABLE_LANGUAGES = [
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "java", label: "Java" },
  { id: "python", label: "Python 3" },
];

export function TeacherLibraryView({ portal, user }: { portal: "teacher" | "student" | null; user?: string }) {
  const [data, setData] = useState<{
    sets: SetItem[];
    problems: ProblemItem[];
    offerings: OfferingItem[];
    stats: {
      totalSets: number;
      totalProblems: number;
      aiSets: number;
      teacherSets: number;
      publishedSets: number;
    };
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [activeTab, setActiveTab] = useState<"sets" | "problems" | "ai" | "import">("sets");
  const [searchFilter, setSearchFilter] = useState("");
  const [originFilter, setOriginFilter] = useState<"ALL" | "teacher" | "ai">("ALL");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "draft" | "published">("ALL");

  const [expandedDraftId, setExpandedDraftId] = useState<string | null>(null);
  const [expandedProblemKey, setExpandedProblemKey] = useState<string | null>(null);

  // New Blank Set Modal
  const [showNewSetModal, setShowNewSetModal] = useState(false);
  const [newSetTitle, setNewSetTitle] = useState("");
  const [creatingSet, setCreatingSet] = useState(false);

  // Deploy Modal
  const [deployDraft, setDeployDraft] = useState<SetItem | null>(null);
  const [selectedOfferingIds, setSelectedOfferingIds] = useState<number[]>([]);
  const [deployDueDate, setDeployDueDate] = useState("");
  const [deployAiEnabled, setDeployAiEnabled] = useState(true);
  const [deployAllowedLanguages, setDeployAllowedLanguages] = useState<string[]>(["c", "cpp", "java", "python"]);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<any | null>(null);

  // In-page AI Generator state
  const [aiTopic, setAiTopic] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

  // In-page Import state
  const [importContent, setImportContent] = useState("");
  const [importBusy, setImportBusy] = useState(false);

  const [actionMsg, setActionMsg] = useState("");

  const loadLibrary = () => {
    setLoading(true);
    setError("");
    api("/teacher/library")
      .then((res) => {
        setData(res);
        setLoading(false);
      })
      .catch((err) => {
        setError(String(err).split("|").pop() || "加载个人题库失败");
        setLoading(false);
      });
  };

  useEffect(() => {
    loadLibrary();
  }, []);

  const handleCreateBlankSet = async () => {
    if (!newSetTitle.trim()) return;
    setCreatingSet(true);
    try {
      const res = await api("/teacher/library/sets", "POST", {
        title: newSetTitle.trim(),
      });
      setShowNewSetModal(false);
      setNewSetTitle("");
      loadLibrary();
      window.location.href = `/teacher/drafts/${res.id}`;
    } catch (e) {
      setError(String(e).split("|").pop() || "创建题单失败");
    } finally {
      setCreatingSet(false);
    }
  };

  const handleCreateAiSet = async () => {
    if (!aiTopic.trim()) return;
    setAiBusy(true);
    setError("");
    try {
      const res = await api("/teacher/library/sets", "POST", {
        topic: aiTopic.trim(),
      });
      setAiTopic("");
      loadLibrary();
      window.location.href = `/teacher/drafts/${res.id}`;
    } catch (e) {
      setError(String(e).split("|").pop() || "AI 出题失败");
    } finally {
      setAiBusy(false);
    }
  };

  const handleImportSet = async () => {
    if (!importContent.trim()) return;
    setImportBusy(true);
    setError("");
    try {
      const res = await api("/teacher/library/sets", "POST", {
        content: importContent.trim(),
      });
      setImportContent("");
      loadLibrary();
      window.location.href = `/teacher/drafts/${res.id}`;
    } catch (e) {
      setError(String(e).split("|").pop() || "导入题单失败");
    } finally {
      setImportBusy(false);
    }
  };

  const handleDeleteDraft = async (draftId: string, title: string) => {
    if (!window.confirm(`确定要从个人题库中删除题单「${title}」吗？`)) return;
    try {
      await api(`/drafts/${draftId}`, "DELETE");
      setActionMsg(`已成功删除题单「${title}」`);
      loadLibrary();
      setTimeout(() => setActionMsg(""), 3000);
    } catch (e) {
      alert(String(e).split("|").pop() || "删除失败");
    }
  };

  const openDeployModal = (item: SetItem) => {
    setDeployDraft(item);
    setDeployResult(null);
    if (data?.offerings && data.offerings.length > 0) {
      if (item.offeringId && data.offerings.some((o) => o.offering_id === item.offeringId)) {
        setSelectedOfferingIds([item.offeringId]);
      } else {
        setSelectedOfferingIds([data.offerings[0].offering_id]);
      }
    }
  };

  const handleDeploy = async () => {
    if (!deployDraft || selectedOfferingIds.length === 0) return;
    setDeploying(true);
    setError("");
    try {
      const res = await api("/teacher/library/deploy", "POST", {
        draftId: deployDraft.draftId,
        offeringIds: selectedOfferingIds,
        dueAt: deployDueDate || undefined,
        aiEnabled: deployAiEnabled,
        allowedLanguages: deployAllowedLanguages,
      });
      setDeployResult(res);
      loadLibrary();
    } catch (e) {
      setError(String(e).split("|").pop() || "发布到教学班失败");
    } finally {
      setDeploying(false);
    }
  };

  const handleDownloadYaml = (item: SetItem) => {
    const yamlStr = `title: ${JSON.stringify(item.title)}
problems:
${item.problems
  .map(
    (p) => `  - slug: ${p.slug}
    title: ${JSON.stringify(p.title)}
    statement: ${JSON.stringify(p.statement)}
    knowledge: [${(p.knowledge || []).map((k) => JSON.stringify(k)).join(", ")}]
    samples:
${(p.samples || []).map((s) => `      - input: ${JSON.stringify(s.input)}\n        output: ${JSON.stringify(s.output)}`).join("\n")}
`,
  )
  .join("\n")}`;

    const blob = new Blob([yamlStr], { type: "text/yaml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${item.title || "problem-set"}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="py-24 text-center text-fg-muted">
        <p className="text-lg">正在加载您的个人题库与题单数据…</p>
      </div>
    );
  }

  const sets = data?.sets || [];
  const problems = data?.problems || [];
  const stats = data?.stats || { totalSets: 0, totalProblems: 0, aiSets: 0, teacherSets: 0, publishedSets: 0 };

  const filteredSets = sets.filter((s) => {
    if (originFilter !== "ALL" && s.origin !== originFilter) return false;
    if (statusFilter !== "ALL" && s.status !== statusFilter) return false;
    if (searchFilter.trim()) {
      const q = searchFilter.toLowerCase();
      const inTitle = s.title.toLowerCase().includes(q);
      const inProb = s.problems.some((p) => p.title.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q));
      if (!inTitle && !inProb) return false;
    }
    return true;
  });

  const filteredProblems = problems.filter((p) => {
    if (originFilter !== "ALL" && p.origin !== originFilter) return false;
    if (searchFilter.trim()) {
      const q = searchFilter.toLowerCase();
      const match =
        p.title.toLowerCase().includes(q) ||
        p.slug.toLowerCase().includes(q) ||
        p.statement.toLowerCase().includes(q) ||
        p.knowledge.some((k) => k.toLowerCase().includes(q));
      if (!match) return false;
    }
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-brand/10 px-2 py-0.5 text-xs font-semibold text-brand">
              TEACHER QUESTION BANK & PROBLEM SETS
            </span>
            <span className="text-meta text-fg-muted">教师个人沉淀 · 独立于学期 · 一键跨班分发</span>
          </div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-fg">我的题库与题单</h1>
          <p className="mt-2 text-sm text-fg-muted leading-relaxed max-w-3xl">
            教师专属的题目资产中心。无论是自编题目、AI 辅助出题还是外部导入的试题，均永久沉淀于此。支持随时在线修改测试点，并可一键批量布置到当前任课教学班。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => setShowNewSetModal(true)}>
            ✏️ 新建题单
          </Button>
          <Button variant="secondary" onClick={() => setActiveTab("ai")}>
            🤖 AI 出题
          </Button>
          <Button variant="secondary" onClick={() => setActiveTab("import")}>
            📂 导入题单
          </Button>
          <Link
            href="/teacher/categories"
            className="rounded-control border border-line bg-surface px-3 py-1.5 text-meta font-medium text-fg hover:bg-surface-muted transition"
          >
            🌲 公共算法题库 →
          </Link>
        </div>
      </header>

      {/* Stats Cards */}
      <div className="grid gap-stack grid-cols-2 lg:grid-cols-4">
        <Stat label="我的题单总数" value={stats.totalSets} unit="份" tone="brand" />
        <Stat label="自建/沉淀题目" value={stats.totalProblems} unit="道" tone="ok" />
        <Stat label="AI 辅助生成" value={stats.aiSets} unit="份" tone="warn" />
        <Stat label="已发布至班级" value={stats.publishedSets} unit="份" tone="neutral" />
      </div>

      {actionMsg && (
        <div role="status" className="p-3 bg-brand/10 border border-brand/30 rounded-control text-brand text-sm">
          {actionMsg}
        </div>
      )}
      {error && (
        <div role="alert" className="p-3 bg-danger/10 border border-danger/30 rounded-control text-danger text-sm">
          {error}
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="border-b border-line flex flex-wrap gap-1 text-meta">
        <button
          type="button"
          className={`px-4 py-2.5 font-medium border-b-2 transition flex items-center gap-2 ${
            activeTab === "sets" ? "border-brand text-brand font-semibold" : "border-transparent text-fg-muted hover:text-fg"
          }`}
          onClick={() => setActiveTab("sets")}
        >
          <span>📁 我的题单库</span>
          <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-mono">{sets.length}</span>
        </button>
        <button
          type="button"
          className={`px-4 py-2.5 font-medium border-b-2 transition flex items-center gap-2 ${
            activeTab === "problems" ? "border-brand text-brand font-semibold" : "border-transparent text-fg-muted hover:text-fg"
          }`}
          onClick={() => setActiveTab("problems")}
        >
          <span>📝 我的题目总览</span>
          <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-mono">{problems.length}</span>
        </button>
        <button
          type="button"
          className={`px-4 py-2.5 font-medium border-b-2 transition flex items-center gap-2 ${
            activeTab === "ai" ? "border-brand text-brand font-semibold bg-brand/5" : "border-transparent text-fg-muted hover:text-fg"
          }`}
          onClick={() => setActiveTab("ai")}
        >
          <span>🤖 AI 智能辅助出题</span>
          <span className="rounded-full bg-brand/10 text-brand px-1.5 py-0.2 text-[11px] font-semibold">DeepSeek</span>
        </button>
        <button
          type="button"
          className={`px-4 py-2.5 font-medium border-b-2 transition flex items-center gap-2 ${
            activeTab === "import" ? "border-brand text-brand font-semibold" : "border-transparent text-fg-muted hover:text-fg"
          }`}
          onClick={() => setActiveTab("import")}
        >
          <span>📂 导入题单文件</span>
        </button>
      </div>

      {/* Tab 1: Sets List */}
      {activeTab === "sets" && (
        <div className="space-y-4">
          {/* Search & Filters */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-surface p-3.5 rounded-control border border-line shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                placeholder="🔍 检索题单名称或题目关键词…"
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                className="rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-fg w-72 focus:outline-none focus:ring-2 focus:ring-brand"
              />
              <div className="flex items-center gap-1 text-xs">
                <span className="text-fg-muted">来源:</span>
                {(["ALL", "teacher", "ai"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`px-2 py-1 rounded transition ${
                      originFilter === mode ? "bg-brand text-brand-fg font-medium" : "text-fg-muted hover:bg-surface-muted"
                    }`}
                    onClick={() => setOriginFilter(mode)}
                  >
                    {mode === "ALL" ? "全部" : mode === "ai" ? "🤖 AI 生成" : "✏️ 教师自编"}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1 text-xs ml-2">
                <span className="text-fg-muted">状态:</span>
                {(["ALL", "draft", "published"] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    className={`px-2 py-1 rounded transition ${
                      statusFilter === st ? "bg-brand text-brand-fg font-medium" : "text-fg-muted hover:bg-surface-muted"
                    }`}
                    onClick={() => setStatusFilter(st)}
                  >
                    {st === "ALL" ? "全部" : st === "draft" ? "草稿" : "已发布"}
                  </button>
                ))}
              </div>
            </div>

            <span className="text-xs text-fg-muted font-mono">共找到 {filteredSets.length} 份匹配题单</span>
          </div>

          {filteredSets.length === 0 ? (
            <Card>
              <Empty
                title="还没有符合条件的题单"
                hint="您可以使用 AI 辅助出题、导入外部 YAML/JSON/XML 文件，或点击上方「新建题单」开始创作。"
              />
              <div className="mt-4 flex justify-center gap-3">
                <Button variant="primary" onClick={() => setActiveTab("ai")}>
                  🤖 体验 AI 出题
                </Button>
                <Button variant="secondary" onClick={() => setActiveTab("import")}>
                  📂 导入题单文件
                </Button>
              </div>
            </Card>
          ) : (
            <div className="grid gap-3">
              {filteredSets.map((item) => {
                const isExpanded = expandedDraftId === item.draftId;
                return (
                  <Card key={item.draftId} className="hover:border-brand/40 transition-colors">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="space-y-1.5 flex-1 min-w-[280px]">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="text-lg font-semibold text-fg">{item.title}</h2>
                          <Badge tone={item.origin === "ai" ? "brand" : "neutral"}>
                            {item.origin === "ai" ? "🤖 AI 生成" : "✏️ 教师自编"}
                          </Badge>
                          <Badge tone={item.status === "published" ? "ok" : "warn"}>
                            {item.status === "published" ? "已发布到班级" : "未发布草稿"}
                          </Badge>
                          <span className="rounded-control bg-surface-muted px-2 py-0.5 text-xs text-fg font-mono">
                            {item.count} 道题目
                          </span>
                        </div>

                        <p className="text-xs text-fg-muted">
                          更新时间: {item.updatedAt}
                          {item.courseName ? ` · 初始归属: ${item.courseCode} ${item.courseName} (${item.offeringSection}班)` : ""}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/teacher/drafts/${item.draftId}`}
                          className="px-3 py-1.5 rounded-control border border-brand/40 bg-brand/5 text-xs font-semibold text-brand hover:bg-brand/10 transition"
                        >
                          📝 查看/修改试题
                        </Link>
                        <Button variant="primary" onClick={() => openDeployModal(item)}>
                          🚀 布置到班级
                        </Button>
                        <Button variant="secondary" onClick={() => handleDownloadYaml(item)}>
                          📥 导出 YAML
                        </Button>
                        <button
                          type="button"
                          className="px-2.5 py-1.5 text-xs text-danger hover:bg-danger/10 rounded-control transition"
                          onClick={() => handleDeleteDraft(item.draftId, item.title)}
                        >
                          🗑️
                        </button>
                      </div>
                    </div>

                    {/* Problem list preview toggle */}
                    <div className="mt-3 border-t border-line/60 pt-2">
                      <button
                        type="button"
                        className="text-xs text-fg-muted hover:text-brand flex items-center gap-1 transition"
                        onClick={() => setExpandedDraftId(isExpanded ? null : item.draftId)}
                      >
                        <span>{isExpanded ? "▲ 收起题目预览" : "▼ 展开查看题目明细 (" + item.problems.length + " 题)"}</span>
                      </button>

                      {isExpanded && (
                        <div className="mt-3 bg-surface-muted/50 rounded-control p-3 border border-line/60 space-y-2">
                          {item.problems.map((p, idx) => (
                            <div
                              key={idx}
                              className="flex flex-wrap items-center justify-between gap-2 py-1.5 border-b border-line/40 last:border-0 text-xs"
                            >
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-fg-muted">#{idx + 1}</span>
                                <span className="font-medium text-fg">{p.title}</span>
                                <span className="font-mono text-fg-muted text-[11px]">({p.slug})</span>
                              </div>
                              <div className="flex items-center gap-2">
                                {p.knowledge.map((k) => (
                                  <span key={k} className="rounded bg-surface px-1.5 py-0.5 text-[11px] text-fg-muted border border-line">
                                    {k}
                                  </span>
                                ))}
                                <span className="text-fg-muted text-[11px]">
                                  样例: {p.samplesCount} | 隐藏测试: {p.testsCount}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Individual Problems Repository */}
      {activeTab === "problems" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 bg-surface p-3.5 rounded-control border border-line shadow-sm">
            <input
              type="text"
              placeholder="🔍 检索题目名称、标识 (slug)、题面描述或知识点…"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              className="rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-fg w-80 focus:outline-none focus:ring-2 focus:ring-brand"
            />
            <span className="text-xs text-fg-muted font-mono">共 {filteredProblems.length} 道个人题目</span>
          </div>

          {filteredProblems.length === 0 ? (
            <Card>
              <Empty title="暂未找到符合条件的题目" hint="在「我的题单」中新建或生成试题后，题目会自动汇聚在此处。" />
            </Card>
          ) : (
            <div className="grid gap-3">
              {filteredProblems.map((prob, idx) => {
                const pKey = `${prob.draftId}_${prob.slug}_${idx}`;
                const isExpanded = expandedProblemKey === pKey;
                return (
                  <Card key={pKey} className="hover:border-brand/40 transition">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-base font-semibold text-fg">{prob.title}</h3>
                          <span className="font-mono text-xs text-fg-muted">slug: {prob.slug}</span>
                          <Badge tone={prob.origin === "ai" ? "brand" : "neutral"}>
                            {prob.origin === "ai" ? "AI 题目" : "自编题目"}
                          </Badge>
                          {prob.knowledge.map((k) => (
                            <span key={k} className="rounded bg-surface-muted px-1.5 py-0.5 text-xs text-fg border border-line">
                              {k}
                            </span>
                          ))}
                        </div>
                        <p className="text-xs text-fg-muted">
                          所属题单:{" "}
                          <Link href={`/teacher/drafts/${prob.draftId}`} className="text-brand hover:underline font-medium">
                            {prob.draftTitle}
                          </Link>{" "}
                          · 公开样例 {prob.samplesCount} 组 · 隐藏测试点 {prob.testsCount} 组
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <Button
                          variant="secondary"
                          onClick={() => setExpandedProblemKey(isExpanded ? null : pKey)}
                        >
                          {isExpanded ? "▲ 收起题面" : "▼ 预览题面与样例"}
                        </Button>
                        <Link
                          href={`/teacher/drafts/${prob.draftId}`}
                          className="px-3 py-1.5 rounded-control border border-line bg-surface hover:bg-surface-muted text-xs font-medium text-fg transition"
                        >
                          编辑题目 →
                        </Link>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="mt-3 border-t border-line/60 pt-3 space-y-3 text-xs">
                        <div className="bg-surface-muted/40 p-3 rounded-control border border-line whitespace-pre-wrap leading-relaxed text-fg">
                          {prob.statement || "暂无题面文本"}
                        </div>

                        {prob.samples && prob.samples.length > 0 && (
                          <div className="grid gap-2 sm:grid-cols-2">
                            {prob.samples.map((s, sIdx) => (
                              <div key={sIdx} className="bg-surface-muted p-2 rounded-control border border-line">
                                <span className="font-semibold text-fg-muted">样例 #{sIdx + 1}</span>
                                <div className="mt-1 font-mono text-[11px]">
                                  <div className="text-brand">输入:</div>
                                  <pre className="bg-surface p-1 rounded border border-line mt-0.5">{s.input || "(空)"}</pre>
                                  <div className="text-ok mt-1">输出:</div>
                                  <pre className="bg-surface p-1 rounded border border-line mt-0.5">{s.output || "(空)"}</pre>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Tab 3: AI Generator */}
      {activeTab === "ai" && (
        <Card className="border border-brand/30 shadow-sm space-y-4">
          <div className="border-b border-line pb-3">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold text-fg">🤖 AI 智能出题（直达个人题库）</h2>
              <Badge tone="brand">DeepSeek 模型</Badge>
            </div>
            <p className="mt-1 text-sm text-fg-muted">
              输入教学目标或生活应用题要求，AI 将自动构思题面、设计公开样例与隐藏边界评测点，并直接保存至您的「我的题单」中。
            </p>
          </div>

          <div className="space-y-3">
            <label className="block text-sm font-medium text-fg">
              教学目标与题型要求 <span className="text-brand">*</span>
              <textarea
                className="mt-1.5 w-full rounded-control border border-line bg-surface p-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand min-h-36"
                placeholder="例如：面向初学者，练习循环边界与条件分支，设计一道校园宿舍电费阶梯分摊题目，提供严谨边界测试。"
                value={aiTopic}
                onChange={(e) => setAiTopic(e.target.value)}
                disabled={aiBusy}
              />
            </label>

            <div>
              <p className="text-xs text-fg-muted mb-2 font-medium">💡 点击快捷预设示例填入：</p>
              <div className="flex flex-wrap gap-2">
                {[
                  { label: "循环累加与统计", text: "面向初学者，练习循环边界与求和，结合校园生活场景，给出严谨边界。" },
                  { label: "双指针回文串", text: "进阶字符串处理：双指针检测回文字符串并求最长回文子串，包含特殊字符测试。" },
                  { label: "单向链表操作", text: "数据结构：单向链表的创建、插入、指定节点删除与就地反转，提供完整测试。" },
                  { label: "校园阶梯计费", text: "应用题：根据阶梯电价计算总电费并按人头分摊，处理浮点精度四舍五入。" },
                  { label: "二叉树深度遍历", text: "树结构：根据前序与中序序列还原二叉树，输出后序遍历与最大深度。" },
                ].map((preset, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="text-xs px-2.5 py-1.5 rounded-control border border-line bg-surface hover:border-brand/40 hover:text-brand hover:bg-brand/5 text-fg-muted transition text-left"
                    onClick={() => setAiTopic(preset.text)}
                    disabled={aiBusy}
                  >
                    ✨ {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="pt-2 flex items-center gap-3">
              <Button variant="primary" disabled={aiBusy || !aiTopic.trim()} onClick={handleCreateAiSet}>
                {aiBusy ? "正在调用 DeepSeek 生成并存入题库（约 3~8 秒）…" : "🚀 生成并存入我的题库 →"}
              </Button>
              <span className="text-xs text-fg-muted">生成后将自动进入草稿编辑页面供您核对。</span>
            </div>
          </div>
        </Card>
      )}

      {/* Tab 4: Import YAML / JSON / XML */}
      {activeTab === "import" && (
        <Card className="space-y-4">
          <div className="border-b border-line pb-3">
            <h2 className="text-xl font-semibold text-fg">📂 导入题单文件（存入个人题库）</h2>
            <p className="mt-1 text-sm text-fg-muted">
              支持上传或粘贴平台标准 YAML、JSON 格式题单，以及 HOJ / HUSTOJ FPS XML 导出文件。
            </p>
          </div>

          <div className="space-y-4">
            <label className="block text-sm font-medium text-fg">
              选择本地题单文件 (.yaml, .yml, .json, .xml)
              <input
                className="mt-2 block w-full text-xs text-fg-muted file:mr-4 file:py-2 file:px-4 file:rounded-control file:border-0 file:text-xs file:font-semibold file:bg-brand/10 file:text-brand hover:file:bg-brand/20 cursor-pointer"
                type="file"
                accept=".json,.yaml,.yml,.xml"
                disabled={importBusy}
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    if (f.size > 1048576) {
                      setError("文件不能超过 1MB");
                      return;
                    }
                    setImportContent(await f.text());
                  }
                }}
              />
            </label>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-sm font-medium text-fg">题单文档内容</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="text-xs text-brand hover:underline"
                    onClick={() =>
                      setImportContent(`title: 个人题库自建题单
problems:
  - slug: sum-two
    title: 两个整数的和
    statement: "输入两个整数 a 和 b，输出它们的和。\\n数据范围：-1000000 ≤ a,b ≤ 1000000。"
    knowledge:
      - 顺序结构
      - 整数运算
    samples:
      - input: "1 2\\n"
        output: "3\\n"
    tests:
      - input: "-2 5\\n"
        output: "3\\n"
      - input: "0 0\\n"
        output: "0\\n"
`)
                    }
                  >
                    载入标准 YAML 模板
                  </button>
                </div>
              </div>
              <textarea
                className="w-full rounded-control border border-line bg-surface p-3 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-brand min-h-80 leading-relaxed"
                value={importContent}
                onChange={(e) => setImportContent(e.target.value)}
                disabled={importBusy}
                placeholder="在此直接粘贴 YAML / JSON / XML 内容…"
              />
            </div>

            <div className="pt-2 flex items-center gap-3">
              <Button variant="primary" disabled={importBusy || !importContent.trim()} onClick={handleImportSet}>
                {importBusy ? "正在解析保存…" : "💾 保存至我的题库 →"}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* New Blank Set Modal */}
      {showNewSetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-fg/40 p-4 backdrop-blur-sm">
          <Card className="w-full max-w-md shadow-2xl">
            <CardTitle title="✏️ 新建自编题单" meta="创建一份空白题单并保存在您的个人题库中" />
            <div className="mt-4 space-y-4">
              <label className="block text-sm font-medium text-fg">
                题单名称 *
                <input
                  type="text"
                  placeholder="例如：第一周 · 基础算法与数组模拟"
                  value={newSetTitle}
                  onChange={(e) => setNewSetTitle(e.target.value)}
                  className="mt-1.5 w-full rounded-control border border-line bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                />
              </label>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="secondary" onClick={() => setShowNewSetModal(false)}>
                  取消
                </Button>
                <Button variant="primary" disabled={creatingSet || !newSetTitle.trim()} onClick={handleCreateBlankSet}>
                  {creatingSet ? "创建中…" : "立即创建 →"}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Multi-Class Deploy Modal */}
      {deployDraft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-fg/40 p-4 backdrop-blur-sm">
          <Card className="w-full max-w-xl max-h-[90vh] overflow-y-auto shadow-2xl">
            {deployResult ? (
              <div className="space-y-4 py-3">
                <div className="text-center space-y-1">
                  <div className="text-3xl">🎉</div>
                  <h3 className="text-xl font-semibold text-fg">布置成功！</h3>
                  <p className="text-xs text-fg-muted">已将题单「{deployDraft.title}」成功发布到以下教学班：</p>
                </div>

                <div className="space-y-2 mt-4">
                  {deployResult.results?.map((r: any) => (
                    <div
                      key={r.offeringId}
                      className="flex items-center justify-between p-3 rounded-control border border-ok/30 bg-ok/5 text-xs"
                    >
                      <div>
                        <span className="font-semibold text-fg">
                          {r.courseName} · {r.section} 班
                        </span>
                        <span className="ml-2 text-fg-muted">BATCH ID: {r.batchId}</span>
                      </div>
                      <Link
                        href={`/teacher/batches/${r.batchId}`}
                        className="text-brand font-semibold hover:underline"
                      >
                        查看班级作业 →
                      </Link>
                    </div>
                  ))}
                </div>

                <div className="flex justify-end pt-4">
                  <Button
                    variant="primary"
                    onClick={() => {
                      setDeployDraft(null);
                      setDeployResult(null);
                    }}
                  >
                    完成
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <CardTitle
                  title="🚀 布置到教学班"
                  meta={`题单: ${deployDraft.title} (共 ${deployDraft.count} 题)`}
                />

                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-fg mb-1">
                      选择目标教学班级 * (可多选)
                    </label>
                    {data?.offerings && data.offerings.length > 0 ? (
                      <div className="grid gap-2 sm:grid-cols-2 max-h-48 overflow-y-auto p-1">
                        {data.offerings.map((off) => {
                          const checked = selectedOfferingIds.includes(off.offering_id);
                          return (
                            <label
                              key={off.offering_id}
                              className={`flex items-start gap-2 p-2.5 rounded-control border cursor-pointer text-xs transition ${
                                checked ? "border-brand bg-brand/5 text-fg font-medium" : "border-line bg-surface text-fg-muted hover:bg-surface-muted"
                              }`}
                            >
                              <input
                                type="checkbox"
                                className="mt-0.5"
                                checked={checked}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setSelectedOfferingIds([...selectedOfferingIds, off.offering_id]);
                                  } else {
                                    setSelectedOfferingIds(selectedOfferingIds.filter((id) => id !== off.offering_id));
                                  }
                                }}
                              />
                              <div>
                                <div className="font-semibold text-fg">
                                  {off.code} {off.name}
                                </div>
                                <div className="text-[11px] text-fg-muted">
                                  {off.term} · {off.section}班
                                </div>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-xs text-danger">暂无可布置的活跃教学班</p>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-fg">
                      作业截止时间 (选填)
                      <input
                        type="datetime-local"
                        value={deployDueDate}
                        onChange={(e) => setDeployDueDate(e.target.value)}
                        className="mt-1 block w-full rounded-control border border-line bg-surface px-3 py-1.5 text-xs text-fg focus:outline-none focus:ring-2 focus:ring-brand"
                      />
                    </label>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <label className="flex items-center gap-2 text-xs font-medium text-fg cursor-pointer">
                      <input
                        type="checkbox"
                        checked={deployAiEnabled}
                        onChange={(e) => setDeployAiEnabled(e.target.checked)}
                      />
                      <span>允许学生使用 AI 智能编程辅学</span>
                    </label>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-fg mb-1">允许编程语言</label>
                    <div className="flex flex-wrap gap-2 text-xs">
                      {AVAILABLE_LANGUAGES.map((l) => {
                        const checked = deployAllowedLanguages.includes(l.id);
                        return (
                          <label key={l.id} className="flex items-center gap-1 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setDeployAllowedLanguages([...deployAllowedLanguages, l.id]);
                                } else {
                                  if (deployAllowedLanguages.length <= 1) {
                                    alert("至少保留一种允许的语言");
                                    return;
                                  }
                                  setDeployAllowedLanguages(deployAllowedLanguages.filter((x) => x !== l.id));
                                }
                              }}
                            />
                            <span>{l.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-3 border-t border-line">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setDeployDraft(null);
                      setDeployResult(null);
                    }}
                  >
                    取消
                  </Button>
                  <Button
                    variant="primary"
                    disabled={deploying || selectedOfferingIds.length === 0}
                    onClick={handleDeploy}
                  >
                    {deploying ? "正在发布到教学班…" : `确认布置到 ${selectedOfferingIds.length} 个班级 →`}
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
