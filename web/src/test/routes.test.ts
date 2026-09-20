/**
 * 路由表与草稿身份隔离的回归测试。
 *
 * 对应 web 节点的两条验收：
 *   1. hustoj-portals-3：/student 与 /teacher 两端分离，未知路由明确「页面未找到」，
 *      旧链接（/history、/themes）迁移到新端路由；
 *   2. 代码草稿按用户隔离，身份切换互不串号。
 */

import {
  draftStorageKey,
  matchRoute,
  readDraft,
  routePortal,
  writeDraft,
} from "@/lib/routes";
import { describe, expect, it } from "vitest";

describe("matchRoute", () => {
  it("识别全部合法路由", () => {
    expect(matchRoute("/")).toEqual({ name: "home" });
    expect(matchRoute("/student")).toEqual({ name: "student" });
    expect(matchRoute("/student/history")).toEqual({ name: "student-history" });
    expect(matchRoute("/student/courses/10")).toEqual({ name: "student-course", oid: "10" });
    expect(matchRoute("/student/batches/10")).toEqual({ name: "student-batch", bid: "10" });
    expect(matchRoute("/student/batches/10/problems/1025")).toEqual({
      name: "student-workspace",
      bid: "10",
      pid: "1025",
    });
    expect(matchRoute("/teacher")).toEqual({ name: "teacher" });
    expect(matchRoute("/teacher/courses/10")).toEqual({ name: "teacher-course", oid: "10" });
    expect(matchRoute("/teacher/batches/10")).toEqual({ name: "teacher-batch", bid: "10" });
    expect(matchRoute("/teacher/batches/10/problems/1025")).toEqual({
      name: "teacher-workspace",
      bid: "10",
      pid: "1025",
    });
    expect(matchRoute("/teacher/offerings/10")).toEqual({ name: "studio", oid: "10" });
    expect(matchRoute("/teacher/drafts/7")).toEqual({ name: "draft", did: "7" });
    expect(matchRoute("/faq")).toEqual({ name: "faq" });
    expect(matchRoute("/student/status")).toEqual({ name: "student-status" });
    expect(matchRoute("/student/ranklist")).toEqual({ name: "student-ranklist" });
    expect(matchRoute("/student/problems")).toEqual({ name: "redirect", to: "/student/categories" });
    expect(matchRoute("/student/categories")).toEqual({ name: "student-categories" });
    expect(matchRoute("/student/problems/1025")).toEqual({ name: "student-problem-detail", pid: "1025" });
    expect(matchRoute("/student/categories/problems/01-basic-io-p01")).toEqual({ name: "student-problem-detail", pid: "01-basic-io-p01" });
    expect(matchRoute("/teacher/categories")).toEqual({ name: "teacher-categories" });
    expect(matchRoute("/teacher/status")).toEqual({ name: "teacher-status" });
    expect(matchRoute("/teacher/ranklist")).toEqual({ name: "teacher-ranklist" });
    expect(matchRoute("/teacher/insights/10")).toEqual({ name: "insights", oid: "10" });
    expect(matchRoute("/teacher/classes/10")).toEqual({ name: "classes", oid: "10" });
    expect(matchRoute("/teacher/library")).toEqual({ name: "teacher-library" });
    expect(matchRoute("/teacher/problems")).toEqual({ name: "teacher-library" });
    expect(matchRoute("/teacher/problem-sets")).toEqual({ name: "teacher-library" });
  });

  it("旧公共链接标记为 legacy，由 Platform 按 me.portal 迁移", () => {
    expect(matchRoute("/courses/10")).toEqual({ name: "legacy-course", oid: "10" });
    expect(matchRoute("/batches/10")).toEqual({ name: "legacy-batch", bid: "10" });
    expect(matchRoute("/batches/10/problems/1025")).toEqual({
      name: "legacy-workspace",
      bid: "10",
      pid: "1025",
    });
    expect(matchRoute("/category.php")).toEqual({ name: "legacy-categories" });
  });

  it("旧链接迁移到新端路由", () => {
    expect(matchRoute("/history")).toEqual({ name: "redirect", to: "/student/history" });
    expect(matchRoute("/themes")).toEqual({ name: "redirect", to: "/" });
  });

  it("未知与畸形路由一律返回 not-found", () => {
    for (const p of ["/nope", "/courses", "/courses/10/edit", "/batches/10/xyz", "/batches/10/problems", "/teacher/drafts", "/teacher/unknown/1", "/student/nope", "/student/courses", "/api/leak"]) {
      expect(matchRoute(p), p).toEqual({ name: "not-found" });
    }
  });
});

describe("routePortal", () => {
  it("学生端命名空间归属 student，教师端命名空间归属 teacher", () => {
    expect(routePortal(matchRoute("/student"))).toBe("student");
    expect(routePortal(matchRoute("/student/history"))).toBe("student");
    expect(routePortal(matchRoute("/student/status"))).toBe("student");
    expect(routePortal(matchRoute("/student/problems/1025"))).toBe("student");
    expect(routePortal(matchRoute("/student/categories/problems/01-basic-io-p01"))).toBe("student");
    expect(routePortal(matchRoute("/student/categories"))).toBe("student");
    expect(routePortal(matchRoute("/student/batches/10/problems/1025"))).toBe("student");
    expect(routePortal(matchRoute("/teacher"))).toBe("teacher");
    expect(routePortal(matchRoute("/teacher/categories"))).toBe("teacher");
    expect(routePortal(matchRoute("/teacher/status"))).toBe("teacher");
    expect(routePortal(matchRoute("/teacher/ranklist"))).toBe("teacher");
    expect(routePortal(matchRoute("/teacher/courses/10"))).toBe("teacher");
    expect(routePortal(matchRoute("/teacher/drafts/7"))).toBe("teacher");
    expect(routePortal(matchRoute("/teacher/library"))).toBe("teacher");
    expect(routePortal(matchRoute("/faq"))).toBeNull();
  });

  it("legacy 与重定向路由返回 null（由 Platform 按身份再判定）", () => {
    expect(routePortal(matchRoute("/courses/10"))).toBeNull();
    expect(routePortal(matchRoute("/batches/10"))).toBeNull();
    expect(routePortal(matchRoute("/history"))).toBeNull();
  });
});

describe("草稿按身份隔离", () => {
  it("不同用户的草稿 key 不同，匿名身份也有独立 key", () => {
    expect(draftStorageKey("cm_pilot_student", "10", "1025")).not.toBe(
      draftStorageKey("cm_pilot_teacher", "10", "1025"),
    );
    expect(draftStorageKey("", "10", "1025")).toBe("code:anon:10:1025");
  });

  it("写入按用户隔离；旧的无用户 key 不再被读取（避免跨身份串号）", () => {
    localStorage.clear();
    localStorage.setItem("code:10:1025", "legacy-code");
    expect(readDraft("cm_pilot_student", "10", "1025")).toBe("");
    writeDraft("cm_pilot_student", "10", "1025", "student-code");
    expect(readDraft("cm_pilot_student", "10", "1025")).toBe("student-code");
    expect(readDraft("cm_pilot_teacher", "10", "1025")).toBe("");
    expect(localStorage.getItem("code:10:1025")).toBe("legacy-code");
  });
});
