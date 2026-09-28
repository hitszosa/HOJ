import { describe, expect, it, vi } from "vitest";
import { loadPortalPage } from "@/lib/portal";

describe("端内详情权限与加载顺序", () => {
  it("归档元数据完成前不交付草稿页面", async () => {
    let resolve!: (value: unknown) => void;
    const metadata = new Promise(r => { resolve = r; });
    const request = vi.fn(async (path: string) => path === "/drafts/a" ? { offering_id: 10 } : metadata);
    let rendered = false;
    const page = loadPortalPage("/drafts/a", { name: "draft", did: "a" }, "teacher", request)
      .then(value => { rendered = true; return value; });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("/offerings/10"));
    expect(rendered).toBe(false);
    resolve({ offering: { role: "teacher", status: "archived" } });
    expect((await page).archived).toBe(true);
  });

  it("权限元数据失败时不能降级成可写页面", async () => {
    const request = vi.fn(async (path: string) => {
      if (path === "/drafts/a") return { offering_id: 10 };
      throw new Error("503|权限服务不可达");
    });
    await expect(loadPortalPage("/drafts/a", { name: "draft", did: "a" }, "teacher", request)).rejects.toThrow("503|");
  });

  it("助教不能进入题单管理，也不会先请求草稿", async () => {
    const request = vi.fn(async () => ({ offering: { role: "ta", status: "active" } }));
    await expect(loadPortalPage("/offerings/10/drafts", { name: "studio", oid: "10" }, "teacher", request)).rejects.toThrow("只有任课教师");
    expect(request.mock.calls).toEqual([["/offerings/10"]]);
  });

  it.each([
    ["student", "teacher"], ["teacher", "student"], ["student", undefined],
  ])("%s 端拒绝不匹配的课程角色 %s", async (portal, role) => {
    await expect(loadPortalPage("/offerings/10", { name: "teacher-course", oid: "10" }, portal!,
      async () => ({ offering: { role } }))).rejects.toThrow("此课程不属于当前端");
  });

  it("助教可以在教学端预览已授权课程", async () => {
    const page = await loadPortalPage("/offerings/10", { name: "teacher-course", oid: "10" }, "teacher",
      async () => ({ offering: { role: "ta", status: "active" }, batches: [] }));
    expect(page.ta).toBe(true);
    expect(page.archived).toBe(false);
  });
});
