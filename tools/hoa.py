#!/usr/bin/env python3
"""HOA（hoa.moe / HITSZ-OpenAuto）联动：L1 元数据与链接，L2 题单导出的红线检查。

对应规划 v3.0 §4 的三层联动：

- **L1（本模块已实现）**：课程代码 ↔ HOA 仓库的映射与链接。
  映射源是 codemind 的 `data/source_registry/courses.json`（里面有 `hitsz_course_code`），
  仓库命名规则是 `HITSZ-OpenAuto/<CODE>`。**刻意不复制那张表**，避免两处漂移。
- **L2（本模块实现导入/导出的安全规则）**：题单以 YAML 存在 HOA 课程仓库，平台可拉取，
  也可导出成 PR。**HOA 是公开仓库，外发不可逆**，所以导出走白名单 + 五条红线。
- **L3（本模块不实现）**：把 HOA 资料作为 AI 出题语料。语料入库必须走人工审批
  （`codemind/modules/rag/registry.py` 的 `RightsStatus` / `ScreeningDecision`）。
  在写这份代码时 `data/source_registry/hoa_screening_overrides.jsonl` 是**空的**，
  也就是说没有任何 HOA 文件被批准给学生访问 —— L3 现在不可用，不要绕过它。

用法::

    python3 tools/hoa.py link COMP1007          # 查课程对应的 HOA 仓库与链接
    python3 tools/hoa.py link --all             # 列出 registry 里的全部映射
    python3 tools/hoa.py check <题单.yml>        # 校验一份题单是否符合公开导出红线
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent

#: 权威映射源。不要复制成第二份表 —— 需要新增课程时走 registry 的审批流程。
COURSES_REGISTRY = WORKSPACE / "codemind" / "data" / "source_registry" / "courses.json"

#: HOA 语料的人工审批记录（`modules/rag/registry.py` 流程的产出）。空 = 无任何语料获批。
SCREENING_OVERRIDES = WORKSPACE / "codemind" / "data" / "source_registry" / "hoa_screening_overrides.jsonl"

HOA_ORG = "HITSZ-OpenAuto"

#: 独立题单中心仓库（统一存放各编程课程题单，按 problems/<课程代码>/ 归档）
HOA_OJ_REPO = "HITSZ-OpenAuto/hoa-oj"
HOA_OJ_URL = f"https://github.com/{HOA_OJ_REPO}"
HOA_PROBLEMS_DIR = "problems"

#: `cm_batch.source_ref` 的列宽（VARCHAR(255)），超长必须在写库前拦下。
SOURCE_REF_MAX_LENGTH = 255

#: 允许写进公开题单的字段（白名单，新增字段默认不外发）
EXPORTED_BATCH_FIELDS = frozenset(
    {"course", "batch", "seq", "title", "open_at", "due_at", "problems"}
)
EXPORTED_PROBLEM_FIELDS = frozenset(
    # seq 是导出时按勾选顺序重排生成的，属于公开字段；category/provenance/courses 支持多维知识点检索
    {"slug", "seq", "title", "knowledge", "difficulty", "statement", "samples",
     "category", "provenance", "courses"}
)

#: 平台侧已知、但**不外发**的内部字段。列出来是为了把"已知内部字段"和"未知字段"
#: 区分开 —— 前者的提示更有用，后者说明有人往题单里塞了东西。
INTERNAL_BATCH_FIELDS = frozenset(
    {"batch_id", "offering_id", "status", "read_only", "source_ref",
     "ai_enabled", "description"}
)
INTERNAL_PROBLEM_FIELDS = frozenset(
    {"problem_id", "score", "due_at", "required", "attempts", "state", "diagnosis"}
)

#: 明确不允许外发的字段 → (红线编号, 说明)。命中时给出比"未知字段"更清楚的提示。
FORBIDDEN_FIELDS = {
    "tests": ("红线4", "测试用例不得外发（公开仓库等于泄题）"),
    "test_cases": ("红线4", "测试用例不得外发"),
    "testdata": ("红线4", "测试用例不得外发"),
    "expected_stdout": ("红线4", "测试用例不得外发"),
    "source": ("红线5", "学生/标程代码不得外发"),
    "source_code": ("红线5", "学生/标程代码不得外发"),
    "submissions": ("红线5", "学生提交不得外发"),
}


@dataclass
class CourseLink:
    """一门校内课程到 HOA 的映射。"""

    code: str
    course_name: str | None = None
    course_id: str | None = None
    registry_id: str | None = None
    #: 是否已被 RAG 语料 registry 收录（与"能否公开链接"是两件事）
    in_registry: bool = False
    notes: str | None = None

    @property
    def hoa_repo(self) -> str:
        return f"{HOA_ORG}/{self.code}"

    @property
    def hoa_url(self) -> str:
        return f"https://github.com/{HOA_ORG}/{self.code}"

    @property
    def problem_set_dir(self) -> str:
        """题单在 HOA 课程仓库里的约定目录（历史单课仓库）。"""
        return "oj"

    @property
    def hoa_oj_repo(self) -> str:
        """独立题单仓库。"""
        return HOA_OJ_REPO

    @property
    def hoa_oj_url(self) -> str:
        """独立题单仓库地址。"""
        return HOA_OJ_URL

    @property
    def hoa_oj_dir(self) -> str:
        """本课程题单在独立仓库中的约定目录。"""
        return f"{HOA_PROBLEMS_DIR}/{self.code}"


def load_course_index(registry_path: Path = COURSES_REGISTRY) -> dict[str, CourseLink]:
    """读取 registry 的课程表，按校内课程代码建索引。"""
    if not registry_path.exists():
        raise FileNotFoundError(
            f"找不到课程 registry：{registry_path}\n"
            "它是 HOA 映射的权威来源，缺失时不要改用硬编码映射。"
        )
    raw = json.loads(registry_path.read_text(encoding="utf-8"))
    index: dict[str, CourseLink] = {}
    for item in raw:
        code = item.get("hitsz_course_code")
        if not code:
            # 例如 computer-networks 尚未确定校内课程代码，跳过
            continue
        index[code] = CourseLink(
            code=code,
            course_name=item.get("course_name"),
            course_id=item.get("course_id"),
            registry_id=f"hoa-{code.lower()}",
            in_registry=True,
            notes=item.get("notes"),
        )
    return index


def resolve_course(code: str, registry_path: Path = COURSES_REGISTRY) -> CourseLink:
    """解析课程代码。

    不在 registry 里也返回可用的链接（L1 只需要仓库命名规则），但 `in_registry`
    为 False —— 提醒调用方：链接可以给，语料不能拿来喂 AI。
    """
    index = load_course_index(registry_path)
    return index.get(code) or CourseLink(code=code)


def corpus_approval_note() -> str:
    """L3（把 HOA 资料当 AI 语料）的审批状态。

    **本工具无权代替审批**，只如实报告审批记录的存在与行数：没有记录就是没有获批，
    不能因为课程出现在 registry 里就当成语料已放行。
    """
    try:
        shown = SCREENING_OVERRIDES.relative_to(WORKSPACE)
    except ValueError:  # pragma: no cover - 仅当 WORKSPACE 关系被改坏
        shown = SCREENING_OVERRIDES
    if not SCREENING_OVERRIDES.exists():
        return f"无审批记录文件（{shown} 不存在）→ L3 不可用"
    lines = [
        line for line in SCREENING_OVERRIDES.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if not lines:
        return f"无任何已审批语料（{shown} 为 0 行）→ L3 不可用"
    return f"有 {len(lines)} 行审批记录，须按 RAG registry 流程逐条核对 → 本工具不代替审批"


# ---------------------------------------------------------------- 来源与只读标记


def batch_read_only(batch: dict[str, Any]) -> bool:
    """题单顶层的只读标记（对应列 `cm_batch.read_only`）。缺省 False。

    非布尔值一律按**只读**处理（fail-closed）：有人写 `read_only: "no"` 或 `0`
    时，静默当成 False 等于把只读题单放进公开导出通道，宁可拒。
    """
    value = batch.get("read_only", False)
    return value if isinstance(value, bool) else True


def validate_batch_provenance(batch: dict[str, Any]) -> None:
    """校验题单顶层的来源字段，非法即报错。

    导入侧对非法 `read_only` 直接报错，而不是像导出侧那样 fail-closed：导入是
    人工动作，把 `read_only: "no"` 猜成 True 会悄悄挡掉本来合法的导出，报错更省事。
    """
    if "read_only" in batch and not isinstance(batch["read_only"], bool):
        value = batch["read_only"]
        raise ValueError(
            f"字段 `read_only` 必须是布尔值，得到 {type(value).__name__}：{value!r}"
        )
    if "source_ref" in batch:
        value = batch["source_ref"]
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"字段 `source_ref` 必须是非空字符串，得到 {value!r}")


def suggest_batch_filename(course_code: str, batch_ident: str) -> str:
    """生成符合 HOA 独立题单仓库规范的文件名：<课程代码>-<批次标识>.yml。

    例如：
      suggest_batch_filename("COMP1007", "W01") -> "COMP1007-W01.yml"
      suggest_batch_filename("COMP1007", "COMP1007-W01") -> "COMP1007-W01.yml"
      suggest_batch_filename("COMP1007", "batch-10") -> "COMP1007-batch-10.yml"
    """
    code = course_code.strip().upper()
    ident = str(batch_ident).strip()
    if ident.endswith(".yml") or ident.endswith(".yaml"):
        ident = ident.rsplit(".", 1)[0]
    if ident.upper().startswith(f"{code}-"):
        ident = ident[len(code) + 1:]
    if re.match(r"^(w\d+|lab\d+|midterm|final|quiz\d*)$", ident, re.IGNORECASE):
        ident = ident.upper()
    return f"{code}-{ident}.yml"



def suggest_batch_repo_path(course_code: str, batch_ident: str) -> str:
    """生成在独立题单仓库中的标准相对路径：problems/<课程代码>/<课程代码>-<批次标识>.yml。"""
    code = course_code.strip().upper()
    filename = suggest_batch_filename(code, batch_ident)
    return f"{HOA_PROBLEMS_DIR}/{code}/{filename}"


def validate_hoa_problem_set_path(path: str) -> tuple[bool, str | None]:
    """校验题单在 HOA 独立题单仓库中的相对路径是否符合规范。

    合规格式为：problems/<课程代码>/<课程代码>-<批次>.yml
    例如：problems/COMP1007/COMP1007-W01.yml
    """
    p = path.strip().replace("\\", "/")
    parts = [part for part in p.split("/") if part]
    if len(parts) != 3 or parts[0] != HOA_PROBLEMS_DIR:
        return False, f"路径必须以 '{HOA_PROBLEMS_DIR}/<课程代码>/' 组织，得到: {path!r}"
    course_dir, filename = parts[1], parts[2]
    if not course_dir or not filename.endswith((".yml", ".yaml")):
        return False, f"文件名必须以 .yml 或 .yaml 结尾，得到: {filename!r}"
    stem = filename.rsplit(".", 1)[0]
    if not stem.upper().startswith(f"{course_dir.upper()}-"):
        return False, f"文件名必须以课程代码前缀 '{course_dir.upper()}-' 开头，得到: {filename!r}"
    return True, None


def build_hoa_oj_source_ref(course_code: str, batch_file: str | Path,
                            repo: str = HOA_OJ_REPO) -> str:
    """由题单路径推导在独立题单仓库 hoa-oj 中的 source_ref。

    格式：hoa:<repo>@problems/<课程代码>/<文件名>
    例如：hoa:HITSZ-OpenAuto/hoa-oj@problems/COMP1007/COMP1007-W01.yml
    """
    code = course_code.strip().upper()
    name = Path(str(batch_file)).name
    if not name:
        raise ValueError(f"无法从题单路径解析出文件名：{batch_file!r}")
    path_str = str(batch_file).replace("\\", "/").strip()
    if path_str.startswith(f"{HOA_PROBLEMS_DIR}/"):
        repo_path = path_str
    else:
        filename = name if name.upper().startswith(f"{code}-") else f"{code}-{name}"
        repo_path = f"{HOA_PROBLEMS_DIR}/{code}/{filename}"
    source_ref = f"hoa:{repo}@{repo_path}"
    if len(source_ref) > SOURCE_REF_MAX_LENGTH:
        raise ValueError(
            f"source_ref 长 {len(source_ref)} 字符，超过列宽 {SOURCE_REF_MAX_LENGTH}：{source_ref}"
        )
    return source_ref


def parse_source_ref(source_ref: str) -> dict[str, Any]:
    """解析 source_ref 字符串，识别独立题单仓库与历史单课仓库格式。

    支持：
    1. 独立题单仓库：hoa:HITSZ-OpenAuto/hoa-oj@problems/COMP1007/COMP1007-W01.yml
    2. 历史单课仓库：hoa:HITSZ-OpenAuto/COMP1007@oj/w03.yml
    """
    if not isinstance(source_ref, str) or not source_ref.startswith("hoa:"):
        return {"type": "unknown", "raw": source_ref}
    payload = source_ref[4:].strip()
    if "@" not in payload:
        return {"type": "unknown", "raw": source_ref}
    repo, path = payload.split("@", 1)
    parts = [part for part in path.replace("\\", "/").split("/") if part]
    if repo == HOA_OJ_REPO and len(parts) >= 3 and parts[0] == HOA_PROBLEMS_DIR:
        return {
            "type": "central",
            "repo": repo,
            "course": parts[1],
            "path": path,
            "filename": parts[-1],
            "raw": source_ref,
        }
    course = repo.split("/", 1)[1] if "/" in repo else repo
    return {
        "type": "legacy",
        "repo": repo,
        "course": course,
        "path": path,
        "filename": parts[-1] if parts else path,
        "raw": source_ref,
    }


def build_source_ref(link: CourseLink, batch_file: str | Path,
                     *, central: bool = False) -> str:
    """由题单文件推导**精确到题单文件**的 `source_ref`。

    格式：
    - 独立题单仓库（默认推荐）：hoa:HITSZ-OpenAuto/hoa-oj@problems/<CODE>/<FILE>
    - 历史单课仓库：hoa:HITSZ-OpenAuto/<CODE>@oj/<FILE>
    """
    path_str = str(batch_file).replace("\\", "/").strip()
    if central or path_str.startswith(f"{HOA_PROBLEMS_DIR}/"):
        return build_hoa_oj_source_ref(link.code, batch_file)

    name = Path(str(batch_file)).name
    if not name:
        raise ValueError(f"无法从题单路径解析出文件名：{batch_file!r}")
    source_ref = f"hoa:{link.hoa_repo}@{link.problem_set_dir}/{name}"
    if len(source_ref) > SOURCE_REF_MAX_LENGTH:
        raise ValueError(
            f"source_ref 长 {len(source_ref)} 字符，超过列宽 {SOURCE_REF_MAX_LENGTH}：{source_ref}"
        )
    return source_ref


def resolve_source_ref(batch: dict[str, Any], link: CourseLink,
                       batch_file: str | Path,
                       *, central: bool = False) -> str:
    """题单显式声明 `source_ref` 就用它（校验长度），否则按文件名推导。"""
    explicit = batch.get("source_ref")
    if explicit is None:
        return build_source_ref(link, batch_file, central=central)
    if not isinstance(explicit, str) or not explicit.strip():
        raise ValueError(f"题单字段 `source_ref` 必须是非空字符串，得到 {explicit!r}")
    text = explicit.strip()
    if len(text) > SOURCE_REF_MAX_LENGTH:
        raise ValueError(
            f"题单字段 `source_ref` 长 {len(text)} 字符，超过列宽 {SOURCE_REF_MAX_LENGTH}"
        )
    return text



# ---------------------------------------------------------------- L2 红线


@dataclass
class ExportRequest:
    """一次公开导出请求。"""

    batch: dict[str, Any]
    selected_slugs: list[str] = field(default_factory=list)
    #: 题单的「只读导入，永不回写」开关（规划 §4.3 第 5 条）
    read_only: bool = False


def check_export(request: ExportRequest) -> list[str]:
    """检查一次导出是否越过红线，返回违规说明列表（空列表=通过）。

    五条红线来自规划 §4.3，逐条对应：

    1. 未勾选任何题目 —— 必须教师逐题勾选，默认全不选
    2. `read_only` 开关打开 —— 该题单只允许导入，永不回写。判 `request.read_only`
       与题单自带的 `batch["read_only"]` **任一为真**即拒，不依赖调用方记得传参
    3. 批次不是 published —— draft 不得外发
    4. 出现测试用例字段 —— 只导样例，测试数据不进公开仓库
    5. 出现学生/标程代码字段 —— 学生代码绝不外发
    """
    problems: list[dict[str, Any]] = request.batch.get("problems", []) or []
    violations: list[str] = []

    # 红线2 有两个来源：调用方显式传的 request.read_only（CLI --read-only），以及题单
    # 自带的 batch["read_only"]（导入时落进 cm_batch.read_only）。只查一个就会被另一个
    # 漏传放行 —— 两个都查，且只报一条，避免刷屏。
    raw_read_only = request.batch.get("read_only", False)
    if not isinstance(raw_read_only, bool):
        violations.append(
            f"红线2：题单字段 `read_only` 应为布尔值，实际是 "
            f"{type(raw_read_only).__name__}：{raw_read_only!r}；"
            "无法判定时按只读处理，拒绝导出。"
        )
    elif request.read_only or raw_read_only:
        violations.append(
            "红线2：该题单标记为「只读导入，永不回写」，禁止导出到 HOA。"
        )

    if not request.selected_slugs:
        violations.append(
            "红线1：必须逐题勾选，且默认全不选。当前一道题都没选，拒绝导出。"
        )

    status = str(request.batch.get("status", "")).lower()
    if status != "published":
        violations.append(
            f"红线3：批次状态为 {status or '未知'}（不是 published），草稿不得外发。"
        )

    known = {str(p.get("slug")) for p in problems}
    unknown = [slug for slug in request.selected_slugs if slug not in known]
    if unknown:
        violations.append(f"勾选的题目不存在于本题单：{', '.join(unknown)}")

    allowed_batch = EXPORTED_BATCH_FIELDS | INTERNAL_BATCH_FIELDS
    allowed_problem = EXPORTED_PROBLEM_FIELDS | INTERNAL_PROBLEM_FIELDS

    for problem in problems:
        slug = problem.get("slug", "<无 slug>")
        for key in problem:
            if key in FORBIDDEN_FIELDS:
                tag, why = FORBIDDEN_FIELDS[key]
                violations.append(f"{tag}：题目 {slug} 含字段 `{key}` —— {why}。")
            elif key not in allowed_problem:
                violations.append(
                    f"题目 {slug} 含未知字段 `{key}`；"
                    f"已知字段：{sorted(allowed_problem)}。"
                )
    for key in request.batch:
        if key in FORBIDDEN_FIELDS:
            tag, why = FORBIDDEN_FIELDS[key]
            violations.append(f"{tag}：题单含字段 `{key}` —— {why}。")
        elif key not in allowed_batch:
            violations.append(
                f"题单含未知字段 `{key}`；已知字段：{sorted(allowed_batch)}。"
            )

    return violations


def build_export_document(request: ExportRequest) -> dict[str, Any]:
    """生成可写入 HOA 课程仓库的公开题单。

    这是**白名单重建**而不是「拷贝后删字段」：即使上游 batch 里混进了测试数据或学生代码，
    产出的文档里也不可能有 —— 结构上就不可能泄漏。
    """
    violations = check_export(request)
    if violations:
        raise ValueError("导出被红线拦下：\n  - " + "\n  - ".join(violations))

    selected = set(request.selected_slugs)
    exported_problems = [
        {key: value for key, value in problem.items() if key in EXPORTED_PROBLEM_FIELDS}
        for problem in request.batch.get("problems", [])
        if str(problem.get("slug")) in selected
    ]

    document = {
        key: value
        for key, value in request.batch.items()
        if key in EXPORTED_BATCH_FIELDS and key != "problems"
    }
    # 按勾选顺序重排：教师勾选的顺序就是期望的题目顺序
    order = {slug: index for index, slug in enumerate(request.selected_slugs)}
    exported_problems.sort(key=lambda p: order.get(str(p.get("slug")), 1 << 30))
    for index, problem in enumerate(exported_problems, start=1):
        problem["seq"] = index
    document["problems"] = exported_problems
    return document


def export_to_yaml(request: ExportRequest) -> str:
    """序列化成 YAML 文本，用于提交 PR 到 HOA 课程仓库的 `oj/` 目录。"""
    import yaml  # 延迟导入：只有真要导出时才需要 PyYAML

    document = build_export_document(request)
    header = (
        "# 由 CodeMind 校内编程作业平台导出，已通过公开导出红线检查。\n"
        "# 只含题面与样例；测试数据与学生代码不在其中。\n"
    )
    return header + yaml.safe_dump(document, allow_unicode=True, sort_keys=False)


# ---------------------------------------------------------------- CLI


def command_link(args: argparse.Namespace) -> int:
    index = load_course_index()
    if args.all:
        if not index:
            print("registry 里没有任何带校内课程代码的课程。")
            return 0
        print(f"{'课程代码':<12}{'课程名':<20}{'registry_id':<18}HOA 仓库")
        print("-" * 78)
        for link in sorted(index.values(), key=lambda item: item.code):
            print(f"{link.code:<12}{link.course_name or '':<20}"
                  f"{link.registry_id or '':<18}{link.hoa_repo}")
        print(f"\n题单约定目录：<仓库>/{next(iter(index.values())).problem_set_dir}/")
        print(f"语料审批    : {corpus_approval_note()}")
        return 0

    if not args.code:
        print("请给出课程代码，或用 --all 列出全部。", file=sys.stderr)
        return 2
    link = resolve_course(args.code)
    print(f"课程代码    : {link.code}")
    print(f"课程名      : {link.course_name or '（registry 中无此课程）'}")
    print(f"HOA 攻略仓库: {link.hoa_repo}")
    print(f"攻略链接    : {link.hoa_url}")
    print(f"独立题单仓库: {link.hoa_oj_repo} ({link.hoa_oj_dir}/)")
    print(f"历史题单目录: {link.hoa_repo}/{link.problem_set_dir}/")
    print(f"registry_id : {link.registry_id or '（未纳入）'}")
    # 无条件打印：L1 给得出链接，不等于 L3 的语料已获批，这两件事必须分开看
    print(f"语料审批    : {corpus_approval_note()}")
    if not link.in_registry:
        print(
            "\n注意：该课程尚未纳入 RAG 语料 registry。\n"
            "  · L1（放攻略链接）可以直接做；\n"
            "  · L3（把仓库资料喂给 AI 出题）必须先把课程纳入 registry 并完成人工审批。"
        )

    return 0


def command_check(args: argparse.Namespace) -> int:
    import yaml  # 延迟导入

    batch = yaml.safe_load(Path(args.path).read_text(encoding="utf-8"))
    slugs = [str(p.get("slug")) for p in batch.get("problems", [])]
    request = ExportRequest(
        batch=batch,
        selected_slugs=args.select or [],
        read_only=args.read_only,
    )
    violations = check_export(request)
    print(f"题单：{args.path}")
    print(f"题目数：{len(slugs)}　勾选数：{len(request.selected_slugs)}")
    if violations:
        print("\n未通过红线检查：")
        for item in violations:
            print(f"  ✗ {item}")
        return 1
    print("\n通过红线检查，可导出。")
    if args.emit:
        print("\n--- 导出内容预览 ---")
        print(export_to_yaml(request))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)

    link = sub.add_parser("link", help="查询课程 ↔ HOA 仓库映射")
    link.add_argument("code", nargs="?", help="校内课程代码，如 COMP1007")
    link.add_argument("--all", action="store_true", help="列出 registry 里的全部映射")
    link.set_defaults(func=command_link)

    check = sub.add_parser("check", help="校验题单是否符合公开导出红线")
    check.add_argument("path")
    check.add_argument("--select", action="append", default=None,
                       help="勾选的题目 slug，可重复；不传表示一道都没勾")
    check.add_argument("--read-only", action="store_true", help="模拟只读开关打开")
    check.add_argument("--emit", action="store_true", help="通过后打印导出内容")
    check.set_defaults(func=command_check)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
