"use client";

import Link from "next/link";
import {useSearchParams} from "next/navigation";
import {useLibraryBasket} from "./LibraryBasket";
import { useEffect, useState } from "react";
import { Badge, Button, Card, CardTitle, Empty, Stat } from "@/components/ui";
import { api } from "@/lib/api";

import type { LibraryProblem as ProblemItem } from "@/api/generated/LibraryProblem";
import type { LibrarySet as SetItem } from "@/api/generated/LibrarySet";
import type { Library } from "@/api/generated/Library";
import type { DraftCreated } from "@/api/generated/DraftCreated";
import type { DeployResponse } from "@/api/generated/DeployResponse";

const AVAILABLE_LANGUAGES = [
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "java", label: "Java" },
  { id: "python", label: "Python 3" },
];

export function TeacherLibraryView({ portal, user, questionsOnly=false }: { portal: "teacher" | "student" | null; user?: string; questionsOnly?: boolean }) {
  const params=useSearchParams();const selectedOid=Number(params.get('oid'));const basketState=useLibraryBasket();
  const editorUrl=(id:string)=>`/programming/drafts/${id}?library=1${questionsOnly?'&return=questions':''}${selectedOid>0?`&oid=${selectedOid}`:''}`;
  function addProblem(p:ProblemItem){if(!basketState)return;const setId=`draft:${p.draft_id}`;const exists=basketState.basket.some(x=>x.setId===setId&&x.slug===p.slug);if(!exists&&basketState.basket.length>=100){setError('选题篮最多 100 道题');return;}basketState.setBasket(xs=>exists?xs.filter(x=>x.setId!==setId||x.slug!==p.slug):[...xs,{setId,setName:p.draft_title,slug:p.slug,title:p.title,difficulty:p.difficulty,knowledge:p.knowledge,statement:p.statement}]);}
  function addSet(item:SetItem){if(!basketState)return;const extra=item.problems.filter(p=>!basketState.basket.some(x=>x.setId===`draft:${p.draft_id}`&&x.slug===p.slug));if(basketState.basket.length+extra.length>100){setError('选题篮最多 100 道题');return;}basketState.setBasket(xs=>[...xs,...extra.map(p=>({setId:`draft:${p.draft_id}`,setName:p.draft_title,slug:p.slug,title:p.title,difficulty:p.difficulty,knowledge:p.knowledge,statement:p.statement}))]);}
  const [data, setData] = useState<Library | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [activeTab, setActiveTab] = useState<"sets" | "problems" | "import">(questionsOnly?"problems":"sets");
  useEffect(()=>{const tab=params.get("tab");if(tab==="create"||tab==="ai"){setActiveTab(questionsOnly?"problems":"sets");setShowNewSetModal(true);}else if(tab==="import")setActiveTab("import");else setActiveTab(questionsOnly?"problems":"sets");},[params,questionsOnly]);
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
  const [deployAiEnabled, setDeployAiEnabled] = useState(false);
  const [deployAllowedLanguages, setDeployAllowedLanguages] = useState<string[]>(["c", "cpp", "java", "python"]);
  const [reviewedDeploy,setReviewedDeploy]=useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<DeployResponse | null>(null);

  // In-page Import state
  const [importContent, setImportContent] = useState("");
  const [importBusy, setImportBusy] = useState(false);

  const [actionMsg, setActionMsg] = useState("");

  const loadLibrary = () => {
    setLoading(true);
    setError("");
    api<Library>("/teacher/library")
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
      const res = await api<DraftCreated>("/teacher/library/sets", "POST", {
        title: newSetTitle.trim(),
      });
      setShowNewSetModal(false);
      setNewSetTitle("");
      loadLibrary();
      window.location.href = editorUrl(res.id);
    } catch (e) {
      setError(String(e).split("|").pop() || "创建题单失败");
    } finally {
      setCreatingSet(false);
    }
  };

  const handleImportSet = async () => {
    if (!importContent.trim()) return;
    setImportBusy(true);
    setError("");
    try {
      const res = await api<DraftCreated>("/teacher/library/sets", "POST", {
        content: importContent.trim(),
      });
      setImportContent("");
      loadLibrary();
      window.location.href = editorUrl(res.id);
    } catch (e) {
      setError(String(e).split("|").pop() || "导入题单失败");
    } finally {
      setImportBusy(false);
    }
  };

  const handleDeleteDraft = async (draftId: string, title: string) => {
    if (!window.confirm(`确定从个人题库中删除题单「${title}」吗？通过此题单发布的课程作业、学生提交和成绩也会实际删除，无法在页面中恢复。`)) return;
    try {
      await api(`/drafts/${draftId}`, "DELETE");
      setActionMsg(`已成功删除题单「${title}」`);
      basketState?.setBasket(xs=>xs.filter(x=>x.setId!==`draft:${draftId}`));
      loadLibrary();
      setTimeout(() => setActionMsg(""), 3000);
    } catch (e) {
      alert(String(e).split("|").pop() || "删除失败");
    }
  };

  const openDeployModal = (item: SetItem) => {
    setDeployDraft(item);setReviewedDeploy(false);
    setDeployResult(null);
    if (data?.offerings && data.offerings.length > 0) {
      if (selectedOid>0 && data.offerings.some(o=>o.offering_id===selectedOid)) {setSelectedOfferingIds([selectedOid]);}
      else if (item.offering_id && data.offerings.some((o) => o.offering_id === item.offering_id)) {
        setSelectedOfferingIds([item.offering_id]);
      } else {
        setSelectedOfferingIds([data.offerings[0].offering_id]);
      }
    }
  };

  const handleDeploy = async () => {
    if (!deployDraft || selectedOfferingIds.length === 0 || !reviewedDeploy) return;
    setDeploying(true);
    setError("");
    try {
      const res = await api<DeployResponse>("/teacher/library/deploy", "POST", {
        draft_id: deployDraft.draft_id,
        reviewed: reviewedDeploy,
        offering_ids: selectedOfferingIds,
        due_at: deployDueDate || undefined,
        ai_enabled: deployAiEnabled,
        allowed_languages: deployAllowedLanguages,
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
  const stats = data?.stats || { total_sets: 0, total_problems: 0, ai_sets: 0, teacher_sets: 0, published_sets: 0 };

  const filteredSets = sets.filter((s) => {
    if (originFilter !== "ALL" && s.origin !== originFilter) return false;
    if (statusFilter !== "ALL" && (s.assignment_count>0?"published":"draft") !== statusFilter) return false;
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
      {!questionsOnly&&<header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div><h1 className="text-3xl font-semibold">我的题单</h1>{selectedOid>0&&<a className="text-brand" href={`/courses/${selectedOid}`}>← 返回当前课程</a>}<p className="mt-2 text-sm text-fg-muted">查看和修改已经组好的题单，选择课程布置为作业。选题、出题和导入都在题库完成。</p></div>
        <Link href={`/library?view=public&source=mine${selectedOid>0?`&oid=${selectedOid}`:''}`} className="rounded-control bg-brand px-4 py-2 text-brand-fg">去题库选题 / 出题 →</Link>
      </header>}
      {!questionsOnly&&<div className="grid gap-stack grid-cols-2"><Stat label="我的题单总数" value={stats.total_sets} unit="份" tone="brand"/><Stat label="已发布至班级" value={stats.published_sets} unit="份"/></div>}
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

      {questionsOnly&&activeTab==='import'&&<Button variant="secondary" onClick={()=>setActiveTab('problems')}>← 返回我出的题</Button>}
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
                    {st === "ALL" ? "全部" : st === "draft" ? "未布置" : "已布置"}
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
                hint="到题库选择自己的题和公开题目，组合成题单。"
              />
              <div className="mt-4 flex justify-center gap-3">
                <Link className="text-brand" href={`/library?view=public&source=mine${selectedOid>0?`&oid=${selectedOid}`:''}`}>去题库选题 / 出题 →</Link>
                <Link className="text-brand" href={`/library?view=public&source=mine&tab=import${selectedOid>0?`&oid=${selectedOid}`:''}`}>📂 导入题目</Link>
              </div>
            </Card>
          ) : (
            <div className="grid gap-3">
              {filteredSets.map((item) => {
                const isExpanded = expandedDraftId === item.draft_id;
                return (
                  <Card key={item.draft_id} className="hover:border-brand/40 transition-colors">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="space-y-1.5 flex-1 min-w-[280px]">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="text-lg font-semibold text-fg">{item.title}</h2>
                          <Badge tone={item.origin === "ai" ? "brand" : "neutral"}>
                            {item.origin === "ai" ? "🤖 AI 生成" : "✏️ 教师自编"}
                          </Badge>
                          <Badge tone={item.assignment_count > 0 ? "ok" : "warn"}>
                            {item.assignment_count > 0 ? `已布置 ${item.assignment_count} 次` : "未布置"}
                          </Badge>
                          <span className="rounded-control bg-surface-muted px-2 py-0.5 text-xs text-fg font-mono">
                            {item.count} 道题目
                          </span>
                        </div>

                        <p className="text-xs text-fg-muted">
                          更新时间: {item.updated_at}
                          {item.course_name ? ` · 初始归属: ${item.course_code} ${item.course_name} (${item.offering_section}班)` : ""}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Button variant="secondary" onClick={()=>addSet(item)}>全部加入选题篮</Button>
                        <Link
                          href={editorUrl(item.draft_id)}
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
                          onClick={() => handleDeleteDraft(item.draft_id, item.title)}
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
                        onClick={() => setExpandedDraftId(isExpanded ? null : item.draft_id)}
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
                                <input aria-label={`加入选题篮 ${p.title}`} type="checkbox" checked={!!basketState?.basket.some(x=>x.setId===`draft:${p.draft_id}`&&x.slug===p.slug)} onChange={()=>addProblem(p)}/>
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
                                  样例: {p.samples_count} | 隐藏测试: {p.tests_count}
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
          <h2 className="text-xl font-semibold">我出的题</h2>
          <div className="flex flex-wrap items-center justify-between gap-3 bg-surface p-3.5 rounded-control border border-line shadow-sm">
            <input
              type="text"
              aria-label="搜索我出的题" placeholder="搜索题目名称、题面或知识点…"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              className="rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-fg w-80 focus:outline-none focus:ring-2 focus:ring-brand"
            />
            <span className="text-xs text-fg-muted font-mono">共 {filteredProblems.length} 道个人题目</span>
          </div>

          {filteredProblems.length === 0 ? (
            <Card>
              <Empty title="暂未找到符合条件的题目" hint="点击上方「去出题」自己编写或让 AI 搭框架；保存后会显示在这里，也可导入已有题目。" />
            </Card>
          ) : (
            <div className="grid gap-3">
              {filteredProblems.map((prob, idx) => {
                const pKey = `${prob.draft_id}_${prob.slug}_${idx}`;
                const isExpanded = expandedProblemKey === pKey;
                return (
                  <Card key={pKey} className="hover:border-brand/40 transition">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-base font-semibold text-fg">{prob.title}</h3>
                          
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
                          <Link href={editorUrl(prob.draft_id)} className="text-brand hover:underline font-medium">
                            {prob.draft_title}
                          </Link>{" "}
                          · 公开样例 {prob.samples_count} 组 · 隐藏测试点 {prob.tests_count} 组
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <Button onClick={()=>addProblem(prob)}>{basketState?.basket.some(x=>x.setId===`draft:${prob.draft_id}`&&x.slug===prob.slug)?"移出选题篮":"加入选题篮"}</Button>
                        <Button
                          variant="secondary"
                          onClick={() => setExpandedProblemKey(isExpanded ? null : pKey)}
                        >
                          {isExpanded ? "▲ 收起题面" : "▼ 预览题面与样例"}
                        </Button>
                        <Link
                          href={editorUrl(prob.draft_id)}
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
            <CardTitle title="去出题" meta="先给题单起个名字，进入后可自己编写，也可让 AI 搭框架" />
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
                  {creatingSet ? "创建中…" : "进入出题 →"}
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
                      key={r.offering_id}
                      className="flex items-center justify-between p-3 rounded-control border border-ok/30 bg-ok/5 text-xs"
                    >
                      <div>
                        <span className="font-semibold text-fg">
                          {r.course_name} · {r.section} 班
                        </span>
                        <span className="ml-2 text-fg-muted">BATCH ID: {r.batch_id}</span>
                      </div>
                      <Link
                        href={`/assignments/${r.batch_id}`}
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

                <label className="block text-sm"><input type="checkbox" checked={reviewedDeploy} onChange={e=>setReviewedDeploy(e.target.checked)}/> 我已核对题面、样例与隐藏测试</label>
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
                    disabled={deploying || selectedOfferingIds.length === 0 || !reviewedDeploy}
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
