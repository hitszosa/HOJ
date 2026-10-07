import { describe, expect, it } from "vitest";
import { managedCoursePath } from "@/lib/managed-courses";

describe("旧编程课程按已授权关联跳转", () => {
  it("使用管理课程 ID，不把编程教学班 ID 当作管理课程 ID", () => {
    expect(managedCoursePath("3", [{ course_id: 5, offering_id: 3 }])).toBe("/management/courses/5");
    expect(managedCoursePath("4", [{ course_id: 5, offering_id: 3 }, { course_id: 6, offering_id: 4 }])).toBe("/management/courses/6");
  });
  it("未授权或不存在的课程不生成链接", () => {
    expect(managedCoursePath("3", [])).toBeNull();
    expect(managedCoursePath("3", [{ course_id: 6, offering_id: 4 }])).toBeNull();
    expect(managedCoursePath("3", { data: [] })).toBeNull();
  });
  it("非法 ID、非法目标和有歧义的映射不生成链接", () => {
    for (const id of ["../5", "0", "-1", "03", "Infinity", "9007199254740993"]) expect(managedCoursePath(id, [])).toBeNull();
    for (const course_id of [0, -1, "../../admin", 1.5]) expect(managedCoursePath("3", [{ course_id, offering_id: 3 }])).toBeNull();
    expect(managedCoursePath("3", [{ course_id: 5, offering_id: 3 }, { course_id: 6, offering_id: 3 }])).toBeNull();
  });
});
