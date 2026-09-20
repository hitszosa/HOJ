#!/usr/bin/env python3
"""HOA 联动模块的测试。

跑法（不需要任何第三方依赖）::

    cd course-service && python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import hoa  # noqa: E402

SEED_DIR = ROOT / "data" / "seed"


def published_batch(**overrides) -> dict:
    """一份处于可导出状态的批次（平台侧数据，含内部字段）。"""
    batch = {
        "batch_id": 11,
        "offering_id": 1,
        "status": "published",
        "course": "COMP1007",
        "batch": "W03-循环结构",
        "seq": 3,
        "title": "第 3 周 · 循环结构",
        "open_at": "2026-09-22 08:00",
        "due_at": "2026-09-29 23:59",
        "problems": [
            {
                "problem_id": 1000,
                "slug": "sum-of-n",
                "title": "累加求和",
                "knowledge": ["循环"],
                "difficulty": "easy",
                "statement": "读入 n，输出 1+2+...+n。\n",
                "samples": [{"input": "5", "output": "15"}],
                "score": 100.0,
                "attempts": 3,
            },
            {
                "problem_id": 1001,
                "slug": "is-prime",
                "title": "判断素数",
                "knowledge": ["循环", "取余"],
                "difficulty": "medium",
                "statement": "读入 n，素数输出 yes。\n",
                "samples": [{"input": "97", "output": "yes"}],
            },
        ],
    }
    batch.update(overrides)
    return batch


class TestCourseLink(unittest.TestCase):
    def test_course_in_registry_resolves_with_registry_id(self):
        link = hoa.resolve_course("COMP2052")
        self.assertTrue(link.in_registry)
        self.assertEqual(link.registry_id, "hoa-comp2052")
        self.assertEqual(link.hoa_repo, "HITSZ-OpenAuto/COMP2052")
        self.assertEqual(link.hoa_url, "https://github.com/HITSZ-OpenAuto/COMP2052")

    def test_course_not_in_registry_still_gets_link_but_flagged(self):
        link = hoa.resolve_course("COMP1007")
        self.assertFalse(link.in_registry)
        self.assertIsNone(link.registry_id)
        # L1 只需要仓库命名规则，所以链接照样可得
        self.assertEqual(link.hoa_url, "https://github.com/HITSZ-OpenAuto/COMP1007")

    def test_index_skips_entries_without_course_code(self):
        index = hoa.load_course_index()
        self.assertIn("COMP2052", index)
        self.assertNotIn("", index)
        for link in index.values():
            self.assertTrue(link.code)


class TestExportRedlines(unittest.TestCase):
    def test_redline1_no_selection_is_rejected(self):
        violations = hoa.check_export(hoa.ExportRequest(batch=published_batch()))
        self.assertTrue(any("红线1" in item for item in violations))

    def test_redline2_read_only_switch_blocks_export(self):
        request = hoa.ExportRequest(
            batch=published_batch(), selected_slugs=["sum-of-n"], read_only=True
        )
        violations = hoa.check_export(request)
        self.assertTrue(any("红线2" in item for item in violations))

    def test_redline3_draft_is_rejected(self):
        request = hoa.ExportRequest(
            batch=published_batch(status="draft"), selected_slugs=["sum-of-n"]
        )
        self.assertTrue(any("红线3" in item for item in hoa.check_export(request)))

    def test_redline4_test_cases_are_rejected(self):
        batch = published_batch()
        batch["problems"][0]["tests"] = [{"input": "5", "expected_stdout": "15"}]
        request = hoa.ExportRequest(batch=batch, selected_slugs=["sum-of-n"])
        self.assertTrue(any("红线4" in item for item in hoa.check_export(request)))

    def test_redline5_source_code_is_rejected(self):
        batch = published_batch()
        batch["problems"][0]["source_code"] = "print(1)"
        request = hoa.ExportRequest(batch=batch, selected_slugs=["sum-of-n"])
        self.assertTrue(any("红线5" in item for item in hoa.check_export(request)))

    def test_unknown_field_is_reported_with_field_list(self):
        batch = published_batch()
        batch["problems"][0]["whatever"] = 1
        request = hoa.ExportRequest(batch=batch, selected_slugs=["sum-of-n"])
        violations = hoa.check_export(request)
        self.assertTrue(any("whatever" in item for item in violations))

    def test_platform_internal_fields_do_not_trip_the_check(self):
        """平台侧数据天然带 status / batch_id / problem_id，这些不能误报。"""
        request = hoa.ExportRequest(
            batch=published_batch(), selected_slugs=["sum-of-n", "is-prime"]
        )
        self.assertEqual(hoa.check_export(request), [])

    def test_selecting_unknown_slug_is_rejected(self):
        request = hoa.ExportRequest(batch=published_batch(), selected_slugs=["nope"])
        self.assertTrue(any("不存在" in item for item in hoa.check_export(request)))


class TestBuildExportDocument(unittest.TestCase):
    def test_document_contains_only_public_fields(self):
        request = hoa.ExportRequest(
            batch=published_batch(), selected_slugs=["sum-of-n", "is-prime"]
        )
        document = hoa.build_export_document(request)
        self.assertEqual(set(document) - {"problems"}, hoa.EXPORTED_BATCH_FIELDS - {"problems"})
        for problem in document["problems"]:
            self.assertTrue(set(problem) <= hoa.EXPORTED_PROBLEM_FIELDS)

    def test_selection_order_becomes_problem_order(self):
        request = hoa.ExportRequest(
            batch=published_batch(), selected_slugs=["is-prime", "sum-of-n"]
        )
        document = hoa.build_export_document(request)
        self.assertEqual([p["slug"] for p in document["problems"]], ["is-prime", "sum-of-n"])
        self.assertEqual([p["seq"] for p in document["problems"]], [1, 2])

    def test_unselected_problems_are_dropped(self):
        request = hoa.ExportRequest(batch=published_batch(), selected_slugs=["is-prime"])
        document = hoa.build_export_document(request)
        self.assertEqual([p["slug"] for p in document["problems"]], ["is-prime"])

    def test_build_refuses_when_redline_violated(self):
        request = hoa.ExportRequest(batch=published_batch(), selected_slugs=[])
        with self.assertRaises(ValueError):
            hoa.build_export_document(request)

    def test_yaml_roundtrip_keeps_multiline_statement(self):
        request = hoa.ExportRequest(batch=published_batch(), selected_slugs=["sum-of-n"])
        text = hoa.export_to_yaml(request)
        self.assertIn("已通过公开导出红线检查", text)
        self.assertIn("sum-of-n", text)
        # 钩子：导出的文本里绝不能出现测试数据相关的字样
        for banned in ("expected_stdout", "test_cases", "source_code"):
            self.assertNotIn(banned, text)


class TestSeedProblemSets(unittest.TestCase):
    """种子题单必须能被解析、且字段全部在允许集合内。"""

    def setUp(self):
        import yaml

        self.yaml = yaml
        self.files = sorted(SEED_DIR.glob("*.yml"))
        self.assert_seed_present()

    def assert_seed_present(self):
        self.assertTrue(self.files, f"{SEED_DIR} 下没有题单文件")

    def test_every_seed_file_has_consistent_shape(self):
        for path in self.files:
            batch = self.yaml.safe_load(path.read_text(encoding="utf-8"))
            with self.subTest(file=path.name):
                self.assertEqual(batch["course"], "COMP1007")
                self.assertIsInstance(batch["seq"], int)
                self.assertTrue(batch["problems"])
                self.assertEqual(
                    set(batch) - {"problems"}, hoa.EXPORTED_BATCH_FIELDS - {"problems"}
                )

    def test_seed_problems_are_unique_and_have_samples(self):
        seen: dict[str, str] = {}
        total = 0
        for path in self.files:
            batch = self.yaml.safe_load(path.read_text(encoding="utf-8"))
            for problem in batch["problems"]:
                slug = problem["slug"]
                total += 1
                with self.subTest(slug=slug):
                    self.assertNotIn(slug, seen, f"{slug} 在 {seen.get(slug)} 与 {path.name} 重复")
                    seen[slug] = path.name
                    self.assertTrue(problem.get("samples"), "种子题必须至少带一个样例")
                    self.assertTrue(set(problem) <= hoa.EXPORTED_PROBLEM_FIELDS)
                    self.assertTrue(problem["statement"].strip())
        # 规划要求 20–30 道种子题
        self.assertGreaterEqual(total, 20)
        self.assertLessEqual(total, 30)


class TestDedicatedHoaOjRepo(unittest.TestCase):
    """测试独立题单仓库 hoa-oj 规范与路径推导。"""

    def setUp(self):
        self.link = hoa.resolve_course("COMP1007")

    def test_course_link_has_hoa_oj_properties(self):
        self.assertEqual(self.link.hoa_oj_repo, "HITSZ-OpenAuto/hoa-oj")
        self.assertEqual(self.link.hoa_oj_url, "https://github.com/HITSZ-OpenAuto/hoa-oj")
        self.assertEqual(self.link.hoa_oj_dir, "problems/COMP1007")

    def test_suggest_batch_filename_normalizes_case_and_prefix(self):
        self.assertEqual(hoa.suggest_batch_filename("COMP1007", "W01"), "COMP1007-W01.yml")
        self.assertEqual(hoa.suggest_batch_filename("COMP1007", "COMP1007-W01"), "COMP1007-W01.yml")
        self.assertEqual(hoa.suggest_batch_filename("comp1007", "w02.yml"), "COMP1007-W02.yml")
        self.assertEqual(hoa.suggest_batch_filename("COMP2052", "LAB01"), "COMP2052-LAB01.yml")

    def test_suggest_batch_repo_path(self):
        self.assertEqual(
            hoa.suggest_batch_repo_path("COMP1007", "W01"),
            "problems/COMP1007/COMP1007-W01.yml",
        )
        self.assertEqual(
            hoa.suggest_batch_repo_path("AUTO1001", "LAB02"),
            "problems/AUTO1001/AUTO1001-LAB02.yml",
        )

    def test_validate_hoa_problem_set_path(self):
        ok, err = hoa.validate_hoa_problem_set_path("problems/COMP1007/COMP1007-W01.yml")
        self.assertTrue(ok)
        self.assertIsNone(err)

        ok, err = hoa.validate_hoa_problem_set_path("problems/COMP2052/COMP2052-LAB01.yaml")
        self.assertTrue(ok)
        self.assertIsNone(err)

        # 非法情况 1：不是 problems/ 目录
        ok, err = hoa.validate_hoa_problem_set_path("COMP1007/W01.yml")
        self.assertFalse(ok)
        self.assertIn("problems", str(err))

        # 非法情况 2：未以课程代码前缀命名
        ok, err = hoa.validate_hoa_problem_set_path("problems/COMP1007/W01.yml")
        self.assertFalse(ok)
        self.assertIn("COMP1007-", str(err))

        # 非法情况 3：非 YAML 扩展名
        ok, err = hoa.validate_hoa_problem_set_path("problems/COMP1007/COMP1007-W01.json")
        self.assertFalse(ok)
        self.assertIn(".yml", str(err))

    def test_build_hoa_oj_source_ref(self):
        ref = hoa.build_hoa_oj_source_ref("COMP1007", "COMP1007-W01.yml")
        self.assertEqual(ref, "hoa:HITSZ-OpenAuto/hoa-oj@problems/COMP1007/COMP1007-W01.yml")

        # 传入相对路径
        ref2 = hoa.build_hoa_oj_source_ref("COMP1007", "problems/COMP1007/COMP1007-W01.yml")
        self.assertEqual(ref2, "hoa:HITSZ-OpenAuto/hoa-oj@problems/COMP1007/COMP1007-W01.yml")

        # 缺少前缀自动补全
        ref3 = hoa.build_hoa_oj_source_ref("COMP1007", "W01.yml")
        self.assertEqual(ref3, "hoa:HITSZ-OpenAuto/hoa-oj@problems/COMP1007/COMP1007-W01.yml")

    def test_build_source_ref_supports_central_and_legacy(self):
        # 兼容旧单课仓库模式
        legacy_ref = hoa.build_source_ref(self.link, "oj/w03.yml")
        self.assertEqual(legacy_ref, "hoa:HITSZ-OpenAuto/COMP1007@oj/w03.yml")

        # 自动识别 problems/ 路径为独立仓库模式
        central_ref = hoa.build_source_ref(self.link, "problems/COMP1007/COMP1007-W01.yml")
        self.assertEqual(central_ref, "hoa:HITSZ-OpenAuto/hoa-oj@problems/COMP1007/COMP1007-W01.yml")

        # 显式声明 central=True
        explicit_central = hoa.build_source_ref(self.link, "COMP1007-W02.yml", central=True)
        self.assertEqual(explicit_central, "hoa:HITSZ-OpenAuto/hoa-oj@problems/COMP1007/COMP1007-W02.yml")

    def test_parse_source_ref_both_modes(self):
        # 独立题单仓库解析
        p_central = hoa.parse_source_ref("hoa:HITSZ-OpenAuto/hoa-oj@problems/COMP1007/COMP1007-W01.yml")
        self.assertEqual(p_central["type"], "central")
        self.assertEqual(p_central["repo"], "HITSZ-OpenAuto/hoa-oj")
        self.assertEqual(p_central["course"], "COMP1007")
        self.assertEqual(p_central["filename"], "COMP1007-W01.yml")

        # 历史单课仓库解析
        p_legacy = hoa.parse_source_ref("hoa:HITSZ-OpenAuto/COMP1007@oj/w03.yml")
        self.assertEqual(p_legacy["type"], "legacy")
        self.assertEqual(p_legacy["repo"], "HITSZ-OpenAuto/COMP1007")
        self.assertEqual(p_legacy["course"], "COMP1007")
        self.assertEqual(p_legacy["filename"], "w03.yml")


if __name__ == "__main__":
    unittest.main(verbosity=2)

