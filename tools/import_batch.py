#!/usr/bin/env python3
"""题单导入器：把 §4.2 格式的题单 YAML 导入 HUSTOJ 与教学域。

对应规划 v3.0 §1.3「教师端 · 导入题单」的第一种入口（平台题单 YAML）。

导入做了什么：

1. 校验题单（字段白名单、必填项、slug 唯一）
2. 确保 `cm_course` / `cm_offering` 存在
3. 按 **`problem.source = codemind:<course>/<batch>/<slug>`** 幂等建题：
   已存在则更新，不存在则新建。用 `source` 承载稳定标识，是为了不新增表
   （HUSTOJ 侧必须保持零新表）。
4. 把题单里的**样例**写成第一个测试点（`/home/judge/data/<id>/1.in|1.out`）
5. 建/更新 `cm_batch` 与 `cm_batch_problem`，并把题单顶层 `read_only`（只读导入
   标记）与**精确到题单文件**的 `source_ref` 一并落库；只读标记一旦为真，
   后续任何一次导入都不会把它清回 0

两条安全默认值：

- **题目默认 `defunct='Y'`（对学生隐藏）**。因为种子题单只带样例测试点，
  样例测试点是可以被硬编码通过的，必须先补完整测试数据再 `--publish`。
- 导入器不写 `jol.users`，也不碰既有提交。

用法::

    python3 tools/import_batch.py data/seed/COMP1007-W01.yml \\
        --course-name 程序设计基础 --teacher admin
    python3 tools/import_batch.py data/seed/COMP1007-W01.yml --publish   # 补完测试数据后再用
    python3 tools/import_batch.py data/seed/COMP1007-W01.yml --dry-run   # 只打印计划

数据库访问走 `docker exec mysql`，与 `hustoj/codemind/tools/verify_direct_submit.py`
保持同一种零依赖风格。生产环境的 Course Service 换成驱动走 TCP 时，SQL 语句不变。
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import hoa  # noqa: E402

SOURCE_PREFIX = "codemind"

#: 教学域库名。导入器连的是 jol 库，所以教学域的表必须写全限定名。
COURSE_DB = "codemind_course"


# ---------------------------------------------------------------- 基础设施


def sql_str(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


class Db:
    """通过 docker exec + mysql CLI 访问数据库（开发环境的零依赖通道）。"""

    def __init__(self, container: str, database: str, user: str, password: str) -> None:
        self.container = container
        self.database = database
        self.user = user
        self.password = password

    def _argv(self, extra: list[str]) -> list[str]:
        return [
            "docker", "exec", "-i", self.container, "mysql",
            "--default-character-set=utf8mb4",
            f"-u{self.user}", f"-p{self.password}", self.database, *extra,
        ]

    def run(self, sql: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        proc = subprocess.run(self._argv([]), input=sql, capture_output=True, text=True)
        if check and proc.returncode != 0:
            raise RuntimeError(f"mysql 执行失败：\n{proc.stderr.strip()}\n--- SQL ---\n{sql}")
        return proc

    def scalar(self, sql: str) -> str:
        proc = subprocess.run(self._argv(["-N", "-B", "-e", sql]),
                              capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(f"mysql 查询失败：{proc.stderr.strip()}\n--- SQL ---\n{sql}")
        return proc.stdout.strip()

    def run_batch_scalar(self, sql: str) -> str:
        """执行多条语句并返回最后一条 SELECT 的结果（同一连接）。"""
        proc = subprocess.run(self._argv(["-N", "-B"]), input=sql,
                              capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(f"mysql 执行失败：\n{proc.stderr.strip()}\n--- SQL ---\n{sql}")
        lines = [line for line in proc.stdout.splitlines() if line.strip()]
        return lines[-1].strip() if lines else ""


class Container:
    """往判题机容器里写测试数据。"""

    def __init__(self, name: str) -> None:
        self.name = name

    def exec(self, script: str, stdin: str | None = None) -> str:
        proc = subprocess.run(
            ["docker", "exec", "-i", self.name, "sh", "-c", script],
            input=stdin, capture_output=True, text=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"容器命令失败：{proc.stderr.strip()}\n--- 脚本 ---\n{script}")
        return proc.stdout

    def write_file(self, path: str, content: str) -> None:
        parent = str(Path(path).parent)
        self.exec(f"mkdir -p {parent} && cat > {path}", stdin=content)

    def chown_data(self, problem_id: int) -> None:
        self.exec(
            f"chown -R www-data:www-data /home/judge/data/{problem_id} && "
            f"chmod 644 /home/judge/data/{problem_id}/*"
        )


# ---------------------------------------------------------------- 题单校验


@dataclass
class Plan:
    """导入计划：每个题目一行，便于 --dry-run 与结果核对。"""

    slug: str
    title: str
    identity: str
    problem_id: int = 0
    action: str = ""
    samples: int = 0


def load_and_validate(path: Path) -> dict:
    batch = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(batch, dict):
        raise ValueError(f"{path} 不是合法的题单（顶层应为映射）")

    allowed_batch = hoa.EXPORTED_BATCH_FIELDS | hoa.INTERNAL_BATCH_FIELDS
    allowed_problem = hoa.EXPORTED_PROBLEM_FIELDS | hoa.INTERNAL_PROBLEM_FIELDS

    missing = {"course", "batch", "seq", "title", "problems"} - set(batch)
    if missing:
        raise ValueError(f"{path} 缺少必填字段：{sorted(missing)}")
    for key in batch:
        if key not in allowed_batch:
            raise ValueError(f"{path} 含未知字段 `{key}`")

    # 只读标记与来源在导入前就固化：宁可在这里报错，也不要写库时静默丢弃
    try:
        hoa.validate_batch_provenance(batch)
        hoa.resolve_source_ref(batch, hoa.resolve_course(batch["course"]), path)
    except ValueError as exc:
        raise ValueError(f"{path}：{exc}") from exc

    seen: set[str] = set()
    for problem in batch["problems"]:
        key_missing = {"slug", "title", "statement", "samples"} - set(problem)
        if key_missing:
            raise ValueError(f"{path} 的题目缺少必填字段：{sorted(key_missing)}")
        for key in problem:
            if key not in allowed_problem:
                raise ValueError(f"{path} 的题目 {problem['slug']} 含未知字段 `{key}`")
        if problem["slug"] in seen:
            raise ValueError(f"{path} 中 slug 重复：{problem['slug']}")
        seen.add(problem["slug"])
        for sample in problem["samples"]:
            if "input" not in sample or "output" not in sample:
                raise ValueError(f"{path} 的题目 {problem['slug']} 的样例缺少 input/output")
    return batch


# ---------------------------------------------------------------- 导入


def ensure_course(db: Db, code: str, name: str) -> int:
    db.run(
        f"INSERT INTO {COURSE_DB}.cm_course(code,name,created_at,updated_at) VALUES "
        f"({sql_str(code)},{sql_str(name)},NOW(),NOW()) "
        "ON DUPLICATE KEY UPDATE updated_at=NOW();\n"
    )
    return int(db.scalar(f"SELECT course_id FROM {COURSE_DB}.cm_course WHERE code={sql_str(code)};"))


def ensure_offering(db: Db, course_id: int, term: str, section: str,
                    title: str, teacher_id: str) -> int:
    db.run(
        f"INSERT INTO {COURSE_DB}.cm_offering(course_id,term,section,title,teacher_id,status,"
        "created_at,updated_at) VALUES "
        f"({course_id},{sql_str(term)},{sql_str(section)},{sql_str(title)},"
        f"{sql_str(teacher_id)},'active',NOW(),NOW()) "
        "ON DUPLICATE KEY UPDATE updated_at=NOW();\n"
    )
    return int(db.scalar(
        f"SELECT offering_id FROM {COURSE_DB}.cm_offering WHERE "
        f"course_id={course_id} AND term={sql_str(term)} AND section={sql_str(section)};"
    ))


def upsert_problem(
    db: Db, *, identity: str, problem: dict, time_limit: float,
    memory_limit: int, publish: bool,
) -> tuple[int, str]:
    """按 identity 幂等建题，返回 (problem_id, 'created'|'updated')。"""
    defunct = "N" if publish else "Y"
    knowledge = ", ".join(problem.get("knowledge", []))
    hint = f"知识点：{knowledge}｜难度：{problem.get('difficulty', '未标注')}"
    sample_input = problem["samples"][0]["input"]
    sample_output = problem["samples"][0]["output"]

    existing = db.scalar(
        f"SELECT problem_id FROM problem WHERE source={sql_str(identity)} LIMIT 1;"
    )

    if existing:
        problem_id = int(existing)
        db.run(
            "UPDATE problem SET "
            f"title={sql_str(problem['title'])},"
            f"description={sql_str(problem['statement'])},"
            f"hint={sql_str(hint)},"
            f"sample_input={sql_str(sample_input)},"
            f"sample_output={sql_str(sample_output)},"
            f"time_limit={time_limit},memory_limit={memory_limit},"
            f"defunct={sql_str(defunct)},in_date=NOW() "
            f"WHERE problem_id={problem_id};\n"
        )
        return problem_id, "updated"

    insert_sql = (
        "INSERT INTO problem(title,description,input,output,sample_input,sample_output,"
        "spj,hint,source,in_date,time_limit,memory_limit,defunct) VALUES "
        f"({sql_str(problem['title'])},{sql_str(problem['statement'])},'',"
        f"'',{sql_str(sample_input)},{sql_str(sample_output)},'0',"
        f"{sql_str(hint)},{sql_str(identity)},NOW(),"
        f"{time_limit},{memory_limit},{sql_str(defunct)});"
    )
    # LAST_INSERT_ID() 是连接级的：插入与读取必须走同一个 mysql 进程，
    # 否则读到的永远是 0（这个坑在提交流程里踩过一次，这里用断言兜住）。
    problem_id = int(db.run_batch_scalar(insert_sql + "\nSELECT LAST_INSERT_ID();\n"))
    if problem_id <= 0:
        raise RuntimeError(
            f"新建题目后拿不到 problem_id（得到 {problem_id}），"
            "疑似 LAST_INSERT_ID() 跨连接读取，已中止以免污染批次关联。"
        )
    return problem_id, "created"


def write_sample_testdata(container: Container, problem_id: int, problem: dict) -> int:
    """把样例写成第一个测试点。返回写入的测试点数。"""
    written = 0
    container.write_file(
        f"/home/judge/data/{problem_id}/1.in", problem["samples"][0]["input"]
    )
    container.write_file(
        f"/home/judge/data/{problem_id}/1.out", problem["samples"][0]["output"]
    )
    written += 1
    container.chown_data(problem_id)
    return written


def upsert_batch(db: Db, *, offering_id: int, batch: dict, source_ref: str) -> int:
    read_only = hoa.batch_read_only(batch)
    open_at = sql_str(batch["open_at"]) if batch.get("open_at") else "NULL"
    due_at = sql_str(batch["due_at"]) if batch.get("due_at") else "NULL"

    db.run(
        f"INSERT INTO {COURSE_DB}.cm_batch(offering_id,seq,title,open_at,due_at,status,"
        "source_ref,read_only,created_at,updated_at) VALUES "
        f"({offering_id},{int(batch['seq'])},{sql_str(batch['title'])},"
        f"{open_at},{due_at},'published',{sql_str(source_ref)},"
        f"{1 if read_only else 0},NOW(),NOW()) "
        "ON DUPLICATE KEY UPDATE title=VALUES(title),open_at=VALUES(open_at),"
        "due_at=VALUES(due_at),source_ref=VALUES(source_ref),"
        # GREATEST 而不是 VALUES(read_only)：只读标记一旦为真，后续任何一次导入
        # 都不许把它清回 0（题单里少写一个字段就等于静默解除只读，是泄露级错误）。
        "read_only=GREATEST(read_only,VALUES(read_only)),updated_at=NOW();\n"
    )
    return int(db.scalar(
        f"SELECT batch_id FROM {COURSE_DB}.cm_batch WHERE "
        f"offering_id={offering_id} AND seq={int(batch['seq'])};"
    ))


def upsert_batch_problem(db: Db, *, batch_id: int, problem_id: int, seq: int,
                         score: float) -> None:
    db.run(
        f"INSERT INTO {COURSE_DB}.cm_batch_problem(batch_id,problem_id,seq,score,created_at,updated_at) "
        f"VALUES({batch_id},{problem_id},{seq},{score},NOW(),NOW()) "
        "ON DUPLICATE KEY UPDATE seq=VALUES(seq),score=VALUES(score),updated_at=NOW();\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("path", help="题单 YAML 路径")
    parser.add_argument("--container", default="hustoj")
    parser.add_argument("--database", default="jol")
    parser.add_argument("--user", default="codemind")
    parser.add_argument("--password", default="codemind-dev-pw")
    parser.add_argument("--course-name", default=None, help="课程名（首次导入时用于建课程）")
    parser.add_argument("--teacher", default="admin", help="主讲教师 user_id")
    parser.add_argument("--term", default="2026-秋")
    parser.add_argument("--section", default="01")
    parser.add_argument("--time-limit", type=float, default=1.0, help="秒")
    parser.add_argument("--memory-limit", type=int, default=128,
                        help="MB —— 注意 problem.memory_limit 的单位是 MB，尽管列注释写的是 KB")
    parser.add_argument("--score", type=float, default=100.0)
    parser.add_argument("--publish", action="store_true",
                        help="建题时对学生可见（默认 defunct='Y' 隐藏，补完测试数据再用）")
    parser.add_argument("--skip-testdata", action="store_true", help="不写样例测试点")
    parser.add_argument("--dry-run", action="store_true", help="只打印计划，不落库")
    args = parser.parse_args()

    try:
        batch = load_and_validate(Path(args.path))
    except (ValueError, yaml.YAMLError) as exc:
        print(f"题单校验失败：{exc}", file=sys.stderr)
        return 2

    db = Db(args.container, args.database, args.user, args.password)
    container = Container(args.container)

    course_code = batch["course"]
    link = hoa.resolve_course(course_code)
    source_ref = hoa.resolve_source_ref(batch, link, args.path)
    read_only = hoa.batch_read_only(batch)
    plans = [
        Plan(
            slug=p["slug"],
            title=p["title"],
            identity=f"{SOURCE_PREFIX}:{course_code}/{batch['batch']}/{p['slug']}",
            samples=len(p["samples"]),
        )
        for p in batch["problems"]
    ]

    print(f"题单：{args.path}")
    print(f"课程：{course_code}（{link.hoa_repo}）　批次：{batch['batch']}　题目：{len(plans)}")
    print(f"来源 source_ref：{source_ref}")
    print(f"只读标记 read_only：{'1（只读导入，禁止回写 HOA）' if read_only else '0（可导出）'}")
    if "read_only" not in batch:
        print("  ⚠ 题单未声明 read_only，按可导出（read_only=0）处理。"
              "若本题单来自 HOA 只读导入，请在题单顶层显式写 read_only: true。")
    print(f"题目可见性：{'学生可见（--publish）' if args.publish else '对学生隐藏 defunct=Y'}")
    if not args.skip_testdata:
        print("测试点：每个题目只写入题单里的**样例**作为第 1 个测试点")
        if args.publish:
            print("  ⚠ 样例测试点可以被硬编码通过，发布前请务必补完整测试数据")

    if args.dry_run:
        print("\n--dry-run，以下为计划（未落库）：")
        for plan in plans:
            print(f"  {plan.slug:<24} → {plan.identity}")
        return 0

    course_id = ensure_course(db, course_code, args.course_name or course_code)
    offering_id = ensure_offering(
        db, course_id, args.term, args.section,
        f"{args.course_name or course_code} {args.term} {args.section} 班",
        args.teacher,
    )
    batch_id = upsert_batch(db, offering_id=offering_id, batch=batch, source_ref=source_ref)

    print(f"\n课程 course_id={course_id}　教学班 offering_id={offering_id}　"
          f"批次 batch_id={batch_id}\n")

    created = updated = 0
    for seq, (plan, problem) in enumerate(zip(plans, batch["problems"]), start=1):
        problem_id, action = upsert_problem(
            db, identity=plan.identity, problem=problem,
            time_limit=args.time_limit, memory_limit=args.memory_limit,
            publish=args.publish,
        )
        plan.problem_id, plan.action = problem_id, action
        created += action == "created"
        updated += action == "updated"

        if not args.skip_testdata:
            write_sample_testdata(container, problem_id, problem)
        upsert_batch_problem(
            db, batch_id=batch_id, problem_id=problem_id, seq=seq, score=args.score
        )
        print(f"  #{problem_id:<6}{action:<8}{plan.slug:<22}{plan.title}")

    print(f"\n导入完成：新建 {created} 题，更新 {updated} 题，批次内 {len(plans)} 题")
    if not args.publish:
        print("题目当前对学生隐藏（defunct='Y'）。补完测试数据后加 --publish 重新导入即可放开。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
